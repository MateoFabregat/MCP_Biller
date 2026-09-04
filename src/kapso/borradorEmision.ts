// =============================================================================
// El borrador de emisión: qué ENTRA al estado y qué SALE hacia el CFE.
//
// POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO ES `emision.ts`
//
// `emision.ts` contesta una sola pregunta —"dado lo que ya se sabe, ¿qué
// sigue?"— y la contesta PURA: los dos datos del mundo que necesita entran por
// parámetro, y por eso el test de los 64 estados parciales significa algo. Este
// módulo contesta las otras dos, que son de otra familia:
//
//   · Cómo se LLENA el borrador. Los importes que escribió una persona
//     ("6.500"), el dato que llega sin decir a qué ítem pertenece (el botón de
//     cantidad), y lo que el extractor sacó del texto y hay que volcar sin
//     pisar nada de lo explícito (la jerarquía de la regla 4 del handbook).
//   · Qué CUERPO produce. El payload parcial con la forma exacta que espera
//     `biller_emitir_comprobante`, incluida la decisión —fiscal— de qué campos
//     NO pueden volver por el canal del modelo.
//
// Las dos son decisiones sobre QUÉ VA EN EL COMPROBANTE, o sea reglas fiscales,
// y estaban adentro de `tools/emisionGuiada.ts`. Ahí eran INALCANZABLES desde
// cualquier otra superficie: el día que la emisión entre por el webhook, por un
// cierre de mes o por una segunda tool, había que reimplementarlas —o importar
// una tool desde otra tool, que es el error tabulado del handbook—. Es el mismo
// caso de `correrCuentaCorriente` antes de mudarse a `services/`.
//
// Y NO SE FUSIONÓ CON `emision.ts` por una razón de dependencias, no de tamaño:
// `rellenarDesdePedido` necesita `PedidoEmision`, o sea `extraerPedido.ts`.
// Metiéndolo ahí, la máquina de pasos —que hoy no depende de nada que adivine—
// pasaría a depender de la gramática que adivina. `kapso/` tiene una sola
// dirección de dependencias y conviene que siga teniéndola: este archivo
// importa `emision.ts` y `extraerPedido.ts`, y ninguno de los dos lo importa a
// él (ver ARQUITECTURA §2.1).
//
// LO QUE ESTE MÓDULO NO HACE: no toca la red, no lee la config y no arma un
// solo mensaje de WhatsApp. Todo lo de acá se puede testear con un objeto.
// =============================================================================

import {
  clasificarDocumento,
  indiceItemEnCurso,
  siguientePaso,
  itemPuedeViajar,
  itemsVigentes,
  type EstadoEmision,
  type ItemEnCurso,
} from "./emision.js";
import { esPedidoDeEmision, type PedidoEmision } from "./extraerPedido.js";
import { formatearUy, montoConSigno, parsearCantidad, parsearImporte } from "../services/importe.js";

/**
 * Muestra un precio que quedó sin línea en el mismo formato que el resto del
 * flujo. Los strings vienen del texto del usuario y se vuelven a leer acá para
 * que "6500" no termine en el aviso como un número crudo; los números ya
 * normalizados conservan exactamente el mismo camino de formato.
 *
 * Si el texto no es legible, se conserva tal cual: el aviso no debe inventar
 * una lectura ni esconder el dato que todavía hay que preguntar.
 */
export function formatearPrecioAviso(precio: number | string, moneda?: string): string {
  const valor = typeof precio === "number" ? precio : parsearImporte(precio).valor;
  return valor === null ? String(precio) : montoConSigno(moneda, valor);
}

/**
 * Aplica un dato al ítem que se está cargando.
 *
 * Existe porque los botones de un paso de ítem —la cantidad, por ahora— llegan
 * sin decir a QUÉ ítem pertenecen: el id de un botón de WhatsApp no lleva
 * índice. Lo único que se puede hacer es aplicarlo al ítem sobre el que se está
 * preguntando, y cuál es ese lo contesta `indiceItemEnCurso` — la MISMA
 * función con la que `siguientePaso` elige qué preguntar.
 *
 * Antes decía "el último", igual que `siguientePaso` antes de su arreglo, y era
 * el mismo modo de falla más barato: con `[{A sin precio}, {B completo}]` el
 * flujo pregunta por A y la cantidad que contesta el usuario aterrizaba en B.
 * Una cantidad en la línea equivocada de un CFE es un total equivocado.
 *
 * Con todos los ítems completos sigue siendo el último (es el que se acaba de
 * cargar), y si no hay ninguno, se crea.
 */
export function aplicarAlItemEnCurso(
  estado: EstadoEmision,
  aplicar: (item: ItemEnCurso) => void,
): void {
  const items = [...(estado.items ?? [])];
  if (items.length === 0) {
    const item: ItemEnCurso = {};
    aplicar(item);
    estado.items = [item];
    return;
  }
  // SE MIDE SOBRE LA MISMA LISTA QUE MIRA `siguientePaso`, y no sobre
  // `estado.items` crudo: cerrados los ítems, la cola sin nada no se pregunta,
  // así que tampoco puede recibir la respuesta. Con `[{A, precio:0}, {}]`
  // cerrados, el flujo pregunta por A y la cantidad aterrizaba en el fantasma
  // del final. `itemsVigentes` es un PREFIJO, así que sus índices son los de
  // `estado.items` sin traducción.
  const vigentes = itemsVigentes(estado);
  const incompleto = vigentes.length === 0 ? -1 : indiceItemEnCurso(vigentes);
  const destino =
    incompleto !== -1
      ? incompleto
      : vigentes.length === 0
        ? items.length - 1
        : vigentes.length - 1;
  const item = { ...items[destino]! };
  aplicar(item);
  items[destino] = item;
  estado.items = items;
}

/**
 * Los ítems tal como pueden llegar de afuera: los importes, todavía en texto.
 *
 * `precio` y `cantidad` aceptan string además de número a propósito, y el
 * porqué está escrito en el schema de la tool: si el tipo fuera solo `number`,
 * el que convierte "6.500" en un número es el modelo, y `Number("6.500")` es
 * 6,5. Este es el tipo del otro lado de esa decisión.
 */
export interface ItemCrudo {
  concepto?: string;
  cantidad?: number | string;
  precio?: number | string;
  indicador_facturacion?: number;
}

/**
 * Convierte los `precio`/`cantidad` que llegaron como texto a números.
 *
 * Un ítem cuyo precio no se puede leer queda SIN precio, no con un precio
 * inventado: el flujo vuelve a preguntarlo, que es exactamente lo que hay que
 * hacer. Devolver 0, o `NaN`, o el número más parecido, sería tapar el problema
 * en el único lugar donde todavía se puede resolver preguntando.
 */
export function normalizarItems(items: ReadonlyArray<ItemCrudo> | undefined): {
  items: ItemEnCurso[] | undefined;
  warnings: string[];
} {
  if (items === undefined) return { items: undefined, warnings: [] };
  const warnings: string[] = [];

  const out = items.map((item, i) => {
    const ordinal = items.length === 1 ? "" : ` (ítem ${i + 1})`;
    const salida: ItemEnCurso = {
      ...(item.concepto !== undefined ? { concepto: item.concepto } : {}),
      ...(item.indicador_facturacion !== undefined
        ? { indicador_facturacion: item.indicador_facturacion }
        : {}),
    };

    // El flag va SIEMPRE que se fije un precio, incluso en false, y por el
    // mismo motivo por el que `montos_brutos` va siempre al borrador: el
    // guardado se fusiona por campo y `undefined` no pisa (ver `fusionarEstado`).
    // Sin el false explícito, un precio corregido a mano ("son 6500") dejaría
    // viva para siempre la advertencia del "6.50" anterior.
    if (typeof item.precio === "number") {
      salida.precio = item.precio;
      salida.precio_ambiguo = false;
    } else if (typeof item.precio === "string") {
      const leido = parsearImporte(item.precio);
      if (leido.valor === null) {
        warnings.push(`No se pudo leer el precio "${item.precio}"${ordinal}: ${leido.detalle}`);
      } else {
        salida.precio = leido.valor;
        // La marca se GUARDA además de avisarse: un warning lo lee el modelo en
        // esta llamada y se pierde, y la confirmación ocurre dos o tres mensajes
        // después. Ver `ItemEnCurso.precio_ambiguo`.
        salida.precio_ambiguo = leido.ambiguo;
        if (leido.ambiguo) {
          warnings.push(
            `⚠️ El precio "${item.precio}"${ordinal} se puede leer de dos formas. ${leido.detalle} ` +
              `Preguntale al usuario "¿$${formatearUy(leido.valor)} por unidad?" y esperá que lo ` +
              "confirme ANTES de emitir.",
          );
        }
      }
    }

    if (typeof item.cantidad === "number") {
      salida.cantidad = item.cantidad;
    } else if (typeof item.cantidad === "string") {
      const leida = parsearCantidad(item.cantidad);
      if (leida.valor === null) {
        warnings.push(`No se pudo leer la cantidad "${item.cantidad}"${ordinal}: ${leida.detalle}`);
      } else {
        salida.cantidad = leida.valor;
        // Misma regla que el precio: si el texto admite otra lectura, el
        // usuario tiene que confirmarla ANTES, no descubrirla en el CFE. La
        // cantidad multiplica al precio, así que el error tiene el mismo
        // tamaño.
        if (leida.ambiguo === true) {
          warnings.push(
            `⚠️ La cantidad "${item.cantidad}"${ordinal} se puede leer de dos formas. ${leida.detalle} ` +
              `Preguntale al usuario "¿${formatearUy(leida.valor)} unidades?" y esperá que lo ` +
              "confirme ANTES de emitir.",
          );
        }
      }
    }

    return salida;
  });

  return { items: out, warnings };
}

/**
 * Vuelca lo que el extractor leyó del texto SOBRE LOS HUECOS del estado.
 *
 * LA REGLA, Y NO TIENE EXCEPCIONES: un campo que ya tiene valor no se toca.
 * Lo que mandó el agente es un dato explícito de la conversación; lo de acá es
 * una inferencia gramatical sobre el mismo texto. Cuando los dos dicen algo,
 * gana el explícito — y cuando el explícito falta, esto es la diferencia entre
 * una pregunta menos y una pregunta más.
 *
 * DOS NIVELES DE CONFIANZA, Y POR ESO DOS TRATOS DISTINTOS:
 *
 *   · Las SEÑALES (forma de pago, criterio de IVA) salen de marcas inequívocas
 *     —"a crédito", "más IVA"— y valen aunque el mensaje no sea un pedido
 *     entero: "sin IVA" contestando una pregunta del flujo es exactamente eso.
 *   · El CLIENTE y los ÍTEMS salen de una gramática posicional, y solo se
 *     aplican cuando el mensaje ES un pedido (`esPedidoDeEmision`). Sin ese
 *     filtro, "pará, eran 3 no 2" en medio de una carga dejaba un cliente
 *     llamado "eran" en el borrador de un CFE.
 *
 * LA MONEDA NO SE FIJA ACÁ, A PROPÓSITO. El extractor la lee ("en dólares") y
 * esta función la convierte en `moneda_dudosa`, o sea en una PREGUNTA. Es el
 * único campo donde equivocarse cuesta 40x —una factura en pesos por un precio
 * cotizado en dólares sale perfectamente bien formada ante DGI— y un toque de
 * más es barato al lado de eso. Ver `moneda_dudosa` en `emision.ts`.
 */
/**
 * ¿Estas dos descripciones hablan de la misma línea?
 *
 * Se compara por TOKENS y no por igualdad: "Bolsa de portland" y "bolsas de
 * portland" son lo mismo dicho dos veces —el agente escribe una y el usuario la
 * otra— y ahí llenar el hueco es exactamente lo que hay que hacer. Se ignoran
 * las palabras cortas ("de", "el") y la "s" final, que es todo el plural que
 * hace falta acá.
 *
 * PERO NO ALCANZA CON QUE COMPARTAN UNA PALABRA, y ese fue el primer intento:
 * con el ítem en curso "Agua tónica" sin precio y el mensaje "3 agua mineral a
 * 60", el token "agua" declaraba que eran la misma línea y el CFE terminaba
 * imprimiendo "3 × Agua tónica $60" — la línea que el usuario quería agregar no
 * existía nunca. En un almacén uruguayo ese patrón es la norma: agua
 * mineral/agua tónica, coca común/coca zero, queso magro/queso colonia, vino
 * tinto/vino blanco. La palabra compartida es la CATEGORÍA; la que las
 * distingue es justamente la que sobra.
 *
 * Por eso la condición es de SUBCONJUNTO: una de las dos no puede tener ninguna
 * palabra propia. "bolsa portland" ⊆ "bolsa portland" (misma línea), "harina" ⊆
 * "harina 000" (misma línea), pero "agua tónica" y "agua mineral" tienen cada
 * una la suya y son dos productos distintos.
 *
 * Ante la duda dice que SÍ: la respuesta negativa frena un volcado, y frenar de
 * más deja al usuario repitiendo un dato que ya dijo. Por eso una descripción
 * sin palabras largas ("2 kg") no se usa para separar nada.
 */
function hablanDeLaMismaLinea(a: string, b: string): boolean {
  const tokens = (texto: string): Set<string> =>
    new Set(
      texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3)
        .map((t) => (t.endsWith("s") ? t.slice(0, -1) : t)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return true;
  const contiene = (grande: Set<string>, chico: Set<string>): boolean => {
    for (const t of chico) if (!grande.has(t)) return false;
    return true;
  };
  return contiene(ta, tb) || contiene(tb, ta);
}

export function rellenarDesdePedido(
  estado: EstadoEmision,
  pedido: PedidoEmision,
): { puestos: string[]; avisos: string[] } {
  const puestos: string[] = [];
  const avisos: string[] = [];

  if (estado.montos_brutos === undefined && pedido.montos_brutos !== undefined) {
    estado.montos_brutos = pedido.montos_brutos;
    puestos.push("montos_brutos");
  }
  if (estado.forma_pago === undefined && pedido.forma_pago !== undefined) {
    estado.forma_pago = pedido.forma_pago;
    puestos.push("forma_pago");
  }
  if (pedido.moneda === "USD" && (estado.moneda ?? "") === "") {
    estado.moneda_dudosa = true;
  }

  if (!esPedidoDeEmision(pedido)) return { puestos, avisos };

  // DÓNDE EMPIEZA A VOLCARSE LO QUE SE LEYÓ, Y POR QUÉ NO ES SIEMPRE CERO.
  //
  // Los ítems del pedido vienen indexados por el MENSAJE que se acaba de
  // parsear, no por el comprobante. Volcarlos desde 0 le pega la respuesta de
  // ahora a la primera línea: con `[{Café,1200}, {precio:250}]` y el usuario
  // contestando "eran 2 medialunas", el 2 aterrizaba como cantidad DEL CAFÉ
  // —que pasaba a $2.400—, las medialunas no se cargaban nunca y la pregunta se
  // repetía para siempre. Y como esto solo llena huecos, no fallaba: no había
  // 422, ni warning, ni forma de notarlo salvo leyendo el total.
  //
  // El ancla es el ítem EN CURSO, que es sobre el que el flujo está preguntando
  // y por lo tanto sobre el que el usuario está contestando. `itemsVigentes` es
  // un prefijo, así que su índice es directamente el de `estado.items`.
  const items: ItemEnCurso[] = [...(estado.items ?? [])];
  const enCurso = indiceItemEnCurso(itemsVigentes(estado));

  // EL CLIENTE SOLO SE LEE MIENTRAS LA ETAPA DEL CLIENTE NO HAYA QUEDADO ATRÁS.
  //
  // Y "atrás" no es "ya hay líneas cargadas", que fue el primer intento y dejaba
  // afuera el caso peor: la PRIMERA pregunta de ítem. Con un e-Ticket sin
  // receptor y sin ningún ítem, "coca 2 litros" dejaba `nombre_cliente: "coca"`
  // y `completar` le ordenaba al agente ponerlo en `cliente.razon_social` de un
  // comprobante que el usuario había pedido SIN identificar: una razón social
  // inventada en un CFE real.
  //
  // Las tres condiciones son la misma pregunta mirada por tres lados: si el
  // usuario ya dijo que no identifica al receptor, o si el flujo está
  // preguntando por un ítem, entonces lo que la gramática posicional lee como
  // "cliente" es un falso positivo — el primer sustantivo de la frase, que acá
  // es un producto. El nombre dicho de verdad llega por `nombre_cliente`, que
  // es explícito y no se toca acá.
  const pasoAbierto = siguientePaso(estado).paso;
  const etapaDelClienteAtras =
    estado.sin_receptor === true ||
    pasoAbierto === "concepto" ||
    pasoAbierto === "precio" ||
    items.some((i) => (i.concepto ?? "") !== "");
  if (
    pedido.cliente !== undefined &&
    !etapaDelClienteAtras &&
    (estado.nombre_cliente ?? "") === "" &&
    (estado.documento ?? "") === ""
  ) {
    estado.nombre_cliente = pedido.cliente;
    puestos.push("nombre_cliente");
  }

  if (pedido.items.length === 0) return { puestos, avisos };

  // SIN ÍTEM EN CURSO Y CON ÍTEMS CARGADOS, NO SE VUELCA NADA.
  //
  // Es el caso de "sumale 3 tortas a 450" cuando el agente YA mandó esa línea
  // en `items`: el estado está completo y lo que el extractor leyó es un eco
  // del mismo mensaje. Volcarlo sobre el primer ítem le corría los datos, y
  // agregarlo como línea nueva cobraría las tortas dos veces. Lo único correcto
  // es no tocar nada y decirlo: el que quiere agregar una línea abre un ítem
  // (el botón ➕, o `precios_sin_ubicar` acá abajo).
  const sinDondeVolcar = enCurso === -1 && items.length > 0;
  if (sinDondeVolcar) {
    avisos.push(
      `El texto nombraba ${pedido.items.length} línea(s) pero no hay ningún ítem a medio cargar: ` +
        "no se volcó ninguna, para no pisar las que ya estaban ni cobrar la misma dos veces. " +
        "Si el usuario quiere agregar otra línea, mandala explícita en 'items'.",
    );
  }
  const base = enCurso === -1 ? 0 : enCurso;

  // Cuando no hay dónde volcar no se vuelca nada, pero el bloque de abajo
  // —el precio que sobró— sigue corriendo: abrir la pregunta por la venta que
  // no se pudo leer es lo otro que este flujo no puede dejar de hacer.
  const descartados: number[] = [];
  if (!sinDondeVolcar) {
    pedido.items.forEach((leido, k) => {
      const i = base + k;
      const item: ItemEnCurso = { ...(items[i] ?? {}) };

      // DOS LÍNEAS DISTINTAS NO SE MEZCLAN.
      //
      // Con `[{Café, sin precio}, {tortas, 3, 450}]` y el usuario escribiendo
      // "sumale 3 tortas a 450", el ítem en curso es el CAFÉ (es al que le
      // falta el precio) y lo leído habla de las tortas: llenarle el hueco le
      // ponía al café el precio de la otra línea. Los conceptos están para algo
      // — cuando los dos existen y no son el mismo, esto no es la respuesta a
      // la pregunta abierta y no se vuelca nada.
      if (
        (item.concepto ?? "") !== "" &&
        leido.concepto !== undefined &&
        !hablanDeLaMismaLinea(item.concepto!, leido.concepto)
      ) {
        // Y LA PLATA DE ESA LÍNEA NO SE EVAPORA.
        //
        // El aviso dura un turno; el borrador dura la conversación. Sin esto,
        // "2 medialunas a 60 y 3 tortas a 450" sobre `[{Café, sin precio}]`
        // cargaba las tortas, descartaba las medialunas, y al mensaje siguiente
        // el flujo decía "ya tengo todo" con los $60 en ningún lado. El precio
        // descartado entra a la misma lista que los que no se pudieron ubicar,
        // que es la que abre un ítem vacío y obliga a preguntar.
        if (leido.precio !== undefined) descartados.push(leido.precio);
        avisos.push(
          `El texto habla de otra línea (no de la que se está cargando): no se volcó nada sobre ` +
            `el ítem ${i + 1}. Si el usuario está corrigiendo o agregando, mandalo explícito en ` +
            "'items'.",
        );
        return;
      }

      if ((item.concepto ?? "") === "" && leido.concepto !== undefined) {
        item.concepto = leido.concepto;
        puestos.push(`items[${i}].concepto`);
      }
      if (item.cantidad === undefined && leido.cantidad !== undefined) {
        item.cantidad = leido.cantidad;
        puestos.push(`items[${i}].cantidad`);
      }
      if (item.precio === undefined && leido.precio !== undefined) {
        item.precio = leido.precio;
        // La marca viaja PEGADA al precio, en la misma condición: sin esto, el
        // "6.50" entraba al estado como 6,5 pelado y el preview mostraba $13
        // sin una palabra sobre las otras dos lecturas. Ver `precio_ambiguo`.
        item.precio_ambiguo = leido.precio_ambiguo === true;
        puestos.push(`items[${i}].precio`);
      }
      items[i] = item;
    });
  }

  // NÚMEROS QUE SOBRARON = VENTA QUE NO SE PUDO LEER.
  //
  // "…3 cajas a 1200 y portland a 6500": el segundo tramo no trae cantidad, así
  // que no hay ítem donde poner los $6.500. Antes se descartaban en silencio y
  // el flujo llegaba a `listo` con media factura. Abrir un ítem vacío es la
  // forma que ya tiene este flujo de decir "seguí preguntando por otro", y
  // convierte la pérdida silenciosa en la pregunta que corresponde. Corre
  // SIEMPRE, incluso cuando no había dónde volcar las líneas leídas: si no, un
  // mensaje que nombra más venta de la que se entiende terminaba en "confirmar"
  // con el aviso de que no se confirme.
  const sinUbicar = [...pedido.precios_sin_ubicar, ...descartados];
  if (sinUbicar.length > 0) {
    const ultimo = items[items.length - 1];
    if (ultimo === undefined || Object.keys(ultimo).length > 0) {
      items.push({});
      puestos.push(`items[${items.length - 1}] (abierto por un precio sin ubicar)`);
    }
    delete estado.items_cerrados;
    if (descartados.length > 0) {
      const monedaAviso = estado.moneda ?? pedido.moneda;
      avisos.push(
        `⚠️ Quedaron sin línea ${descartados.length} precio(s) del mensaje ` +
          `(${descartados.map((precio) => formatearPrecioAviso(precio, monedaAviso)).join(", ")}): ` +
          `se abrió un ítem para preguntarlos. NO emitas hasta ` +
          "cargarlos o descartarlos con el usuario.",
      );
    }
  }

  if (items.length > 0) estado.items = items;
  return { puestos, avisos };
}

/**
 * Arma el borrador con la forma que espera `biller_emitir_comprobante`.
 *
 * DELIBERADAMENTE NO INCLUYE `concepto` NI `razon_social`, y no es un descuido:
 *
 * Esos dos nombres de clave están en `CAMPOS_NO_CONFIABLES`, así que la barrera
 * de salida los envuelve en ⟦dato-no-confiable⟧ antes de que salgan del server.
 * Para el texto de un comprobante RECIBIDO eso es exactamente lo correcto. Pero
 * un borrador que vuelve envuelto es peor que inútil: si el agente lo pasa tal
 * cual a la emisión, las marcas terminan impresas en el CFE.
 *
 * La salida no es debilitar la barrera —compara por nombre de clave a propósito,
 * y una excepción acá es la grieta por la que después pasa texto de un tercero—.
 * Es notar que esos dos campos no tienen por qué estar acá: el borrador existe
 * para cargar lo que la tool DEDUJO (el tipo de CFE, el indicador de IVA, la
 * forma de pago), que es justo donde un modelo se equivoca caro. El concepto y
 * la razón social los escribió el usuario hace dos mensajes y el agente los
 * tiene textuales; copiarlos es lo único que sabe hacer sin equivocarse.
 *
 * Por eso el borrador viene acompañado de `completar`: qué falta agregarle y de
 * dónde sacarlo. Ver `menuWhatsapp.ts` para el mismo problema resuelto al revés
 * (ahí se pudo renombrar la clave; acá la clave es parte del contrato de la API).
 */
export function borradorComprobante(
  estado: EstadoEmision,
  tipo: number | null,
): {
  borrador: Record<string, unknown>;
  completar: string[];
  /**
   * Los ítems del ESTADO que quedaron a medio cargar, en posición 1-based y con
   * qué les falta. Vacío en el caso normal.
   *
   * Sale del `completar` además de estar escrito adentro porque el llamador lo
   * necesita como DATO y no como prosa: `emisionGuiada` lo convierte en un
   * warning propio, que es donde el agente mira antes de emitir.
   */
  incompletos: Array<{ posicion: number; falta: string[] }>;
} {
  const borrador: Record<string, unknown> = {};
  const completar: string[] = [];

  if (tipo !== null) borrador["tipo_comprobante"] = tipo;
  // `numero_interno` NO VUELVE ACÁ, y esa es toda la defensa contra el duplicado.
  //
  // Está en CAMPOS_NO_CONFIABLES, así que la barrera de salida lo envuelve en
  // ⟦dato-no-confiable⟧ antes de que salga del server. Un id envuelto le deja
  // al modelo dos caminos y los dos terminan mal: copiarlo con las marcas
  // adentro (y emitir un CFE con basura en el campo), o limpiarlo a mano — que
  // es peor, porque dos reintentos que limpian distinto producen DOS ids
  // distintos, `buscarPorNumeroInterno` no matchea ninguno, y la misma venta
  // sale dos veces ante DGI. Justo lo que este id existe para impedir.
  //
  // El id se genera en el server, vive en el store y lo completa
  // `completarDesdeSesion` al emitir: nunca pasa por el canal del modelo. Por
  // eso tampoco hace falta declararlo en `completar` — no hay nada que copiar.
  if (estado.fecha_emision !== undefined) borrador["fecha_emision"] = estado.fecha_emision;
  if (estado.forma_pago !== undefined) borrador["forma_pago"] = estado.forma_pago;
  if (estado.moneda !== undefined) borrador["moneda"] = estado.moneda;
  if (estado.tasa_cambio !== undefined) borrador["tasa_cambio"] = estado.tasa_cambio;
  if (estado.fecha_vencimiento !== undefined) {
    borrador["fecha_vencimiento"] = estado.fecha_vencimiento;
  }
  // `montos_brutos` va SIEMPRE que se sepa, incluso en false.
  //
  // Omitirlo no es neutral: la API interpreta la ausencia como "los precios son
  // netos" y le suma el IVA. O sea que el silencio ya es una respuesta, y es la
  // equivocada para el precio de mostrador uruguayo, que se cotiza con IVA
  // adentro. Un borrador que no lleva el campo factura 22% de más.
  if (estado.montos_brutos !== undefined) borrador["montos_brutos"] = estado.montos_brutos;

  if (estado.documento !== undefined) {
    const d = clasificarDocumento(estado.documento);
    if (d.tipo !== "desconocido") {
      // `tipo_documento` YA está deducido (12 dígitos = RUT, 7-8 = CI): dejarlo
      // afuera obligaba al modelo a re-deducirlo, y ese código decide en qué
      // CAMPO va el nombre del cliente. Ver el `completar` de acá abajo.
      const cliente: Record<string, unknown> = {
        tipo_documento: d.tipo === "rut" ? 2 : 3,
        documento: d.normalizado,
      };

      // `cliente.sucursal.pais` es obligatorio para clientes que no son
      // empresas, así que va SIEMPRE y no solo cuando el cliente es nuevo.
      const sucursal: Record<string, unknown> = { pais: "UY" };
      if (estado.cliente_ya_facturado === false) {
        // Dirección y ciudad solo cuando hay que darlo de alta: son los dos
        // campos que la API exige en esa llamada (verificado: 422 sin ellos).
        if (estado.direccion_cliente !== undefined) sucursal["direccion"] = estado.direccion_cliente;
        if (estado.ciudad_cliente !== undefined) sucursal["ciudad"] = estado.ciudad_cliente;
      }
      cliente["sucursal"] = sucursal;
      borrador["cliente"] = cliente;
    }
  }
  if (estado.nombre_cliente !== undefined && estado.nombre_cliente.trim() !== "") {
    // EL CAMPO DEPENDE DEL TIPO DE DOCUMENTO, y no es intercambiable: con RUT
    // el nombre principal es `razon_social`; con cédula es `nombre_fantasia`.
    // Antes esto decía siempre "razon_social", así que a un consumidor final
    // identificado con CI se le mandaba el nombre en el campo equivocado.
    const d = estado.documento === undefined ? null : clasificarDocumento(estado.documento);
    const campo = d?.tipo === "ci" ? "cliente.nombre_fantasia" : "cliente.razon_social";
    const porque =
      d?.tipo === "ci"
        ? "es una cédula (tipo_documento 3), y para 3/5/6 el nombre principal va en nombre_fantasia"
        : "es un RUT (tipo_documento 2), y para 2/7 el nombre principal va en razon_social";
    completar.push(
      `${campo}: ponelo vos, con el nombre que te dio el usuario en la conversación — ${porque}. ` +
        "(No lo devuelvo acá para no ensuciarlo con las marcas de la barrera de salida.)",
    );
  }

  // EL FILTRO DE ÍTEMS A MEDIO CARGAR, Y POR QUÉ NO ALCANZA CON FILTRAR.
  //
  // Un ítem sin concepto o sin precio no puede ir al borrador: produce un 422
  // que habla de un campo que el usuario nunca vio. Pero SACARLO DEL MEDIO es
  // peor que el 422, porque no falla — corre una casilla a todas las líneas que
  // seguían. Y la posición es de lo único que dispone quien completa los
  // conceptos: el agente, a quien esta misma función le pide abajo que los
  // ponga en orden, y `completarDesdeSesion` (`write/emitirComprobante.ts`),
  // que rellena `items[i].concepto` desde `itemsGuardados[i]` sin mirar nada
  // más. Con `[{A,100}, {B sin precio}, {C,300}]` la línea de $300 salía con el
  // concepto de B impreso en un CFE real.
  //
  // Por eso el borrador CORTA en el primer agujero en vez de saltearlo: un
  // prefijo de los ítems guardados sigue alineado por posición con ellos, que
  // es la propiedad que el resto del sistema da por cierta. Se pierde una línea
  // —visible en el preview, que muestra el comprobante entero— en lugar de
  // ganar una línea con la descripción de otra cosa.
  //
  // Y no se elige mandar el índice original adentro de cada ítem: `items[]` es
  // el cuerpo REAL que va a `biller_emitir_comprobante`, un campo de más ahí es
  // un 422 (verificado con `numero_interno`) o, peor, algo que la API acepta y
  // termina en el CFE. Además no arreglaría nada: quien rellena por posición es
  // código del server que no lee ese campo.
  const itemsEstado = estado.items ?? [];

  // "QUÉ FALTA PREGUNTAR" Y "QUÉ LÍNEA NO PUEDE VIAJAR" SON DOS PREGUNTAS
  // DISTINTAS, Y CONFUNDIRLAS FACTURA DE MENOS.
  //
  // `siguientePaso` considera incompleto un precio que no sea un número
  // POSITIVO, y para preguntar está bien: un ítem que quedó en cero
  // probablemente es uno al que todavía no se le puso el precio. Pero para
  // decidir qué línea sale, el criterio tiene que ser el de la API y nada más:
  // `ItemSchema` (`biller/cfeSchema.ts`) pide un número y NO restringe el signo.
  //
  // Una bonificación a $0 y un descuento de -$200 son líneas de mostrador
  // perfectamente emitibles, y `repetirUltima` las copia tal cual de la factura
  // anterior (descarta solo `precio === null`) junto con `items_cerrados`. Con
  // el criterio de preguntar aplicado acá, "repetir lo de siempre" sobre una
  // factura con una línea bonificada truncaba el borrador EN esa línea: se
  // emitía $1.000 en vez de $1.300, sin que nadie hubiera pedido nada raro.
  const loQueFalta = (i: ItemEnCurso): string[] => {
    const falta: string[] = [];
    if ((i.concepto ?? "") === "") falta.push("concepto");
    if (typeof i.precio !== "number") falta.push("precio");
    return falta;
  };
  const incompletos = itemsEstado
    .map((i, idx) => ({ posicion: idx + 1, falta: loQueFalta(i) }))
    .filter((x) => x.falta.length > 0);
  const corte = itemsEstado.findIndex((i) => !itemPuedeViajar(i));

  const items = (corte === -1 ? itemsEstado : itemsEstado.slice(0, corte)).map((i) => {
    const item: Record<string, unknown> = {};
    if (i.cantidad !== undefined) item["cantidad"] = i.cantidad;
    if (i.precio !== undefined) item["precio"] = i.precio;
    const ind = i.indicador_facturacion ?? estado.indicador_facturacion;
    if (ind !== undefined) item["indicador_facturacion"] = ind;
    return item;
  });
  if (items.length > 0) {
    borrador["items"] = items;
    completar.push(
      "items[].concepto: completá cada ítem con la descripción TEXTUAL que dio el usuario, en el " +
        "mismo orden en que la dijo — items[N] es la N-ésima cosa que dijo, y por eso el borrador " +
        "corta antes del primer ítem incompleto en vez de saltearlo. Es el único campo del cuerpo " +
        "que sale de la conversación.",
    );
  }
  // EL FILTRO DEJA DE SER SILENCIOSO.
  //
  // El flujo ya no llega a `listo` con un agujero (ver `siguientePaso`), pero
  // esta función es alcanzable por otros caminos —una emisión directa, un
  // agente que arme el estado a mano— y ahí no hay nadie preguntando. Que lo
  // que falta se diga acá es la diferencia entre una línea de menos que se ve y
  // una línea de más con la descripción equivocada que no se ve.
  if (incompletos.length > 0) {
    const primero = incompletos[0]!;
    const cortadas = itemsEstado.length - items.length;
    completar.push(
      `⚠️ NO EMITAS TODAVÍA: el ítem ${primero.posicion} está a medio cargar (le falta ` +
        `${primero.falta.join(" y ")}). El borrador corta ahí, así que van ${items.length} de ` +
        `${itemsEstado.length} líneas y quedan ${cortadas} afuera. No las agregues vos por tu ` +
        "cuenta: los conceptos se completan POR POSICIÓN y correrlas le pone la descripción de " +
        "una línea a otra. Terminá de cargar ese ítem con biller_emision_guiada y volvé a pedir " +
        "el borrador.",
    );
  }

  // `adenda` está en CAMPOS_NO_CONFIABLES igual que `concepto`: si volviera acá
  // volvería envuelta, y esas marcas terminarían impresas en el CFE.
  if (estado.adenda !== undefined && estado.adenda.trim() !== "") {
    completar.push(
      "adenda: ponela vos, con las palabras textuales del usuario (no la devuelvo acá por la " +
        "barrera de salida).",
    );
  }

  return { borrador, completar, incompletos };
}
