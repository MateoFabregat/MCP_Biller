// =============================================================================
// biller_crear_cliente  -> POST /v2/clientes/crear  (ESCRITURA)
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClienteCrearSchema, validarClienteCrear } from "../../biller/operacionesSchema.js";
import { WRITE_PATHS } from "../../constants.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = WRITE_PATHS.clientesCrear;

const inputShape = {
  cliente: ClienteCrearSchema.describe(
    "Datos del cliente en un ÚNICO objeto plano (no anidado como en la emisión de CFE): " +
      "tipo_documento, documento, razon_social o nombre_fantasia según el tipo, direccion, ciudad, departamento, pais.",
  ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCrearCliente(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: Record<string, unknown> = { ...a.cliente };
  const warnings = validarClienteCrear(a.cliente);

  return runWriteOperation({
    ctx,
    tool: "biller_crear_cliente",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    remitente: a.remitente,
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
