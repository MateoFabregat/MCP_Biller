// =============================================================================
// La emisión guiada por WhatsApp: de "quiero facturar" a un CFE, sin jerga.
//
// EL PROBLEMA QUE RESUELVE
//
// `biller_requisitos_comprobante` ya sabe decir qué falta para emitir. Pero
// exige `tipo_comprobante` como ENTRADA, y ahí está el agujero: el dueño de la
// PyME no sabe —ni tiene por qué saber— si lo que necesita es un 101 o un 111.
// Preguntárselo con esas palabras es pedirle que resuelva él la parte que el
// sistema puede resolver solo.
//
// La pregunta que sí sabe contestar es OTRA: "¿a quién le estás facturando?".
// Si es una empresa con RUT, es e-Factura. Si es alguien que se lleva algo del
// mostrador, es e-Ticket. El tipo de comprobante SE DEDUCE de eso, y de un dato
// que el usuario ya tiene en la mano. Ver `tipoComprobanteSugerido`.
//
// POR QUÉ ESTO ES CÓDIGO Y NO PROMPT
//
// Mismo criterio que `menu.ts`: la secuencia de preguntas, los ids que vuelven
// cuando el usuario toca un botón, y sobre todo la DERIVACIÓN del tipo de
// comprobante son decisiones fiscales. Un modelo que improvisa "creo que esto
// es un e-Ticket" produce un comprobante mal emitido que hay que anular con una
// nota de crédito. La regla vive acá, se testea, y no cambia de humor.
//
// LO QUE ESTE MÓDULO NO HACE
//
// No mantiene estado entre mensajes. El hilo de la conversación lo lleva el
// Agent Node, que para eso tiene el historial. Acá se responde una sola
// pregunta, siempre la misma: "dado lo que ya se sabe, ¿qué sigue?". Eso hace
// que el flujo sea reanudable desde cualquier punto —el usuario contesta tres
// cosas juntas, o se va y vuelve mañana— sin una máquina de estados que se
// desincronice con lo que el usuario cree que pasó.
//
// Tampoco escribe los mensajes. Acá se decide QUÉ preguntar; los submenús que
// el usuario ve los arma `render.ts`, que es el único lugar del proyecto donde
// se redacta lo que sale por WhatsApp. La dependencia va en un solo sentido.
// =============================================================================

import { FORMAS_PAGO, INDICADORES_FACTURACION, TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { hoyDgiUy } from "../services/fechaUy.js";
import { formatearUy, montoConSigno } from "../services/importe.js";
import type { InteractivoBotones, InteractivoLista } from "./client.js";
import { PREFIJO_PASO } from "./protocolo.js";
import {
  construirDesempateReceptor,
  construirListaClientes,
  construirSubmenuConceptoExtra,
  construirSubmenuFecha,
  construirSubmenuFormaPago,
  construirSubmenuIva,
  construirSubmenuIvaFusionado,
  construirSubmenuLineaSinDescripcion,
  construirSubmenuMoneda,
  construirSubmenuMontosBrutos,
  construirSubmenuPrecioNoPositivo,
  construirSubmenuReceptor,
  construirSubmenuReceptorOpcional,
} from "./render.js";

// `PREFIJO_PASO` se re-exporta desde acá para no romper a quien ya lo importaba
// por este módulo; su definición vive en `protocolo.ts`, con sus tres hermanos.
export { PREFIJO_PASO } from "./protocolo.js";

/** A quién se le factura. Es la única pregunta de fondo que hay que hacer. */
export type ClaseReceptor = "empresa" | "consumidor_final";

/**
 * Los pasos, en orden. El primero que no esté resuelto es el que se pregunta.
 *
 * UNA COSA POR MENSAJE, Y NO "UNA PREGUNTA POR MENSAJE"
 *
 * El paso de ítems antes era uno solo y pedía tres datos juntos: "qué es,
 * cuántos y a qué precio". Eso es un formulario disfrazado de pregunta. En un
 * chat, quien contesta desde el mostrador manda "2 bolsas" y se queda esperando
 * — y el que tiene que reconstruir qué falta es el modelo, justo lo que este
 * módulo existe para evitar.
 *
 * Ahora cada dato es su propio paso: concepto → precio → IVA. Son más mensajes,
 * pero cada uno se contesta con una palabra o un toque, y en cualquier momento
 * se puede cortar y retomar sin que nadie tenga que acordarse de qué le faltaba.
 *
 * Eso NO significa preguntar lo que ya se sabe: quien escribe "facturale a
 * Pérez 2 bolsas de harina a 6000" llega con todo resuelto y va derecho al
 * preview. El orden es la ruta más larga, no la obligatoria.
 *
 * LO QUE DEJÓ DE SER UN PASO, Y POR QUÉ
 *
 * Una emisión a un cliente conocido hacía DOCE preguntas. Medido: incluso
 * arrancando con "facturale a Pérez 2 bolsas a 6500" quedaban siete. Cada una
 * es un mensaje más para alguien que tiene a un cliente esperando enfrente.
 *
 * Cinco de esas doce se contestaban solas y ahora las contesta el código:
 *
 *   · `fecha` → hoy. Es la respuesta el 99% de las veces, y el 1% restante se
 *     escribe ("para el viernes") sin que nadie tenga que tocar un botón.
 *   · `forma_pago` → contado.
 *   · `moneda` → UYU, salvo que el texto del usuario hable de dólares.
 *   · `cantidad` → 1 cuando no vino en el mensaje.
 *   · `precio_incluye_iva` + `iva` → UN paso con tres botones.
 *
 * Y dos se mudaron al preview de confirmación, que es donde el usuario ya está
 * mirando el comprobante entero: `otro_item` (botón ➕ Otro ítem) y `adenda`
 * (se escribe: "ponele una nota: orden 4471").
 *
 * NINGÚN DEFAULT ES SILENCIOSO. Los cinco aparecen en el preview antes de
 * emitir — la fecha, la forma de pago y el criterio de IVA en la línea de
 * supuestos, la cantidad como "1 × concepto". Un default que el usuario no ve
 * no es un default, es una suposición nuestra impresa en un documento fiscal.
 */
export type PasoEmision =
  | "receptor"
  | "fecha"
  | "cliente"
  | "datos_cliente_nuevo"
  | "moneda"
  | "tasa_cambio"
  | "forma_pago"
  | "fecha_vencimiento"
  | "concepto"
  | "precio"
  | "precio_incluye_iva"
  | "iva"
  | "confirmar";

/** Un ítem en construcción. Se completa campo por campo, en su propio paso. */
export interface ItemEnCurso {
  concepto?: string;
  cantidad?: number;
  precio?: number;
  indicador_facturacion?: number;
  /**
   * true cuando el precio admitía dos lecturas y se guardó la más probable
   * ("6.50" es 6,50 o 6.500 — cien veces de diferencia).
   *
   * VIVE ACÁ PORQUE TIENE QUE SOBREVIVIR HASTA EL PREVIEW, y el estado es lo
   * único que sobrevive entre un mensaje y el siguiente. `extraerPedido.ts` lo
   * viene marcando desde siempre, pero la marca se perdía al volcarse al
   * estado: el preview mostraba "$13" sin una palabra, cuando el usuario había
   * escrito lo que probablemente eran $13.000.
   *
   * NO es un campo del CFE y no entra al borrador: se rinde como TEXTO en el
   * resumen de confirmación (ver `ContextoPreview.precios_ambiguos`).
   */
  precio_ambiguo?: boolean;
  /**
   * true cuando el precio NO es un hueco: salió de un comprobante ya emitido.
   *
   * Lo pone `repetir_ultima_de` sobre los ítems que copia, y existe por un solo
   * caso que sin él no tiene salida: la línea BONIFICADA. Una factura con
   * "Bonificación $0" al final se repite tal cual, pero `itemIncompleto` trata
   * un precio 0 como "todavía no me lo dijeron" y el flujo pedía el precio de
   * esa línea… que ya estaba dicho. Contestar "0" no salía del paso, "listo" y
   * "no va" tampoco, y el paso `precio` no tiene botones: el número mudo. Y la
   * salida que sí funcionaba era peor —contestar "60" convertía la bonificación
   * en una línea de $60 y "lo de siempre" salía $13.060 en vez de $13.000—.
   *
   * NO es un campo del CFE y no entra al borrador. Y no lo puede mandar el
   * agente: no está en el schema de la tool, lo pone solo el server al copiar.
   * Si el agente reenvía `items` explícitos, la marca se pierde y el flujo
   * vuelve a preguntar — que es lo correcto: ese precio ya no viene de la
   * factura vieja sino del modelo.
   */
  precio_copiado?: boolean;
  /** El usuario confirmó explícitamente que un precio cero/negativo se deja así. */
  precio_no_positivo_confirmado?: boolean;
}

/**
 * EL PERFIL DE LA CASA: los defaults que salen del historial de la empresa.
 *
 * QUÉ PROBLEMA RESUELVE
 *
 * Después de sacar cinco preguntas del flujo (fecha, moneda, forma de pago,
 * cantidad, tasa de IVA) quedó UNA que se sigue haciendo casi siempre: si el
 * precio ya trae el IVA adentro. Y es la única que no se puede defaultear
 * mirando el mensaje, porque los dos valores posibles están bien para mitad del
 * mundo cada uno: la panadería cotiza con IVA incluido, el mayorista lo suma
 * aparte. Ninguna de las dos cambia de opinión entre facturas.
 *
 * O sea que el dato no está en el mensaje: está en las últimas facturas de ESTA
 * empresa. Eso es este perfil — no las preferencias del CLIENTE (esas ya las
 * copia `repetir_ultima_de`), sino la costumbre de la casa.
 *
 * DÓNDE ENTRA EN LA CADENA DE PRECEDENCIA
 *
 *   lo que dijo el usuario  >  lo leído de su texto  >  PERFIL  >  default duro
 *
 * Justo arriba del default duro y debajo de todo lo demás. Se aplica en
 * `aplicarDefaults`, o sea en una COPIA: el borrador guardado sigue teniendo
 * solo lo que dijo el usuario (ver `perfil_casa` en `EstadoEmision`).
 *
 * POR QUÉ LOS CAMPOS NO SE DERIVAN TODOS CON EL MISMO CRITERIO
 *
 * `montos_brutos` e `indicador_facturacion` exigen UNANIMIDAD sobre una muestra
 * mínima; `moneda` y `forma_pago` se conforman con mayoría. La asimetría no es
 * gusto: equivocarse en el criterio de IVA cambia el total un 22% y el
 * comprobante sale igual de bien formado, así que ahí "casi siempre" no
 * alcanza. Una moneda equivocada se ve en cada línea del preview y una forma de
 * pago equivocada se ve escrita en la línea de supuestos.
 *
 * Ver `derivarPerfilCasa` en `services/repetirUltima.ts`, que es quien lo arma
 * (y quien tiene los conteos).
 */
export interface PerfilCasa {
  /** Siempre true. Marca, adentro del dato, que esto NO lo dijo el usuario. */
  derivado: true;
  /** Sobre cuántos CFE aceptados se derivó. Menos que el mínimo = no se deriva nada. */
  muestras: number;
  /** Ventana de emisión que se miró, en aaaa-mm-dd. */
  desde?: string;
  hasta?: string;
  /** Solo si los `muestras` comprobantes COINCIDEN todos. */
  montos_brutos?: boolean;
  /** Solo si coinciden todos, y solo si cada comprobante usaba una sola tasa. */
  indicador_facturacion?: number;
  /** Por mayoría estricta (más de la mitad). */
  moneda?: string;
  /** Por mayoría estricta (más de la mitad). */
  forma_pago?: number;
  /**
   * Una línea por campo derivado, y una por campo que NO se pudo derivar.
   *
   * Es lo que hace auditable un default que el usuario no dictó: dice cuántos
   * comprobantes se miraron y qué contestaron. No lleva NADA de texto de un
   * comprobante (ni conceptos ni razones sociales): solo códigos y conteos.
   */
  detalles: string[];
}

/**
 * Lo que se sabe hasta ahora. Todo opcional: el punto de entrada real es
 * "quiero facturarle a Pérez 2 bolsas a 6000", que llega con varios campos
 * cargados de una y salteando los primeros pasos.
 */
export interface EstadoEmision {
  clase_receptor?: ClaseReceptor;
  /** Fecha de emisión en dd/mm/aaaa, como la espera Biller. */
  fecha_emision?: string;
  /** RUT o CI del receptor, como lo escribió el usuario. */
  documento?: string;
  /** Razón social o nombre. */
  nombre_cliente?: string;
  /**
   * true = consumidor final que NO se identifica.
   *
   * Es un valor explícito y no la ausencia de `documento`: "no me lo dio" y
   * "todavía no se lo pregunté" llevan a pasos distintos, y confundirlos hace
   * que el flujo pregunte el documento para siempre o que no lo pregunte nunca.
   */
  sin_receptor?: boolean;
  /**
   * true si a este cliente ya se le facturó antes (o sea: existe en Biller).
   *
   * Biller NO tiene endpoint de lectura de clientes —hay 7 GET en toda la API y
   * ninguno los lista—, así que la única forma de saberlo es mirar los
   * comprobantes ya emitidos. Importa porque dar de alta un cliente en la misma
   * llamada de emisión EXIGE dirección y ciudad: sin eso la API contesta 422 y
   * el usuario perdió la conversación entera en el último paso.
   */
  cliente_ya_facturado?: boolean;
  direccion_cliente?: string;
  ciudad_cliente?: string;
  /** Ítems ya recolectados. El último puede estar a medio cargar. */
  items?: ItemEnCurso[];
  /** true cuando el usuario dijo que no agrega más ítems. */
  items_cerrados?: boolean;
  /** Código de INDICADORES_FACTURACION. Se pregunta una vez y vale de default. */
  indicador_facturacion?: number;
  moneda?: string;
  /**
   * true cuando el TEXTO del usuario dejó la moneda en duda ("son 200 dólares").
   *
   * Es lo que convierte el default de moneda en algo defendible. Sin esta
   * marca hay dos opciones y las dos están mal: preguntar siempre (un paso más
   * para el 95% que factura en pesos) o defaultear siempre a UYU (una factura
   * en pesos por un precio que el usuario cotizó en dólares — un error de 40x
   * que además queda perfectamente bien formado ante DGI).
   *
   * Con la marca, el default vale para el silencio y la pregunta aparece justo
   * cuando hay algo que desambiguar. La pone `sugiereDolares` desde el mensaje;
   * `siguientePaso` no lee texto libre, solo este booleano.
   */
  moneda_dudosa?: boolean;
  /**
   * Pesos por unidad de la moneda extranjera. Solo cuando la moneda no es UYU.
   *
   * Sin esto, `totalEnPesos` devuelve null y el chequeo del umbral de 5.000 UI
   * queda INDETERMINADO — justo sobre el comprobante en dólares, que es el que
   * más chance tiene de superarlo. La API lo completa sola con la cotización del
   * cierre anterior, pero entonces el número que aprobó el usuario y el que se
   * emite pueden no ser el mismo.
   */
  tasa_cambio?: number;
  /** Código de FORMAS_PAGO: 1 contado, 2 crédito. */
  forma_pago?: number;
  /**
   * Vencimiento en dd/mm/aaaa. OBLIGATORIO cuando `forma_pago = 2` (crédito).
   *
   * Sin fecha de vencimiento, una venta a crédito no aparece en
   * `biller_vencimientos` ni sale en "¿quién me debe?": la cobranza queda
   * invisible justo en el comprobante que se emitió para cobrar después.
   */
  fecha_vencimiento?: string;
  /**
   * true = los precios de los ítems YA INCLUYEN IVA.
   *
   * Es el campo `montos_brutos` de la API, y es el que más plata mueve de todo
   * este módulo. En Uruguay el precio de mostrador se cotiza CON IVA adentro:
   * "la pelota, $200" son doscientos pesos que paga el cliente. Si no se manda
   * el campo, Biller entiende que $200 es el neto y le suma 22%: la factura sale
   * $244 y el comprobante queda perfectamente bien formado.
   *
   * Por eso es un valor explícito de tres estados (true / false / sin
   * preguntar) y no un default: los dos defaults posibles están mal para la
   * mitad de los casos.
   */
  montos_brutos?: boolean;
  /**
   * Nota al pie del comprobante. Texto libre del usuario.
   *
   * YA NO ES UN PASO. Preguntar "¿querés agregar una nota?" al final de un
   * flujo largo es poner una pregunta abierta justo donde la gente abandona, y
   * la respuesta es "no" casi siempre. Se setea escribiéndola en cualquier
   * momento del flujo ("ponele una nota: orden 4471"): el enrutador manda eso a
   * `flujo_emision` y el agente lo pasa como `adenda`.
   */
  adenda?: string;
  /**
   * true cuando el usuario dijo explícitamente que no quiere adenda.
   *
   * Sobrevive a la eliminación del paso porque los borradores guardados de
   * antes lo traen, y porque sigue siendo un dato honesto: "me lo preguntaron y
   * dije que no". Ya no cambia ningún camino del flujo.
   */
  sin_adenda?: boolean;
  /**
   * EL PERFIL DE LA CASA, CACHEADO. NO ES UNA RESPUESTA DEL USUARIO.
   *
   * Es lo único de `EstadoEmision` que no salió de la conversación: se deriva
   * del historial de CFE de la empresa (ver `derivarPerfilCasa`) y vive acá
   * SOLO como cache, para no volver a consultarlo en cada mensaje de la misma
   * sesión.
   *
   * Tres propiedades lo mantienen distinguible de un dato dicho, y las tres
   * importan porque el borrador guardado es la BASE sobre la que se fusiona lo
   * que llega (`fusionarEstado`):
   *
   *   · Va bajo su propia clave. Los valores derivados NUNCA se escriben en
   *     `montos_brutos`, `moneda`, `forma_pago` ni `indicador_facturacion` del
   *     estado guardado: se aplican en la COPIA que devuelve `aplicarDefaults`,
   *     igual que la fecha de hoy o la cantidad 1.
   *   · Lleva `derivado: true` adentro, así que un volcado del borrador lo
   *     declara solo.
   *   · No se puede inyectar desde afuera: `biller_emision_guiada` no acepta
   *     ningún parámetro que lo escriba. Solo lo pone el server.
   *
   * Si esto se guardara como si el usuario lo hubiera dicho, una corrección
   * posterior ("no, este va sin IVA adentro") tendría que discutirle a un dato
   * de la misma jerarquía. Así, pisa un `undefined` y no hay nada que discutir.
   */
  perfil_casa?: PerfilCasa;
  /**
   * Identificador de deduplicación, generado por el server al abrir el borrador.
   *
   * Es la respuesta al warning que salía en CADA emisión guiada: "sin
   * numero_interno no hay forma de deduplicar". Pedírselo al agente era pedirle
   * que invente un id único —justo el tipo de tarea en la que un retry produce
   * el mismo texto o uno distinto según el humor—. El server lo genera UNA vez
   * al crear el borrador y lo conserva: un reintento de la misma emisión lleva
   * el mismo id (la API lo rechaza como duplicado, que es el punto), y un
   * borrador nuevo lleva otro.
   */
  numero_interno?: string;
}

/**
 * Hoy en el formato que espera Biller (dd/mm/aaaa), en hora de Uruguay.
 *
 * Antes usaba los getters locales del proceso. En un contenedor —que corre en
 * UTC, y este proyecto no fija `TZ` en ningún lado— eso significa que un
 * comercio facturando a las 21:30 de Montevideo recibía la fecha de MAÑANA en
 * un CFE real. Ver `services/fechaUy.ts`.
 */
export function hoyDgi(ahora: Date = new Date()): string {
  return hoyDgiUy(ahora);
}

// --- Documento: qué es lo que me pasaron ------------------------------------

/**
 * RUT uruguayo: 12 dígitos. Cédula: 7 u 8.
 *
 * La distinción no es cosmética: define el tipo de CFE. Por eso `desconocido`
 * es un resultado de primera clase y no un default silencioso — un número de 9
 * dígitos no es un RUT corto, es un dato que hay que volver a pedir.
 */
export interface DocumentoClasificado {
  tipo: "rut" | "ci" | "desconocido";
  /** Solo dígitos. */
  normalizado: string;
  /** Qué clase de receptor implica, si es que implica alguna. */
  clase: ClaseReceptor | null;
  detalle: string;
}

export function clasificarDocumento(raw: string): DocumentoClasificado {
  const normalizado = raw.replace(/\D/g, "");

  if (normalizado.length === 12) {
    return {
      tipo: "rut",
      normalizado,
      clase: "empresa",
      detalle: "12 dígitos: es un RUT. El receptor es una empresa, así que corresponde e-Factura.",
    };
  }
  if (normalizado.length === 7 || normalizado.length === 8) {
    return {
      tipo: "ci",
      normalizado,
      clase: "consumidor_final",
      detalle:
        `${normalizado.length} dígitos: es una cédula. El receptor es una persona, así que ` +
        "corresponde e-Ticket (con el receptor identificado).",
    };
  }
  return {
    tipo: "desconocido",
    normalizado,
    clase: null,
    detalle:
      `"${raw}" no tiene forma de RUT (12 dígitos) ni de cédula (7 u 8): tiene ${normalizado.length}. ` +
      "Hay que volver a pedirlo; no se puede deducir el tipo de comprobante de un documento dudoso.",
  };
}

// --- La derivación del tipo de comprobante ----------------------------------

export interface TipoSugerido {
  tipo_comprobante: number;
  etiqueta: string;
  motivo: string;
  /** true si el receptor DEBE ir identificado con documento. */
  exige_receptor: boolean;
}

/**
 * De "a quién le facturo" al código de CFE.
 *
 * Es a propósito el caso simple y solo el caso simple: e-Ticket y e-Factura
 * cubren la venta de mostrador y la venta a empresa, que es el 99% de lo que
 * emite una PyME por WhatsApp. Exportación, venta por cuenta ajena y resguardos
 * NO se deducen acá: son decisiones con consecuencias fiscales que nadie debería
 * tomar por inferencia desde un chat. Para esos casos el flujo deriva al
 * catálogo completo en vez de adivinar.
 */
export function tipoComprobanteSugerido(clase: ClaseReceptor): TipoSugerido {
  if (clase === "empresa") {
    return {
      tipo_comprobante: 111,
      etiqueta: TIPOS_COMPROBANTE[111] ?? "e-Factura",
      motivo:
        "El receptor es una empresa con RUT: DGI exige e-Factura (111) con el receptor identificado, " +
        "sin importar el monto.",
      exige_receptor: true,
    };
  }
  return {
    tipo_comprobante: 101,
    etiqueta: TIPOS_COMPROBANTE[101] ?? "e-Ticket",
    motivo:
      "El receptor es un consumidor final: corresponde e-Ticket (101). Si el importe supera el " +
      "umbral de 5.000 UI hay que identificarlo igual — eso lo chequea " +
      "biller_requisitos_comprobante con el total real.",
    exige_receptor: false,
  };
}

/**
 * ¿El texto del usuario habla de dólares?
 *
 * El comentario de `construirSubmenuMoneda` declaraba desde siempre que la
 * moneda "solo se pregunta si algo en el mensaje sugiere que no es UYU" — y el
 * código la preguntaba SIEMPRE. Esta función es lo que hacía falta para que la
 * declaración fuera cierta.
 *
 * Es a propósito estrecha: solo detecta lo que nombra al dólar. No intenta
 * inferir "es un monto chico, debe ser en pesos" ni nada por el estilo. Un
 * falso positivo cuesta una pregunta; un falso negativo emite una factura en
 * pesos por un precio cotizado en dólares, que es un error de 40x. Ante la duda
 * conviene preguntar, así que el sesgo va para ese lado.
 */
export function sugiereDolares(texto: string): boolean {
  const limpio = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  // "u$s", "us$" y "usd" no sobreviven a un \b (el $ ya es límite de palabra),
  // así que van por inclusión directa.
  if (limpio.includes("u$s") || limpio.includes("us$") || limpio.includes("usd")) return true;
  return /\bdolar(es)?\b/.test(limpio);
}

// --- Leer lo que contestó el usuario ----------------------------------------

export type RespuestaPaso =
  | { paso: "receptor"; clase: ClaseReceptor }
  | { paso: "receptor_no_se" }
  | { paso: "cliente"; documento: string }
  | { paso: "cliente_otro" }
  | { paso: "cliente_sin_identificar" }
  | { paso: "fecha_hoy" }
  | { paso: "fecha_otra" }
  | { paso: "cantidad"; cantidad: number }
  | { paso: "item_otro" }
  | { paso: "item_listo" }
  | { paso: "item_cancelar" }
  | { paso: "item_descartar"; posicion?: number; precio?: number }
  | { paso: "item_conservar_precio"; posicion: number; precio: number }
  | { paso: "item_descartar_precio"; posicion: number; precio: number }
  | { paso: "iva_otro" }
  | { paso: "iva"; indicador_facturacion: number }
  | { paso: "moneda"; moneda: string }
  | { paso: "forma_pago"; forma_pago: number }
  | { paso: "montos_brutos"; incluye_iva: boolean }
  | { paso: "tasa_cambio"; tasa: number }
  | { paso: "ninguna" };

/** Saca tildes, baja a minúsculas y colapsa espacios. Para comparar lo que se escribió. */
function normalizarLibre(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Interpreta lo que el usuario ESCRIBIÓ, no lo que tocó, acotado al paso en curso.
 *
 * POR QUÉ HACE FALTA. `interpretarPaso` solo entiende ids de botón. Eso alcanza
 * mientras el usuario toque, y no siempre toca: el botón quedó arriba en el
 * chat, contesta desde el reloj, o simplemente escribe porque está apurado.
 * Cuando eso pasaba, el mensaje no matcheaba nada, el estado no cambiaba y el
 * flujo volvía a hacer LA MISMA PREGUNTA. Para siempre.
 *
 * Y el caso peor era el que la propia pregunta invitaba: en el paso `cliente` el
 * texto dice —textual— 'decime "sin identificar" y sigo'. Escribir exactamente
 * eso no hacía nada. Una pregunta que rechaza su propia respuesta sugerida es la
 * peor forma de este bug, porque el usuario no tiene ninguna razón para dudar de
 * lo que escribió.
 *
 * VA ACOTADO AL PASO, y ahí está la seguridad de esto: "sin identificar" solo
 * significa algo cuando lo que se preguntó fue el cliente, y "no" significa
 * cosas distintas según dónde caiga. Interpretar texto libre sin saber qué se
 * preguntó es adivinar; interpretarlo contra una pregunta concreta es leer.
 *
 * Devuelve `ninguna` ante la duda: que el agente repregunte es barato, y que un
 * texto ambiguo mueva el flujo solo, no.
 */
export function interpretarRespuestaLibre(raw: string, paso: string): RespuestaPaso {
  const t = normalizarLibre(raw);
  if (t === "") return { paso: "ninguna" };
  const es = (...frases: string[]): boolean => frases.includes(t);

  switch (paso) {
    case "receptor":
      if (es("consumidor final", "final", "consumidor", "mostrador", "a consumidor final"))
        return { paso: "receptor", clase: "consumidor_final" };
      if (es("empresa", "a una empresa", "con rut", "rut", "una empresa"))
        return { paso: "receptor", clase: "empresa" };
      if (es("no se", "no sé", "ni idea", "no tengo idea")) return { paso: "receptor_no_se" };
      return { paso: "ninguna" };

    case "cliente":
      // La frase que la pregunta sugiere, y las que dice la gente en su lugar.
      if (es("sin identificar", "sin datos", "no tiene", "no tengo", "sin cliente", "no", "mostrador"))
        return { paso: "cliente_sin_identificar" };
      if (es("otro", "otro cliente", "no es ese")) return { paso: "cliente_otro" };
      return { paso: "ninguna" };

    case "moneda":
      if (es("pesos", "peso", "uyu", "en pesos", "pesos uruguayos"))
        return { paso: "moneda", moneda: "UYU" };
      if (es("dolares", "dolar", "usd", "en dolares")) return { paso: "moneda", moneda: "USD" };
      return { paso: "ninguna" };

    case "montos_brutos":
      // La pregunta del mostrador uruguayo: ¿el precio que dijiste ya lleva IVA?
      if (es("si", "con iva", "iva incluido", "ya incluye", "incluye iva", "si ya incluye"))
        return { paso: "montos_brutos", incluye_iva: true };
      if (es("no", "sin iva", "no incluye", "mas iva", "sin el iva"))
        return { paso: "montos_brutos", incluye_iva: false };
      return { paso: "ninguna" };

    case "item":
      if (es("listo", "nada mas", "ya esta", "eso es todo", "no mas", "terminamos"))
        return { paso: "item_listo" };
      if (es("otro", "otro mas", "agrego otro", "uno mas")) return { paso: "item_otro" };
      return { paso: "ninguna" };

    case "fecha":
      if (es("hoy", "de hoy", "hoy mismo")) return { paso: "fecha_hoy" };
      return { paso: "ninguna" };

    case "tasa_cambio": {
      // "PESOS" ACÁ NO ES RUIDO: ES UNA CORRECCIÓN.
      //
      // A este paso se llega porque la moneda quedó en USD —muchas veces por el
      // `perfil_casa`, que la heredó de los últimos comprobantes de la empresa,
      // no porque nadie la haya dicho—. Si el usuario contesta "pesos", está
      // arreglando eso, y sin esto se lo ignoraba y se le seguía pidiendo una
      // cotización que no corresponde. Peor: si después tipeaba un número, ese
      // número quedaba como tasa y la venta salía en dólares. "2 bolsas a 480"
      // a 40 pesos por dólar son $38.400 en vez de $960.
      if (es("pesos", "peso", "uyu", "en pesos", "son pesos", "es en pesos")) {
        return { paso: "moneda", moneda: "UYU" };
      }
      // La pregunta dice "Decime cuántos pesos vale uno (por ejemplo 40)", así
      // que un número pelado es LA respuesta esperada, no una casualidad.
      //
      // Se lee del RAW y no de `normalizarLibre`, que borra los signos: "40,5"
      // quedaba como "40 5" y se leía NaN. Y acá la coma es el separador
      // decimal, así que perderla no es perder un signo — es perder el precio.
      const n = Number(raw.trim().replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) && n > 0 ? { paso: "tasa_cambio", tasa: n } : { paso: "ninguna" };
    }

    default:
      return { paso: "ninguna" };
  }
}

/**
 * Interpreta el id que vuelve de un botón o fila de la emisión guiada.
 *
 * Devuelve `ninguna` para todo lo que no reconoce, en vez de tirar: un id que
 * no se entiende tiene que poder caer al enrutador general y terminar en una
 * respuesta, no en una excepción que deja al usuario sin contestación.
 */
export function interpretarPaso(raw: string): RespuestaPaso {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_PASO)) return { paso: "ninguna" };
  const resto = texto.slice(PREFIJO_PASO.length);
  const sep = resto.indexOf(":");
  if (sep === -1) return { paso: "ninguna" };
  const campo = resto.slice(0, sep);
  const valor = resto.slice(sep + 1);

  switch (campo) {
    case "receptor":
      if (valor === "empresa") return { paso: "receptor", clase: "empresa" };
      if (valor === "final") return { paso: "receptor", clase: "consumidor_final" };
      if (valor === "no_se") return { paso: "receptor_no_se" };
      return { paso: "ninguna" };
    case "cliente":
      if (valor === "otro") return { paso: "cliente_otro" };
      if (valor === "sin_identificar") return { paso: "cliente_sin_identificar" };
      return { paso: "cliente", documento: valor };
    case "fecha":
      if (valor === "hoy") return { paso: "fecha_hoy" };
      if (valor === "otra") return { paso: "fecha_otra" };
      return { paso: "ninguna" };
    case "cantidad": {
      const n = Number(valor);
      return Number.isFinite(n) && n > 0 ? { paso: "cantidad", cantidad: n } : { paso: "ninguna" };
    }
    case "item":
      if (valor === "otro") return { paso: "item_otro" };
      if (valor === "listo") return { paso: "item_listo" };
      if (valor === "cancelar") return { paso: "item_cancelar" };
      // "🗑️ Sacar $250": el descarte EXPLÍCITO de una línea con plata. Es un id
      // propio y no un `cancelar` con otro texto justamente porque hace algo
      // que `cancelar` tiene prohibido hacer.
      //
      // Y LLEVA ADENTRO A QUÉ LÍNEA APUNTABA: `descartar:2:250` es la línea 2,
      // la de $250. Es la misma idea que el `confirmation_token` adentro del
      // botón de emitir —el id ata lo que se toca a lo que se leyó—, en chico:
      // sin eso, un botón tocado diez minutos después, con el borrador ya
      // cambiado, sacaba lo que hubiera quedado en esa posición o no hacía
      // nada y el chat quedaba mudo.
      if (valor === "descartar") return { paso: "item_descartar" };
      if (valor.startsWith("descartar:")) {
        const partes = valor.split(":");
        const posicion = Number(partes[1]);
        const precio = partes[2] === "" || partes[2] === undefined ? NaN : Number(partes[2]);
        return {
          paso: "item_descartar",
          ...(Number.isInteger(posicion) && posicion > 0 ? { posicion } : {}),
          ...(Number.isFinite(precio) ? { precio } : {}),
        };
      }
      for (const [prefijo, paso] of [
        ["conservar_precio:", "item_conservar_precio"],
        ["descartar_precio:", "item_descartar_precio"],
      ] as const) {
        if (!valor.startsWith(prefijo)) continue;
        const partes = valor.slice(prefijo.length).split(":");
        const posicion = Number(partes[0]);
        const precio = Number(partes[1]);
        return Number.isInteger(posicion) && posicion > 0 && Number.isFinite(precio)
          ? { paso, posicion, precio }
          : { paso: "ninguna" };
      }
      return { paso: "ninguna" };
    case "iva": {
      const codigo = Number(valor);
      return Number.isInteger(codigo) && codigo in INDICADORES_FACTURACION
        ? { paso: "iva", indicador_facturacion: codigo }
        : { paso: "ninguna" };
    }
    case "moneda":
      return /^[A-Z]{3}$/.test(valor) ? { paso: "moneda", moneda: valor } : { paso: "ninguna" };
    case "pago": {
      const codigo = Number(valor);
      return Number.isInteger(codigo) && codigo in FORMAS_PAGO
        ? { paso: "forma_pago", forma_pago: codigo }
        : { paso: "ninguna" };
    }
    case "iva_incluido":
      // Los dos primeros contestan las DOS cosas: criterio de precio y tasa
      // básica. El tercero no contesta nada, abre la pregunta de la tasa.
      if (valor === "si") return { paso: "montos_brutos", incluye_iva: true };
      if (valor === "no") return { paso: "montos_brutos", incluye_iva: false };
      if (valor === "otro") return { paso: "iva_otro" };
      return { paso: "ninguna" };
    default:
      return { paso: "ninguna" };
  }
}

// --- Dirección y ciudad, en un solo mensaje ---------------------------------

/**
 * "Rivera 1234, Melo" -> { direccion: "Rivera 1234", ciudad: "Melo" }
 *
 * Eran dos preguntas seguidas y son un solo dato en la cabeza del usuario: nadie
 * dice su dirección sin la ciudad. Cobrarle dos mensajes al cliente NUEVO —el
 * único que pasa por acá, y el que más chance tiene de abandonar porque todavía
 * no vio ningún resultado— era el peor lugar posible para poner un paso de más.
 *
 * SE PARTE POR LA ÚLTIMA COMA, y no por la primera: las direcciones uruguayas
 * llevan comas adentro ("Av. Italia 1234, apto 302, Montevideo"). Con la
 * primera, el apartamento se convertía en la ciudad.
 *
 * Sin coma no se adivina: se devuelve todo como dirección y `ciudad` queda
 * `undefined`, así que el flujo repregunta SOLO la ciudad. Partir por el último
 * espacio ("Rivera 1234 Melo" -> ciudad "Melo") funcionaría en el ejemplo y
 * fallaría en "Ruta 8 km 32", dejando "32" como ciudad de un cliente real.
 */
export function separarDireccionCiudad(bruto: string): { direccion: string; ciudad?: string } {
  const texto = bruto.trim();
  const coma = texto.lastIndexOf(",");
  if (coma === -1) return { direccion: texto };

  const direccion = texto.slice(0, coma).trim();
  const ciudad = texto.slice(coma + 1).trim();
  // Una coma al final ("Rivera 1234,") no es una ciudad vacía: es una coma al
  // final. Y una dirección vacía ("‚ Melo") tampoco sirve de nada.
  if (direccion === "" || ciudad === "") return { direccion: texto.replace(/,\s*$/, "") };
  return { direccion, ciudad };
}

// --- Los defaults -----------------------------------------------------------

/** Qué campo se completó solo. Se usa para explicarlo en el preview. */
export type ClaveDefault =
  | "fecha_emision"
  | "moneda"
  | "forma_pago"
  | "cantidad"
  | "montos_brutos"
  | "indicador_facturacion";

export interface EstadoConDefaults {
  /** Copia del estado con los defaults ya puestos. El original no se toca. */
  estado: EstadoEmision;
  /** Qué se completó solo, para poder decirlo. */
  aplicados: ClaveDefault[];
  /**
   * Cuáles de esos vinieron del PERFIL DE LA CASA y no del default duro.
   *
   * Es un subconjunto de `aplicados`, no una lista aparte: para el preview los
   * dos son lo mismo (algo que el usuario no dijo y hay que mostrarle). La
   * distinción existe para poder explicarlo cuando pregunta —"lo pongo así
   * porque tus últimas cinco facturas fueron así"— y para poder MEDIR cuántas
   * preguntas ahorró el perfil.
   */
  del_perfil: ClaveDefault[];
}

/** Lo que `aplicarDefaults` necesita saber del mundo. Todo inyectable. */
export interface ContextoDefaults {
  /** Hoy en dd/mm/aaaa. Se inyecta para que la máquina de estados no lea el reloj. */
  hoy?: string;
  /**
   * El perfil de la casa, si ya se buscó.
   *
   * Se puede pasar acá o dejarlo en `estado.perfil_casa` (donde lo cachea la
   * sesión): lo de acá gana. Que el estado alcance es lo que hace que
   * `siguientePaso(estado)` siga siendo llamable con un solo argumento desde
   * cualquier lado sin perder el perfil.
   */
  perfil?: PerfilCasa | null;
}

/**
 * Completa lo que se puede contestar solo.
 *
 * POR QUÉ DEVUELVE UNA COPIA Y NO ESCRIBE EN EL ESTADO GUARDADO
 *
 * Es la decisión más importante de esta función y la que hace que las
 * correcciones sigan funcionando. En el borrador que se persiste,
 * `forma_pago: undefined` significa "no me dijeron nada" y `forma_pago: 1`
 * significa "el usuario dijo contado". Si el default se escribiera en el
 * borrador, los dos casos quedarían indistinguibles — y peor: `fusionarEstado`
 * trata lo guardado como base, así que el default escrito sería un dato con la
 * misma jerarquía que una respuesta del usuario.
 *
 * Manteniéndolo afuera, "es a crédito" dicho tres mensajes después llega como
 * `forma_pago: 2`, pisa un `undefined` y no hay nada que discutir. El default
 * se vuelve a calcular en cada lectura, que es exactamente lo que un default
 * tiene que ser: la respuesta al silencio, no un dato.
 *
 * Los cinco defaults, y por qué son defendibles:
 *
 *   · fecha = hoy. Se factura lo que se acaba de vender.
 *   · moneda = UYU, salvo que el texto haya hablado de dólares (ver
 *     `moneda_dudosa`). Ahí la pregunta vuelve, porque hay algo que resolver.
 *   · forma_pago = contado. Es el default de DGI y el del mostrador.
 *   · cantidad = 1 por ítem que no la traiga. "una bolsa de portland" es lo que
 *     alguien dice cuando vende una.
 *   · el IVA NO tiene default duro: o lo dice el usuario, o lo dice el PERFIL
 *     DE LA CASA por unanimidad, o se pregunta. Equivocarse ahí cambia la
 *     factura un 22% (ver `montos_brutos`), así que no hay ningún valor que se
 *     pueda suponer desde cero.
 *
 * Y los cinco vuelven a aparecer en el preview antes de emitir. Un default que
 * el usuario no ve es una suposición nuestra impresa en un documento fiscal.
 *
 * EL PERFIL VA ENTRE MEDIO, NO ARRIBA NI ABAJO DE TODO.
 *
 * Cada campo se resuelve en el mismo orden: lo que dijo el usuario (ya está en
 * `estado`, y entonces acá no se toca) → el perfil de la casa → el default
 * duro. Por eso el perfil se consulta ADENTRO de cada `if` de campo faltante y
 * no antes: un perfil aplicado sobre el estado, y no sobre el hueco, sería un
 * dato con la misma jerarquía que una respuesta. Ver `PerfilCasa`.
 */
export function aplicarDefaults(
  estado: EstadoEmision,
  contexto: ContextoDefaults = {},
): EstadoConDefaults {
  const hoy = contexto.hoy ?? hoyDgi();
  const salida: EstadoEmision = { ...estado };
  const aplicados: ClaveDefault[] = [];
  const del_perfil: ClaveDefault[] = [];

  // El perfil explícito le gana al cacheado en la sesión: así un llamador puede
  // recalcularlo sin tener que escribirlo primero en el estado.
  const perfil = contexto.perfil ?? salida.perfil_casa ?? null;
  const desdePerfil = (clave: ClaveDefault): void => {
    aplicados.push(clave);
    del_perfil.push(clave);
  };

  // La fecha NO se toma del perfil, y no es un olvido: la fecha de la casa es
  // hoy, siempre. Un promedio de las fechas de las últimas facturas no
  // significa nada, y copiar la última es el error que el TTL del borrador
  // existe para evitar.
  if ((salida.fecha_emision ?? "") === "") {
    salida.fecha_emision = hoy;
    aplicados.push("fecha_emision");
  }

  // La moneda se defaultea SOLO cuando no hay nada que desambiguar. Con
  // `moneda_dudosa` se deja en blanco a propósito: `siguientePaso` la pregunta,
  // y el perfil tampoco la contesta — la duda la puso el texto del usuario, que
  // le gana a la costumbre.
  if ((salida.moneda ?? "") === "" && salida.moneda_dudosa !== true) {
    if (perfil?.moneda !== undefined) {
      salida.moneda = perfil.moneda;
      desdePerfil("moneda");
    } else {
      salida.moneda = "UYU";
      aplicados.push("moneda");
    }
  }

  if (salida.forma_pago === undefined) {
    if (perfil?.forma_pago !== undefined) {
      // Ojo con la consecuencia, que es deseada: si la casa vende a crédito,
      // el flujo va a pedir el vencimiento. Es un dato que hace falta de
      // verdad — sin él la venta no aparece en "¿quién me debe?" —, no una
      // pregunta de más. Defaultear contado sobre una casa que vende a crédito
      // pierde la cobranza en silencio, que es bastante peor.
      salida.forma_pago = perfil.forma_pago;
      desdePerfil("forma_pago");
    } else {
      salida.forma_pago = 1;
      aplicados.push("forma_pago");
    }
  }

  // EL CRITERIO DE IVA: DEL PERFIL O DE NADIE.
  //
  // No hay default duro y no puede haberlo (ver `montos_brutos`): los dos
  // valores posibles están mal para la mitad de los casos. Lo único que
  // autoriza a completarlo sin preguntar es que las últimas N facturas de esta
  // misma empresa coincidan TODAS, que es lo que `derivarPerfilCasa` exige
  // antes de poner el campo. Si no coinciden, el campo no viene y el flujo
  // pregunta como siempre.
  if (salida.montos_brutos === undefined && perfil?.montos_brutos !== undefined) {
    salida.montos_brutos = perfil.montos_brutos;
    desdePerfil("montos_brutos");
  }

  // La tasa, con el mismo criterio de unanimidad. Sin ella el paso de IVA se
  // sigue haciendo aunque `montos_brutos` ya esté resuelto: `siguientePaso`
  // pregunta las dos mitades por separado.
  if (salida.indicador_facturacion === undefined && perfil?.indicador_facturacion !== undefined) {
    salida.indicador_facturacion = perfil.indicador_facturacion;
    desdePerfil("indicador_facturacion");
  }

  // La cantidad se completa solo en los ítems que ya tienen concepto: un ítem
  // vacío es "estoy por agregar otra cosa", y ponerle cantidad 1 lo haría
  // parecer a medio cargar en vez de recién abierto.
  if (salida.items !== undefined) {
    let toco = false;
    salida.items = salida.items.map((item) => {
      const tieneConcepto = (item.concepto ?? "") !== "";
      const sinCantidad = typeof item.cantidad !== "number" || item.cantidad <= 0;
      if (!tieneConcepto || !sinCantidad) return item;
      toco = true;
      return { ...item, cantidad: 1 };
    });
    if (toco) aplicados.push("cantidad");
  }

  return { estado: salida, aplicados, del_perfil };
}

// --- Qué sigue --------------------------------------------------------------

/**
 * ¿Esta línea puede ir al CFE? Concepto cargado y precio numérico.
 *
 * EL SIGNO NO SE MIRA, Y ES A PROPÓSITO: `ItemSchema` (`biller/cfeSchema.ts`)
 * no lo restringe, y una bonificación a $0 o un descuento de -$200 son líneas
 * de mostrador perfectamente emitibles —`repetirUltima` las copia tal cual de
 * la factura anterior—. Es la condición con la que `borradorComprobante` decide
 * dónde cortar, y por eso vive acá: si el flujo y el borrador tuvieran cada uno
 * la suya, volvería a existir un ítem que uno da por listo y el otro descarta.
 */
export function itemPuedeViajar(item: ItemEnCurso): boolean {
  return (item.concepto ?? "") !== "" && typeof item.precio === "number";
}

/**
 * ¿Le queda algo por preguntar a este ítem?
 *
 * Es una pregunta DISTINTA de la de arriba y por eso son dos funciones: acá el
 * precio tiene que ser positivo, porque un ítem que quedó en cero es
 * probablemente uno al que todavía no se le puso el precio y vale la pena
 * repreguntarlo. Confundir las dos —usar esta para decidir qué línea sale—
 * trunca el borrador en una línea bonificada y factura de menos.
 */
export function itemIncompleto(item: ItemEnCurso): boolean {
  if (!itemPuedeViajar(item)) return true;
  // Un precio 0 es un hueco… salvo que venga de un comprobante real, donde 0 es
  // una bonificación que alguien ya escribió. Ver `precio_copiado`.
  return (
    (item.precio ?? 0) <= 0 &&
    item.precio_copiado !== true &&
    item.precio_no_positivo_confirmado !== true
  );
}

/**
 * Un ítem donde el usuario no dijo NADA: ni descripción, ni precio, ni cantidad.
 *
 * Es el que se abre por error tocando ➕, y el único que se puede descartar sin
 * preguntarle a nadie, porque no hay nada que perder. Todo lo demás —un precio,
 * o incluso solo una cantidad que alguien tipeó— se pregunta o se descarta con
 * un botón que dice qué está sacando.
 *
 * LA CANTIDAD CUENTA, aunque no sea plata: `[{A,100}, {cantidad:2}, {C,300}]`
 * pasando por "↩️ Volver así" hacía desaparecer el "2" que el usuario había
 * tipeado. Un dato dicho no se descarta en silencio ni cuando es barato.
 */
export function itemSinNada(item: ItemEnCurso): boolean {
  return (
    (item.concepto ?? "") === "" &&
    typeof item.precio !== "number" &&
    typeof item.cantidad !== "number"
  );
}

/**
 * Los ítems que el flujo y el borrador consideran vivos, en su orden original.
 *
 * ES UN PREFIJO DE `estado.items`, SIEMPRE, y de ahí sale toda la seguridad de
 * este módulo: los conceptos se copian por posición (el agente desde
 * `completar`, y `completarDesdeSesion` desde el borrador guardado), así que
 * cualquier cosa que saque un ítem DEL MEDIO le pone la descripción de una
 * línea a otra en un CFE real. Sacar de la cola no mueve ninguna posición.
 *
 * Qué se saca: cerrados los ítems ("listo"), la cola de los que no tienen NADA
 * cargado. Ni uno más. Antes se descartaba toda la cola sin concepto, y eso se
 * llevaba puesto el ítem con precio y sin descripción: `[{Café,1200},
 * {precio:250}]` decía "ya tengo todo" y facturaba $1.200 en vez de $1.450.
 *
 * La usan `siguientePaso` (para decidir qué preguntar) y `aplicarAlItemEnCurso`
 * (para decidir a quién le pertenece un botón sin índice). Que sea UNA función
 * es el punto: cuando cada una recortaba distinto, el flujo preguntaba por un
 * ítem y el dato aterrizaba en otro.
 */
export function itemsVigentes(estado: EstadoEmision): ItemEnCurso[] {
  const todos = estado.items ?? [];
  if (estado.items_cerrados !== true) return [...todos];
  let hasta = todos.length;
  while (hasta > 0 && itemSinNada(todos[hasta - 1]!)) hasta -= 1;
  return todos.slice(0, hasta);
}

/**
 * Cuál es el ítem que se está cargando. -1 si no falta nada.
 *
 * ES LA DEFINICIÓN ÚNICA DE "EL ÍTEM EN CURSO", y existe como función exportada
 * para que no haya una segunda: `siguientePaso` decide qué preguntar con esto y
 * `aplicarAlItemEnCurso` decide a quién aplicarle un botón sin índice con esto
 * mismo. Cuando cada uno tenía la suya —"el último"— un dato podía aterrizar en
 * una línea distinta de la que el usuario estaba contestando.
 *
 * LOS DEL MEDIO Y EL ÚLTIMO NO SE MIDEN CON LA MISMA VARA, y no es un parche:
 *
 *   · De los del MEDIO importa una sola cosa, que es la que hace daño: que el
 *     borrador no los pueda mandar. Ahí se corren las posiciones y una línea
 *     termina con la descripción de otra. Un ítem del medio a $0 no es eso: el
 *     usuario dijo cero y siguió cargando, o sea que ya lo contestó, y el
 *     borrador lo manda igual.
 *   · Del ÚLTIMO importa además que el precio sea positivo, porque puede ser
 *     uno recién abierto al que todavía no se le puso nada.
 *
 * Así el flujo solo frena por lo mismo que corta el borrador, más la pregunta
 * de siempre sobre el que se está cargando.
 */
export function indiceItemEnCurso(items: ReadonlyArray<ItemEnCurso>): number {
  const enElMedio = items.findIndex((i, idx) => idx < items.length - 1 && !itemPuedeViajar(i));
  if (enElMedio !== -1) return enElMedio;
  const ultimo = items[items.length - 1];
  return ultimo !== undefined && itemIncompleto(ultimo) ? items.length - 1 : -1;
}

export interface SiguientePaso {
  paso: PasoEmision;
  /** La pregunta, en castellano, para el caso en que no se mande el interactivo. */
  pregunta: string;
  /** El mensaje tocable que corresponde a esta pregunta. null si es texto libre. */
  interactivo: InteractivoBotones | null;
  /** El tipo de CFE ya deducido, si se puede. */
  tipo: TipoSugerido | null;
  /** true cuando no falta nada y corresponde llamar a biller_emitir_comprobante. */
  listo: boolean;
}

/**
 * Dado lo que se sabe, qué preguntar ahora. UNA sola cosa por vez.
 *
 * El orden no es arbitrario: primero lo que DERIVA otras decisiones (a quién),
 * y después lo que el usuario tiene en la cabeza en ese momento (qué vendió y a
 * cuánto). Lo administrativo —fecha, moneda, forma de pago, cantidad— ya no se
 * pregunta: lo contesta `aplicarDefaults` y se muestra en el preview.
 *
 * SIGUE SIENDO PURA. Los dos datos del mundo que necesita —qué día es hoy y el
 * perfil de la casa— entran como parámetros (`contexto`), con default
 * inyectable: el mismo patrón que `hoyDgi(ahora)` y `construirSubmenuFecha(hoy)`.
 * Así el test que verifica que la fecha se defaultea no depende de cuándo se
 * corra, y el que verifica el perfil no depende de que haya API.
 *
 * Nunca devuelve "no sé qué preguntar": si no falta nada, `listo` es true. Ese
 * es el invariante que hace que el flujo no se pueda trancar.
 */
export function siguientePaso(
  estadoCrudo: EstadoEmision,
  contexto: ContextoDefaults = {},
): SiguientePaso {
  // Se razona SOBRE los defaults: un campo que se contesta solo no es un campo
  // que falte. El estado que llegó no se toca (ver `aplicarDefaults`).
  const estado = aplicarDefaults(estadoCrudo, contexto).estado;

  const tipo = estado.clase_receptor === undefined ? null : tipoComprobanteSugerido(estado.clase_receptor);
  const paso = (p: Omit<SiguientePaso, "tipo" | "listo">): SiguientePaso => ({
    ...p,
    tipo,
    listo: false,
  });

  // 1. A quién. Es lo único que DERIVA otra decisión (el tipo de CFE), así que
  //    va primero por necesidad y no por convención.
  if (estado.clase_receptor === undefined) {
    return {
      paso: "receptor",
      pregunta: "¿A quién le estás facturando: a una empresa con RUT o a un consumidor final?",
      interactivo: construirSubmenuReceptor(),
      tipo: null,
      listo: false,
    };
  }

  // 2. La fecha ya no se pregunta acá: es hoy salvo que el usuario diga otra
  //    cosa, y sale escrita en el preview. El paso "fecha" sigue existiendo en
  //    `PasoEmision` porque la tool lo devuelve cuando el usuario pide cambiarla
  //    sin decir por cuál; lo que ya no existe es la pregunta obligatoria.

  // 3. Cliente. Para e-Factura es obligatorio SIEMPRE; para e-Ticket se puede
  //    no identificar, pero tiene que decirlo explícitamente.
  const sinDocumento = (estado.documento ?? "") === "";
  if (estado.clase_receptor === "empresa" && sinDocumento) {
    return paso({
      paso: "cliente",
      pregunta: "¿Cuál es el RUT de la empresa? Si no lo tenés a mano, decime el nombre y lo busco.",
      interactivo: null,
    });
  }
  if (estado.clase_receptor === "consumidor_final" && sinDocumento && estado.sin_receptor !== true) {
    return paso({
      paso: "cliente",
      pregunta:
        "¿Tenés los datos del cliente (cédula o RUT)? Si es una venta de mostrador sin datos, " +
        'decime "sin identificar" y sigo.',
      interactivo: construirSubmenuReceptorOpcional(),
    });
  }

  // 4. Dirección y ciudad, SOLO si el cliente es nuevo en Biller.
  //    Verificado contra la API: darlo de alta en la misma llamada sin estos
  //    dos campos devuelve 422. Preguntarlo acá cuesta dos mensajes;
  //    descubrirlo en la emisión cuesta la conversación entera.
  if (
    estado.clase_receptor === "empresa" &&
    estado.cliente_ya_facturado === false &&
    ((estado.direccion_cliente ?? "") === "" || (estado.ciudad_cliente ?? "") === "")
  ) {
    return paso({
      paso: "datos_cliente_nuevo",
      // Las dos cosas en un mensaje: nadie dice su dirección sin la ciudad. Si
      // vino con coma, `separarDireccionCiudad` ya las partió y este paso no se
      // alcanza; la repregunta queda solo para el que mandó una sin la otra.
      pregunta:
        (estado.direccion_cliente ?? "") === ""
          ? "Es la primera vez que le facturás a este cliente, así que hay que darlo de alta. " +
            '¿Dirección y ciudad? Todo junto va bien: "Rivera 1234, Melo".'
          : "¿En qué ciudad?",
      interactivo: null,
    });
  }

  // 5. Moneda. Solo se llega acá cuando el texto del usuario habló de dólares:
  //    en el silencio, `aplicarDefaults` ya la dejó en UYU. Es la promesa que
  //    el comentario de `construirSubmenuMoneda` venía haciendo desde siempre y
  //    el código no cumplía.
  if ((estado.moneda ?? "") === "") {
    return paso({
      paso: "moneda",
      pregunta: "¿La facturo en pesos o en dólares?",
      interactivo: construirSubmenuMoneda(),
    });
  }

  // 5b. Tasa de cambio, SOLO si la moneda no es la local.
  //     La API la completa sola con la cotización del cierre anterior, pero
  //     entonces el total que aprobó el usuario y el que se emite pueden no ser
  //     el mismo — y sin ella el chequeo del umbral de 5.000 UI no se puede
  //     hacer, justo sobre el comprobante que más chance tiene de superarlo.
  if ((estado.moneda ?? "UYU") !== "UYU" && estado.tasa_cambio === undefined) {
    return paso({
      paso: "tasa_cambio",
      pregunta:
        `¿A qué cotización tomo el ${estado.moneda}? Decime cuántos pesos vale uno (por ejemplo 40).`,
      interactivo: null,
    });
  }

  // 6. La forma de pago ya no se pregunta: el default es contado y sale escrito
  //    en el preview. "Es a crédito" dicho en cualquier momento la cambia, y
  //    ahí sí aparece el paso de vencimiento de acá abajo.

  // 6b. Vencimiento, SOLO a crédito. Sin esto la venta a crédito no aparece en
  //     "¿quién me debe?" ni en vencimientos: se emitió para cobrar después y
  //     la cobranza queda invisible.
  if (estado.forma_pago === 2 && (estado.fecha_vencimiento ?? "") === "") {
    return paso({
      paso: "fecha_vencimiento",
      pregunta:
        "¿Cuándo te la tiene que pagar? Decime la fecha (dd/mm/aaaa) o en cuántos días " +
        '(por ejemplo "30 días").',
      interactivo: null,
    });
  }

  // 7-9. El ítem en curso, campo por campo: concepto → precio → IVA.
  //
  // La cantidad dejó de estar en esa lista: `aplicarDefaults` la pone en 1 y el
  // preview la muestra como "1 × concepto". El que dice "2 bolsas" ya la trajo;
  // el que no la dijo casi siempre está vendiendo una.
  //
  // CERRADOS LOS ÍTEMS SE DESCARTA LA COLA, Y SOLO LA COLA.
  //
  // El descarte existe para no trancar el flujo PARA SIEMPRE: abrir un ítem por
  // error deja uno vacío, el chequeo de `concepto` va ANTES que el de
  // `items_cerrados`, y sin esto se le pregunta su descripción hasta el fin de
  // los tiempos. Hoy además está el botón "↩️ Volver así"
  // (`construirSubmenuConceptoExtra`), pero los borradores guardados traen
  // `items_cerrados` de antes y el invariante vale igual.
  //
  // LO QUE SÍ CAMBIÓ ES EL ALCANCE: antes se filtraba TODO ítem sin concepto,
  // en cualquier posición, y eso escondía el agujero del medio justo en el
  // camino donde el usuario ya tocó "listo". Con
  // `[{Harina,100}, {sin concepto,250}, {Arena,300}]` y `items_cerrados`, esta
  // función veía dos ítems completos y decía "confirmar, listo" mientras
  // `borradorComprobante` —que NO filtra por `items_cerrados`— cortaba en el
  // del medio y mandaba UNA línea de tres: el CFE salía por $100 en vez de
  // $450, y el usuario había leído "ya tengo todo".
  //
  // Descartando solo la COLA las dos funciones vuelven a coincidir por
  // construcción, y no por casualidad: las dos se quedan con un PREFIJO de
  // `estado.items`. Sacar del final no corre ninguna posición; sacar del medio
  // las corre todas, que es la raíz de esta familia de bugs.
  const items = itemsVigentes(estado);

  // EL ÍTEM EN CURSO ES EL PRIMERO QUE FALTA, NO EL ÚLTIMO.
  //
  // Miraba solo el último, y ese era un bug fiscal con nombre y apellido: con
  // `[{A,100}, {B sin precio}, {C,300}]` el último está completo, así que esto
  // devolvía "confirmar, listo". El borrador sale con DOS líneas —la del medio
  // la filtra `borradorComprobante`, porque un ítem sin precio produce un 422—
  // y entonces la correspondencia por posición entre el borrador y los ítems
  // guardados se corre una casilla. Esa correspondencia es de lo único que
  // disponen tanto el agente (a quien `completar` le pide los conceptos "en el
  // mismo orden en que la dijo") como `completarDesdeSesion`, que rellena
  // `items[i].concepto` desde `itemsGuardados[i]`: la línea de $300 terminaba
  // con el concepto de B impreso en un CFE real ante DGI, y nada avisaba.
  //
  // EL INVARIANTE, DICHO CON PRECISIÓN: `listo` solo puede salir cuando el
  // borrador va a llevar TODAS las líneas que quedaron después de descartar la
  // cola cerrada. O sea: ningún ítem incompleto ENTRE medio de otros. Lo que se
  // descarta al cerrar es un sufijo, y descartar un sufijo no le cambia la
  // posición a ninguna línea que sí viaja.
  //
  // Y el primero es el que hay que preguntar, no el último: el que carga desde
  // el mostrador dijo las cosas en un orden, y preguntar salteado obliga a
  // reconstruir de cuál se está hablando.
  const indice = indiceItemEnCurso(items);
  const enCurso = indice === -1 ? items[items.length - 1] : items[indice];
  // Cuando el agujero está al final —el ítem recién abierto con ➕, que es el
  // caso de todos los días— la pregunta es EXACTAMENTE la de antes. El
  // diferencial de este cambio cae solo sobre los estados con un agujero en el
  // medio, que hasta ahora no se preguntaban nunca.
  const interior = indice !== -1 && indice < items.length - 1;
  const ordinal = interior
    ? // Con un agujero en el medio, el total importa: "el ítem 2" a secas se
      // confunde con "el segundo que estás cargando ahora".
      ` del ítem ${indice + 1} de ${items.length}`
    : items.length <= 1
      ? ""
      : ` del ítem ${items.length}`;

  if (enCurso === undefined || (enCurso.concepto ?? "") === "") {
    // UN ÍTEM CON ALGO CARGADO Y SIN DESCRIPCIÓN SE PREGUNTA POR SU PLATA, Y SE
    // DESCARTA NOMBRÁNDOLA. En cualquier posición, incluida la última.
    //
    // Antes el último caía en "¿qué es lo que agregás?" con "↩️ Volver así", y
    // con los ítems cerrados ni siquiera se preguntaba: se descartaba solo y el
    // flujo decía "ya tengo todo". `[{Café,1200}, {precio:250}]` facturaba
    // $1.200 en vez de $1.450 sin una palabra. Ahora el descarte de la cola se
    // limita a lo que no tiene NADA cargado, así que esta pregunta existe — y
    // tiene que poder contestarse de un toque sin que el toque tire plata en
    // silencio: el botón dice cuánto saca.
    //
    // EL ANCLA ES EL PRECIO, NO EL CONCEPTO, Y NO POR ESTILO: el concepto no
    // puede salir del server. Está en `CAMPOS_NO_CONFIABLES` y puede haber
    // entrado al estado desde la API (`repetir_ultima_de` copia los ítems de un
    // comprobante ya emitido), así que ecoarlo en `pregunta` —que no lleva
    // clave envuelta— es justo el agujero que la barrera de salida existe para
    // tapar. El número lo calculamos nosotros y el usuario lo reconoce igual.
    if (enCurso !== undefined && !itemSinNada(enCurso)) {
      const cual = items.length <= 1 ? "" : ` (el ítem ${indice + 1} de ${items.length})`;
      const plata =
        typeof enCurso.precio === "number"
          ? montoConSigno(estado.moneda, enCurso.precio)
          : null;
      return paso({
        paso: "concepto",
        pregunta:
          plata === null
            ? `Me quedó una línea sin descripción${cual}, con ${enCurso.cantidad} de cantidad. ` +
              "¿Qué era? Decime solo qué es."
            : `Me falta saber qué era la línea de ${plata}${cual}. ¿De qué era? Decime solo qué es.`,
        interactivo: construirSubmenuLineaSinDescripcion(plata, {
          posicion: indice + 1,
          ...(typeof enCurso.precio === "number" ? { precio: enCurso.precio } : {}),
        }),
      });
    }
    if (interior) {
      // Un ítem del medio sin NADA cargado: se abrió por error y no hay ninguna
      // plata que perder. La salida de un toque es la misma de siempre.
      return paso({
        paso: "concepto",
        pregunta:
          `Me quedó vacío el ítem ${indice + 1} de ${items.length}. ¿Qué le vendiste ahí? ` +
          "Decime solo qué es.",
        interactivo: construirSubmenuConceptoExtra(),
      });
    }
    // Ítem vacío AL FINAL, que es el caso de todos los días: con uno completo
    // atrás esto es "tocaste ➕" y la pregunta lleva su propia salida; con
    // ninguno, es la primera pregunta del comprobante y no hay a qué volver.
    const esAgregado = items.length > 1;
    return paso({
      paso: "concepto",
      pregunta: esAgregado
        ? "¿Qué es lo que agregás?"
        : '¿Qué le vendiste? Decime solo qué es, por ejemplo: "bolsas de harina".',
      interactivo: esAgregado ? construirSubmenuConceptoExtra() : null,
    });
  }

  // EL PRECIO SE PREGUNTA CUANDO HAY UN ÍTEM EN CURSO, y `indiceItemEnCurso` es
  // quien decide eso. Repetir acá la condición ("precio <= 0") era tener dos
  // definiciones de lo mismo, y la de acá no sabía de la línea BONIFICADA: un
  // ítem copiado de una factura real con precio $0 no volvía a `indice` —bien—
  // pero caía igual en esta pregunta, que no tiene botones y que "0" no
  // contesta. El número mudo, por una condición duplicada.
  if (indice !== -1 && (typeof enCurso.precio !== "number" || enCurso.precio <= 0)) {
    if (typeof enCurso.precio === "number") {
      return paso({
        paso: "precio",
        pregunta: "Ese precio quedó en cero o negativo. Elegí si lo dejamos así o sacamos la línea.",
        interactivo: construirSubmenuPrecioNoPositivo(
          indice + 1,
          enCurso.precio,
          estado.moneda ?? "UYU",
        ),
      });
    }
    return paso({
      paso: "precio",
      pregunta: `¿A qué precio por unidad${ordinal}? Solo el número.`,
      interactivo: null,
    });
  }

  // EL IVA, EN UN SOLO PASO.
  //
  // Los dos datos —si el precio ya lo incluye y a qué tasa— eran dos preguntas
  // seguidas sobre lo mismo. Fusionadas, los dos botones normales contestan las
  // dos cosas (criterio + tasa básica) y el tercero abre el caso raro.
  //
  // Las tres ramas siguen existiendo por separado porque el estado puede llegar
  // con una mitad resuelta: por `repetir_ultima_de`, que copia el indicador de
  // la venta anterior, o por el propio botón "🔢 Otro IVA", que fija la tasa y
  // deja el criterio de precio pendiente.
  // El precio con el que se pregunta el IVA: el del ítem en curso, salvo que sea
  // una línea sin plata (una bonificación copiada a $0). "Los $0 que me
  // pasaste, ¿ya tienen el IVA adentro?" no es una pregunta.
  const precioMuestra =
    (enCurso.precio ?? 0) > 0
      ? enCurso.precio!
      : (items.find((i) => (i.precio ?? 0) > 0)?.precio ?? enCurso.precio ?? 0);
  const indicador = enCurso.indicador_facturacion ?? estado.indicador_facturacion;
  if (estado.montos_brutos === undefined && indicador === undefined) {
    return paso({
      paso: "iva",
      pregunta:
        `Los ${montoConSigno(estado.moneda, precioMuestra)} que me pasaste, ` +
        "¿ya tienen el IVA adentro? (tomo tasa básica 22% salvo que me digas otra cosa)",
      interactivo: construirSubmenuIvaFusionado(precioMuestra, estado.moneda ?? "UYU"),
    });
  }
  if (indicador === undefined) {
    return paso({
      paso: "iva",
      pregunta: "¿Qué IVA lleva? Tasa básica (22%), mínima (10%) o exento.",
      interactivo: construirSubmenuIva(),
    });
  }
  if (estado.montos_brutos === undefined) {
    return paso({
      paso: "precio_incluye_iva",
      pregunta:
        `Los ${montoConSigno(estado.moneda, precioMuestra)} que me pasaste, ` +
        "¿ya tienen el IVA adentro?",
      interactivo: construirSubmenuMontosBrutos(precioMuestra, estado.moneda ?? "UYU"),
    });
  }

  // 10. Y ya está: el resto se decide sobre el preview, que es donde el usuario
  //     tiene el comprobante entero delante. "¿Otro ítem?" es un botón de ahí, y
  //     la adenda se escribe. Preguntar las dos cosas acá era cobrarle dos
  //     mensajes a todo el mundo por dos casos minoritarios.
  return {
    paso: "confirmar",
    pregunta:
      "Ya tengo todo. Armo el comprobante y te lo mando para que lo confirmes antes de emitirlo.",
    interactivo: null,
    tipo,
    listo: true,
  };
}
