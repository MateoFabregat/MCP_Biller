// =============================================================================
// biller_crear_recibo  -> POST /v2/recibos/crear  (ESCRITURA)
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = "/v2/recibos/crear";

const inputShape = {
  recibo: z
    .object({ tipo_comprobante: z.number().int() })
    .passthrough()
    .describe(
      "Cuerpo del recibo según Biller: forma_pago, sucursal, moneda, cliente{}, referencias[], pago{}, etc.",
    ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCrearRecibo(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: Record<string, unknown> = { ...a.recibo };
  const warnings: string[] = [];
  if (payload.referencias === undefined && payload.pago === undefined) {
    warnings.push("El recibo no incluye 'referencias' ni 'pago': confirmá el cuerpo antes de ejecutar.");
  }

  return runWriteOperation({
    ctx,
    tool: "biller_crear_recibo",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "dgi",
    warnings,
  });
}

export function registerCrearRecibo(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_crear_recibo",
    {
      title: "Crear recibo — ESCRITURA",
      description:
        "Emite un recibo en Biller (POST /v2/recibos/crear). Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Crear recibo (escritura)" },
    },
    async (args) => handleCrearRecibo(args, ctx),
  );
}
