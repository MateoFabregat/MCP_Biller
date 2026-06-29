// =============================================================================
// biller_crear_cliente  -> POST /v2/clientes/crear  (ESCRITURA)
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = "/v2/clientes/crear";

const inputShape = {
  cliente: z
    .object({
      tipo_documento: z.number().int().describe("Tipo de documento (ej: 2=RUT, 3=CI)."),
      documento: z.string().min(1).describe("Número de documento/RUT."),
    })
    .passthrough()
    .describe(
      "Datos del cliente: razon_social o nombre_fantasia, direccion, ciudad, departamento, pais, etc.",
    ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCrearCliente(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: Record<string, unknown> = { ...a.cliente };
  const warnings: string[] = [];
  if (payload.razon_social === undefined && payload.nombre_fantasia === undefined) {
    warnings.push("El cliente no incluye razon_social ni nombre_fantasia: confirmá los datos antes de ejecutar.");
  }

  return runWriteOperation({
    ctx,
    tool: "biller_crear_cliente",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "default",
    warnings,
  });
}

export function registerCrearCliente(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_crear_cliente",
    {
      title: "Crear cliente — ESCRITURA",
      description:
        "Crea un cliente en Biller (POST /v2/clientes/crear). Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Crear cliente (escritura)" },
    },
    async (args) => handleCrearCliente(args, ctx),
  );
}
