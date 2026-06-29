// =============================================================================
// biller_resumen_facturacion_periodo  (solicitado: resumen_facturacion_periodo)
//
// Usa GET /v2/comprobantes/obtener (emitidos) y agrega por moneda y por tipo.
// Ventas suman, NC restan, ND suman. NO convierte monedas.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import { resumirFacturacion } from "../services/resumenFacturacion.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  fechaHoraSchema,
  jsonResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  desde: fechaHoraSchema.describe("Requerido. Inicio del período, formato aaaa-mm-dd hh:mm:ss."),
  hasta: fechaHoraSchema.describe("Requerido. Fin del período, formato aaaa-mm-dd hh:mm:ss."),
  sucursal: z.string().optional().describe("Sucursal emisora. Si se omite, usa BILLER_DEFAULT_SUCURSAL_ID si existe."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda antes de agregar."),
  cliente_rut: z.string().optional().describe("Filtro LOCAL por RUT de cliente (solo si es extraíble; si no, warning)."),
  incluir_anulados: z.boolean().optional().default(false).describe("Default false."),
};

export const resumenInputSchema = z.object(inputShape);

const monedaTotalSchema = z.object({ total: z.number(), comprobantes: z.number() });
const tipoTotalSchema = z.object({
  tipo: z.number(),
  categoria: z.enum(["venta", "nota_credito", "nota_debito", "especial", "desconocido"]),
  etiqueta: z.string(),
  signo: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  total_por_moneda: z.record(z.number()),
  conteo: z.number(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string() }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  filtros_aplicados: z.record(z.unknown()),
  totales_por_moneda: z.record(monedaTotalSchema),
  totales_por_tipo_comprobante: z.record(tipoTotalSchema),
  conteo_por_tipo_comprobante: z.record(z.number()),
  conteo_total: z.number(),
  conteo_incluidos: z.number(),
  conteo_excluidos: z.number(),
  warnings: z.array(z.string()),
  no_convertir_moneda: z.literal(true),
};

export async function handleResumenFacturacion(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = resumenInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const comprobantes = await fetchEmitidos(client, { desde: a.desde, hasta: a.hasta, sucursal });

    const filtered = filterEmitidos(comprobantes, { moneda: a.moneda, cliente_rut: a.cliente_rut });
    const resumen = resumirFacturacion(filtered.list, { incluir_anulados: a.incluir_anulados });

    const warnings = [...filtered.warnings, ...resumen.warnings];

    return jsonResult({
      periodo: { desde: a.desde, hasta: a.hasta },
      fuente: "biller:/v2/comprobantes/obtener",
      filtros_aplicados: {
        sucursal: sucursal ?? null,
        moneda: a.moneda ?? null,
        cliente_rut: a.cliente_rut ?? null,
        incluir_anulados: a.incluir_anulados,
      },
      totales_por_moneda: resumen.totales_por_moneda,
      totales_por_tipo_comprobante: resumen.totales_por_tipo_comprobante,
      conteo_por_tipo_comprobante: resumen.conteo_por_tipo_comprobante,
      conteo_total: resumen.conteo_total,
      conteo_incluidos: resumen.conteo_incluidos,
      conteo_excluidos: resumen.conteo_excluidos,
      warnings,
      no_convertir_moneda: true,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerResumenFacturacion(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_resumen_facturacion_periodo",
    {
      title: "Resumen de facturación por período",
      description:
        "Calcula totales de comprobantes emitidos en un período (GET /v2/comprobantes/obtener), separados por moneda y por tipo. " +
        "Ventas suman, Notas de Crédito restan, Notas de Débito suman. No convierte monedas. " +
        "Reporta warnings si no puede clasificar un tipo, si faltan campos o si no puede excluir anulados.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Resumen de facturación" },
    },
    async (args) => handleResumenFacturacion(args, ctx),
  );
}
