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
import { PREFIJO_PASO } from "./emision.js";
import { opcionesDisponibles, type MenuOpcion, type MenuOpciones } from "./intenciones.js";
import { PREFIJO_EMISION } from "./protocolo.js";

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
