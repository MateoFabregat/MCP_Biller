// =============================================================================
// biller_obtener_comprobante  (solicitado: obtener_comprobante)
//
// GET /v2/comprobantes/obtener para un comprobante específico.
// Requiere: id, o numero_interno, o la terna tipo_comprobante+serie+numero.
// No llama al endpoint PDF.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import { ComprobanteEmitidoSchema } from "../biller/types.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  trioSuperRefine,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  id: z.string().optional().describe("ID del CFE. Si se define, la respuesta puede incluir items."),
  sucursal: z.string().optional().describe("Sucursal emisora. Si se omite, usa BILLER_DEFAULT_SUCURSAL_ID si existe."),
  tipo_comprobante: z.string().optional().describe("Tipo de comprobante. Requiere serie y numero."),
  serie: z.string().optional().describe("Serie. Requiere tipo_comprobante y numero."),
  numero: z.string().optional().describe("Número ante DGI. Requiere tipo_comprobante y serie."),
  numero_interno: z.string().optional().describe("Identificador propio de la empresa."),
  recibidos: z.boolean().optional().describe("Si es true, consulta el lado de recibidos (recibidos=1)."),
};

export const obtenerInputSchema = z.object(inputShape).superRefine((d, ctx) => {
  trioSuperRefine(d, ctx);
  const hasTrio = Boolean(d.tipo_comprobante && d.serie && d.numero);
  const hasId = Boolean(d.id);
  const hasInterno = Boolean(d.numero_interno);
  if (!hasId && !hasInterno && !hasTrio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Debe especificar 'id', 'numero_interno', o la terna completa tipo_comprobante+serie+numero.",
      path: ["id"],
    });
  }
});

const outputShape = {
  comprobante: ComprobanteEmitidoSchema.nullable(),
  comprobantes: z.array(ComprobanteEmitidoSchema),
  count: z.number(),
  filtros_aplicados: z.record(z.unknown()),
  warnings: z.array(z.string()),
};

export async function handleObtenerComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = obtenerInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const comprobantes = await fetchEmitidos(client, {
      id: a.id,
      sucursal,
      tipo_comprobante: a.tipo_comprobante,
      serie: a.serie,
      numero: a.numero,
      numero_interno: a.numero_interno,
      recibidos: a.recibidos,
    });

    const warnings: string[] = [];
    if (comprobantes.length === 0) {
      warnings.push("No se encontró ningún comprobante para los criterios indicados.");
    } else if (comprobantes.length > 1) {
      warnings.push(
        `Biller devolvió ${comprobantes.length} comprobantes para los criterios indicados; ` +
          "se expone el primero en 'comprobante' y todos en 'comprobantes'.",
      );
    }
    if (a.id === undefined) {
      warnings.push("La respuesta solo incluye 'items' cuando se consulta con 'id'.");
    }

    return jsonResult({
      comprobante: comprobantes[0] ?? null,
      comprobantes,
      count: comprobantes.length,
      filtros_aplicados: {
        id: a.id ?? null,
        sucursal: sucursal ?? null,
        tipo_comprobante: a.tipo_comprobante ?? null,
        serie: a.serie ?? null,
        numero: a.numero ?? null,
        numero_interno: a.numero_interno ?? null,
        recibidos: a.recibidos ?? false,
      },
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerObtenerComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_obtener_comprobante",
    {
      title: "Obtener un comprobante",
      description:
        "Obtiene un comprobante por id, numero_interno o la terna tipo_comprobante+serie+numero, " +
        "vía GET /v2/comprobantes/obtener. Cuando se consulta con id, la respuesta puede incluir items. No usa el endpoint PDF.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Obtener comprobante" },
    },
    async (args) => handleObtenerComprobante(args, ctx),
  );
}
