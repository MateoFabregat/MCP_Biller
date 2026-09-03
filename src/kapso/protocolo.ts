// =============================================================================
// El protocolo de ids: lo que mandamos NOSOTROS y vuelve tal cual.
//
// Cada mensaje interactivo que sale de acá (una fila del menú, un botón del
// preview, un botón de desambiguación) lleva un id que el usuario no escribe:
// lo toca, y WhatsApp nos lo devuelve como TEXTO, por el mismo canal que "hola".
// Este módulo es el único lugar donde se decide cómo se escriben esos ids y cómo
// se leen de vuelta.
//
// Está separado del enrutador a propósito: el enrutador ADIVINA (normaliza,
// puntúa, tolera typos) y acá no hay nada que adivinar — un id o es nuestro o no
// lo es. Por eso los lectores de este módulo corren PRIMERO en
// `interpretarMensaje`, antes de cualquier heurística.
//
// No depende de nada: ni del catálogo, ni de los constructores de mensajes.
// =============================================================================

/** Prefijo de los ids del menú. Distingue una elección de menú de otras respuestas. */
export const PREFIJO_MENU = "menu:";

/** Prefijo de los ids de la confirmación de emisión. */
export const PREFIJO_EMISION = "emitir:";

/** Prefijo de los dos pasos explícitos de una anulación. */
export const PREFIJO_ANULACION = "anular:";

/**
 * Prefijo de los ids de un paso de la emisión guiada.
 *
 * Vive acá y no en `emision.ts` por la misma razón que los otros tres: lo
 * escriben los constructores de mensajes (`render.ts`) y lo leen el enrutador y
 * el intérprete de pasos. Tenerlo del lado de la decisión obligaba a que
 * `render.ts` importara `emision.ts`, y con los submenús acá eso era un ciclo.
 */
export const PREFIJO_PASO = "emision:";

/**
 * Prefijo de los botones de desambiguación de `biller_resolver_nombre`.
 *
 * Cuarto prefijo propio, y va con los otros tres por el mismo motivo: llega como
 * texto igual que "hola". Sin esta rama, "resolver:cliente:0" —la respuesta a
 * "¿cuál de estos dos clientes?"— no matchea ningún sinónimo, cae en
 * `desconocido` y el bot contesta el menú entero: el usuario acaba de elegir
 * entre dos candidatos y lo mandan al principio.
 */
export const PREFIJO_RESOLVER = "resolver:";
/**
 * Lee el botón de desambiguación: "resolver:cliente:1" -> el segundo candidato.
 *
 * Devuelve null para todo lo que no reconoce, para que un id mal formado siga su
 * camino por el enrutador en vez de cortar la conversación.
 */
export function interpretarRespuestaResolucion(
  raw: string,
): { tipo: "cliente" | "producto"; indice: number } | null {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_RESOLVER)) return null;
  const partes = texto.slice(PREFIJO_RESOLVER.length).split(":");
  const tipo = partes[0];
  const indice = Number(partes[1]);
  if (tipo !== "cliente" && tipo !== "producto") return null;
  if (!Number.isInteger(indice) || indice < 0) return null;
  return { tipo, indice };
}

export type RespuestaEmision =
  | { accion: "emitir"; token: string }
  | { accion: "cancelar" }
  | { accion: "ninguna" };

/** Lee la respuesta a la confirmación. El token vuelve tal cual se mandó. */
export function interpretarRespuestaEmision(raw: string): RespuestaEmision {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_EMISION)) return { accion: "ninguna" };
  const resto = texto.slice(PREFIJO_EMISION.length);
  if (resto === "no") return { accion: "cancelar" };
  if (resto.startsWith("si:")) {
    const token = resto.slice(3);
    return token === "" ? { accion: "ninguna" } : { accion: "emitir", token };
  }
  return { accion: "ninguna" };
}

export type RespuestaAnulacion =
  | { accion: "revisar"; token: string }
  | { accion: "anular"; token: string }
  | { accion: "cancelar" }
  | { accion: "ninguna" };

/** Lee exclusivamente ids emitidos por nuestros botones de anulación. */
export function interpretarRespuestaAnulacion(raw: string): RespuestaAnulacion {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_ANULACION)) return { accion: "ninguna" };
  const resto = texto.slice(PREFIJO_ANULACION.length);
  if (resto === "no") return { accion: "cancelar" };
  for (const [prefijo, accion] of [
    ["revisar:", "revisar"],
    ["si:", "anular"],
  ] as const) {
    if (!resto.startsWith(prefijo)) continue;
    const token = resto.slice(prefijo.length);
    return token === "" ? { accion: "ninguna" } : { accion, token };
  }
  return { accion: "ninguna" };
}
