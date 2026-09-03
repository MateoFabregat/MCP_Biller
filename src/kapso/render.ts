// =============================================================================
// Los mensajes que ve el usuario: menú, listas, botones, preview de emisión.
//
// Todo lo que arma un payload de WhatsApp vive acá, y nada de lo que decide QUÉ
// contestar. La razón práctica es la del preview de emisión: el cuerpo se arma
// con números YA CALCULADOS en TypeScript, y eso solo se puede sostener si el
// lugar donde se escribe el texto es un lugar sin lógica de negocio adentro.
//
// Depende del catálogo (`intenciones.ts`) y del protocolo de ids
// (`protocolo.ts`), nunca al revés: el enrutador no importa este módulo.
// =============================================================================

import type { InteractivoBotones, InteractivoLista } from "./client.js";
import { hoyDgiUy } from "../services/fechaUy.js";
import { formatearUy, montoConSigno, simboloMoneda } from "../services/importe.js";
import { opcionesDisponibles, type MenuOpcion, type MenuOpciones } from "./intenciones.js";
import { PREFIJO_ANULACION, PREFIJO_EMISION, PREFIJO_PASO } from "./protocolo.js";

/** Menú como lista interactiva de WhatsApp. */
export function construirMenuInteractivo(opciones: MenuOpciones = {}): InteractivoLista {
  const disponibles = opcionesDisponibles(opciones);
  // Mismo orden que OPCIONES_MENU: Facturar primero. Si estos dos órdenes se
  // separan, el número que el usuario escribe deja de coincidir con la fila que
  // ve — que es justamente lo que la numeración existe para evitar.
  const grupos: MenuOpcion["grupo"][] = ["Facturar", "Plata", "Números", "Otros"];

  const secciones = grupos
    .map((grupo) => ({
      titulo: grupo,
      filas: disponibles
        .filter((o) => o.grupo === grupo)
        .map((o) => ({ id: o.id, titulo: o.titulo, descripcion: o.descripcion })),
    }))
    .filter((s) => s.filas.length > 0);

  return {
    tipo: "lista",
    encabezado: opciones.empresa === undefined ? "Biller" : `Biller · ${opciones.empresa}`,
    cuerpo:
      "Hola 👋 Soy el asistente de tu facturación. Preguntame lo que quieras con tus palabras, " +
      "o elegí una opción de la lista.",
    pie: "Los números salen de tus comprobantes en Biller.",
    boton: "Ver opciones",
    secciones,
  };
}

/**
 * La pregunta que resuelve un empate, como botones.
 *
 * Es la alternativa a las dos malas salidas que había antes: elegir una de las
 * dos al azar (y contestar con seguridad la pregunta que el usuario no hizo) o
 * devolver el menú entero (y hacerle releer diez opciones a alguien que ya
 * escribió lo que quería). Acá se le devuelve exactamente lo que él dijo,
 * separado en las dos cosas que puede significar, a un toque de distancia.
 *
 * Los ids son los mismos `menu:*` de siempre: la respuesta vuelve por el mismo
 * camino que una fila del menú y no hace falta ningún estado intermedio.
 */
export function construirDesambiguacion(candidatas: readonly MenuOpcion[]): InteractivoBotones {
  const elegidas = candidatas.slice(0, 3);
  return {
    tipo: "botones",
    cuerpo:
      elegidas.length === 0
        ? "¿Qué necesitás?"
        : "Puede ser una de estas dos cosas y no quiero contestarte la que no era 🙂\n\n¿Cuál es?",
    botones: elegidas.map((o) => ({ id: o.id, titulo: o.titulo.slice(0, 20) })),
  };
}

/**
 * Mismo menú en texto plano.
 *
 * No es un fallback decorativo: es lo que se usa cuando el que contesta es el
 * Agent Node de Kapso (que responde texto), y también cuando el interactivo se
 * rechaza. La numeración coincide con el orden de `opcionesDisponibles`, que es
 * lo que hace que "3" signifique lo mismo en los dos formatos.
 */
export function construirMenuTexto(opciones: MenuOpciones = {}): string {
  const disponibles = opcionesDisponibles(opciones);
  const lineas = [
    "👋 Hola, soy el asistente de tu facturación.",
    "",
    "Preguntame con tus palabras, o mandá el número:",
    "",
    ...disponibles.map((o, i) => `${i + 1}. *${o.titulo}* — ${o.descripcion}`),
  ];
  if (opciones.capabilityMode !== "write_enabled") {
    lineas.push("", "_Modo consulta: puedo mirar, todavía no emitir._");
  }
  return lineas.join("\n");
}

// --- Confirmación de emisión ------------------------------------------------

/**
 * El preview de emisión como dos botones.
 *
 * El `confirmation_token` viaja DENTRO del id del botón. Eso es lo que hace que
 * tocar "Emitir" sea lo mismo que confirmar el preview exacto que se leyó: el
 * token está ligado al payload por hash, así que no hay forma de que el botón
 * confirme algo distinto de lo que dice el mensaje.
 *
 * El texto del cuerpo lo arma esta función a partir de números YA CALCULADOS en
 * TypeScript. Si el resumen lo redactara el modelo, el importe que el usuario
 * aprueba y el que se emite podrían no ser el mismo — y el usuario no tendría
 * cómo notarlo.
 */
export function construirConfirmacionEmision(datos: {
  /** El cuerpo ya formateado: ítems, IVA, total y supuestos. Ver `formatearTotales`. */
  resumen: string;
  cliente?: string;
  /** RUT o CI del receptor. Se enmascara. */
  documento?: string;
  tipoComprobante?: string;
  ambiente: "test" | "production";
  token: string;
}): InteractivoBotones {
  // El encabezado dice a QUIÉN, y va arriba de todo: el error más caro de una
  // emisión no es el total, es el cliente. Antes el nombre iba después de los
  // números, donde se lee último o no se lee.
  const quien = datos.cliente === undefined || datos.cliente.trim() === "" ? "" : datos.cliente.trim();
  const encabezado =
    (datos.tipoComprobante ?? "Comprobante") + (quien === "" ? "" : ` a ${quien}`);

  const lineas = [encabezado];
  const doc = enmascararDocumento(datos.documento);
  if (doc !== null) lineas.push(doc);
  lineas.push("", datos.resumen, "", "¿Lo emito?");

  return {
    tipo: "botones",
    cuerpo: lineas.join("\n"),
    pie:
      datos.ambiente === "production"
        ? "⚠️ PRODUCCIÓN: se emite ante DGI de verdad."
        : "Ambiente de prueba (no va a DGI real).",
    // TRES BOTONES, QUE ES EL MÁXIMO DE WHATSAPP.
    //
    // El tercero reemplaza dos pasos enteros del flujo (`otro_item` y `adenda`)
    // por una opción que solo paga el que la usa. Antes, agregar una segunda
    // línea costaba una pregunta a TODAS las emisiones — incluidas las de una
    // sola línea, que son la mayoría. Acá el que quiere agregar toca; el que no,
    // ni se entera de que existía la pregunta.
    //
    // Al tocarlo se abre un ítem vacío y el flujo pide su concepto y su precio;
    // después vuelve a este mismo preview, con el token recalculado sobre el
    // payload nuevo. El ciclo dry-run → token → confirm no cambia en nada.
    botones: [
      { id: `${PREFIJO_EMISION}si:${datos.token}`, titulo: "✅ Emitir" },
      { id: `${PREFIJO_PASO}item:otro`, titulo: "➕ Otro ítem" },
      { id: `${PREFIJO_EMISION}no`, titulo: "✖️ Cancelar" },
    ],
  };
}

interface DatosAnulacion {
  comprobante: string;
  ambiente: "test" | "production";
  token: string;
}

/** Primer toque: obliga a revisar el documento y explica la consecuencia. */
export function construirRevisionAnulacion(datos: DatosAnulacion): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "Anulación · 1 de 2",
    cuerpo:
      `PASO 1 de 2 · Revisar\n\nRevisá antes de seguir: ${datos.comprobante}.\n\n` +
      "La anulación es TOTAL y crea una Nota de Crédito ante DGI. Este botón todavía no anula.",
    pie:
      datos.ambiente === "production"
        ? "⚠️ PRODUCCIÓN: el paso final afecta DGI real."
        : "Ambiente de prueba (no va a DGI real).",
    botones: [
      { id: `${PREFIJO_ANULACION}revisar:${datos.token}`, titulo: "Revisar anulación" },
      { id: `${PREFIJO_ANULACION}no`, titulo: "✖️ Cancelar" },
    ],
  };
}

/** Segundo toque, deliberadamente distinto: es el que autoriza el POST. */
export function construirConfirmacionAnulacion(datos: DatosAnulacion): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "Confirmación final · 2 de 2",
    cuerpo:
      `PASO 2 de 2 · Confirmación final\n\nANULAR ${datos.comprobante}\n\n` +
      "Esto emitirá ahora una Nota de Crédito TOTAL. Confirmá solo si el comprobante es el correcto.",
    pie:
      datos.ambiente === "production"
        ? "⚠️ PRODUCCIÓN: afecta DGI de verdad."
        : "Ambiente de prueba (no va a DGI real).",
    botones: [
      { id: `${PREFIJO_ANULACION}si:${datos.token}`, titulo: "⛔ Anular ahora" },
      { id: `${PREFIJO_ANULACION}no`, titulo: "↩️ No anular" },
    ],
  };
}

/**
 * "219999830019" -> "RUT 21…0011". null si no hay documento.
 *
 * Mismo criterio que el enmascarado del `payload_preview` (write/shared.ts):
 * queda suficiente para reconocer al cliente y no para copiarlo entero. Acá
 * pesa además que el mensaje va por WhatsApp, o sea que queda en el teléfono.
 */
function enmascararDocumento(bruto: string | undefined): string | null {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  if (digitos.length < 7) return null;
  const etiqueta = digitos.length === 12 ? "RUT" : "CI";
  return `${etiqueta} ${digitos.slice(0, 2)}…${digitos.slice(-4)}`;
}

// =============================================================================
// Los submenús de la emisión guiada
//
// Vivían en `emision.ts`, al lado de `siguientePaso`. Están acá por lo que dice
// la cabecera de este archivo: `emision.ts` decide QUÉ preguntar y este módulo
// escribe CÓMO se ve. La dependencia va en un solo sentido —`emision.ts`
// importa de acá— y por eso `PREFIJO_PASO` se mudó a `protocolo.ts`: tenerlo
// del otro lado era el ciclo que impedía esta separación.
// =============================================================================

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
 * YA NO ES UN PASO DEL FLUJO: el 99% de las veces la respuesta es "hoy", así
 * que ahora "hoy" es el default y la fecha aparece en el preview en vez de en
 * una pregunta. Un botón cuyo 99% es una sola opción no es una pregunta, es una
 * confirmación disfrazada — y confirmar es justo lo que hace el preview.
 *
 * Se conserva para el camino explícito: el usuario que dice "quiero cambiar la
 * fecha" sin decir cuál. Ahí sí hay una pregunta genuina que hacer.
 */
/**
 * OJO: hoy NO LO MANDA NADIE, y es una decisión, no un olvido.
 *
 * El retroceso de la fecha se pensó para el preview, y ahí no hay lugar: Meta
 * permite tres botones y los tres están tomados (✅ Emitir · ➕ Otro ítem ·
 * ✖️ Cancelar). El camino que SÍ funciona es el id `emision:fecha:otra`, que
 * marca el borrador (`fecha_a_elegir`) y deja la pregunta abierta hasta que la
 * fecha llegue escrita — eso está probado en `tests/flujoMostradorAuditoria.test.ts`.
 * Se conserva el constructor porque el día que haya un mensaje con lugar para
 * él, el resto del camino ya existe.
 */
export function construirSubmenuFecha(hoy: string = hoyDgiUy()): InteractivoBotones {
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
/**
 * La salida del ítem que se abrió por error.
 *
 * `➕ Otro ítem` en el preview mete un ítem vacío y el flujo pasa a pedir su
 * concepto, que es texto libre. Sin este botón, tocar ➕ sin querer deja al
 * usuario en una pregunta abierta sin ninguna salida tocable — el mismo modo de
 * falla que el paso `otro_item` vino a arreglar en su momento, reintroducido
 * por la puerta de al lado. El invariante del módulo es que el flujo no se
 * puede trancar, y un botón vale más que un comentario que lo declare.
 */
export function construirSubmenuConceptoExtra(): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "¿Qué le agregás?",
    cuerpo:
      "Decime qué es lo otro que le vendiste.\n\nSi tocaste ➕ sin querer, volvemos al comprobante " +
      "como estaba.",
    botones: [{ id: `${PREFIJO_PASO}item:cancelar`, titulo: "↩️ Volver así" }],
  };
}
/**
 * La salida de una línea que tiene plata cargada y no tiene descripción.
 *
 * Es OTRO botón que "↩️ Volver así", y la diferencia es la que importa: aquel
 * descarta un ítem donde no se cargó nada, así que no puede perder nada; este
 * saca una línea que el usuario mencionó. Por eso el botón NOMBRA lo que saca
 * —"🗑️ Sacar $250"— en vez de decir "volver": un descarte de plata tiene que
 * ser una decisión leída, no el efecto lateral de un botón genérico.
 *
 * Sin este botón la pregunta no tiene salida tocable: "↩️ Volver así" no puede
 * sacar un ítem con precio (y hace bien), así que el usuario que no se acuerda
 * qué era esa línea se queda en la misma pregunta para siempre.
 */
export function construirSubmenuLineaSinDescripcion(
  plata: string | null,
  ubicacion?: { posicion: number; precio?: number },
): InteractivoBotones {
  // EL MONTO NO SE RECORTA NUNCA. NI UN DÍGITO.
  //
  // El título de un botón de WhatsApp son 20 caracteres, y esto decía
  // `\`🗑️ Sacar ${plata}\`.slice(0, 20)`. Con "$12.500.000" eso deja
  // "🗑️ Sacar $12.500.00", que en Uruguay —donde el punto es de miles— se lee
  // $12.500,00: el usuario toca un botón que dice doce mil quinientos y saca
  // una línea de doce millones y medio. Es exactamente el error de lectura que
  // `services/importe.ts` existe para prevenir, reintroducido en el eco.
  //
  // Por eso lo que se achica es el TEXTO, en dos escalones, y si ni así entra
  // se cae al genérico: el monto sigue escrito entero en el cuerpo, que no
  // tiene tope de 20.
  const titulo = ((): string => {
    if (plata === null) return "🗑️ Sacar esa línea";
    for (const candidato of [`🗑️ Sacar ${plata}`, `🗑️ ${plata}`]) {
      if (candidato.length <= 20) return candidato;
    }
    return "🗑️ Sacar esa línea";
  })();

  // El id ata el botón a la línea que el usuario está leyendo. Ver `interpretarPaso`.
  const id =
    ubicacion === undefined
      ? `${PREFIJO_PASO}item:descartar`
      : `${PREFIJO_PASO}item:descartar:${ubicacion.posicion}:` +
        `${ubicacion.precio === undefined ? "" : ubicacion.precio}`;

  return {
    tipo: "botones",
    encabezado: "¿Qué era esa línea?",
    cuerpo:
      plata === null
        ? "Me quedó una línea sin descripción. Decime qué era y la pongo en el comprobante.\n\n" +
          "Si no va, la saco."
        : `Me quedó una línea de ${plata} sin descripción. Decime qué era y la pongo en el ` +
          `comprobante.\n\nSi esa línea no va, la saco y seguimos.`,
    botones: [{ id, titulo }],
  };
}
/** Salida explícita para una última línea con precio cero o negativo. */
export function construirSubmenuPrecioNoPositivo(
  posicion: number,
  precio: number,
  moneda: string,
): InteractivoBotones {
  const mostrado = montoConSigno(moneda, precio);
  return {
    tipo: "botones",
    encabezado: "Precio no positivo",
    cuerpo:
      `La línea ${posicion} quedó en ${mostrado} por unidad. ` +
      "¿La dejás así o sacás esa línea del comprobante?",
    botones: [
      {
        id: `${PREFIJO_PASO}item:conservar_precio:${posicion}:${precio}`,
        titulo: "✅ Dejarlo así",
      },
      {
        id: `${PREFIJO_PASO}item:descartar_precio:${posicion}:${precio}`,
        titulo: "🗑️ Sacar línea",
      },
    ],
  };
}
/**
 * Contado o crédito. Define si la factura entra en la cuenta corriente.
 *
 * YA NO ES UN PASO: el default es contado y sale escrito en el preview. Se
 * conserva para el pedido explícito ("quiero cambiar la forma de pago") y
 * porque el crédito sigue derivando el paso de vencimiento.
 */
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
  return {
    tipo: "botones",
    encabezado: "Una cosa sobre el precio",
    cuerpo:
      `Los ${montoConSigno(moneda, precio)} que me pasaste, ¿ya tienen el IVA adentro?\n\n` +
      "Si es el precio que le cobrás al cliente en el mostrador, sí. Si es el precio sin impuestos " +
      "y el IVA se suma aparte, no.",
    pie: "Si me equivoco acá, la factura sale 22% distinta.",
    botones: [
      { id: `${PREFIJO_PASO}iva_incluido:si`, titulo: "✅ Ya incluye IVA" },
      { id: `${PREFIJO_PASO}iva_incluido:no`, titulo: "➕ Se suma aparte" },
    ],
  };
}
/**
 * LAS DOS PREGUNTAS DE IVA, EN UN SOLO MENSAJE.
 *
 * Eran dos pasos seguidos —"¿ya incluye IVA?" y después "¿qué tasa?"— y eran
 * dos formas de preguntar lo mismo: cómo tratar el impuesto de esta venta. La
 * segunda además tenía la respuesta cantada: la tasa básica es el 22% de las
 * ventas y bastante más del 90% de las líneas de una PyME.
 *
 * Fusionadas, los dos botones grandes contestan LAS DOS COSAS de una (criterio
 * de precio + tasa básica) y el tercero abre el caso raro. El que vende
 * alimentos al 10% paga un toque de más; el resto ahorra un mensaje entero, que
 * es la proporción correcta.
 *
 * Nótese que los dos primeros botones son EXACTAMENTE los de `montos_brutos`:
 * la pregunta que se conserva es la que mueve plata (equivocarse cambia la
 * factura un 22%), y la que se defaultea es la que casi nunca cambia.
 */
export function construirSubmenuIvaFusionado(precio: number, moneda: string): InteractivoBotones {
  return {
    tipo: "botones",
    encabezado: "Una cosa sobre el precio",
    cuerpo:
      `Los ${montoConSigno(moneda, precio)} que me pasaste, ¿ya tienen el IVA adentro?\n\n` +
      "Si es el precio que le cobrás al cliente en el mostrador, sí. Si es el precio sin impuestos " +
      "y el IVA se suma aparte, no.\n\n" +
      "En los dos casos tomo la tasa básica (22%). Si esto lleva otro IVA —10%, exento—, tocá el " +
      "tercer botón.",
    pie: "Si me equivoco acá, la factura sale 22% distinta.",
    botones: [
      { id: `${PREFIJO_PASO}iva_incluido:si`, titulo: "✅ Ya incluye IVA" },
      { id: `${PREFIJO_PASO}iva_incluido:no`, titulo: "➕ Se suma aparte" },
      { id: `${PREFIJO_PASO}iva_incluido:otro`, titulo: "🔢 Otro IVA" },
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
  // UNA FILA SIN DOCUMENTO NO SE PUEDE TOCAR.
  //
  // El id lleva el documento, que es lo que el paso `cliente` sabe leer. Sin
  // él salía `emision:cliente:0`, y tocar esa fila contestaba "0 no tiene forma
  // de RUT" y volvía a preguntar lo mismo: una opción visible que no resuelve
  // nada. El que no tiene documento entra por "➕ Otro cliente", que sí tiene
  // camino.
  const filas: Array<{ id: string; titulo: string; descripcion?: string }> = clientes
    .filter((c) => (c.documento ?? "").trim() !== "")
    .slice(0, 9)
    .map((c) => ({
      id: `${PREFIJO_PASO}cliente:${c.documento!}`,
      titulo: c.nombre.slice(0, 24),
      descripcion: `RUT/CI ${c.documento!}`,
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
