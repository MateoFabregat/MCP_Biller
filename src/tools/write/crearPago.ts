// =============================================================================
// biller_crear_pago  -> POST /v2/pagos/crear  (ESCRITURA)
//
// Registra un pago y lo imputa a uno o más comprobantes ya emitidos.
//
// Reglas documentadas (validadas en `PagoBodySchema` / acá):
//   - El monto total debe coincidir con la suma de los montos imputados.
//   - Los comprobantes deben ser de la misma empresa, mismo cliente, misma
//     moneda y mismo tipo.
//   - Se admiten montos negativos para revertir un pago anterior.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PagoBodySchema } from "../../biller/operacionesSchema.js";
import { WRITE_PATHS } from "../../constants.js";
import { WRITE_ANNOTATIONS, validationErrorResult, type ToolContext, type ToolResult } from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

const ENDPOINT = WRITE_PATHS.pagosCrear;

const inputShape = {
  pago: PagoBodySchema.describe(
    "Cuerpo del pago: fecha (aaaa-mm-dd), monto, referencia y comprobantes[{id, monto}]. " +
      "La suma de los montos imputados debe igualar el monto del pago.",
  ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCrearPago(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const warnings: string[] = [];
  if (a.pago.monto < 0) {
    warnings.push(
      "El monto es negativo: esto REVIERTE un pago anterior. Verificá que sea lo que querés hacer.",
    );
  }
  warnings.push(
    "Biller exige que los comprobantes imputados sean del mismo cliente, la misma moneda y el mismo tipo. " +
      "Si no lo son, la operación fallará con 422.",
  );

  return runWriteOperation({
    ctx,
    tool: "biller_crear_pago",
    endpoint: ENDPOINT,
    payload: a.pago,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    remitente: a.remitente,
    warnings,
  });
}

export function registerCrearPago(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_crear_pago",
    {
      title: "Registrar pago — ESCRITURA",
      description:
        "Registra un pago y lo imputa a uno o más comprobantes emitidos (POST /v2/pagos/crear). " +
        "Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true. " +
        "Admite montos negativos para revertir un pago anterior.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Registrar pago (escritura)" },
    },
    async (args) => handleCrearPago(args, ctx),
  );
}
