// =============================================================================
// El enrutador: de lo que escribió el usuario a una intención del catálogo.
//
// Tres formas de elegir, todas soportadas: tocar la fila (llega el `id`),
// escribir el número de la lista, o escribir con sus palabras. La tercera es la
// que realmente se usa; las dos primeras son las que no fallan.
//
// EL ORDEN DE LOS PASOS ES EL INVARIANTE, y está documentado paso por paso
// adentro de `interpretarMensaje`: los ids propios primero (nada de heurística
// sobre algo que mandamos nosotros), después el número, después las
// afirmaciones/cancelaciones escritas, y recién al final el matching por
// palabras — exacto, por inclusión, por tokens y por typos, en ese orden, de lo
// más seguro a lo más arriesgado. Un empate no se resuelve al azar: se pregunta.
//
// Solo depende del catálogo (`intenciones.ts`) y del protocolo de ids
// (`protocolo.ts`). No sabe nada de cómo se dibuja un mensaje de WhatsApp.
// =============================================================================

import { similitudEdicion } from "../services/resolver.js";
import { PREFIJO_PASO } from "./emision.js";
import { esPedidoDeEmision, extraerPedidoEmision } from "./extraerPedido.js";
import {
  AFIRMACIONES,
  ASENTIMIENTOS,
  CANCELACIONES,
  CORTESIAS,
  NEGACIONES_SECAS,
  OPCIONES_MENU,
  SALUDOS,
  VACIAS,
  intencionesDisponibles,
  opcionesDisponibles,
  type MenuOpcion,
  type MenuOpciones,
} from "./intenciones.js";
import {
  PREFIJO_MENU,
  interpretarRespuestaEmision,
  interpretarRespuestaResolucion,
} from "./protocolo.js";

/** Tokens con contenido de un texto ya normalizado. */
function tokenizar(norm: string): string[] {
  return norm.split(" ").filter((t) => t !== "" && !VACIAS.has(t));
}

/**
 * Cuánto se parecen dos frases contando palabras con contenido.
 *
 * Devuelve la fracción de los tokens del SINÓNIMO que aparecen en el mensaje.
 * Se mide contra el sinónimo y no contra el mensaje a propósito: el usuario
 * agrega palabras ("¿me decís cómo viene el mes que viene?") y eso no debería
 * bajar el puntaje, pero omitir palabras del sinónimo sí.
 *
 * TOLERA TYPOS, y esa fue la corrección más grande del enrutador. La versión
 * anterior comparaba tokens por igualdad exacta, con el argumento —correcto en
 * sí mismo— de que un match aproximado equivocado es peor que ninguno. El
 * problema es que el costo del otro lado no se había medido: **"facturale a
 * perez 2 bolsas a 6500" caía en "no entendí"**, y con él nueve de cada diez
 * transcripciones de audio ("acele una fatura a peres", "kien me deve plata",
 * "komo biene el mes"). Alguien que dicta un audio no está escribiendo mal: está
 * usando el canal como se usa WhatsApp.
 *
 * La tolerancia va en el ÚLTIMO paso, después de exacto y de inclusión, así que
 * no le puede ganar a nada seguro; se limita a palabras de 4 letras o más con
 * largos parecidos; y el resultado sale marcado `aproximado` con su confianza,
 * que es lo que permite al agente repreguntar en vez de afirmar.
 *
 * Los tokens del sinónimo llegan YA CALCULADOS (ver `INDICE_SINONIMOS`): son los
 * mismos para todos los mensajes, y volver a normalizarlos acá era el grueso del
 * trabajo del enrutador.
 */
function puntajeTokens(tokensMensaje: readonly string[], tokensSin: readonly string[]): number {
  if (tokensSin.length === 0) return 0;
  const presentes = tokensSin.filter((ts) =>
    tokensMensaje.some((tm) => tokenCoincide(tm, ts)),
  ).length;
  return presentes / tokensSin.length;
}

/** Mínimo de coincidencia para aceptar un match aproximado. */
const UMBRAL_APROXIMADO = 0.6;

/**
 * Cuánto se puede parecer una palabra mal escrita a una palabra del catálogo.
 *
 * 0.75 de similitud de edición: "fatura"→"factura" (0.86), "deve"→"debe" (0.75),
 * "kien"→"quien" (0.6, NO entra por edición pero sí por el token vecino).
 * Bajarlo más empieza a unir palabras distintas — "cobrar" y "cobrar" contra
 * "comprar" están a una letra— y ese error es peor que no entender: manda al
 * usuario a la respuesta de otra pregunta.
 */
const UMBRAL_EDICION = 0.75;

/** Palabras de menos de esto no se comparan por edición: todo se parece a todo. */
const LARGO_MINIMO_EDICION = 4;

/**
 * ¿Este token del mensaje es "el mismo" que este token del sinónimo?
 *
 * Exacto primero (barato y seguro), y recién después por distancia de edición.
 * El orden importa: un match exacto nunca puede perder contra uno aproximado.
 */
function tokenCoincide(tokenMensaje: string, tokenSinonimo: string): boolean {
  if (tokenMensaje === tokenSinonimo) return true;
  if (tokenMensaje.length < LARGO_MINIMO_EDICION || tokenSinonimo.length < LARGO_MINIMO_EDICION) {
    return false;
  }
  // Una diferencia de largo grande no es un typo, es otra palabra.
  if (Math.abs(tokenMensaje.length - tokenSinonimo.length) > 2) return false;
  return similitudEdicion(tokenMensaje, tokenSinonimo) >= UMBRAL_EDICION;
}

/** Normaliza para comparar: minúsculas, sin tildes, sin signos, sin espacios de más. */
export function normalizarTexto(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Interpreta lo que mandó el usuario.
 *
 * Tres formas de elegir, todas soportadas: tocar la fila (llega el `id`),
 * escribir el número de la lista, o escribir con sus palabras. La tercera es la
 * que realmente se usa; las dos primeras son las que no fallan.
 */
export interface Interpretacion {
  /** La opción elegida, si se pudo determinar. */
  opcion: MenuOpcion | null;
  /**
   * Cómo se determinó.
   * - `saludo`: no eligió nada, mostrale el menú.
   * - `cortesia`: dijo "gracias"/"dale". No hay nada que buscar; se acusa recibo.
   * - `aproximado`: se parece a una opción, pero no es seguro. Mirá `confianza`.
   * - `ambiguo`: apunta a dos opciones. Mirá `candidatas` y preguntá cuál.
   * - `no_disponible`: la opción existe pero el server no la tiene habilitada.
   * - `emision_confirmada` / `emision_cancelada`: tocó ✅ o ✖️ en el preview.
   * - `flujo_emision`: es una respuesta de la emisión guiada, no del menú.
   * - `pedido_emision`: no matcheó ningún sinónimo, pero el texto ES un pedido
   *   de facturación con datos adentro. Ver `extraerPedido.ts`.
   */
  via:
    | "id"
    | "numero"
    | "sinonimo"
    | "aproximado"
    | "ambiguo"
    | "saludo"
    | "cortesia"
    | "no_disponible"
    | "emision_confirmada"
    | "emision_cancelada"
    | "flujo_emision"
    | "pedido_emision"
    | "resolucion_elegida"
    | "afirmacion"
    | "cancelacion"
    | "desconocido";
  /** true si corresponde mandar el menú. */
  mostrar_menu: boolean;
  /**
   * Las opciones entre las que hay que elegir cuando `via` es "ambiguo".
   * Siempre 2 o más, y como máximo 3: es lo que entra en botones de WhatsApp.
   */
  candidatas?: MenuOpcion[];
  /** El `confirmation_token` que venía adentro del botón ✅, ya sin el prefijo. */
  confirmation_token?: string;
  /**
   * Qué contestar cuando no hay tool que llamar. Existe para que NINGÚN camino
   * termine sin respuesta: un mensaje sin respuesta es el peor resultado
   * posible de este flujo, peor que una respuesta imperfecta.
   */
  respuesta_sugerida?: string;
  /** Coincidencia 0..1 cuando `via` es "aproximado". */
  confianza?: number;
  /**
   * Qué eligió el usuario en la desambiguación de `biller_resolver_nombre`.
   * `indice` es la posición dentro del array `candidatos` de ESA respuesta.
   */
  resolucion?: { tipo: "cliente" | "producto"; indice: number };
  /**
   * Cuando `via` es "pedido_emision": QUÉ CAMPOS trae el mensaje, por nombre.
   *
   * Nombres, nunca valores. El concepto de un ítem es texto libre y su clave
   * está en `CAMPOS_NO_CONFIABLES`: devolverlo acá lo haría salir envuelto en
   * ⟦dato-no-confiable⟧ por la barrera y volvería a entrar así al borrador.
   * Los VALORES los vuelve a leer `biller_emision_guiada`, del lado del server,
   * con el mismo extractor — que es lo que hace que el resultado no dependa de
   * que el modelo los haya copiado bien.
   */
  pedido_campos?: string[];
}

/**
 * Resultado de buscar el texto del usuario contra un conjunto de opciones.
 *
 * `empate` no es un fracaso: es información. Significa que el mensaje apunta a
 * dos cosas distintas y que hay exactamente una pregunta corta que lo resuelve.
 * Devolver las candidatas permite preguntarla; devolver `null` obligaba a
 * contestar el menú entero, que es hacerle releer diez opciones a alguien que
 * ya escribió lo que quería.
 */
type Busqueda =
  | { clase: "hit"; opcion: MenuOpcion; via: "sinonimo" | "aproximado"; confianza: number }
  | { clase: "empate"; opciones: MenuOpcion[] }
  | null;

/**
 * Una palabra suelta ("emitir", "clientes", "pdf") no se busca como subcadena:
 * tiene que aparecer como PALABRA en el mensaje.
 *
 * El caso que lo motivó no es teórico. El id que llega cuando el usuario toca
 * ✖️ Cancelar es "emitir:no", que contiene la cadena "emitir": el enrutador lo
 * leía como "quiere emitir" y reabría el flujo que el usuario acababa de
 * cancelar. Una frase de varias palabras sí se busca como subcadena — es
 * específica por sí misma, y ahí el riesgo no existe.
 */
function esPalabraSuelta(sinonimoNorm: string): boolean {
  return !sinonimoNorm.includes(" ");
}

/**
 * Un sinónimo que, sacándole las palabras vacías, se reduce a UNA sola palabra
 * no sirve para puntuar por tokens: matchea al 100% cualquier frase que la
 * contenga.
 *
 * Esto también salió de fallas reales y silenciosas: "me pagaron la factura
 * 1234" matcheaba "Mandar un comprobante" al 100% —porque "pasame la factura"
 * se reduce a "factura"— y el usuario recibía el PDF de una factura cuando
 * estaba avisando que se la habían pagado. Una respuesta segura de sí misma a
 * una pregunta que nadie hizo.
 *
 * Para la comparación por SUBCADENA esos sinónimos siguen valiendo: ahí se
 * compara la frase textual, no sus palabras sueltas.
 */
function esDebilPorTokens(sinonimo: SinonimoIndexado): boolean {
  return sinonimo.tokens.length < 2;
}

/**
 * Palabras que dan vuelta el sentido de lo que sigue.
 *
 * "no me pagaron todavía" contiene "me pagaron", que es sinónimo-frase de
 * "Registrar un cobro" — una tool de ESCRITURA. O sea: el usuario avisaba que
 * NO le habían pagado y el sistema lo llevaba a emitir un recibo, con seguridad
 * total y sin warning. La subcadena no alcanza como evidencia cuando adelante
 * hay un negador.
 */
const NEGADORES = new Set(["no", "nunca", "nadie", "todavia", "aun", "sin", "tampoco"]);

/**
 * ¿Hay un negador en las dos palabras anteriores a donde matcheó el sinónimo?
 *
 * Dos y no más: "no me pagaron" y "todavía no me pagaron" quedan adentro,
 * mientras que un "no" a diez palabras de distancia (otra oración) no invalida
 * nada.
 */
function negadoAntesDe(norm: string, sinonimo: string): boolean {
  const pos = norm.indexOf(sinonimo);
  if (pos <= 0) return false;
  const previas = norm.slice(0, pos).trim().split(" ").filter((t) => t !== "");
  return previas.slice(-2).some((t) => NEGADORES.has(t));
}

/**
 * Un sinónimo del catálogo, ya masticado.
 *
 * Las tres cosas que la búsqueda necesita saber de un sinónimo —cómo se escribe
 * normalizado, si es una palabra suelta, y en qué tokens con contenido se
 * descompone— no dependen del mensaje: dependen del catálogo, que es constante.
 */
interface SinonimoIndexado {
  /** El sinónimo pasado por `normalizarTexto`. */
  readonly norm: string;
  /** `esPalabraSuelta(norm)`: se busca como palabra, no como subcadena. */
  readonly suelta: boolean;
  /** `tokenizar(norm)`. Solo se usa para los que no son débiles por tokens. */
  readonly tokens: readonly string[];
}

interface OpcionIndexada {
  /** Todos los sinónimos, EN EL ORDEN DEL CATÁLOGO. El orden es conducta. */
  readonly todos: readonly SinonimoIndexado[];
  /** Los que sirven para puntuar por tokens. Ver `esDebilPorTokens`. */
  readonly porTokens: readonly SinonimoIndexado[];
}

/**
 * NORMALIZAR LOS ~400 SINÓNIMOS UNA VEZ, AL CARGAR EL MÓDULO.
 *
 * `buscarPorTexto` los recorría tres veces por llamada —exacto, inclusión,
 * tokens— y `puntajeTokens` volvía a normalizar y tokenizar cada sinónimo por
 * cada mensaje. Como `interpretarMensaje` llama a `buscarPorTexto` DOS veces
 * (contra lo disponible y contra lo bloqueado), un solo "hola" pagaba varios
 * miles de `normalize("NFD")` sobre cadenas que nunca cambian.
 *
 * El catálogo es `readonly` y no se arma en runtime, así que el resultado es el
 * mismo siempre: precomputarlo no cambia ninguna decisión, solo deja de
 * repetirla. El orden dentro de `todos` es el del catálogo, que es lo que hace
 * que el desempate por longitud de la inclusión siga cayendo igual.
 */
function indexarOpcion(o: MenuOpcion): OpcionIndexada {
  const todos: SinonimoIndexado[] = o.sinonimos.map((s) => {
    const norm = normalizarTexto(s);
    return { norm, suelta: esPalabraSuelta(norm), tokens: tokenizar(norm) };
  });
  return { todos, porTokens: todos.filter((s) => !esDebilPorTokens(s)) };
}

const INDICE_SINONIMOS = new Map<string, OpcionIndexada>(
  OPCIONES_MENU.map((o) => [o.id, indexarOpcion(o)]),
);

/** El índice de una opción. Lo calcula si viniera una que no está en el catálogo. */
function indiceDe(o: MenuOpcion): OpcionIndexada {
  const yaEsta = INDICE_SINONIMOS.get(o.id);
  if (yaEsta !== undefined) return yaEsta;
  const nuevo = indexarOpcion(o);
  INDICE_SINONIMOS.set(o.id, nuevo);
  return nuevo;
}

/** Busca en un conjunto de opciones por sinónimo exacto, inclusión y tokens. */
function buscarPorTexto(norm: string, candidatas: readonly MenuOpcion[]): Busqueda {
  const tokens = tokenizar(norm);

  // a. Igualdad exacta con un sinónimo: lo más barato y lo más confiable.
  for (const o of candidatas) {
    if (indiceDe(o).todos.some((s) => s.norm === norm)) {
      return { clase: "hit", opcion: o, via: "sinonimo", confianza: 1 };
    }
  }

  // b. Inclusión, del sinónimo más largo al más corto: "nota de credito" tiene
  //    que ganarle a "credito" si ambos existen.
  //
  //    La inclusión es por PALABRA COMPLETA para los sinónimos de una palabra.
  //    Sin eso, el id "emitir:no" —lo que llega cuando el usuario toca ✖️
  //    Cancelar— contenía la cadena "emitir" y el enrutador lo leía como
  //    "quiere emitir": cancelar reabría el flujo que se acababa de cancelar.
  const inclusiones = candidatas
    .flatMap((o) => indiceDe(o).todos.map((s) => ({ opcion: o, sinonimo: s })))
    .filter((c) => {
      if (c.sinonimo.norm === "") return false;
      const matchea = c.sinonimo.suelta
        ? tokens.includes(c.sinonimo.norm)
        : norm.includes(c.sinonimo.norm);
      // Un negador adelante da vuelta el sentido: ver `negadoAntesDe`.
      return matchea && !negadoAntesDe(norm, c.sinonimo.norm);
    })
    .sort((a, b) => b.sinonimo.norm.length - a.sinonimo.norm.length);

  const mejorInclusion = inclusiones[0];
  if (mejorInclusion !== undefined) {
    // Cuando lo mejor que matcheó es una palabra suelta, la longitud NO es
    // evidencia: "qué clientes están en deuda" toca "clientes" y "deuda", y que
    // una tenga tres letras más no dice nada sobre qué quiso preguntar. Dos
    // palabras genéricas apuntando a intenciones distintas es la definición de
    // ambigüedad, y se pregunta.
    //
    // Si lo mejor es una FRASE, gana la más larga y no hay empate que resolver:
    // "nota de credito" tiene que ganarle a "credito", que es justamente el
    // caso para el que existe el orden por longitud.
    if (mejorInclusion.sinonimo.suelta) {
      const sueltas = dedupOpciones(
        inclusiones.filter((c) => c.sinonimo.suelta).map((c) => c.opcion),
      );
      if (sueltas.length > 1) return { clase: "empate", opciones: sueltas };
    }

    // DOS FRASES DE OPCIONES DISTINTAS TAMBIÉN SON UN EMPATE.
    //
    // El orden por longitud existe para el caso ANIDADO ("nota de credito" tiene
    // que ganarle a "credito"), y ahí sigue valiendo. Pero cuando las dos frases
    // son independientes, la longitud no decide nada: "cuánto compré y cuánto
    // vendí" se resolvía por UN carácter de diferencia entre los dos sinónimos,
    // en silencio y con confianza 1. Son dos preguntas en un mensaje, y eso se
    // pregunta.
    const independientes = dedupOpciones(
      inclusiones
        .filter(
          (c) =>
            !c.sinonimo.suelta &&
            !mejorInclusion.sinonimo.norm.includes(c.sinonimo.norm) &&
            !c.sinonimo.norm.includes(mejorInclusion.sinonimo.norm),
        )
        .map((c) => c.opcion)
        .filter((o) => o.id !== mejorInclusion.opcion.id),
    );
    if (independientes.length > 0) {
      return { clase: "empate", opciones: [mejorInclusion.opcion, ...independientes] };
    }

    return { clase: "hit", opcion: mejorInclusion.opcion, via: "sinonimo", confianza: 1 };
  }

  // c. Coincidencia por palabras con contenido. Esto es lo que hace que
  //    "¿cómo dieron el mes?" llegue a "¿cómo viene el mes?" y que "¿qué MÁS
  //    podés hacer?" llegue a la ayuda: dos preguntas que antes caían en
  //    "no entendí" por una palabra de diferencia.
  if (tokens.length === 0) return null;

  const puntajes = candidatas
    .map((o) => ({
      opcion: o,
      puntaje: Math.max(0, ...indiceDe(o).porTokens.map((s) => puntajeTokens(tokens, s.tokens))),
    }))
    .sort((a, b) => b.puntaje - a.puntaje);

  const mejor = puntajes[0];
  if (mejor === undefined || mejor.puntaje < UMBRAL_APROXIMADO) return null;

  // Empate entre dos opciones distintas = no se sabe. Antes esto devolvía el
  // menú entero; ahora devuelve las candidatas, que es lo que hace falta para
  // preguntar "¿cuál de estas dos?" en vez de empezar de cero.
  const empatados = puntajes.filter((p) => p.puntaje === mejor.puntaje).map((p) => p.opcion);
  if (empatados.length > 1) return { clase: "empate", opciones: dedupOpciones(empatados) };

  return { clase: "hit", opcion: mejor.opcion, via: "aproximado", confianza: mejor.puntaje };
}

function dedupOpciones(opciones: readonly MenuOpcion[]): MenuOpcion[] {
  const vistos = new Set<string>();
  return opciones.filter((o) => (vistos.has(o.id) ? false : (vistos.add(o.id), true)));
}

export function interpretarMensaje(raw: string, opciones: MenuOpciones = {}): Interpretacion {
  const disponibles = opcionesDisponibles(opciones);
  const intenciones = intencionesDisponibles(opciones);
  const texto = raw.trim();

  // 0. Los ids que emitimos NOSOTROS en otros mensajes.
  //
  //    Esto va primero y sin pasar por ninguna heurística. El enrutador es el
  //    punto de entrada de TODO lo que escribe el usuario, incluidos los
  //    botones de la emisión guiada y los del preview — que llegan como texto,
  //    igual que "hola". Antes caían en el matching por palabras, con dos
  //    consecuencias feas y silenciosas: "emitir:no" (tocar ✖️ Cancelar) se
  //    leía como "quiere emitir" y reabría el flujo recién cancelado, y
  //    "emision:iva:3" no matcheaba nada y devolvía el menú, tirando a la
  //    basura una conversación de seis mensajes.
  const respuestaEmision = interpretarRespuestaEmision(texto);
  if (respuestaEmision.accion === "emitir") {
    return {
      opcion: null,
      via: "emision_confirmada",
      mostrar_menu: false,
      confirmation_token: respuestaEmision.token,
      respuesta_sugerida: "Dale, lo emito.",
    };
  }
  if (respuestaEmision.accion === "cancelar") {
    return {
      opcion: null,
      via: "emision_cancelada",
      mostrar_menu: false,
      respuesta_sugerida:
        "Listo, no emití nada. El comprobante quedó sin emitir. Cuando quieras lo retomamos.",
    };
  }
  const resolucion = interpretarRespuestaResolucion(texto);
  if (resolucion !== null) {
    return {
      opcion: null,
      via: "resolucion_elegida",
      mostrar_menu: false,
      resolucion,
      respuesta_sugerida: "Dale, sigo con ese.",
    };
  }
  if (texto.startsWith(PREFIJO_PASO)) {
    return {
      opcion: OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`) ?? null,
      via: "flujo_emision",
      mostrar_menu: false,
    };
  }

  // 1. Id exacto: viene de que el usuario tocó una fila O un botón.
  //
  //    Se busca contra `intenciones` (el catálogo) y NO contra `disponibles`
  //    (la vidriera). La distinción vidriera/catálogo aplica a lo que se MUESTRA
  //    y a la numeración; un id que VUELVE es catálogo por definición: se lo
  //    mandamos nosotros.
  //
  //    Con `disponibles` acá pasaba esto, y es peor que un bug: "dar de alta"
  //    devuelve ambiguo entre dos intenciones ocultas, `construirDesambiguacion`
  //    manda los dos botones, el usuario toca uno... y el paso 1b concluía "esa
  //    opción no está habilitada, el server está en modo consulta" — con el
  //    server en write_enabled. Le mandamos un botón y cuando lo toca le
  //    mentimos.
  const porId = intenciones.find((o) => o.id === texto);
  if (porId !== undefined) return { opcion: porId, via: "id", mostrar_menu: false };

  // 1b. Un id que existe en el catálogo pero NO está habilitado. Sin esta rama
  //     caía en "no entendí" y el usuario recibía el menú de vuelta sin que
  //     nadie le dijera nunca por qué la opción que tocó no hizo nada.
  const porIdNoDisponible = OPCIONES_MENU.find((o) => o.id === texto);
  if (porIdNoDisponible !== undefined) {
    return {
      opcion: porIdNoDisponible,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(porIdNoDisponible),
    };
  }

  const norm = normalizarTexto(texto);
  if (norm === "") return { opcion: null, via: "desconocido", mostrar_menu: true };

  // 2. Número de la lista tal como se le mostró.
  //
  //    SALVO en medio de la emisión: ahí "3" contesta "¿cuántos?" y no elige la
  //    fila 3 del menú. El flujo tiene prioridad sobre la numeración porque la
  //    pregunta abierta es del flujo. (Se saltea el paso entero: el texto sigue
  //    hasta el fallback de flujo del final.)
  //
  //    Se acepta con palabras vacías alrededor: "la 4", "opción 3", "el 2",
  //    "2 por favor". Antes el regex corría sobre `norm` COMPLETO, así que las
  //    cuatro caían en "no entendí" y devolvían el menú a alguien que ya había
  //    elegido. Se exige que quede UN SOLO token con contenido, así "3 chapas" o
  //    "anular la 456" no se tragan como elección de menú.
  const tokensNum = tokenizar(norm);
  if (opciones.en_flujo !== true && tokensNum.length === 1 && /^\d{1,2}$/.test(tokensNum[0]!)) {
    const idx = Number(tokensNum[0]!) - 1;
    const porNumero = disponibles[idx];
    if (porNumero !== undefined) return { opcion: porNumero, via: "numero", mostrar_menu: false };
    return {
      opcion: null,
      via: "desconocido",
      mostrar_menu: true,
      respuesta_sugerida:
        `Ese número no está en la lista: hay ${disponibles.length} opciones. Te la mando de nuevo.`,
    };
  }

  // 2b. Afirmación o cancelación escritas.
  //
  //     Van ANTES de los sinónimos: "dale" y "pará" no significan nada para el
  //     menú, pero lo significan todo para el paso que estaba pendiente.
  if (AFIRMACIONES.includes(norm) || ASENTIMIENTOS.includes(norm)) {
    return {
      opcion: null,
      via: "afirmacion",
      mostrar_menu: false,
      respuesta_sugerida:
        "El usuario dijo que sí. Aplicalo al paso que estabas esperando —confirmar la emisión, " +
        "elegir un candidato, cerrar los ítems— y seguí. NO mandes el menú: no está eligiendo una " +
        "opción, está contestando tu última pregunta. Si no había ninguna pregunta abierta, es un " +
        "\"dale\" de cortesía: acusá recibo corto y listo, no preguntes nada. OJO: si el paso " +
        "pendiente era emitir, necesitás " +
        "el confirmation_token del dry-run; un 'sí' escrito no reemplaza al token.",
    };
  }
  if (CANCELACIONES.includes(norm) || NEGACIONES_SECAS.includes(norm)) {
    return {
      opcion: null,
      via: "cancelacion",
      mostrar_menu: false,
      respuesta_sugerida:
        "El usuario dijo que no. NO emitas ni ejecutes nada de lo que estaba pendiente; si había " +
        "algo, confirmale en una línea que quedó sin hacer. Si no había nada pendiente, es un " +
        "\"no\" a tu última pregunta: tomalo como respuesta y seguí. No mandes el menú: decir que " +
        "no, no es pedir opciones.",
    };
  }

  // 3. Saludo o pedido explícito de menú. Va ANTES de los sinónimos: "menu" no
  //    debe matchear "¿qué más podés hacer?" por contener la palabra opciones.
  if (SALUDOS.includes(norm)) return { opcion: null, via: "saludo", mostrar_menu: true };

  // 4. Cortesía: no hay nada que buscar y el menú sería una respuesta grosera.
  if (CORTESIAS.includes(norm)) {
    return {
      opcion: null,
      via: "cortesia",
      mostrar_menu: false,
      respuesta_sugerida: "Dale, cualquier cosa escribime. Si querés ver las opciones, mandá \"menú\".",
    };
  }

  // 5. Palabras del usuario, contra TODO lo que se puede contestar (filas del
  //    menú + intenciones ocultas) y contra lo que está apagado.
  //
  //    Las dos búsquedas se comparan por CALIDAD, no por orden. Antes ganaba
  //    siempre lo disponible, y por eso "necesito hacer una boleta" en modo
  //    lectura terminaba en "¿Qué más podés hacer?" —un match flojo pero
  //    disponible— en vez de decir la verdad: que en modo consulta no se emite.
  //    Un parecido lejano no le puede ganar a una coincidencia exacta solo por
  //    estar habilitada.
  const noDisponibles = OPCIONES_MENU.filter((o) => !intenciones.includes(o));
  const hit = buscarPorTexto(norm, intenciones);
  const hitBloqueado = noDisponibles.length === 0 ? null : buscarPorTexto(norm, noDisponibles);

  if (hitBloqueado !== null && calidad(hitBloqueado) > calidad(hit)) {
    const opcion = hitBloqueado.clase === "hit" ? hitBloqueado.opcion : hitBloqueado.opciones[0]!;
    return {
      opcion,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(opcion),
    };
  }

  if (hit !== null) {
    if (hit.clase === "empate") {
      // Dos intenciones distintas, una pregunta corta que las separa. Ver
      // `construirDesambiguacion`.
      const candidatas = hit.opciones.slice(0, 3);
      return {
        opcion: null,
        via: "ambiguo",
        mostrar_menu: false,
        candidatas,
        respuesta_sugerida: `¿Cuál de estas necesitás: ${candidatas
          .map((o) => `"${o.titulo}"`)
          .join(" o ")}?`,
      };
    }
    return {
      opcion: hit.opcion,
      via: hit.via,
      mostrar_menu: false,
      ...(hit.via === "aproximado" ? { confianza: hit.confianza } : {}),
    };
  }

  // 6. ¿Pedía algo que existe pero está deshabilitado? Decirlo es la diferencia
  //    entre "no se puede acá" y el silencio.
  if (hitBloqueado !== null) {
    const opcion = hitBloqueado.clase === "hit" ? hitBloqueado.opcion : hitBloqueado.opciones[0]!;
    return {
      opcion,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(opcion),
    };
  }

  // 6b. En medio de la emisión, lo que no matcheó NADA es una respuesta del
  //     flujo, no un desconocido. "pará, eran 3 no 2", "que sean de 25kg",
  //     "el rut es 21..." — el catálogo no las conoce y no tiene por qué:
  //     la pregunta abierta es del flujo, y el que sabe aplicarlas es
  //     biller_emision_guiada con el borrador adelante. Devolver el menú acá
  //     era tirar a la basura una carga a medio hacer.
  if (opciones.en_flujo === true) {
    return {
      opcion: OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`) ?? null,
      via: "flujo_emision",
      mostrar_menu: false,
    };
  }

  // 6c. ¿ES UN PEDIDO DE FACTURACIÓN AUNQUE NO SE PAREZCA A NINGÚN SINÓNIMO?
  //
  //     "perez 2 bolsas portland 6500" no matchea nada del catálogo y es una
  //     orden de facturar perfectamente clara. El catálogo compara contra
  //     FRASES; un pedido real trae un cliente, una cantidad y un precio, y eso
  //     no se puede enumerar. `extraerPedido.ts` lo lee con una gramática, y
  //     con dos campos adentro ya no hay ambigüedad sobre qué se está pidiendo.
  //
  //     VA ÚLTIMO Y NO PRIMERO, a propósito: cualquier coincidencia del
  //     catálogo —exacta, por inclusión o por parecido— le gana, igual que le
  //     gana la rama del flujo. El extractor no compite con el enrutador; se
  //     queda con lo que el enrutador iba a tirar a "no entendí".
  const pedido = extraerPedidoEmision(texto);
  if (esPedidoDeEmision(pedido)) {
    const emitir = OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`);
    if (emitir !== undefined) {
      // En modo consulta la emisión no existe, y decirlo es mejor que abrir un
      // flujo que no puede terminar. Misma regla que el resto del enrutador.
      if (!intenciones.includes(emitir)) {
        return {
          opcion: emitir,
          via: "no_disponible",
          mostrar_menu: false,
          respuesta_sugerida: motivoNoDisponible(emitir),
        };
      }
      return {
        opcion: emitir,
        via: "pedido_emision",
        mostrar_menu: false,
        pedido_campos: pedido.campos,
      };
    }
  }

  // 7. No se entendió. El menú es mejor respuesta que "no te entendí" — pero
  //    NO es lo mismo que "no se puede contestar": la tool avisa al agente que
  //    una pregunta concreta de facturación se contesta igual.
  return { opcion: null, via: "desconocido", mostrar_menu: true };
}

/**
 * Cuán buena es una búsqueda, para poder comparar dos conjuntos de candidatas.
 * Exacto/inclusión (2) > empate (1.5) > parecido (1) > nada (0).
 */
function calidad(b: Busqueda): number {
  if (b === null) return 0;
  if (b.clase === "empate") return 1.5;
  return b.via === "sinonimo" ? 2 : 1;
}

/** Por qué una opción del catálogo no está habilitada, en castellano. */
/**
 * POR QUÉ ESTE TEXTO LE HABLA AL USUARIO Y NO AL AGENTE.
 *
 * `respuesta_sugerida` tiene dos destinos, y solo uno tiene un modelo en el
 * medio: la tool (`biller_menu_whatsapp`) se la da al agente para que redacte,
 * pero el webhook la manda TAL CUAL por WhatsApp cuando la vía es
 * autorespondible — y `no_disponible` lo es. La versión anterior decía
 * "BILLER_CAPABILITY_MODE=read_only" y "Decile al usuario eso": el dueño del
 * almacén recibía el nombre de una variable de entorno y una orden dirigida a
 * otro. La regla que queda: toda `respuesta_sugerida` de una vía
 * autorespondible se escribe para el usuario final; el encuadre para el agente
 * vive en `menuWhatsapp.ts`, que es el único lugar donde hay un agente leyendo.
 */
function motivoNoDisponible(opcion: MenuOpcion): string {
  if (opcion.requiereEscritura === true) {
    return (
      `Por ahora este canal es solo de consulta: puedo mostrarte todo lo que ya está emitido ` +
      `—ventas, deudas, vencimientos— pero no ${opcion.titulo.toLowerCase()}. Para habilitar esa ` +
      "parte hay que activarla en el servidor; habla con quien te lo configuró."
    );
  }
  return `"${opcion.titulo}" no está habilitada en este canal. Escribime "menú" y te muestro lo que sí puedo.`;
}
