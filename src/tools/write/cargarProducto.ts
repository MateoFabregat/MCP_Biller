// =============================================================================
// biller_cargar_producto  -> POST /v2/productos/cargar  (ESCRITURA)
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = "/v2/productos/cargar";

const inputShape = {
  producto: z
    .object({
      codigo: z.string().min(1),
      nombre: z.string().min(1),
      moneda: z.string().min(1),
      precio: z.union([z.string(), z.number()]),
      indicador_facturacion: z.number().int(),
      es_servicio: z.boolean(),
    })
    .passthrough()
    .describe("Datos del producto/servicio: descripcion, inventario, etc."),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCargarProducto(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  return runWriteOperation({
    ctx,
    tool: "biller_cargar_producto",
    endpoint: ENDPOINT,
    payload: { ...a.producto },
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "default",
  });
}

export function registerCargarProducto(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_cargar_producto",
    {
      title: "Cargar producto/servicio — ESCRITURA",
      description:
        "Crea un producto o servicio en Biller (POST /v2/productos/cargar). Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Cargar producto (escritura)" },
    },
    async (args) => handleCargarProducto(args, ctx),
  );
}
