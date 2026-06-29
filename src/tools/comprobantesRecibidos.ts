// =============================================================================
// biller_listar_comprobantes_recibidos  (solicitado: listar_comprobantes_recibidos)
//
// GET /v2/comprobantes/recibidos/obtener (datos DGI, limitados: solo montos
// totales, sin items). Filtros por proveedor/moneda/tipo/estado son LOCALES.
// Rate limit DGI (1 req/seg).
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchRecibidos } from "../biller/queries.js";
import { ComprobanteRecibidoSchema } from "../biller/types.js";
import { filterRecibidos } from "../services/comprobanteFilters.js";
import {
  READ_ONLY_ANNOTATIONS,
  applyLimit,
  errorToolResult,
  fechaSchema,
  jsonResult,
  paginationProbeSchema,
  paginationWarnings,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  fecha_desde: fechaSchema.describe("Requerido. Formato aaaa-mm-dd."),
  fecha_hasta: fechaSchema.describe("Requerido. Formato aaaa-mm-dd."),
  proveedor_rut: z.string().optional().describe("Filtro LOCAL por rut_emisor."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda."),
  tipo: z.number().int().optional().describe("Filtro LOCAL por tipo de comprobante."),
  estado: z.string().optional().describe("Filtro LOCAL por estado (ej: AE)."),
  limit: z.number().int().positive().optional().describe("Límite LOCAL sobre la respuesta recibida."),
  ...paginationProbeSchema,
};

export const recibidosInputSchema = z.object(inputShape);

const outputShape = {
  comprobantes: z.array(ComprobanteRecibidoSchema),
  count: z.number(),
  pagination_supported: z.literal(false),
  filtros_aplicados: z.record(z.unknown()),
  warnings: z.array(z.string()),
};

export async function handleListarRecibidos(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = recibidosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const client = ctx.getClient();
    const comprobantes = await fetchRecibidos(client, {
      fecha_desde: a.fecha_desde,
      fecha_hasta: a.fecha_hasta,
    });

    const warnings: string[] = [];
    warnings.push(...paginationWarnings(a));
    warnings.push(
      "Los comprobantes recibidos provienen de DGI y son limitados: incluyen solo montos totales, sin items.",
    );

    const filtered = filterRecibidos(comprobantes, {
      proveedor_rut: a.proveedor_rut,
      moneda: a.moneda,
      tipo: a.tipo,
      estado: a.estado,
    });
    warnings.push(...filtered.warnings);

    const limited = applyLimit(filtered.list, a.limit);
    warnings.push(...limited.warnings);

    return jsonResult({
      comprobantes: limited.list,
      count: limited.list.length,
      pagination_supported: false,
      filtros_aplicados: {
        fecha_desde: a.fecha_desde,
        fecha_hasta: a.fecha_hasta,
        proveedor_rut: a.proveedor_rut ?? null,
        moneda: a.moneda ?? null,
        tipo: a.tipo ?? null,
        estado: a.estado ?? null,
        limit: a.limit ?? null,
      },
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerListarRecibidos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_listar_comprobantes_recibidos",
    {
      title: "Listar comprobantes recibidos (DGI)",
      description:
        "Lista comprobantes recibidos vía GET /v2/comprobantes/recibidos/obtener (datos DGI, solo montos totales). " +
        "Requiere fecha_desde y fecha_hasta (aaaa-mm-dd). Filtros por proveedor/moneda/tipo/estado son locales. Rate limit DGI: 1 req/seg.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Listar comprobantes recibidos" },
    },
    async (args) => handleListarRecibidos(args, ctx),
  );
}
