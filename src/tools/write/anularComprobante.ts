// =============================================================================
// biller_anular_comprobante  -> POST /v2/comprobantes/anular  (ESCRITURA)
//
// Anula por `id` o por la terna `tipo_comprobante+serie+numero`. Requiere
// `fecha_emision_hoy` (0|1). Dos fases: dry-run y ejecución confirmada.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = "/v2/comprobantes/anular";

const inputShape = {
  id: z.number().int().optional().describe("ID del CFE a anular. Alternativa a la terna."),
  tipo_comprobante: z.number().int().optional().describe("Con serie y numero, identifica el CFE."),
  serie: z.string().optional(),
  numero: z.number().int().optional(),
  fecha_emision_hoy: z
    .union([z.literal(0), z.literal(1)])
    .describe("1 si la nota de anulación se emite con fecha de hoy, 0 si no."),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape).superRefine((d, ctx) => {
  const hasId = d.id !== undefined;
  const hasTrio = d.tipo_comprobante !== undefined && d.serie !== undefined && d.numero !== undefined;
  if (hasId === hasTrio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Especificá 'id' O la terna completa tipo_comprobante+serie+numero (uno u otro, no ambos ni ninguno).",
      path: ["id"],
    });
  }
});

export async function handleAnularComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload =
    a.id !== undefined
      ? { id: a.id, fecha_emision_hoy: a.fecha_emision_hoy }
      : {
          tipo_comprobante: a.tipo_comprobante,
          serie: a.serie,
          numero: a.numero,
          fecha_emision_hoy: a.fecha_emision_hoy,
        };

  return runWriteOperation({
    ctx,
    tool: "biller_anular_comprobante",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "dgi",
  });
}

export function registerAnularComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_anular_comprobante",
    {
      title: "Anular comprobante (CFE) — ESCRITURA",
      description:
        "ANULA un CFE existente ante DGI (POST /v2/comprobantes/anular). Por defecto dry-run; ejecuta con confirm=true + confirmation_token " +
        "y BILLER_WRITE_ENABLED=true (en producción también allow_production=true).",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Anular comprobante (escritura)" },
    },
    async (args) => handleAnularComprobante(args, ctx),
  );
}
