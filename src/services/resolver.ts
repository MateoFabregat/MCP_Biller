// =============================================================================
// Resolver un nombre escrito a mano contra una lista real.
//
// EL PROBLEMA
//
// El enrutador de `menu.ts` ya tolera que el usuario escriba mal la INTENCIÓN:
// "como dieron el mes" llega a "¿Cómo viene el mes?". Pero un nivel más abajo no
// había nada. "Facturale a Distribuidora Peres" tiene una intención clarísima y
// una ENTIDAD que no existe con ese nombre: el cliente se llama "Distribuidora
// Pérez S.R.L.". Hasta acá eso lo resolvía el modelo por su cuenta, sin reglas y
// sin poder decir "no estoy seguro" — y las dos formas de equivocarse son caras:
// facturarle al cliente equivocado, o dar de alta un duplicado mal cargado.
//
// LA REGLA CENTRAL: NUNCA ELIGE SOLO CUANDO HAY DUDA
//
// Es la misma decisión que ya se tomó para los empates del menú, y por el mismo
// motivo: contestar con seguridad la pregunta que no se hizo es el modo de falla
// más caro en un canal donde el usuario no ve que hubo una decisión. Acá es peor
// todavía, porque la consecuencia no es un mensaje de más sino un CFE ante DGI.
//
// Por eso hay DOS umbrales y no uno:
//   - `UMBRAL_MINIMO`: por debajo, ni se ofrece. Un parecido lejano es ruido.
//   - `MARGEN_DECISIVO`: el primero tiene que separarse del segundo. Dos
//     candidatos parecidos entre sí no son "el mejor y el resto", son una
//     pregunta de un toque. "Pérez" contra "Peres Hnos" y "Pérez S.R.L." no se
//     resuelve con decimales.
//
// LO QUE NO HACE
//
// No inventa clientes ni productos: solo puede devolver cosas que ya están en la
// facturación de esta empresa. Si el nombre no matchea nada, eso ES la
// respuesta ("es cliente nuevo"), y es información útil — dispara el alta con
// dirección y ciudad, que es lo que la API exige y lo que si falta hace fallar
// la emisión entera en el último paso.
//
// QUÉ MÁS VIVE ACÁ: EL UNIVERSO CONTRA EL QUE SE RESUELVE
//
// Además de comparar, este módulo DEFINE la lista contra la cual se compara
// (`universoClientes`, `universoProductos`, al final del archivo). Eso no es
// plomería: "la cartera se deriva de la facturación y el universo es completo"
// es una regla de negocio con consecuencia visible —decide si la respuesta es
// "es un cliente nuevo" o "no lo encontré"—, y vivía adentro de
// `tools/resolverNombre.ts`, o sea inalcanzable desde cualquier otra superficie.
// La emisión guiada, un cron o una segunda tool que necesiten resolver un nombre
// con el mismo criterio tenían dos salidas y las dos malas: reimplementarlo, o
// importar una tool desde otra tool (el error tabulado del HANDBOOK: lo que
// calcula vive en `services/`, ninguna tool importa a otra).
// =============================================================================

import type { ComprobanteEmitido } from "../biller/types.js";
import type { RangoFechas } from "./periodo.js";
import { rankingClientes, SIN_RECEPTOR } from "./rankingClientes.js";
import { rankingProductos } from "./rankingProductos.js";

/**
 * Mínimo de caracteres para que un fragmento pueda matchear por contención.
 *
 * Tres es el piso donde una subcadena empieza a decir algo. Con dos, "ez"
 * resolvía a "Juan Pérez" con 80% de confianza.
 */
export const LARGO_MINIMO_CONTENCION = 3;

/** Por debajo de esto no se ofrece nada: es ruido, no un candidato. */
export const UMBRAL_MINIMO = 0.55;

/**
 * Cuánto tiene que separarse el primero del segundo para elegirlo solo.
 *
 * Con menos diferencia que esta, los dos van como candidatos y se pregunta.
 * 0.12 sale de mirar los pares que de verdad confunden: apellidos parecidos y
 * razones sociales que comparten la primera palabra ("Distribuidora X" y
 * "Distribuidora Y") quedan siempre adentro de ese margen.
 */
export const MARGEN_DECISIVO = 0.12;

/**
 * Sufijos societarios que no distinguen nada.
 *
 * "Pérez S.R.L." y "Pérez SRL" son el mismo cliente escrito por dos personas.
 * Peor: dejar el sufijo hace que "Distribuidora Sur SA" y "Distribuidora Norte
 * SA" se parezcan MÁS de lo que son, porque comparten dos de tres tokens.
 */
const SUFIJOS_SOCIETARIOS = new Set([
  "srl", "sa", "s a", "sas", "ltda", "limitada", "sociedad", "anonima",
  "unipersonal", "coop", "cooperativa", "sca", "scp",
]);

/**
 * Conectores que no distinguen nada, por el MISMO motivo que los sufijos.
 *
 * Sin filtrarlos, "bolsa de harina" contra "Bolsa de harina 000 x 25kg" daba
 * 0.23 y el resolvedor contestaba "es un producto nuevo" — que dispara un alta
 * duplicada, justo el error que existe para evitar. La causa es aritmética:
 * `de` y `x` cuentan como tokens plenos en el denominador de la cobertura, así
 * que dos nombres que hablan de lo mismo se parecen menos cuanto más largos son.
 */
const CONECTORES = new Set([
  "de", "del", "la", "el", "los", "las", "y", "x", "con", "para", "un", "una",
  "al", "a", "en", "por",
]);

/** Normaliza para comparar: minúsculas, sin tildes, sin puntuación, sin sufijos. */
export function normalizarNombre(raw: string): string {
  const base = raw
    .toLowerCase()
    .normalize("NFD")
    // Los diacríticos separados por NFD. Así "Pérez" y "Perez" son la misma
    // cadena antes de cualquier comparación, que es lo que evita que una tilde
    // mal puesta cuente como un error de tipeo.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Los puntos de "S.R.L." ya se convirtieron en espacios, así que el sufijo
  // llega partido en tres tokens de una letra y no matchea nada de la lista. Sin
  // reunirlos, "Distribuidora Pérez S.R.L." conserva tres tokens de basura que
  // hacen que TODO nombre de dos palabras le gane por cobertura — que es
  // exactamente cómo "Distribuidora Peres" terminaba resolviendo a
  // "Distribuidora Sur SA".
  const tokens = reunirIniciales(base.split(" ").filter((t) => t !== "")).filter(
    (t) => !SUFIJOS_SOCIETARIOS.has(t) && !CONECTORES.has(t),
  );
  // Si al sacar los sufijos no queda nada, el nombre ERA el sufijo: se devuelve
  // la base para no convertir "SA" en la cadena vacía, que matchearía con todo.
  return tokens.length === 0 ? base : tokens.join(" ");
}

/** Junta corridas de tokens de una sola letra: ["s","r","l"] -> ["srl"]. */
function reunirIniciales(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let corrida: string[] = [];
  const volcar = (): void => {
    if (corrida.length === 0) return;
    out.push(corrida.join(""));
    corrida = [];
  };
  for (const t of tokens) {
    if (t.length === 1 && !/\d/.test(t)) corrida.push(t);
    else {
      volcar();
      out.push(t);
    }
  }
  volcar();
  return out;
}

/**
 * Distancia de edición (Levenshtein) entre dos cadenas.
 *
 * Es lo que hace que "peres" llegue a "perez" y "harnia" a "harina": una letra
 * cambiada, una de menos, dos traspuestas. Implementación con dos filas porque
 * los nombres son cortos y no hace falta la matriz completa.
 */
export function distanciaEdicion(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  let actual = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    actual[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(actual[j - 1]! + 1, anterior[j]! + 1, anterior[j - 1]! + costo);
    }
    [anterior, actual] = [actual, anterior];
  }
  return anterior[b.length]!;
}

/**
 * Normaliza un identificador para compararlo: solo alfanumérico, en minúsculas.
 *
 * Sirve para las tres cosas que llegan por acá — RUT, cédula y código de
 * producto — porque el error de transcripción de todas es el mismo: los
 * separadores. "218765430-011", "218.765.430.011" y "218765430011" son el mismo
 * RUT, y "har 25" es el mismo código que "HAR-25".
 */
export function normalizarIdentificador(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Similitud 0..1 derivada de la distancia de edición. */
export function similitudEdicion(a: string, b: string): number {
  const largo = Math.max(a.length, b.length);
  if (largo === 0) return 1;
  return 1 - distanciaEdicion(a, b) / largo;
}

/**
 * Similitud entre dos nombres, combinando dos miradas.
 *
 * La distancia de edición sola no alcanza: "perez" contra "distribuidora perez"
 * da 0.35 aunque sea obviamente el mismo cliente, porque compara cadenas
 * enteras. La coincidencia por tokens sola tampoco: no perdona un typo adentro
 * de una palabra, que es justo el caso que motiva todo esto.
 *
 * Se toma el MÁXIMO de las dos y no el promedio: cada una reconoce un caso que
 * la otra no ve, y promediarlas hace que ninguno de los dos llegue al umbral.
 */
export function similitudNombres(consulta: string, candidato: string): number {
  const a = normalizarNombre(consulta);
  const b = normalizarNombre(candidato);
  if (a === "" || b === "") return 0;
  if (a === b) return 1;

  // Contención: "perez" adentro de "distribuidora perez". Se pondera por cuánto
  // del candidato cubre, para que una consulta corta no gane siempre.
  //
  // Con menos de LARGO_MINIMO_CONTENCION caracteres NO se aplica: "ez" está
  // adentro de "Juan Pérez" y puntuaba 0.80, o sea que dos letras alcanzaban
  // para que el resolvedor dijera "es este, seguí con ese". Un fragmento así no
  // es evidencia de nada; lo correcto es pedir algunas letras más.
  let porContencion = 0;
  if (a.length >= LARGO_MINIMO_CONTENCION && (b.includes(a) || a.includes(b))) {
    const corto = Math.min(a.length, b.length);
    const largo = Math.max(a.length, b.length);
    // 0.75 de piso: es un match real, pero menos confiable que una igualdad.
    porContencion = 0.75 + 0.25 * (corto / largo);
  }

  // Por tokens, permitiendo un typo por token (de ahí el `similitudEdicion`
  // adentro): "distribuidora peres" contra "distribuidora perez" da 1.
  const tokensA = a.split(" ");
  const tokensB = b.split(" ");
  const usados = new Set<number>();
  let acumulado = 0;
  for (const ta of tokensA) {
    let mejor = 0;
    let mejorIdx = -1;
    tokensB.forEach((tb, i) => {
      if (usados.has(i)) return;
      const s = similitudEdicion(ta, tb);
      if (s > mejor) {
        mejor = s;
        mejorIdx = i;
      }
    });
    // Un token solo cuenta si de verdad se parece: sin este piso, palabras
    // cortas ("de", "y") suman parecido entre nombres que no tienen nada que ver.
    if (mejor >= 0.7 && mejorIdx >= 0) {
      usados.add(mejorIdx);
      acumulado += mejor;
    }
  }
  // Cuánto de lo que ESCRIBIÓ el usuario quedó cubierto, atenuado por cuánto del
  // candidato quedó sin explicar.
  //
  // Dividir por el máximo de los dos largos (lo primero que probé) castiga
  // demasiado buscar por una palabra: "perez" contra "Peres Hnos" caía a 0.4 y
  // dejaba de ser candidato, cuando es justo el que hay que ofrecer. Y dividir
  // solo por el largo de la consulta es demasiado generoso al revés: cualquier
  // palabra suelta matchearía al 100% el nombre más largo que la contenga.
  const cubiertos = usados.size;
  const porTokens =
    tokensA.length === 0
      ? 0
      : (acumulado / tokensA.length) * (0.6 + 0.4 * (cubiertos / tokensB.length));

  // La distancia de edición sobre la cadena ENTERA solo vale para nombres de una
  // palabra. Con varias, premia el prefijo compartido: "distribuidora peres" y
  // "distribuidora sur" dan 0.79 por tener trece letras iguales adelante, y así
  // el cliente equivocado le ganaba al correcto. Para nombres de varias palabras
  // el typo ya lo perdona la comparación token a token, que es donde
  // corresponde.
  const unaPalabra = tokensA.length === 1 && tokensB.length === 1;
  const porEdicion = unaPalabra ? similitudEdicion(a, b) : 0;

  return Math.max(porContencion, porTokens, porEdicion);
}

/** Algo que se puede resolver por nombre: un cliente, un producto. */
export interface Resoluble {
  /** Cómo figura en la facturación. Es lo que se compara y lo que se devuelve. */
  nombre: string;
  /**
   * Documento (RUT/CI) si lo tiene. Un match por acá es CERTEZA, no parecido:
   * los números no se parecen, coinciden o no.
   */
  documento?: string | null;
  /** Datos extra que el llamador quiera arrastrar (último precio, última compra…). */
  extra?: Record<string, unknown>;
}

export interface Candidato<T extends Resoluble = Resoluble> {
  item: T;
  /** 0..1. 1 cuando el match fue por documento o por nombre idéntico. */
  score: number;
  /** Por qué matcheó. Se devuelve para que el agente pueda explicarlo. */
  via: "documento" | "exacto" | "parecido";
}

export type Resolucion<T extends Resoluble = Resoluble> =
  /** Uno solo, y con distancia suficiente sobre el resto. Se puede usar. */
  | { clase: "unico"; elegido: Candidato<T>; alternativas: Array<Candidato<T>> }
  /** Varios plausibles. HAY QUE PREGUNTAR: no elijas por el usuario. */
  | { clase: "ambiguo"; candidatos: Array<Candidato<T>> }
  /** Nada se parece lo suficiente. Probablemente es nuevo. */
  | { clase: "ninguno"; candidatos: [] };

export interface OpcionesResolver {
  /** Cuántos candidatos devolver como máximo. 3 = lo que entra en botones. */
  maxCandidatos?: number;
  umbralMinimo?: number;
  margenDecisivo?: number;
}

/**
 * Resuelve un texto escrito por el usuario contra una lista real.
 *
 * El orden de los `via` no es cosmético: un documento que coincide gana siempre,
 * sin importar cómo esté escrito el nombre. Alguien que manda el RUT ya
 * identificó al cliente; ponerse a comparar razones sociales ahí sería
 * reintroducir incertidumbre donde no había.
 */
export function resolver<T extends Resoluble>(
  consulta: string,
  universo: readonly T[],
  opciones: OpcionesResolver = {},
): Resolucion<T> {
  const max = opciones.maxCandidatos ?? 3;
  const umbral = opciones.umbralMinimo ?? UMBRAL_MINIMO;
  const margen = opciones.margenDecisivo ?? MARGEN_DECISIVO;

  const texto = consulta.trim();
  if (texto === "" || universo.length === 0) return { clase: "ninguno", candidatos: [] };

  // 1. ¿Coincide un identificador? Un RUT, una cédula o un código de producto
  //    que coinciden no son un parecido: los identificadores no se parecen,
  //    coinciden o no.
  //
  //    Se compara alfanumérico y no solo dígitos porque los códigos de producto
  //    no son números ("HAR-25", "ACE-900"). Tratarlos como texto libre hacía
  //    que tipear el código exacto del producto diera "ninguno", que es el peor
  //    resultado posible para la entrada más precisa que puede dar el usuario.
  const clave = normalizarIdentificador(texto);
  if (clave.length >= 3) {
    const porDoc = universo.filter((u) => normalizarIdentificador(u.documento ?? "") === clave);
    if (porDoc.length === 1) {
      return {
        clase: "unico",
        elegido: { item: porDoc[0]!, score: 1, via: "documento" },
        alternativas: [],
      };
    }
    // Dos entradas con el mismo documento y nombres distintos existe: el mismo
    // cliente cargado dos veces. Se pregunta en vez de elegir el primero.
    if (porDoc.length > 1) {
      return {
        clase: "ambiguo",
        candidatos: porDoc.slice(0, max).map((item) => ({ item, score: 1, via: "documento" as const })),
      };
    }
  }

  // 2. Por nombre.
  const puntuados = universo
    .map((item) => {
      const score = similitudNombres(texto, item.nombre);
      return {
        item,
        score,
        via: (score === 1 ? "exacto" : "parecido") as Candidato<T>["via"],
      };
    })
    .filter((c) => c.score >= umbral)
    .sort((a, b) => b.score - a.score);

  if (puntuados.length === 0) return { clase: "ninguno", candidatos: [] };

  const primero = puntuados[0]!;
  const segundo = puntuados[1];

  // Un match exacto único gana aunque haya otro exacto abajo... no puede haber:
  // dos exactos son dos entradas con el mismo nombre, y eso SÍ es ambiguo.
  if (segundo === undefined || primero.score - segundo.score >= margen) {
    return {
      clase: "unico",
      elegido: primero,
      alternativas: puntuados.slice(1, max),
    };
  }

  return { clase: "ambiguo", candidatos: puntuados.slice(0, max) };
}

/**
 * La frase que el agente le tiene que decir al usuario, según cómo salió.
 *
 * Vive acá y no en el prompt por la misma razón que el menú: es la parte donde
 * el modelo tiende a resolver la duda por su cuenta ("dale, debe ser Pérez") en
 * vez de trasladarla. El texto no le deja esa salida.
 */
export function comoSigue<T extends Resoluble>(r: Resolucion<T>, consulta: string): string {
  switch (r.clase) {
    case "unico":
      return r.elegido.via === "documento"
        ? `Coincide el documento: es "${r.elegido.item.nombre}". Seguí con ese.`
        : `Es "${r.elegido.item.nombre}" (coincidencia ${Math.round(r.elegido.score * 100)}%). ` +
            "Seguí con ese, pero nombralo en tu respuesta para que el usuario pueda corregirte " +
            "si no era.";
    case "ambiguo":
      return (
        `"${consulta}" se parece a ${r.candidatos.length} de la lista ` +
        `(${r.candidatos.map((c) => `"${c.item.nombre}"`).join(", ")}) y no hay forma de saber cuál. ` +
        "NO elijas vos: preguntá cuál es. Si tenés el canal de WhatsApp, mandá los candidatos como " +
        "botones. Emitirle a la empresa equivocada se arregla con una nota de crédito; preguntar " +
        "cuesta un mensaje."
      );
    case "ninguno":
      return (
        `No hay nada parecido a "${consulta}" en la facturación de esta empresa. Lo más probable es ` +
        "que sea nuevo. Si vas a emitirle, va a haber que darlo de alta — y para eso la API exige " +
        "dirección y ciudad además del nombre y el documento."
      );
  }
}

// ---------------------------------------------------------------------------
// El universo: contra qué lista se resuelve
// ---------------------------------------------------------------------------

/** Un candidato con el contexto que permite distinguirlo de otro parecido. */
export interface ItemResoluble extends Resoluble {
  extra: Record<string, unknown>;
}

/**
 * El límite que se le pide al ranking para armar el universo: TODO.
 *
 * No es un número afinado: es la forma de decirle a `rankingClientes` /
 * `rankingProductos` —que existen para contestar "quiénes son los mejores" y por
 * eso cortan en 20 por default— que acá la pregunta es otra. El universo de
 * resolución es la CARTERA ENTERA del período, no el podio.
 *
 * EL MODO DE FALLA SI ESTO FUERA EL TOP 20
 *
 * Buscar a un cliente chico entre los 20 más grandes no lo encuentra, y el
 * resolvedor no contesta "no sé": contesta `ninguno`, que en el contrato de este
 * módulo significa "probablemente es NUEVO". Y "es nuevo" no es una respuesta
 * pasiva — dispara el alta de cliente dentro de la emisión. O sea: un cliente
 * que existe, que facturó poco, y al que se le termina creando un duplicado mal
 * cargado. Es exactamente el error que el resolvedor existe para evitar, servido
 * con toda seguridad y sin ninguna señal de duda.
 *
 * Es un número y no `Infinity` porque el ranking espera un entero, y es alto y
 * redondo porque no está pensado para atarse a nada: la cartera de una PyME
 * uruguaya en 90 días no llega a diez mil nombres distintos, y si alguna vez
 * llegara, el que se pierde es el que menos factura — el mismo modo de falla, y
 * entonces el arreglo no es subir el número sino dejar de derivar la cartera de
 * la facturación (haría falta un GET de clientes que Biller hoy no expone).
 *
 * El costo es memoria y CPU sobre datos que YA están en el proceso: el universo
 * se arma sobre los comprobantes que la ventana trajo, no agrega una request.
 */
export const LIMITE_UNIVERSO = 10_000;

/**
 * Construye el universo de clientes desde los comprobantes del período.
 *
 * La cartera se DERIVA de la facturación porque Biller no expone un listado de
 * clientes por GET. Consecuencia que hay que decir en voz alta: un cliente que
 * existe en la base pero no facturó en el período consultado no está acá, y por
 * eso `ninguno` se comunica como "probablemente es nuevo" y nunca como "no
 * existe".
 *
 * Se sacan los que no tienen nombre y el grupo `SIN_RECEPTOR`: no son clientes,
 * son la bolsa de las ventas de mostrador sin receptor identificado, y dejarlos
 * adentro haría que "(sin receptor)" compitiera por parecido con lo que escribe
 * el usuario.
 */
export function universoClientes(
  comprobantes: ComprobanteEmitido[],
  rango: RangoFechas,
): ItemResoluble[] {
  const ranking = rankingClientes(comprobantes, {
    desde: rango.desde,
    hasta: rango.hasta,
    // Sin límite útil: el universo es la cartera entera, no el top 20. Buscar a
    // un cliente chico entre los 20 más grandes no encuentra nada y contesta
    // "es nuevo", que es la respuesta equivocada con más consecuencias.
    limite: LIMITE_UNIVERSO,
  });
  return ranking.clientes
    .filter((c) => c.nombre !== null && c.nombre !== SIN_RECEPTOR)
    .map((c) => ({
      nombre: c.nombre!,
      documento: c.rut,
      extra: {
        ultima_compra: c.ultima_compra,
        comprobantes: c.comprobantes,
        esta_dormido: c.esta_dormido,
        es_nuevo: c.es_nuevo,
        facturado_por_moneda: c.facturado_por_moneda,
      },
    }));
}

/**
 * Construye el universo de productos. Requiere el detalle por id (N+1).
 *
 * Recibe los comprobantes YA detallados: el listado GET viene con `items: null`
 * y el catálogo solo se puede leer pidiendo cada comprobante por su `id`. Cuántos
 * se detallan lo decide el llamador —es una decisión de costo de red, no de
 * resolución— y es la limitación que la tool declara en sus warnings.
 *
 * El límite del ranking es el mismo `LIMITE_UNIVERSO` y por el mismo motivo: con
 * el top 20 de productos, pedir un artículo que se vende poco contesta "es un
 * producto nuevo" y se termina cargando un ítem duplicado con otro nombre.
 */
export function universoProductos(comprobantes: ComprobanteEmitido[]): ItemResoluble[] {
  const ranking = rankingProductos(comprobantes, { limite: LIMITE_UNIVERSO });
  return ranking.productos
    .filter((p) => p.concepto !== null && p.concepto.trim() !== "")
    .map((p) => ({
      // El valor viene de `concepto`, pero sale bajo `nombre`: la clave define
      // si la barrera lo envuelve, y esto vuelve a entrar en la emisión.
      //
      // Dicho entero, porque el comentario se mudó con el código y el motivo no
      // está a la vista desde acá: `concepto` está en `CAMPOS_NO_CONFIABLES`
      // (`src/security/untrusted.ts`), así que la barrera de SALIDA lo envolvería
      // en ⟦dato-no-confiable⟧ mirando SOLO el nombre de la clave, sin importar
      // de dónde vino el valor. Esta salida está pensada justamente para volver a
      // entrar en el payload de la emisión, así que esas marcas terminarían
      // impresas en un CFE ante DGI. Ya pasó dos veces. Por eso el nombre del
      // producto sale bajo `nombre` y NUNCA bajo `concepto` ni `razon_social`.
      nombre: p.concepto!,
      documento: p.codigo,
      extra: {
        codigo: p.codigo,
        precio_unitario_promedio: p.precio_unitario_promedio_ponderado,
        precio_unitario_min: p.precio_unitario_min,
        precio_unitario_max: p.precio_unitario_max,
        unidades: p.unidades,
        ultima_venta: p.ultima_venta,
        dispersion_alta: p.dispersion_alta,
      },
    }));
}
