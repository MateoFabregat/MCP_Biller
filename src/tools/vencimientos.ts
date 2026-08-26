// =============================================================================
// biller_vencimientos
//
// "¿Qué facturas vencen esta semana?" y el aging de lo ya vencido.
//
// Consulta los comprobantes emitidos en una ventana hacia atrás (por defecto 180
// días) y los clasifica por `fecha_vencimiento` respecto de hoy. La ventana
// existe porque una factura que vence esta semana pudo emitirse hace meses.
//
// ⚠️ NO es un estado de cuenta: es lo FACTURADO con vencimiento en el rango, no
// la deuda neta. Los recibos (indicador_cobranza_propia=1) se identifican y se
// sacan del listado —cobrar un recibo no tiene sentido— pero todavía no se
// imputan contra la factura que pagan. El warning viaja siempre en la respuesta.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import { aIso, consultarPorPeriodo } from "../services/periodo.js";
import { BUCKETS, analizarVencimientos } from "../services/vencimientos.js";
import {
  READ_ONLY_ANNOTATIONS,
  applyLimit,
  errorToolResult,
  jsonResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/** Ventana hacia atrás por defecto: cubre plazos de pago de hasta ~6 meses. */
const DIAS_ATRAS_DEFAULT = 180;

const inputShape = {
  horizonte_dias: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .default(7)
    .describe(
      "Cuántos días hacia adelante mirar. 7 = 'lo que vence esta semana'; 0 = solo hasta hoy.",
    ),
  incluir_vencidas: z
    .boolean()
    .optional()
    .default(true)
    .describe("Incluir las facturas cuyo vencimiento ya pasó (default true)."),
  dias_atras: z
    .number()
    .int()
    .min(1)
    .max(730)
    .optional()
    .default(DIAS_ATRAS_DEFAULT)
    .describe(
      `Ventana de EMISIÓN hacia atrás a consultar (default ${DIAS_ATRAS_DEFAULT}). Una factura que vence ` +
        "esta semana pudo emitirse hace meses; si tenés plazos más largos, subilo. Cada 7 días es una " +
        "llamada más a la API.",
    ),
  solo_a_credito: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true: descarta el contado con la heurística fecha_vencimiento <= fecha_emision " +
        "(Biller no expone la forma de pago en el GET).",
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe("Default true: considera solo comprobantes en estado 'Aceptado DGI'."),
  sucursal: z.string().optional().describe("Filtra la consulta a una sola sucursal (ID real de Biller)."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda (ej: UYU, USD)."),
  cliente_rut: z.string().optional().describe("Filtro LOCAL por RUT de cliente (solo si es extraíble)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(200)
    .describe("Máximo de facturas en el listado detallado. Los totales se calculan sobre TODAS."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const vencimientosInputSchema = z.object(inputShape);

const montoPorMonedaSchema = z.object({ total: z.number(), comprobantes: z.number() });

const facturaSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  etiqueta_tipo: z.string(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  fecha_emision: z.string().nullable(),
  fecha_vencimiento: z.string(),
  dias_para_vencer: z.number(),
  bucket: z.enum(BUCKETS),
  cliente_rut: z.string().nullable(),
  cliente_nombre: z.string().nullable(),
  moneda: z.string(),
  total: z.number(),
  estado: z.string().nullable(),
  sucursal: z.number().nullable(),
});

const resumenBucketSchema = z.object({
  bucket: z.enum(BUCKETS),
  etiqueta: z.string(),
  vencida: z.boolean(),
  totales_por_moneda: z.record(montoPorMonedaSchema),
  conteo: z.number(),
});

const resumenClienteSchema = z.object({
  cliente_rut: z.string().nullable(),
  cliente_nombre: z.string().nullable(),
  totales_por_moneda: z.record(montoPorMonedaSchema),
  vencido_por_moneda: z.record(montoPorMonedaSchema),
  conteo: z.number(),
  dias_atraso_maximo: z.number(),
});

const outputShape = {
  hoy: z.string(),
  ventana: z.object({
    emitidas_desde: z.string(),
    emitidas_hasta: z.string(),
    horizonte_dias: z.number(),
    incluir_vencidas: z.boolean(),
  }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  filtros_aplicados: z.record(z.unknown()),
  totales_por_moneda: z.record(montoPorMonedaSchema),
  vencido_por_moneda: z.record(montoPorMonedaSchema),
  por_vencer_por_moneda: z.record(montoPorMonedaSchema),
  resumen_por_bucket: z.array(resumenBucketSchema),
  por_cliente: z.array(resumenClienteSchema),
  facturas: z.array(facturaSchema),
  conteo_analizados: z.number(),
  conteo_incluidos: z.number(),
  excluidos: z.record(z.number()),
  ventanas_consultadas: z.number(),
  /**
   * false: los recibos SÍ se leen (indicador_cobranza_propia=1), pero esta tool
   * todavía no los descuenta factura por factura. Lo listado es lo facturado.
   */
  cobranzas_imputadas: z.literal(false),
  warnings: z.array(z.string()),
  no_convertir_moneda: z.literal(true),
};

export async function handleVencimientos(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = vencimientosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const hoy = new Date();
    const hoyIso = aIso(hoy);
    const desde = aIso(new Date(hoy.getTime() - a.dias_atras * 86_400_000));
    const rango = { desde, hasta: hoyIso };

    const consulta = await consultarPorPeriodo(client, rango, {
      sucursal,
      ventanaDias: a.ventana_dias,
    });

    // Filtro local por fecha de EMISIÓN: la API filtra por fecha de creación.
    const filtered = filterEmitidos(consulta.comprobantes, {
      moneda: a.moneda,
      cliente_rut: a.cliente_rut,
      emitidas_desde: rango.desde,
      emitidas_hasta: rango.hasta,
    });

    const resultado = analizarVencimientos(filtered.list, {
      hoy,
      horizonte_dias: a.horizonte_dias,
      incluir_vencidas: a.incluir_vencidas,
      solo_aceptados: a.solo_aceptados,
      solo_a_credito: a.solo_a_credito,
    });

    const limitado = applyLimit(resultado.facturas, a.limit);

    return jsonResult({
      hoy: hoyIso,
      ventana: {
        emitidas_desde: rango.desde,
        emitidas_hasta: rango.hasta,
        horizonte_dias: a.horizonte_dias,
        incluir_vencidas: a.incluir_vencidas,
      },
      fuente: "biller:/v2/comprobantes/obtener",
      filtros_aplicados: {
        sucursal: sucursal ?? null,
        moneda: a.moneda ?? null,
        cliente_rut: a.cliente_rut ?? null,
        solo_aceptados: a.solo_aceptados,
        solo_a_credito: a.solo_a_credito,
        dias_atras: a.dias_atras,
      },
      totales_por_moneda: resultado.totales_por_moneda,
      vencido_por_moneda: resultado.vencido_por_moneda,
      por_vencer_por_moneda: resultado.por_vencer_por_moneda,
      resumen_por_bucket: resultado.resumen_por_bucket,
      por_cliente: resultado.por_cliente,
      facturas: limitado.list,
      conteo_analizados: resultado.conteo_analizados,
      conteo_incluidos: resultado.conteo_incluidos,
      excluidos: { ...resultado.excluidos },
      ventanas_consultadas: consulta.ventanas,
      cobranzas_imputadas: false,
      warnings: [
        ...consulta.warnings,
        ...filtered.warnings,
        ...resultado.warnings,
        ...limitado.warnings,
        `Solo se miraron comprobantes emitidos desde ${rango.desde}. Una factura más vieja que eso ` +
          "no aparece: subí 'dias_atras' si trabajás con plazos más largos.",
      ],
      no_convertir_moneda: true,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerVencimientos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_vencimientos",
    {
      title: "Vencimientos y aging de facturas",
      description:
        "Facturas por fecha de vencimiento: qué vence en los próximos días y qué ya venció, con " +
        "aging por tramos (1-30, 31-60, 61-90, +90 días) y ranking de clientes por monto vencido. " +
        "Responde '¿qué tengo que cobrar esta semana?' y '¿quién me debe más?'. " +
        "IMPORTANTE: es lo FACTURADO con vencimiento en el rango, NO la deuda neta. Los recibos de " +
        "cobranza se detectan y se excluyen del listado, pero todavía no se descuentan de cada " +
        "factura, así que una factura ya cobrada aparece igual. Siempre aclarar ese límite al " +
        "responder.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Vencimientos y aging" },
    },
    async (args) => handleVencimientos(args, ctx),
  );
}
