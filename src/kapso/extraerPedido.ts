// =============================================================================
// "Facturale a Pérez 2 bolsas de portland a 6.500" leído por TypeScript.
//
// POR QUÉ EXISTE
//
// Ese mensaje es EL punto de entrada real del flujo de emisión —`emision.ts` lo
// dice en su propio encabezado— y hasta ahora el único que lo desarmaba era el
// modelo: el enrutador decía "esto es menu:emitir" y el agente inventaba los
// campos del borrador a mano. Dos problemas, y ninguno se ve cuando falla:
//
//   1. LA PLATA LA LEE TYPESCRIPT. `services/importe.ts` existe entero por una
//      línea: `Number("6.500")` es 6,5. Un modelo que se come el punto factura
//      la bolsa a seis pesos con cincuenta, el CFE sale bien formado y el error
//      aparece cobrando. Este módulo parte los números ANTES y hace pasar cada
//      uno por `parsearImporte`/`parsearCantidad`, que ya tienen las reglas
//      escritas y testeadas — incluida la marca `ambiguo`, que tiene que
//      sobrevivir hasta el preview.
//   2. LA MITAD DE LOS "no entendí" ERAN PEDIDOS. "perez 2 bolsas portland
//      6500" no se parece a ningún sinónimo del catálogo y es una orden de
//      facturar perfectamente clara. Con la gramática de acá, dos campos
//      extraídos alcanzan para enrutarla (ver `esPedidoDeEmision`).
//
// LAS TRES REGLAS QUE LO MANTIENEN HONESTO
//
//   · EXTRACCIÓN PARCIAL ES UN ÉXITO. Cada campo que sale acá es una pregunta
//     que el flujo no hace; lo que no salga se pregunta igual, como siempre.
//     No hay ningún camino donde "no pude leer el precio" termine en un precio.
//   · NUNCA SE INVENTA. Un número que `parsearImporte` no puede leer no entra:
//     queda afuera y el flujo lo pide. Devolver "el más probable" sin marcarlo
//     es exactamente el error que este módulo existe para cerrar.
//   · ES PURO. No lee el reloj, no toca la red, no guarda nada. Se puede
//     testear con veinte frases de corrido, que es la única forma de saber si
//     una gramática escrita a mano entiende a la gente o no.
//
// LO QUE DELIBERADAMENTE NO HACE
//
// No decide el tipo de comprobante, no clasifica el documento y no resuelve el
// nombre del cliente contra Biller. Devuelve el NOMBRE tal como se escribió;
// quién es ese nombre lo contesta `biller_resolver_nombre`, que sabe preguntar
// cuando hay dos candidatos. Adivinar el cliente es el error más caro de una
// emisión —más que el total— y no se toma por gramática.
// =============================================================================

import { parsearCantidad, parsearImporte } from "../services/importe.js";
import { sugiereDolares } from "./emision.js";

/** Un ítem tal como se lee del mensaje. Todo opcional: parcial es un éxito. */
export interface ItemPedido {
  concepto?: string;
  cantidad?: number;
  precio?: number;
  /**
   * true cuando el precio admitía más de una lectura y se eligió la más
   * probable ("6.50" puede ser 6,50 o 6.500). Ver `services/importe.ts`.
   *
   * TIENE QUE SOBREVIVIR HASTA EL PREVIEW: la diferencia entre las dos lecturas
   * es de cien veces, y un eco cuesta un mensaje.
   */
  precio_ambiguo?: boolean;
}

/** Lo que se pudo leer del mensaje. Nada de esto es obligatorio. */
export interface PedidoEmision {
  /** Nombre del cliente COMO LO ESCRIBIÓ el usuario. Sin resolver. */
  cliente?: string;
  items: ItemPedido[];
  /**
   * Los números que venían MARCADOS como precio ("a 6500", "$900") y que no
   * entraron en ningún ítem.
   *
   * NO ES DIAGNÓSTICO: es un freno. Un número marcado como precio que quedó
   * afuera significa que el mensaje nombraba más venta de la que se pudo leer
   * —"…a 1200 y portland a 6500", donde el segundo tramo no trae cantidad— y
   * un pedido así NO puede considerarse completo. Antes se descartaba en
   * silencio y el preview mostraba media factura: los $6.500 no aparecían en
   * ninguna línea ni en el total, y el CFE salía perfectamente bien formado.
   *
   * Quien lo consume (`rellenarDesdePedido`) abre un ítem vacío para que el
   * flujo pregunte por el resto en vez de ir derecho a "listo".
   */
  precios_sin_ubicar: string[];
  /** "USD" o "UYU", solo si el texto la nombró. */
  moneda?: string;
  /** Código de FORMAS_PAGO: 1 contado, 2 crédito. Solo si el texto lo dijo. */
  forma_pago?: number;
  /** true = los precios ya incluyen IVA ("con IVA incluido"). */
  montos_brutos?: boolean;
  /** true si algún número leído quedó marcado como ambiguo. */
  ambiguo: boolean;
  /**
   * true si el texto NOMBRA la acción de facturar ("factura", "facturale",
   * "emitile", "cobrale"). No es un campo del comprobante: es la evidencia que
   * permite enrutar un pedido al que solo se le pudo leer un dato.
   */
  verbo: boolean;
  /** Qué campos se extrajeron, por NOMBRE. Es lo que se cuenta para enrutar. */
  campos: string[];
  /** Qué se leyó y por qué, en castellano. Para ecoarlo antes de emitir. */
  detalles: string[];
}

// --- Los vocabularios cerrados ----------------------------------------------

/**
 * Las preposiciones que introducen al cliente.
 *
 * El discriminador entre "a Pérez" y "a 6500" es MECÁNICO y no semántico: lo
 * que sigue a la preposición es un dígito (o un número en letras) o no lo es.
 * Esa es toda la gramática, y por eso funciona con nombres que no conocemos.
 */
const PREPOSICIONES_CLIENTE: ReadonlySet<string> = new Set(["a", "al", "para"]);

/** Palabras que se saltean al empezar a leer un nombre: "a la panadería". */
const SALTEABLES: ReadonlySet<string> = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "mi", "mis", "tu", "tus", "su", "sus", "nombre", "de", "del",
]);

/**
 * Lo que NUNCA es un nombre de cliente aunque venga después de "a".
 *
 * "a crédito" es la forma de pago y "a 30 días" es el plazo; sin esta lista, el
 * cliente del comprobante quedaba siendo "credito". Un cliente inventado es el
 * error más caro de una emisión, así que ante la duda no se toma el nombre.
 */
const NO_CLIENTE: ReadonlySet<string> = new Set([
  "credito", "contado", "cuenta", "corriente", "plazo", "dias", "dia",
  "hoy", "manana", "ayer", "fecha", "vencimiento",
  "pesos", "peso", "dolares", "dolar", "usd", "uyu", "iva", "precio", "unidad",
  "factura", "facturas", "comprobante", "comprobantes", "boleta", "boletas",
  "recibo", "recibos", "nota", "ticket", "eticket",
  "cobrar", "pagar", "emitir", "facturar", "mano", "medias",
]);

/** Lo que CORTA un nombre de cliente que se estaba leyendo. */
const CORTES_CLIENTE: ReadonlySet<string> = new Set([
  "por", "x", "con", "y", "o", "que", "cada", "en", "sin", "mas", "@", "c/u",
]);

/**
 * Palabras de función: pronombres, interrogativos y los verbos con los que
 * arranca un pedido de información.
 *
 * Ninguna es un nombre de cliente ni un concepto, y la que motivó la lista es
 * "me": sin ella, "me pagaron la 1234" se leía en modo telegráfico como
 * "cliente: me pagaron" y un aviso de cobro se convertía en un pedido de
 * facturación a un cliente llamado "me pagaron".
 */
const PALABRAS_FUNCION: ReadonlySet<string> = new Set([
  "me", "te", "se", "lo", "le", "les", "nos", "yo", "vos", "che",
  "cuanto", "cuantos", "cuanta", "cuantas", "quien", "quienes", "como", "cuando",
  "donde", "porque", "cual", "cuales",
  "es", "era", "eran", "son", "fue", "fueron", "esta", "estan", "hay", "habia",
  "mostrame", "dame", "pasame", "mandame", "decime", "buscame", "quiero", "necesito",
]);

/**
 * Números en letras que cuentan como CANTIDAD.
 *
 * "un"/"una"/"uno" quedan afuera a propósito, y no es un olvido: en castellano
 * son el artículo indefinido mucho más seguido que el número. Con ellos
 * adentro, "mi tío compró una bicicleta" se leía como "cantidad 1 de
 * bicicleta" — o sea, el enrutador entendía un pedido de facturación en una
 * frase que no tiene nada que ver. Entran solo como primera mitad de un
 * compuesto ("un par", "una docena"), donde el número está en la segunda.
 */
const CANTIDADES_LETRA: ReadonlySet<string> = new Set([
  "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "docena", "docenas", "par", "pares",
]);

/** Primera mitad de una cantidad compuesta: "media docena", "un par". */
const MULTIPLICADORES: ReadonlySet<string> = new Set(["un", "una", "uno", "media", "medio"]);
const COMPUESTOS: ReadonlySet<string> = new Set(["docena", "docenas", "par", "pares"]);

/** Palabras que, ANTES de un número, lo marcan como precio: "a 6500", "x 120". */
const MARCA_PRECIO_ANTES: ReadonlySet<string> = new Set([
  "a", "x", "por", "@", "de", "cada", "c/u", "vale", "valen", "sale", "salen",
]);

/** Y las que lo marcan DESPUÉS: "6500 cada una", "6500 c/u". */
const MARCA_PRECIO_DESPUES: ReadonlySet<string> = new Set(["cada", "c/u", "cu", "la"]);

/**
 * Lo que SEPARA un ítem del siguiente: "…a 1200 Y 2 bolsas…".
 *
 * La coma y el salto de línea no están —y no es un olvido—: `tokenizarPedido`
 * los convierte en espacio antes de que este módulo los vea. Los cubre la otra
 * mitad de la regla (ver `abreOtroItem`): un número que acaba de consumirse
 * como precio también separa, y eso es exactamente lo que queda escrito donde
 * había una coma o un enter.
 */
const SEPARADORES_ITEM: ReadonlySet<string> = new Set(["y", "o", "mas", "ademas", "tambien", "+"]);

/**
 * Palabras que, DESPUÉS de un número, dicen que ese número no era plata.
 *
 * Son las que hacen que un número marcado quede afuera sin que eso signifique
 * "falta media venta": en "a 30 días" el 30 lleva la marca de precio (la
 * preposición es la misma) y es un plazo, y en "bolsas de 25 kg" el 25 es parte
 * del producto. Sin esta lista, las dos frases más comunes del mostrador
 * abrirían una pregunta de "¿algo más?" que no corresponde.
 */
const UNIDADES_NO_PRECIO: ReadonlySet<string> = new Set([
  "dias", "dia", "meses", "mes", "semanas", "semana", "cuotas", "cuota", "horas", "hora",
  "kg", "kilo", "kilos", "gr", "gramos", "lt", "litro", "litros",
  "mt", "metro", "metros", "cm", "mm", "unidad", "unidades", "%",
]);

/** Palabras que no pueden ser el concepto de un ítem. */
const NO_CONCEPTO: ReadonlySet<string> = new Set([
  ...NO_CLIENTE,
  ...PALABRAS_FUNCION,
  "no", "si", "es", "era", "eran", "fue", "pero", "esta", "este", "esa", "ese",
  "ya", "y", "o", "que", "ponele", "sale", "salen", "vale", "valen",
]);

/**
 * Lo que hace que un texto NOMBRE la acción de facturar.
 *
 * Se compara por prefijo porque el imperativo con clítico es como escribe la
 * gente ("facturale", "emitile") y enumerar las conjugaciones es una lista que
 * siempre queda corta. "cobrale" está adentro y "cobrar" NO: en el mostrador
 * uruguayo "cobrale 1500 a Martínez" es emitir un comprobante, mientras que
 * "cobrar" a secas es la pregunta de la cobranza. La diferencia es el clítico,
 * y es exactamente lo que separa las dos intenciones.
 */
const PREFIJOS_VERBO: readonly string[] = ["factur", "emiti"];
const VERBOS_EXACTOS: ReadonlySet<string> = new Set([
  "comprobante", "comprobantes", "boleta", "boletas", "eticket", "e-ticket",
  "cobrale", "cobrales", "cobrarle", "cobrarles", "hacele", "haceles",
]);

// --- Las señales que no son números -----------------------------------------

/** El orden importa: "con IVA aparte" contiene "con iva". */
const MARCA_IVA_APARTE = /\biva\s+aparte\b|\bmas\s+iva\b|\+\s*iva\b|\bsin\s+iva\b|\bmas\s+el\s+iva\b/;
const MARCA_IVA_INCLUIDO =
  /\biva\s+incluido\b|\bcon\s+iva\b|\bcon\s+el\s+iva\b|\biva\s+adentro\b|\bincluye\s+iva\b/;

const MARCA_CREDITO = /\ba\s+credito\b|\bes\s+credito\b|\bfiado\b|\ba\s+\d+\s+dias\b|\bme\s+paga\s+despues\b/;
const MARCA_CONTADO = /\b(al\s+)?contado\b|\bya\s+me\s+pago\b|\ben\s+efectivo\b/;

const MARCA_PESOS = /\ben\s+pesos\b|\bpesos\b|\buyu\b|\$u\b/;

// --- Tokenizar --------------------------------------------------------------

/**
 * Normaliza y parte en palabras, CUIDANDO los separadores de los números.
 *
 * La coma y el punto se vuelven espacio salvo cuando están entre dígitos: ahí
 * son el punto de miles o la coma decimal, y comérselos convierte "6.500" en
 * "6 500" — dos números donde había uno, que es justo lo que
 * `parsearImporte` no puede resolver sin adivinar.
 */
export function tokenizarPedido(raw: string): string[] {
  const plano = (raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  let salida = "";
  for (let i = 0; i < plano.length; i += 1) {
    const c = plano[i]!;
    if (c === "." || c === ",") {
      const previo = plano[i - 1] ?? "";
      const siguiente = plano[i + 1] ?? "";
      salida += /\d/.test(previo) && /\d/.test(siguiente) ? c : " ";
      continue;
    }
    salida += /[¿?¡!;:()[\]"']/.test(c) ? " " : c;
  }
  return salida.split(/\s+/).filter((t) => t !== "");
}

/**
 * ¿Este token es UN NÚMERO y nada más?
 *
 * "25kg" NO lo es: es parte del concepto ("bolsas de 25kg"). Se aceptan los
 * símbolos de moneda pegados porque la gente los escribe así ("$6.500").
 */
function esNumeroToken(t: string): boolean {
  const sinMoneda = t.replace(/^(u\$s|us\$|usd|\$u|\$)/, "");
  return /^\d[\d.,]*$/.test(sinMoneda);
}

function esCantidadEnLetras(t: string): boolean {
  return CANTIDADES_LETRA.has(t);
}

/** ¿Puede una palabra empezar (o seguir) el concepto de un ítem? */
function esPalabraConcepto(t: string): boolean {
  if (esNumeroToken(t) || esCantidadEnLetras(t) || MULTIPLICADORES.has(t)) return false;
  if (PREPOSICIONES_CLIENTE.has(t) || CORTES_CLIENTE.has(t)) return false;
  if (NO_CONCEPTO.has(t) || esRellenoConcepto(t)) return false;
  return /[a-z]/.test(t) && t.length >= 2;
}

/**
 * Las palabras que pueden ir ADENTRO de un concepto sin empezarlo.
 *
 * "bolsas DE portland" sí; "de portland" a secas no, porque el concepto que
 * termina en el borrador se lee en el CFE y "de empanadas" no es lo que nadie
 * vendió. Se saltean al principio y se recortan al final.
 */
function esRellenoConcepto(t: string): boolean {
  return t === "de" || t === "del" || t === "la" || t === "el" || t === "los" || t === "las";
}

// --- Leer el cliente --------------------------------------------------------

/**
 * "…a Pérez 2 bolsas…" -> "perez"
 *
 * Recorre las preposiciones de izquierda a derecha y se queda con la primera
 * que NO va seguida de un número. Con eso, "2 bolsas a 6500 para Pérez" —el
 * cliente al final, que es como se escribe cuando uno ya empezó a contar la
 * venta— sale igual de bien que la forma canónica.
 */
function leerCliente(tokens: readonly string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!PREPOSICIONES_CLIENTE.has(tokens[i]!)) continue;

    let j = i + 1;
    while (j < tokens.length && SALTEABLES.has(tokens[j]!)) j += 1;
    const primera = tokens[j];
    if (primera === undefined) continue;
    // El discriminador mecánico: dígito o número en letras después de la
    // preposición significa que ahí viene la plata, no el cliente.
    if (esNumeroToken(primera) || esCantidadEnLetras(primera)) continue;
    if (NO_CLIENTE.has(primera) || PALABRAS_FUNCION.has(primera) || !/[a-z]/.test(primera)) continue;

    const partes: string[] = [];
    while (j < tokens.length && partes.length < 4) {
      const t = tokens[j]!;
      if (esNumeroToken(t) || esCantidadEnLetras(t)) break;
      if (PREPOSICIONES_CLIENTE.has(t) || CORTES_CLIENTE.has(t)) break;
      if (NO_CLIENTE.has(t) || PALABRAS_FUNCION.has(t)) break;
      // UN ARTÍCULO EN EL MEDIO CIERRA EL NOMBRE.
      //
      // "emitile a Rodríguez el flete, 2.500" daba un cliente llamado
      // "rodriguez el flete": el nombre se comía la venta. Cortar acá pierde la
      // segunda mitad de "Ferretería La Estrella" —queda "ferreteria"— y eso
      // está bien: `biller_resolver_nombre` tolera un nombre corto y pregunta
      // cuando hay dos candidatos, mientras que un nombre con media frase
      // adentro no matchea nada y el flujo pide el cliente de nuevo.
      if (partes.length > 0 && SALTEABLES.has(t)) break;
      partes.push(t);
      j += 1;
    }
    if (partes.length === 0) continue;
    return partes.join(" ");
  }
  return undefined;
}

/**
 * El caso TELEGRÁFICO: "perez 2 bolsas portland 6500".
 *
 * Sin ninguna preposición no hay gramática que separe al cliente de la venta,
 * pero sí hay una posición: lo que está ANTES del primer número, cuando no es
 * un verbo ni una palabra del vocabulario, es a quién se le factura. Se limita
 * a dos palabras y se exige que haya un número después, para que una frase
 * cualquiera no se convierta en un nombre de cliente.
 */
function leerClienteTelegrafico(tokens: readonly string[]): string | undefined {
  const partes: string[] = [];
  for (let i = 0; i < tokens.length && i < 2; i += 1) {
    const t = tokens[i]!;
    if (!/^[a-z][a-z]+$/.test(t)) return undefined;
    if (
      esVerbo(t) ||
      NO_CLIENTE.has(t) ||
      PALABRAS_FUNCION.has(t) ||
      SALTEABLES.has(t) ||
      CORTES_CLIENTE.has(t) ||
      esCantidadEnLetras(t) ||
      MULTIPLICADORES.has(t)
    ) {
      return undefined;
    }
    partes.push(t);

    // EL NÚMERO TIENE QUE VENIR PEGADO AL NOMBRE.
    //
    // Es lo único que distingue "perez 2 bolsas" de cualquier frase que
    // empiece con dos palabras y tenga un número más adelante. Sin esta
    // exigencia, "me pagaron la 1234" daba un cliente llamado "me pagaron".
    const siguiente = tokens[i + 1];
    if (siguiente !== undefined && (esNumeroToken(siguiente) || esCantidadEnLetras(siguiente))) {
      return partes.join(" ");
    }
  }
  return undefined;
}

function esVerbo(t: string): boolean {
  if (VERBOS_EXACTOS.has(t)) return true;
  return PREFIJOS_VERBO.some((p) => t.startsWith(p));
}

// --- El módulo --------------------------------------------------------------

/**
 * Lee un pedido de emisión de un mensaje escrito a mano.
 *
 * Gramática mínima, y a propósito:
 *
 *     [verbo]? (a|para|al) <cliente>  +  <cantidad> <concepto> (a|x|por|@) <precio>
 *
 * Las dos mitades son independientes: cada una puede faltar entera y lo que
 * salga de la otra sigue valiendo. Ese es el punto — extracción parcial es un
 * éxito, no un fracaso a medias.
 */
export function extraerPedidoEmision(texto: string): PedidoEmision {
  const tokens = tokenizarPedido(texto);
  const norm = tokens.join(" ");
  const pedido: PedidoEmision = {
    items: [],
    precios_sin_ubicar: [],
    ambiguo: false,
    verbo: false,
    campos: [],
    detalles: [],
  };
  if (tokens.length === 0) return pedido;

  pedido.verbo = tokens.some((t) => esVerbo(t));

  // --- El cliente ----------------------------------------------------------
  const cliente = leerCliente(tokens) ?? leerClienteTelegrafico(tokens);
  if (cliente !== undefined) {
    pedido.cliente = cliente;
    pedido.campos.push("cliente");
    pedido.detalles.push(`Cliente: "${cliente}" (como lo escribió el usuario; falta resolverlo).`);
  }

  // --- La venta: UNO O VARIOS ítems, y los números que sobran --------------
  //
  // POR QUÉ ESTO LEE MÁS DE UN ÍTEM, Y POR QUÉ NO LEE CUALQUIER COSA
  //
  // La versión anterior tenía una sola `cantidad` y un solo `concepto`, así que
  // "3 cajas de clavos a 1200 y 2 bolsas de portland a 6500" facturaba $3.600
  // en vez de $16.600 — la segunda mitad de la venta desaparecía sin un solo
  // warning, y el CFE salía perfectamente bien formado. Un comprobante al que
  // le falta media venta no lo nota nadie hasta que se cobra.
  //
  // Lo que NO se podía hacer era abrir un ítem nuevo con cada número que tenga
  // una palabra al lado: "2 bolsas DE 25 KG a 300" habría dado dos líneas
  // ("2 bolsas" y "25 kg"), que es el error simétrico y peor, porque INVENTA
  // una línea en vez de perderla. Por eso un segundo ítem exige un SEPARADOR
  // adelante: la "y" explícita, o el número que se acaba de consumir como
  // precio del ítem anterior —que es lo que queda escrito donde el usuario
  // puso una coma o un enter, porque el tokenizador se los come—.
  const sueltos: Array<{ token: string; marcado: boolean; posterior: string }> = [];
  let actual: ItemPedido | undefined;
  /** Índice del token que se consumió como precio del ítem en curso. */
  let precioEn = -2;

  const abrirItem = (item: ItemPedido): void => {
    pedido.items.push(item);
    actual = item;
  };

  /** Guarda el precio en el ítem en curso y lo declara. */
  const ponerPrecio = (item: ItemPedido, texto: string): boolean => {
    const leido = parsearImporte(texto);
    if (leido.valor === null || leido.valor <= 0) {
      if (leido.valor === null) {
        pedido.detalles.push(`No se pudo leer "${texto}" como precio: se pregunta igual.`);
      }
      return false;
    }
    item.precio = leido.valor;
    pedido.detalles.push(`Precio: ${leido.detalle}`);
    if (leido.ambiguo) {
      // TIENE QUE SOBREVIVIR HASTA EL PREVIEW: entre las dos lecturas hay cien
      // veces de diferencia. Ver `ItemPedido.precio_ambiguo`.
      item.precio_ambiguo = true;
      pedido.ambiguo = true;
    }
    return true;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const compuesto = MULTIPLICADORES.has(t) && COMPUESTOS.has(tokens[i + 1] ?? "");
    const esCandidata = esNumeroToken(t) || esCantidadEnLetras(t) || compuesto;
    if (!esCandidata) continue;

    const salto = compuesto ? 2 : 1;
    const textoCantidad = compuesto ? `${t} ${tokens[i + 1]}` : t;
    const siguiente = tokens[i + salto];

    // "500 DE pan" NO ES UNA CANTIDAD: SON QUINIENTOS PESOS DE PAN.
    //
    // La forma "<número> de <cosa>" sin unidad adelante es como se pide en el
    // mostrador uruguayo, y leerla como cantidad tenía dos consecuencias en
    // cadena: 500 unidades de pan, y después el precio confirmado ("500")
    // multiplicado por esas 500 unidades — $250.000 por una bolsa de pan.
    //
    // Se distingue de "una docena DE empanadas" porque ahí el número está
    // escrito en letras (o es un compuesto), y de "una factura DE 12000" porque
    // ahí el "de" viene ANTES del número, no después.
    const importeDeConcepto = esNumeroToken(t) && !compuesto && siguiente === "de";

    // ¿Arranca un concepto justo después? Entonces es la cantidad de ese ítem.
    // El "de" cuenta como arranque —"una docena DE empanadas"— pero no queda
    // adentro del concepto; de eso se ocupa `recolectarConcepto`.
    const abreConcepto =
      !importeDeConcepto &&
      siguiente !== undefined &&
      (esPalabraConcepto(siguiente) || siguiente === "de");

    // El primer ítem no necesita separador; los siguientes sí. Ver arriba.
    const previoTok = tokens[i - 1] ?? "";
    const puedeAbrir =
      pedido.items.length === 0 || SEPARADORES_ITEM.has(previoTok) || i - 1 === precioEn;

    if (importeDeConcepto && puedeAbrir) {
      const recolectado = recolectarConcepto(tokens, i + 1);
      if (recolectado.concepto !== undefined) {
        const item: ItemPedido = { concepto: recolectado.concepto };
        if (ponerPrecio(item, t)) {
          abrirItem(item);
          precioEn = i;
          i = recolectado.hasta - 1;
          continue;
        }
      }
      // Si no salió limpio, sigue por el camino de siempre: el número queda
      // suelto y el flujo pregunta, que es lo correcto.
    }

    if (abreConcepto && puedeAbrir) {
      const leida = parsearCantidad(textoCantidad);
      if (leida.valor !== null && leida.valor > 0) {
        const recolectado = recolectarConcepto(tokens, i + salto);
        const item: ItemPedido = { cantidad: leida.valor };
        if (recolectado.concepto !== undefined) item.concepto = recolectado.concepto;
        abrirItem(item);
        i = recolectado.hasta - 1;
        continue;
      }
    }

    if (!esNumeroToken(t)) continue;
    const posterior = tokens[i + 1] ?? "";
    const marcado =
      // Una unidad detrás desarma cualquier marca de adelante: en "bolsas DE 25
      // KG a 300" la preposición marcaba el 25 como precio y la bolsa se
      // facturaba a veinticinco pesos, con el 300 —el precio de verdad—
      // descartado en silencio.
      !UNIDADES_NO_PRECIO.has(posterior) &&
      (MARCA_PRECIO_ANTES.has(previoTok) ||
        MARCA_PRECIO_DESPUES.has(posterior) ||
        /^(u\$s|us\$|usd|\$u|\$)/.test(t));

    // Un número marcado como precio pertenece al ítem que se está leyendo. Es
    // lo único que hace falta para que la segunda mitad de la venta exista.
    if (marcado && actual !== undefined && actual.precio === undefined) {
      if (ponerPrecio(actual, t)) precioEn = i;
      continue;
    }
    sueltos.push({ token: t, marcado, posterior });
  }

  // El precio suelto: el primero marcado; si no hay ninguno, el único que quedó.
  const elegido = sueltos.find((n) => n.marcado) ?? (sueltos.length === 1 ? sueltos[0] : undefined);
  let usado: (typeof sueltos)[number] | undefined;

  if (elegido !== undefined) {
    // UN NÚMERO SUELTO SIN NINGUNA MARCA NO ES UN PRECIO POR SÍ SOLO.
    //
    // "me pagaron la factura 1234" y "anular la 456" traen un número que es un
    // NÚMERO DE COMPROBANTE. Leerlo como precio es cargarle 1.234 pesos a una
    // factura que el usuario estaba nombrando. Se exige o una marca explícita
    // ("a 6500", "$6500"), o que el mensaje ya se haya declarado una venta:
    // hay un cliente, o hay una cantidad y un concepto.
    const hayVenta =
      pedido.cliente !== undefined ||
      pedido.items.some((it) => it.cantidad !== undefined && it.concepto !== undefined);
    if (elegido.marcado || hayVenta) {
      const destino = pedido.items.find((it) => it.precio === undefined);
      if (destino !== undefined) {
        ponerPrecio(destino, elegido.token);
        // Se intentó: leído o no, no queda como "sin ubicar" — si no se pudo
        // leer, el flujo pregunta el precio de esa línea, que es lo correcto.
        usado = elegido;
      } else if (pedido.items.length === 0) {
        // "cobrale 1500 a Martínez": plata sin línea. El concepto se pregunta.
        const item: ItemPedido = {};
        if (ponerPrecio(item, elegido.token)) abrirItem(item);
        usado = elegido;
      }
      // Y si TODOS los ítems ya tienen precio, este número sobra de verdad:
      // cae en `precios_sin_ubicar` acá abajo y el flujo pregunta qué más se
      // vendió. Crearle un ítem sin concepto sería inventar una línea.
    }
  }

  // LO QUE QUEDÓ MARCADO COMO PRECIO Y NO ENTRÓ EN NINGÚN LADO.
  //
  // Es el freno de FISCAL-1: mientras haya uno, el mensaje nombraba más venta
  // de la que se pudo leer y el pedido NO está completo. Ver `precios_sin_ubicar`.
  for (const n of sueltos) {
    if (n === usado || !n.marcado) continue;
    // "a 30 días" y "de 25 kg" llevan la misma marca y no son plata.
    if (UNIDADES_NO_PRECIO.has(n.posterior)) continue;
    pedido.precios_sin_ubicar.push(n.token);
  }
  if (pedido.precios_sin_ubicar.length > 0) {
    pedido.detalles.push(
      `Quedaron ${pedido.precios_sin_ubicar.length} número(s) escritos como precio ` +
        `(${pedido.precios_sin_ubicar.join(", ")}) que no pertenecen a ningún ítem leído: ` +
        "el pedido NO está completo, falta preguntar qué más se vendió.",
    );
  }

  // Los campos y el eco, ya con los ítems armados.
  pedido.items.forEach((item, i) => {
    const ordinal = pedido.items.length === 1 ? "" : ` (ítem ${i + 1})`;
    if (item.concepto !== undefined) {
      pedido.campos.push("concepto");
      pedido.detalles.push(`Concepto${ordinal}: "${item.concepto}".`);
    }
    if (item.cantidad !== undefined) {
      pedido.campos.push("cantidad");
      pedido.detalles.push(`Cantidad${ordinal}: ${item.cantidad}.`);
    }
    if (item.precio !== undefined) pedido.campos.push("precio");
  });

  // --- Las señales que no son números --------------------------------------
  if (MARCA_IVA_APARTE.test(norm)) {
    pedido.montos_brutos = false;
    pedido.campos.push("montos_brutos");
    pedido.detalles.push("El usuario dijo que el IVA va aparte: los precios son netos.");
  } else if (MARCA_IVA_INCLUIDO.test(norm)) {
    pedido.montos_brutos = true;
    pedido.campos.push("montos_brutos");
    pedido.detalles.push("El usuario dijo que el precio ya incluye IVA.");
  }

  if (sugiereDolares(texto)) {
    pedido.moneda = "USD";
    pedido.campos.push("moneda");
    pedido.detalles.push("El texto habla de dólares.");
  } else if (MARCA_PESOS.test(norm)) {
    pedido.moneda = "UYU";
    pedido.campos.push("moneda");
    pedido.detalles.push("El texto habla de pesos.");
  }

  if (MARCA_CREDITO.test(norm)) {
    pedido.forma_pago = 2;
    pedido.campos.push("forma_pago");
    pedido.detalles.push("Es a crédito: va a hacer falta la fecha de vencimiento.");
  } else if (MARCA_CONTADO.test(norm)) {
    pedido.forma_pago = 1;
    pedido.campos.push("forma_pago");
    pedido.detalles.push("Es al contado.");
  }

  return pedido;
}

/** Junta las palabras del concepto desde `inicio`. Devuelve dónde cortó. */
function recolectarConcepto(
  tokens: readonly string[],
  inicio: number,
): { concepto?: string; hasta: number } {
  const partes: string[] = [];
  let j = inicio;
  // El relleno del principio se saltea: "una docena de empanadas" es un ítem
  // de empanadas, no uno de "de empanadas".
  while (j < tokens.length && esRellenoConcepto(tokens[j]!)) j += 1;
  while (j < tokens.length && partes.length < 6) {
    const t = tokens[j]!;
    if (!esPalabraConcepto(t) && !(partes.length > 0 && esRellenoConcepto(t))) break;
    partes.push(t);
    j += 1;
  }
  while (partes.length > 0 && esRellenoConcepto(partes[partes.length - 1]!)) {
    partes.pop();
    j -= 1;
  }
  return partes.length === 0 ? { hasta: inicio } : { concepto: partes.join(" "), hasta: j };
}

/**
 * ¿Alcanza lo extraído para tratar el mensaje como un pedido de emisión?
 *
 * DOS CAMPOS, o UNO con el verbo adelante. El umbral no es arbitrario: un campo
 * suelto sin verbo es cualquier frase con un nombre o un número adentro —el
 * falso positivo manda a alguien a un flujo de emisión que no pidió—, mientras
 * que "sale factura para Pérez" trae un solo campo y no puede ser otra cosa.
 *
 * El costo de los dos errores no es simétrico y por eso el umbral está de este
 * lado: enrutar de más abre una pregunta ("¿a quién le facturás?") que se
 * cancela con una palabra; enrutar de menos devuelve el menú entero a alguien
 * que ya escribió exactamente lo que quería.
 */
export function esPedidoDeEmision(pedido: PedidoEmision): boolean {
  if (pedido.campos.length >= 2) return true;
  return pedido.verbo && pedido.campos.length >= 1;
}
