// =============================================================================
// Cómo se traen las ventanas: en paralelo, con reintento, y pasando por cache.
//
// Las tres cosas atacan el mismo problema desde ángulos distintos, y ninguna
// sola alcanza.
//
// PARALELISMO ACOTADO
//
// Las ventanas son independientes entre sí: se piden por rangos de fecha
// disjuntos y el resultado se une deduplicando. Pedirlas de a una era el orden
// más simple de escribir, no una necesidad. Con concurrencia 4, "ultimos_90_dias"
// baja de ~5,5 s a ~1,5 s.
//
// El límite es 4 y no "todas": el rate limiter documentado de Biller es 30
// req/s, y saturar la cuenta de una empresa con 53 requests simultáneas para
// contestar "¿cómo viene el mes?" es una forma de que el resto de sus
// integraciones empiece a recibir errores por culpa nuestra.
//
// REINTENTO
//
// Los 500 de esta API NO son excepcionales: está documentado que devuelve 500
// con rangos amplios en vez de paginar o truncar. Sin reintento, un 500 en la
// ventana 40 de 53 tira a la basura las 39 anteriores y el usuario recibe un
// error por algo que anda. Solo se reintenta lo que puede ser transitorio (5xx,
// timeout, red) y NUNCA un 4xx: un 422 es una respuesta, no una falla.
//
// Que sea seguro reintentar acá y no en la escritura no es una casualidad: esto
// es GET. Un GET repetido no emite nada.
// =============================================================================

import { logger } from "../logger.js";
import { BillerApiError, BillerNetworkError, BillerTimeoutError } from "../utils/errors.js";

/** Cuántas ventanas se piden a la vez. */
export const CONCURRENCIA = 4;

/** Cuántas veces se reintenta una ventana que falló por algo transitorio. */
export const MAX_REINTENTOS = 2;

/** Espera antes de cada reintento. Creciente: si está saturada, insistir no ayuda. */
export const BACKOFF_MS = [400, 1200];

/** ¿Vale la pena volver a intentar este error? */
export function esTransitorio(err: unknown): boolean {
  if (err instanceof BillerTimeoutError || err instanceof BillerNetworkError) return true;
  // Un 4xx es una respuesta de la API: el rango es inválido, el token no sirve,
  // el comprobante no existe. Reintentarlo solo gasta la cuota de la empresa.
  if (err instanceof BillerApiError) return err.status >= 500;
  return false;
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ejecuta `fn` reintentando lo transitorio. */
export async function conReintento<T>(
  fn: () => Promise<T>,
  opciones: { maxReintentos?: number; etiqueta?: string; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const max = opciones.maxReintentos ?? MAX_REINTENTOS;
  const sleepFn = opciones.sleepFn ?? dormir;
  let ultimo: unknown;

  for (let intento = 0; intento <= max; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (!esTransitorio(err) || intento === max) break;
      const espera = BACKOFF_MS[intento] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      logger.debug("biller.reintento", {
        etiqueta: opciones.etiqueta,
        intento: intento + 1,
        espera_ms: espera,
      });
      await sleepFn(espera);
    }
  }
  throw ultimo;
}

/**
 * `Promise.all` con techo de concurrencia, preservando el orden de salida.
 *
 * El orden importa más de lo que parece: los warnings y la deduplicación
 * dependen de recorrer las ventanas en orden cronológico, y un resultado que
 * cambia de orden según cuál respondió primero hace que dos ejecuciones
 * idénticas devuelvan JSON distinto — que es lo que convierte un test en
 * intermitente.
 */
export async function mapConLimite<T, R>(
  items: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limite), items.length) }, () => worker()),
  );
  return resultados;
}
