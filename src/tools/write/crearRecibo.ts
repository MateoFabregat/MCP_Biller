// =============================================================================
// biller_crear_recibo  -> POST /v2/recibos/crear  (ESCRITURA)
//
// Registra el cobro (total o parcial) de uno o varios CFE. El cuerpo se valida
// contra `ReciboBodySchema`: `cliente` y `pago` son obligatorios según la doc.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReciboBodySchema, validarRecibo } from "../../biller/operacionesSchema.js";
import { WRITE_PATHS } from "../../constants.js";
import {
  WRITE_ANNOTATIONS,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "../shared.js";
import {
  aplicarSucursalPorDefecto,
  runWriteOperation,
  writeControlShape,
  writeOutputShape,
} from "./shared.js";

const ENDPOINT = WRITE_PATHS.recibosCrear;

const inputShape = {
  recibo: ReciboBodySchema.describe(
    "Cuerpo del recibo: tipo_comprobante del CFE cobrado, cliente{} (obligatorio, con documento y dirección), " +
      "referencias[{padre,total}] con los comprobantes que se cobran, y pago{fecha (aaaa-mm-dd), monto, referencia}.",
  ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleCrearRecibo(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload = { ...a.recibo };
  aplicarSucursalPorDefecto(payload, ctx);

  // Biller exige sucursal. En execute bloqueamos con un mensaje claro en vez de
  // dejar que la API devuelva un 422 confuso; en dry-run alcanza con el warning.
  if (payload.sucursal === undefined && a.confirm) {
    return simpleErrorResult(
      "Falta 'sucursal': Biller la exige para emitir un recibo. Pasala en el cuerpo o configurá " +
        "BILLER_DEFAULT_SUCURSAL_ID con el ID real de tu sucursal (Ajustes → Sucursales).",
      ctx,
    );
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
    remitente: a.remitente,
    rateLimitClass: "dgi", // creación de recibos: 1 req/seg
    warnings: validarRecibo(a.recibo),
  });
}

export function registerCrearRecibo(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_crear_recibo",
    {
      title: "Crear recibo — ESCRITURA",
      description:
        "Emite un recibo de cobranza en Biller (POST /v2/recibos/crear), asociándolo a uno o más comprobantes. " +
        "Por defecto dry-run; ejecuta con confirm=true + confirmation_token y BILLER_WRITE_ENABLED=true. " +
        "Si el pago supera la suma de las referencias, Biller agrega un ítem de 'Adelanto' por la diferencia.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Crear recibo (escritura)" },
    },
    async (args) => handleCrearRecibo(args, ctx),
  );
}
