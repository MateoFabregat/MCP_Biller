// =============================================================================
// Qué día es HOY en Uruguay.
//
// EL BUG QUE ESTE MÓDULO EXISTE PARA CERRAR
//
// Había dos formas distintas de contestar esa pregunta, y las dos estaban mal:
//
//   · `hoyDgi` (kapso/emision.ts) usaba los getters LOCALES del proceso.
//   · `aIso` (services/periodo.ts) usaba los getters UTC sobre un `new Date()`.
//
// Ninguna parte del proyecto fija `TZ`, así que en un contenedor —Vercel, un
// Docker, cualquier server -— el proceso corre en UTC. Uruguay es UTC−3 todo el
// año. Consecuencias, las dos reales:
//
//   1. Un almacén que factura a las 21:30 de Montevideo recibía
//      `fecha_emision` = MAÑANA en un CFE de verdad. Un documento fiscal con la
//      fecha equivocada no se corrige: se anula con una nota de crédito.
//   2. "¿Cuánto vendí hoy?" después de las 21:00 contestaba cero, porque el
//      rango se armaba para el día siguiente.
//
// Y peor que cada una por separado: las dos funciones podían estar en días
// DISTINTOS al mismo tiempo, así que el comprobante se emitía con una fecha y
// el resumen lo buscaba en otra.
//
// POR QUÉ Intl Y NO UN −3 A MANO
//
// Restar tres horas funciona hoy y es una bomba de tiempo: Uruguay tuvo horario
// de verano hasta 2015 y podría volver a tenerlo. `Intl` usa la base de datos
// de zonas horarias del sistema, que es la que se actualiza sola. El costo es
// un objeto de formato; el beneficio es no tener que acordarse.
// =============================================================================

/** La zona del negocio. Todo el producto factura en Uruguay. */
export const ZONA_UY = "America/Montevideo";

const FORMATO_ISO = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_UY,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * El día de hoy en Uruguay, como `aaaa-mm-dd`.
 *
 * `en-CA` da exactamente ese formato, así que no hay que rearmar el string
 * pieza por pieza — que es donde se cuelan los off-by-one de mes.
 */
export function hoyIsoUy(ahora: Date = new Date()): string {
  return FORMATO_ISO.format(ahora);
}

/**
 * El día de hoy en Uruguay, como `dd/mm/aaaa`, que es lo que espera Biller.
 *
 * Sale del ISO y no de un formateo aparte: dos formateadores distintos son dos
 * chances de estar en días distintos, y este es el que termina impreso en un CFE.
 */
export function hoyDgiUy(ahora: Date = new Date()): string {
  const [anio, mes, dia] = hoyIsoUy(ahora).split("-");
  return `${dia}/${mes}/${anio}`;
}

/** Un `Date` anclado al mediodía UTC del día uruguayo de hoy. */
export function hoyComoDateUy(ahora: Date = new Date()): Date {
  return new Date(`${hoyIsoUy(ahora)}T12:00:00Z`);
}
