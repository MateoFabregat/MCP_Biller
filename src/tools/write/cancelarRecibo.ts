// =============================================================================
// biller_cancelar_recibo  -> POST /v2/recibos/cancelar?id=...  (ESCRITURA)
//
// El identificador va por query param `id` (sin body). El confirmation_token
// liga ese `id`, así que cambiar el id invalida el token.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = "/v2/recibos/cancelar";

const inputShape = {
  id: z.union([z.number().int(), z.string().min(1)]).describe("ID del recibo a cancelar."),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCancelarRecibo(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  return runWriteOperation({
    ctx,
    tool: "biller_cancelar_recibo",
    endpoint: ENDPOINT,
    payload: undefined, // sin body
    query: { id: String(a.id) },
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "dgi",
  });
}

export function registerCancelarRecibo(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_cancelar_recibo",
    {
      title: "Cancelar recibo — ESCRITURA",
      description:
        "Cancela un recibo en Biller (POST /v2/recibos/cancelar?id=...). Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Cancelar recibo (escritura)" },
    },
    async (args) => handleCancelarRecibo(args, ctx),
  );
}
