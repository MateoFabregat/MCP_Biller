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
// =============================================================================

import { FORMAS_PAGO, INDICADORES_FACTURACION, TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { hoyDgiUy } from "../services/fechaUy.js";
import type { InteractivoBotones, InteractivoLista } from "./client.js";

/** Prefijo de los ids de la emisión guiada. Distinto del de confirmación. */
export const PREFIJO_PASO = "emision:";

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
 * Ahora cada dato es su propio paso: concepto → precio → cantidad → IVA. Son
 * más mensajes, pero cada uno se contesta con una palabra o un toque, y en
 * cualquier momento se puede cortar y retomar sin que nadie tenga que acordarse
 * de qué le faltaba.
 *
 * Eso NO significa preguntar lo que ya se sabe: quien escribe "facturale a
 * Pérez 2 bolsas de harina a 6000" llega con cuatro pasos resueltos de una y el
 * flujo arranca en el quinto. El orden es la ruta más larga, no la obligatoria.
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
  | "cantidad"
  | "iva"
  | "otro_item"
  | "adenda"
  | "confirmar";

/** Un ítem en construcción. Se completa campo por campo, en su propio paso. */
export interface ItemEnCurso {
  concepto?: string;
  cantidad?: number;
  precio?: number;
  indicador_facturacion?: number;
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
  /** Nota al pie del comprobante. Texto libre del usuario. */
  adenda?: string;
  /** true cuando el usuario dijo explícitamente que no quiere adenda. */
  sin_adenda?: boolean;
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

// --- Los mensajes de cada paso ----------------------------------------------

/**
 * El primer mensaje del flujo de emisión: la pregunta que reemplaza a
 * "¿e-Ticket o e-Factura?".
 *
 * Tres botones y no dos: "no sé" es una respuesta legítima y frecuente, y sin
 * ella el usuario que duda no tiene ningún camino salvo abandonar. Con ella el
 * sistema puede hacer la pregunta de atrás ("¿te pidió factura a nombre de una
 * empresa?"), que sí sabe contestar.
 */
export function construirSubmenuReceptor(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "Emitir un comprobante",
    cuerpo:
      "Dale, vamos. Primero lo más importante:\n\n¿A quién le estás facturando?\n\n" +
      "Con eso ya sé qué tipo de comprobante corresponde y no te lo pregunto.",
    pie: "Podés escribirme el RUT o el nombre directamente.",
    botones: [
      { id: `${PREFIJO_PASO}receptor:empresa`, titulo: "🏢 A una empresa" },
      { id: `${PREFIJO_PASO}receptor:final`, titulo: "👤 Consumidor final" },
      { id: `${PREFIJO_PASO}receptor:no_se`, titulo: "🤔 No sé" },
    ],
  };
}

/** La pregunta de atrás, para el que tocó "no sé". */
export function construirDesempateReceptor(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "Una sola pregunta más",
    cuerpo:
      "¿Te pidieron la factura a nombre de una empresa, con RUT?\n\n" +
      "Si te dieron un RUT o te dijeron “ponelo a nombre de tal SRL”, es empresa. " +
      "Si es alguien que se lleva algo y no te pidió nada a nombre de nadie, es consumidor final.",
    botones: [
      { id: `${PREFIJO_PASO}receptor:empresa`, titulo: "🏢 Sí, con RUT" },
      { id: `${PREFIJO_PASO}receptor:final`, titulo: "👤 No, es persona" },
    ],
  };
}

/**
 * El indicador de facturación como tres botones en castellano.
 *
 * `INDICADORES_FACTURACION` tiene diez valores y ninguno se llama "22%". Los
 * tres que cubren casi todo se ofrecen con el nombre que el usuario usa; el
 * resto queda accesible escribiendo, no escondido. Ofrecer los diez en una
 * lista sería trasladarle a alguien que está atendiendo el mostrador una
 * decisión de tratamiento de IVA que casi nunca es dudosa.
 */
export function construirSubmenuIva(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Qué IVA lleva?",
    cuerpo:
      "Lo normal es la tasa básica (22%). La mínima (10%) es para algunos alimentos, " +
      "medicamentos y hotelería.",
    pie: "Si es otro caso, escribime cuál.",
    botones: [
      { id: `${PREFIJO_PASO}iva:3`, titulo: "IVA 22% (básica)" },
      { id: `${PREFIJO_PASO}iva:2`, titulo: "IVA 10% (mínima)" },
      { id: `${PREFIJO_PASO}iva:1`, titulo: "Exento" },
    ],
  };
}

/**
 * La fecha, con el caso normal a un toque.
 *
 * El 99% de las veces la respuesta es "hoy", así que la pregunta abierta
 * ("¿qué fecha?") le cobra a todo el mundo el costo del caso raro. Con el botón,
 * lo normal es un toque y lo excepcional sigue siendo posible escribiéndolo.
 */
export function construirSubmenuFecha(hoy: string = hoyDgi()): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿De qué fecha?",
    cuerpo: `Si es de hoy (${hoy}), tocá el botón. Si es de otro día, escribime la fecha.`,
    pie: "Formato dd/mm/aaaa.",
    botones: [
      { id: `${PREFIJO_PASO}fecha:hoy`, titulo: "📅 Hoy" },
      { id: `${PREFIJO_PASO}fecha:otra`, titulo: "✏️ Otra fecha" },
    ],
  };
}

/**
 * Para consumidor final: identificarlo o no.
 *
 * El e-Ticket no exige receptor por debajo del umbral de UI, así que obligar a
 * cargar una cédula para vender un café es pedir un dato que DGI no pide. Pero
 * la opción tiene que ser EXPLÍCITA: si "no identificar" fuera simplemente no
 * contestar, el flujo no sabría distinguirlo de una pregunta pendiente.
 */
export function construirSubmenuReceptorOpcional(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Lo identificamos?",
    cuerpo:
      "Si el cliente te dio cédula o RUT, mandámelo y lo pongo en el comprobante.\n\n" +
      "Si es una venta de mostrador sin datos, seguimos sin identificarlo.",
    pie: "Arriba de 5.000 UI hay que identificarlo igual: si el total lo pasa, te aviso.",
    botones: [
      { id: `${PREFIJO_PASO}cliente:sin_identificar`, titulo: "👤 Sin identificar" },
    ],
  };
}

/** Cantidad, con el caso normal (una unidad) a un toque. */
export function construirSubmenuCantidad(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Cuántos?",
    cuerpo: "Si es uno solo, tocá el botón. Si son varios, escribime el número.",
    botones: [{ id: `${PREFIJO_PASO}cantidad:1`, titulo: "1 unidad" }],
  };
}

/** ¿Va otro ítem o ya está? Sin esto, un comprobante es siempre de una línea. */
export function construirSubmenuOtroItem(cantidadItems: number): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: cantidadItems === 1 ? "Un ítem cargado" : `${cantidadItems} ítems cargados`,
    cuerpo: "¿Le agregás otra cosa al comprobante, o lo cerramos así?",
    botones: [
      { id: `${PREFIJO_PASO}item:listo`, titulo: "✅ Así está bien" },
      { id: `${PREFIJO_PASO}item:otro`, titulo: "➕ Agregar otro" },
    ],
  };
}

/**
 * La adenda es el último paso y trae su propia salida.
 *
 * Es opcional de verdad, así que la pregunta tiene que poder contestarse con un
 * toque que diga "no". Una pregunta abierta al final de un flujo largo es donde
 * la gente abandona.
 */
export function construirSubmenuAdenda(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Alguna nota?",
    cuerpo:
      "Podés agregarle una adenda al comprobante: una referencia, un número de orden, " +
      "condiciones de entrega. Si no hace falta, seguimos.",
    botones: [{ id: `${PREFIJO_PASO}adenda:no`, titulo: "Sin nota, dale" }],
  };
}

/** Contado o crédito. Define si la factura entra en la cuenta corriente. */
export function construirSubmenuFormaPago(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Cómo te paga?",
    cuerpo:
      "Contado: ya te pagó.\nCrédito: te paga después — la factura te queda como deuda del cliente " +
      "y aparece en “¿Quién me debe?”.",
    botones: [
      { id: `${PREFIJO_PASO}pago:1`, titulo: "💵 Contado" },
      { id: `${PREFIJO_PASO}pago:2`, titulo: "📅 Crédito" },
    ],
  };
}

/**
 * ¿El precio que me dijiste ya tiene el IVA adentro?
 *
 * Es la pregunta que evita facturar 22% de más. Va DESPUÉS del primer precio y
 * no antes: preguntada en frío ("¿vas a cotizar con IVA incluido?") es jerga
 * contable; preguntada con el número del usuario adelante ("los $200, ¿ya
 * incluyen IVA?") la contesta cualquiera sin pensar.
 *
 * Se pregunta UNA sola vez por comprobante: nadie mezcla criterios entre ítems
 * de la misma factura.
 */
export function construirSubmenuMontosBrutos(precio: number, moneda: string): InteractivoBotones {
  const simbolo = moneda === "USD" ? "U$S" : "$";
  return {
    tipo: "botones",
    encabezado: "Una cosa sobre el precio",
    cuerpo:
      `Los ${simbolo}${precio} que me pasaste, ¿ya tienen el IVA adentro?\n\n` +
      "Si es el precio que le cobrás al cliente en el mostrador, sí. Si es el precio sin impuestos " +
      "y el IVA se suma aparte, no.",
    pie: "Si me equivoco acá, la factura sale 22% distinta.",
    botones: [
      { id: `${PREFIJO_PASO}iva_incluido:si`, titulo: "✅ Ya incluye IVA" },
      { id: `${PREFIJO_PASO}iva_incluido:no`, titulo: "➕ Se suma aparte" },
    ],
  };
}

/** Moneda. Solo se pregunta si algo en el mensaje sugiere que no es UYU. */
export function construirSubmenuMoneda(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿En qué moneda?",
    cuerpo: "¿La facturo en pesos o en dólares?",
    botones: [
      { id: `${PREFIJO_PASO}moneda:UYU`, titulo: "🇺🇾 Pesos" },
      { id: `${PREFIJO_PASO}moneda:USD`, titulo: "💵 Dólares" },
    ],
  };
}

/**
 * Lista de clientes recientes para elegir sin escribir.
 *
 * Los nombres los pasa el llamador desde `biller_ranking_clientes`, que los saca
 * de comprobantes ya emitidos: son clientes REALES de esta empresa, no una
 * lista inventada. La última fila es siempre "otro cliente" — una lista cerrada
 * de clientes frecuentes sería un callejón sin salida para el cliente nuevo,
 * que es justo el que más se factura una sola vez.
 */
export function construirListaClientes(
  clientes: ReadonlyArray<{ id?: string; nombre: string; documento?: string }>,
): InteractivoLista {
  const filas = clientes.slice(0, 9).map((c, i) => ({
    id: `${PREFIJO_PASO}cliente:${c.documento ?? c.id ?? String(i)}`,
    titulo: c.nombre.slice(0, 24),
    ...(c.documento !== undefined ? { descripcion: `RUT/CI ${c.documento}` } : {}),
  }));

  filas.push({ id: `${PREFIJO_PASO}cliente:otro`, titulo: "➕ Otro cliente" });

  return {
    tipo: "lista",
    encabezado: "¿A quién le facturás?",
    cuerpo: "Estos son los que más facturaste últimamente. Si no está, elegí “Otro cliente”.",
    boton: "Elegir cliente",
    secciones: [{ titulo: "Tus clientes", filas }],
  };
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
  | { paso: "adenda_no" }
  | { paso: "iva"; indicador_facturacion: number }
  | { paso: "moneda"; moneda: string }
  | { paso: "forma_pago"; forma_pago: number }
  | { paso: "montos_brutos"; incluye_iva: boolean }
  | { paso: "ninguna" };

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
      return { paso: "ninguna" };
    case "adenda":
      return valor === "no" ? { paso: "adenda_no" } : { paso: "ninguna" };
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
      if (valor === "si") return { paso: "montos_brutos", incluye_iva: true };
      if (valor === "no") return { paso: "montos_brutos", incluye_iva: false };
      return { paso: "ninguna" };
    default:
      return { paso: "ninguna" };
  }
}

// --- Qué sigue --------------------------------------------------------------

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
 * después lo que el usuario tiene en la cabeza en ese momento (qué vendió y a
 * cuánto), y al final lo administrativo (IVA, moneda, forma de pago), que es lo
 * que se puede defaultear sin que nadie se sorprenda.
 *
 * Nunca devuelve "no sé qué preguntar": si no falta nada, `listo` es true. Ese
 * es el invariante que hace que el flujo no se pueda trancar.
 */
export function siguientePaso(estado: EstadoEmision): SiguientePaso {
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

  // 2. Fecha.
  if ((estado.fecha_emision ?? "") === "") {
    return paso({
      paso: "fecha",
      pregunta: `¿De qué fecha es el comprobante? Si es de hoy (${hoyDgi()}), decime "hoy".`,
      interactivo: construirSubmenuFecha(),
    });
  }

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
      pregunta:
        (estado.direccion_cliente ?? "") === ""
          ? "Es la primera vez que le facturás a este cliente, así que hay que darlo de alta. ¿Cuál es su dirección?"
          : "¿En qué ciudad?",
      interactivo: null,
    });
  }

  // 5. Moneda.
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

  // 6. Forma de pago.
  if (estado.forma_pago === undefined) {
    return paso({
      paso: "forma_pago",
      pregunta: "¿Te paga al contado o a crédito?",
      interactivo: construirSubmenuFormaPago(),
    });
  }

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

  // 7-10. El ítem en curso, campo por campo.
  //
  // Si el usuario ya cerró los ítems, los que quedaron a medio cargar se
  // descartan. Sin esto el flujo se trancaba PARA SIEMPRE: tocar "➕ Agregar
  // otro" por error mete un ítem vacío, y el chequeo de `concepto` (paso 7) va
  // ANTES que el de `items_cerrados` (paso 11), así que "✅ Así está bien" no
  // servía de nada y la pregunta que volvía era texto libre, sin ningún botón de
  // salida. Rompía el invariante declarado del módulo: el flujo no se puede
  // trancar.
  const items = (estado.items ?? []).filter(
    (i) => estado.items_cerrados !== true || (i.concepto ?? "") !== "",
  );
  const enCurso = items.length === 0 ? undefined : items[items.length - 1];
  const ordinal = items.length <= 1 ? "" : ` del ítem ${items.length}`;

  if (enCurso === undefined || (enCurso.concepto ?? "") === "") {
    return paso({
      paso: "concepto",
      pregunta:
        items.length === 0
          ? '¿Qué le vendiste? Decime solo qué es, por ejemplo: "bolsas de harina".'
          : "¿Qué es lo que agregás?",
      interactivo: null,
    });
  }

  if (typeof enCurso.precio !== "number" || enCurso.precio <= 0) {
    return paso({
      paso: "precio",
      pregunta: `¿A qué precio por unidad${ordinal}? Solo el número.`,
      interactivo: null,
    });
  }

  // El IVA incluido se pregunta UNA vez, apenas hay un precio sobre la mesa. Es
  // el paso que evita facturar 22% de más sobre un precio de mostrador.
  if (estado.montos_brutos === undefined) {
    return paso({
      paso: "precio_incluye_iva",
      pregunta: `Los ${enCurso.precio} que me pasaste, ¿ya tienen el IVA adentro?`,
      interactivo: construirSubmenuMontosBrutos(enCurso.precio, estado.moneda ?? "UYU"),
    });
  }

  if (typeof enCurso.cantidad !== "number" || enCurso.cantidad <= 0) {
    return paso({
      paso: "cantidad",
      pregunta: `¿Cuántos${ordinal}?`,
      interactivo: construirSubmenuCantidad(),
    });
  }

  if (enCurso.indicador_facturacion === undefined && estado.indicador_facturacion === undefined) {
    return paso({
      paso: "iva",
      pregunta: "¿Qué IVA lleva? Tasa básica (22%), mínima (10%) o exento.",
      interactivo: construirSubmenuIva(),
    });
  }

  // 11. ¿Otro ítem? Sin este paso, todo comprobante tiene exactamente una línea.
  if (estado.items_cerrados !== true) {
    return paso({
      paso: "otro_item",
      pregunta: "¿Le agregás otro ítem al comprobante, o lo cerramos así?",
      interactivo: construirSubmenuOtroItem(items.length),
    });
  }

  // 12. Adenda, opcional y con salida de un toque.
  if ((estado.adenda ?? "") === "" && estado.sin_adenda !== true) {
    return paso({
      paso: "adenda",
      pregunta: "¿Querés agregarle alguna nota al comprobante (adenda)? Si no, seguimos.",
      interactivo: construirSubmenuAdenda(),
    });
  }

  return {
    paso: "confirmar",
    pregunta:
      "Ya tengo todo. Armo el comprobante y te lo mando para que lo confirmes antes de emitirlo.",
    interactivo: null,
    tipo,
    listo: true,
  };
}
