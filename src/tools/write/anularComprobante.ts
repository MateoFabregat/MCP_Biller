// =============================================================================
// biller_anular_comprobante  -> POST /v2/comprobantes/anular  (ESCRITURA)
//
// Anula por `id` o por la terna `tipo_comprobante+serie+numero`. Requiere
// `fecha_emision_hoy` (0|1). Dos fases: dry-run y ejecución confirmada.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIPOS_COMPROBANTE } from "../../biller/cfeSchema.js";
import { booleano, codigo, entero } from "../../biller/coerce.js";
import { WRITE_PATHS } from "../../constants.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = WRITE_PATHS.comprobantesAnular;

// required: ["fecha_emision_hoy"]; `id` es obligatorio solo si no se envía la
// terna tipo_comprobante+serie+numero (y viceversa).
const inputShape = {
  id: entero("id").optional().describe("ID del CFE a anular. Obligatorio si no se envía la terna."),
  tipo_comprobante: codigo(TIPOS_COMPROBANTE, "tipo_comprobante")
    .optional()
    .describe("Con serie y numero, identifica el CFE. Obligatorio si no se envía 'id'."),
  serie: z.string().optional(),
  numero: entero("numero").optional(),
  sucursal: entero("sucursal")
    .optional()
    .describe("Sucursal emisora de la nota anuladora. Si se omite, se usa la del comprobante original."),
  fecha_emision_hoy: booleano().describe(
    "true: la nota de crédito se emite con fecha de hoy. false: con la fecha del comprobante anulado.",
  ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape).superRefine((d, ctx) => {
  const hasId = d.id !== undefined;
  const hasTrio = d.tipo_comprobante !== undefined && d.serie !== undefined && d.numero !== undefined;
  // La doc pide una u otra forma de identificación, pero no prohíbe enviar
  // ambas: solo se exige que haya al menos una completa.
  if (!hasId && !hasTrio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Identificá el comprobante con 'id' o con la terna completa tipo_comprobante+serie+numero.",
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

  const payload: Record<string, unknown> = { fecha_emision_hoy: a.fecha_emision_hoy };
  if (a.id !== undefined) {
    payload.id = a.id;
  } else {
    payload.tipo_comprobante = a.tipo_comprobante;
    payload.serie = a.serie;
    payload.numero = a.numero;
  }
  if (a.sucursal !== undefined) payload.sucursal = a.sucursal;

  return runWriteOperation({
    ctx,
    tool: "biller_anular_comprobante",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    remitente: a.remitente,
    rateLimitClass: "dgi",
    warnings: [
      "Anular genera una Nota de Crédito que anula el CFE en su totalidad. Solo funciona sobre " +
        "e-Tickets y e-Facturas que NO tengan comprobantes asociados.",
    ],
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
