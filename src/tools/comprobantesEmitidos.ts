// =============================================================================
// biller_listar_comprobantes_emitidos  (solicitado: listar_comprobantes_emitidos)
//
// GET /v2/comprobantes/obtener. Filtros por moneda/cliente_rut son LOCALES.
// No se asume paginación ni campo de anulación (no documentados).
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import { ComprobanteEmitidoSchema } from "../biller/types.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import {
  READ_ONLY_ANNOTATIONS,
  applyLimit,
  errorToolResult,
  fechaHoraSchema,
  jsonResult,
  paginationProbeSchema,
  paginationWarnings,
  trioSuperRefine,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  desde: fechaHoraSchema.optional().describe("Desde (fecha de creación), formato aaaa-mm-dd hh:mm:ss."),
  hasta: fechaHoraSchema.optional().describe("Hasta (fecha de creación), formato aaaa-mm-dd hh:mm:ss."),
  sucursal: z.string().optional().describe("Sucursal emisora. Si se omite, usa BILLER_DEFAULT_SUCURSAL_ID si existe."),
  id: z.string().optional().describe("ID del CFE. Si se define, la respuesta puede incluir items."),
  tipo_comprobante: z.string().optional().describe("Tipo de comprobante. Requiere serie y numero."),
  serie: z.string().optional().describe("Serie. Requiere tipo_comprobante y numero."),
  numero: z.string().optional().describe("Número ante DGI. Requiere tipo_comprobante y serie."),
  numero_interno: z.string().optional().describe("Identificador propio de la empresa para el comprobante."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda (Biller no documenta filtro nativo)."),
  cliente_rut: z.string().optional().describe("Filtro LOCAL por RUT de cliente (solo si es extraíble; si no, warning)."),
  incluir_anulados: z.boolean().optional().default(false).describe("Default false. Solo aplica si hubiera campo de anulación (no documentado)."),
  limit: z.number().int().positive().optional().describe("Límite LOCAL sobre la respuesta recibida."),
  ...paginationProbeSchema,
};

export const emitidosInputSchema = z.object(inputShape).superRefine(trioSuperRefine);

const outputShape = {
  comprobantes: z.array(ComprobanteEmitidoSchema),
  count: z.number(),
  pagination_supported: z.literal(false),
  filtros_aplicados: z.record(z.unknown()),
  warnings: z.array(z.string()),
  raw_fields_present: z.array(z.string()),
};

export async function handleListarEmitidos(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = emitidosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();

    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const comprobantes = await fetchEmitidos(client, {
      desde: a.desde,
      hasta: a.hasta,
      sucursal,
      id: a.id,
      tipo_comprobante: a.tipo_comprobante,
      serie: a.serie,
      numero: a.numero,
      numero_interno: a.numero_interno,
    });

    const warnings: string[] = [];
    warnings.push(...paginationWarnings(a));

    if (a.desde !== undefined || a.hasta !== undefined) {
      warnings.push(
        "Los filtros 'desde'/'hasta' se envían a Biller como fecha de creación (fecha_creacion), según el OpenAPI.",
      );
    }
    if (a.id === undefined && a.desde === undefined) {
      warnings.push(
        "No se especificó 'id' ni 'desde': Biller toma 'desde' como la fecha de hoy a las 00:00:00.",
      );
    }

    // Anulación: no hay campo documentado en emitidos.
    const hayAnulacion = comprobantes.some((c) =>
      c.campos_presentes.some((k) => ["estado", "anulado", "anulada", "cancelado"].includes(k.toLowerCase())),
    );
    if (!hayAnulacion && a.incluir_anulados === false) {
      warnings.push(
        "No hay campo documentado de estado/anulación en comprobantes emitidos: no se pudieron excluir anulados.",
      );
    }

    const filtered = filterEmitidos(comprobantes, { moneda: a.moneda, cliente_rut: a.cliente_rut });
    warnings.push(...filtered.warnings);

    const limited = applyLimit(filtered.list, a.limit);
    warnings.push(...limited.warnings);

    const rawFields = [...new Set(comprobantes.flatMap((c) => c.campos_presentes))].sort();

    return jsonResult({
      comprobantes: limited.list,
      count: limited.list.length,
      pagination_supported: false,
      filtros_aplicados: {
        desde: a.desde ?? null,
        hasta: a.hasta ?? null,
        sucursal: sucursal ?? null,
        id: a.id ?? null,
        tipo_comprobante: a.tipo_comprobante ?? null,
        serie: a.serie ?? null,
        numero: a.numero ?? null,
        numero_interno: a.numero_interno ?? null,
        moneda: a.moneda ?? null,
        cliente_rut: a.cliente_rut ?? null,
        incluir_anulados: a.incluir_anulados,
        limit: a.limit ?? null,
      },
      warnings,
      raw_fields_present: rawFields,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerListarEmitidos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_listar_comprobantes_emitidos",
    {
      title: "Listar comprobantes emitidos",
      description:
        "Lista comprobantes emitidos vía GET /v2/comprobantes/obtener. Acepta filtros documentados (desde/hasta/sucursal/" +
        "tipo_comprobante+serie+numero/numero_interno/id) y filtros LOCALES (moneda, cliente_rut, limit). " +
        "No asume paginación ni estado de anulación (no documentados): lo informa en warnings.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Listar comprobantes emitidos" },
    },
    async (args) => handleListarEmitidos(args, ctx),
  );
}
