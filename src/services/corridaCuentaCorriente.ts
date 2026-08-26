// =============================================================================
// La corrida de cuenta corriente: UNA sola, para las dos tools que la necesitan.
//
// POR QUÉ ES UNA ORQUESTADORA Y NO UN CÁLCULO PURO
//
// `services/cuentaCorriente.ts` calcula la deuda a partir de comprobantes ya
// traídos y no toca la red. Esta capa es la que hace el I/O: baja la ventana de
// comprobantes y, para imputar EXACTO, pide el detalle de cada recibo (una
// llamada por recibo, ver `cargarReferencias`). Por eso vive en un módulo
// aparte: quien solo quiere el cálculo no se lleva puesta la pila HTTP.
//
// POR QUÉ ESTÁ COMPARTIDA (el motivo original, que sigue en pie)
//
// `biller_cuenta_corriente` (lo que ve el dueño) y `biller_recordatorio_cobro`
// (lo que se le manda al cliente) tienen que calcular la MISMA deuda con el
// MISMO criterio. Si cada tool armara la suya, el número que se muestra y el
// que se envía podrían diferir, y esa diferencia se descubriría en el peor
// lugar posible: en el WhatsApp de un tercero.
//
// Antes esto vivía en `tools/cuentaCorriente.ts` y la otra tool lo importaba de
// ahí — una tool importando de otra tool. El porqué era correcto; el lugar no.
// =============================================================================

import { traerPorId } from "../biller/traerDetalles.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import type { ToolContext } from "../tools/shared.js";
import { classifyCfe } from "./cfeTypes.js";
import {
  calcularCuentaCorriente,
  referenciasDeRecibo,
  type CuentaCorrienteResultado,
  type ReferenciaCobranza,
} from "./cuentaCorriente.js";
import { hoyComoDateUy } from "./fechaUy.js";
import { aIso } from "./periodo.js";
import { traerVentana } from "./ventana.js";

/** Tope de consultas de detalle, para no disparar cientos de llamadas sin aviso. */
const MAX_DETALLE_RECIBOS = 50;

/**
 * Trae el detalle de cada recibo para leer a qué facturas se imputó.
 *
 * Por qué hace falta una llamada por recibo: el listado devuelve `items: null`
 * y la imputación de un recibo vive en el CONCEPTO de sus ítems (verificado
 * contra la API real). Sin esta consulta no hay forma de saber qué factura
 * pagó cada cobro, y todo cae a FIFO.
 *
 * Devuelve un mapa id -> referencias. Los recibos cuyo detalle no aporta nada
 * quedan fuera del mapa, y el servicio los imputa por FIFO.
 */
async function cargarReferencias(
  ctx: ToolContext,
  recibos: ComprobanteEmitido[],
): Promise<{ mapa: Map<number, ReferenciaCobranza[]>; consultados: number; warnings: string[] }> {
  const mapa = new Map<number, ReferenciaCobranza[]>();
  const warnings: string[] = [];
  const conId = recibos.filter((r) => r.id !== null);

  const aConsultar = conId.slice(0, MAX_DETALLE_RECIBOS);
  if (conId.length > MAX_DETALLE_RECIBOS) {
    warnings.push(
      `Hay ${conId.length} recibos y se consultó el detalle de los primeros ${MAX_DETALLE_RECIBOS} ` +
        "para no disparar cientos de llamadas. El resto se imputó por FIFO. Acotá el período o " +
        "el rango para una imputación completa.",
    );
  }

  // En paralelo acotado, con reintento y con cache (`biller/traerDetalles.ts`).
  // Antes era un bucle en serie: 50 recibos eran ~20 s de espera para contestar
  // "¿quién me debe?", y un 500 transitorio mandaba ese recibo a FIFO sin
  // haberlo intentado de nuevo.
  const ids = aConsultar.map((r) => r.id!);
  const { detalles, fallidos } = await traerPorId(ctx.getClient(), ids);

  for (const id of ids) {
    const detalle = detalles.get(id);
    if (detalle === undefined) continue;
    // `referenciasDeRecibo` mira primero un campo `referencias` y después el
    // concepto de los ítems, que es de donde salen HOY (ver cuentaCorriente.ts).
    const refs = referenciasDeRecibo(detalle);
    if (refs !== null) mapa.set(id, refs);
  }

  // Un detalle que falla no invalida el resto: ese recibo cae a FIFO. Solo se
  // avisa del ERROR: una respuesta sin contenido no es una falla, es un recibo
  // que no declara a qué se imputó.
  for (const fallo of fallidos) {
    if (fallo.motivo !== "error") continue;
    warnings.push(
      `No se pudo consultar el detalle del recibo ${fallo.id}: se imputó por FIFO en vez de por referencias.`,
    );
  }

  if (aConsultar.length > 0 && mapa.size === 0) {
    warnings.push(
      `Se consultó el detalle de ${aConsultar.length} recibo(s) y NINGUNO devolvió referencias al ` +
        "comprobante que paga. La imputación por factura es FIFO (estimada). El saldo por cliente " +
        "no se ve afectado: ese sí es exacto.",
    );
  }

  return { mapa, consultados: aConsultar.length, warnings };
}

/** Parámetros de la corrida de cuenta corriente, ya con defaults resueltos. */
export interface CorridaCuentaCorriente {
  dias_atras: number;
  imputar_por_referencias: boolean;
  solo_a_credito: boolean;
  solo_aceptados: boolean;
  incluir_canceladas: boolean;
  sucursal?: string;
  ventana_dias?: number;
  /**
   * Saltea la lectura del cache de ventanas. Solo para el paso de confirmación
   * de algo que sale hacia afuera: ver `consultarPorPeriodo`.
   */
  sin_cache?: boolean;
}

export interface ResultadoCorrida {
  resultado: CuentaCorrienteResultado;
  hoy: Date;
  hoyIso: string;
  rango: { desde: string; hasta: string };
  /** La sucursal efectivamente consultada, con el default de la empresa ya aplicado. */
  sucursal: string | undefined;
  ventanas: number;
  detalles_consultados: number;
  warnings: string[];
}

/**
 * Trae los comprobantes, imputa los cobros y calcula la cuenta corriente.
 *
 * Es el ÚNICO camino hacia el saldo de un cliente: tanto la tool que se lo
 * muestra al dueño como la que se lo manda al cliente pasan por acá (ver el
 * encabezado del módulo).
 */
export async function correrCuentaCorriente(
  ctx: ToolContext,
  a: CorridaCuentaCorriente,
): Promise<ResultadoCorrida> {
  // Día uruguayo, no día del proceso: los tramos de mora ("0-30", "31-60") se
  // cuentan desde hoy, y en UTC ese "hoy" se adelanta a las 21:00 de Montevideo.
  const hoy = hoyComoDateUy();
  const hoyIso = aIso(hoy);
  const desde = aIso(new Date(hoy.getTime() - a.dias_atras * 86_400_000));
  const rango = { desde, hasta: hoyIso };

  // El filtro LOCAL por cliente/moneda NO se pide acá: sacar cobros antes de
  // imputar inflaría la deuda. Se aplica sobre el resultado.
  const ventana = await traerVentana(ctx, {
    rango,
    sucursal: a.sucursal,
    ventana_dias: a.ventana_dias,
    sinCache: a.sin_cache,
  });

  // Detalle de recibos, para imputar por referencias reales.
  let referenciasPorId = new Map<number, ReferenciaCobranza[]>();
  let detallesConsultados = 0;
  const warningsDetalle: string[] = [];
  if (a.imputar_por_referencias) {
    const recibos = ventana.comprobantes.filter(
      (c) => classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia).categoria === "cobranza",
    );
    if (recibos.length > 0) {
      const cargadas = await cargarReferencias(ctx, recibos);
      referenciasPorId = cargadas.mapa;
      detallesConsultados = cargadas.consultados;
      warningsDetalle.push(...cargadas.warnings);
    }
  }

  const resultado = calcularCuentaCorriente(ventana.comprobantes, {
    hoy,
    solo_aceptados: a.solo_aceptados,
    solo_a_credito: a.solo_a_credito,
    incluir_canceladas: a.incluir_canceladas,
    resolverReferencias: (c) =>
      (c.id !== null ? referenciasPorId.get(c.id) : undefined) ?? referenciasDeRecibo(c),
  });

  return {
    resultado,
    hoy,
    hoyIso,
    rango,
    sucursal: ventana.sucursal,
    ventanas: ventana.ventanas,
    detalles_consultados: detallesConsultados,
    warnings: [...ventana.warnings, ...warningsDetalle],
  };
}
