// =============================================================================
// biller_cargar_producto  -> POST /v2/productos/cargar  (ESCRITURA)
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProductoSchema, validarProducto } from "../../biller/operacionesSchema.js";
import { WRITE_PATHS } from "../../constants.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = WRITE_PATHS.productosCargar;

const inputShape = {
  producto: ProductoSchema.describe(
    "Datos del producto/servicio: codigo, nombre, descripcion, moneda, precio, indicador_facturacion, " +
      "inventario (solo productos) y es_servicio.",
  ),
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
    remitente: a.remitente,
    rateLimitClass: "default",
    warnings: validarProducto(a.producto),
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
