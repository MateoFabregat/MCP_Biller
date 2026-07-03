// =============================================================================
// Runner compartido para las tools de ESCRITURA ("escritura con barreras").
//
// Patrón de dos fases:
//   - confirm=false (default) -> DRY-RUN: valida, arma el payload, devuelve un
//     preview + confirmation_token. NO hace ninguna llamada de red.
//   - confirm=true            -> EJECUTA: verifica el token contra el payload,
//     pasa por el gate + idempotencia + audit, y recién ahí hace el POST.
// =============================================================================

import { z } from "zod";
import type { RateLimitClass } from "../../utils/rateLimit.js";
import { BillerConfirmationError } from "../../utils/errors.js";
import { computeConfirmationToken, verifyConfirmationToken } from "../../write/confirm.js";
import { executeWrite } from "../../write/execute.js";
import { evaluateWriteGate } from "../../write/gate.js";
import { generateIdempotencyKey } from "../../write/idempotency.js";
import { errorToolResult, jsonResult, type ToolContext, type ToolResult } from "../shared.js";

// tipo_documento es un código de categoría numérico (2=RUT, 3=CI): no es PII por
// sí mismo, así que no se redacta (redactarlo dificulta verificar el preview).
const PII_FIELDS = new Set([
  "rut", "documento", "razon_social", "nombre_fantasia",
  "email", "telefono", "direccion", "domicilio",
]);

function redactPayloadPreview(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactPayloadPreview);
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, PII_FIELDS.has(k) ? "[REDACTED]" : redactPayloadPreview(v)]),
  );
}

/** Campos de control comunes a todas las tools de escritura. */
export const writeControlShape = {
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe("false = dry-run/preview (SIN red). true = ejecuta el POST real."),
  confirmation_token: z
    .string()
    .optional()
    .describe("Token devuelto por el dry-run. Obligatorio cuando confirm=true."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Clave de idempotencia. Si se omite, se genera una automáticamente."),
  allow_production: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Doble confirmación para PRODUCCIÓN. Junto con BILLER_ALLOW_PRODUCTION_WRITES=true habilita el POST contra biller.uy.",
    ),
};

export const writeOutputShape = {
  mode: z.enum(["dry_run", "executed"]),
  tool: z.string(),
  endpoint: z.string(),
  environment: z.enum(["test", "production"]),
  method: z.literal("POST").optional(),
  write_enabled: z.boolean().optional(),
  gate: z
    .object({
      allowed: z.boolean(),
      reason: z.string().nullable(),
      requires_allow_production: z.boolean(),
    })
    .optional(),
  payload_preview: z.unknown().optional(),
  query_preview: z.unknown().optional(),
  confirmation_token: z.string().optional(),
  idempotency_key: z.string().nullable().optional(),
  next_step: z.string().optional(),
  no_network_call: z.boolean().optional(),
  http_status: z.number().optional(),
  response: z.unknown().optional(),
  audit_id: z.string().optional(),
  warnings: z.array(z.string()),
};

export interface RunWriteParams {
  ctx: ToolContext;
  tool: string;
  endpoint: string;
  /** Cuerpo del POST (o undefined para endpoints sin body, p.ej. cancelar). */
  payload: unknown;
  query?: Record<string, string | number | undefined>;
  confirm: boolean;
  confirmationToken?: string;
  idempotencyKey?: string;
  allowProduction: boolean;
  rateLimitClass?: RateLimitClass;
  warnings?: string[];
}

export async function runWriteOperation(p: RunWriteParams): Promise<ToolResult> {
  const { ctx, tool, endpoint, payload } = p;
  const warnings = [...(p.warnings ?? [])];

  try {
    const config = ctx.getConfig();
    const environment = config.environment;
    const gate = evaluateWriteGate(config, { allowProduction: p.allowProduction });
    // El token (y la idempotencia/audit) ligan tanto el body como la query.
    const subject = { payload, query: p.query ?? null };
    const token = computeConfirmationToken(endpoint, environment, subject);

    // --- Fase DRY-RUN ---
    if (!p.confirm) {
      if (!gate.allowed) {
        warnings.push(
          gate.reason === "write_disabled"
            ? "La ejecución está deshabilitada (BILLER_WRITE_ENABLED!=true). Este preview no ejecuta nada."
            : "La ejecución contra PRODUCCIÓN está bloqueada. Requiere BILLER_ALLOW_PRODUCTION_WRITES=true y allow_production=true.",
        );
      }
      if (environment === "production") {
        warnings.push(
          "⚠️ Ambiente PRODUCCIÓN: ejecutar este POST emite/anula un comprobante REAL ante DGI.",
        );
      }
      if (p.idempotencyKey !== undefined) {
        warnings.push(
          "La protección de idempotencia es in-process y se resetea al reiniciar el servidor MCP.",
        );
      }
      return jsonResult({
        mode: "dry_run",
        tool,
        endpoint,
        environment,
        method: "POST",
        write_enabled: config.writeEnabled,
        gate: {
          allowed: gate.allowed,
          reason: gate.reason ?? null,
          requires_allow_production: environment === "production",
        },
        payload_preview: redactPayloadPreview(payload),
        query_preview: p.query ?? null,
        confirmation_token: token,
        idempotency_key: p.idempotencyKey ?? null,
        next_step:
          `Para EJECUTAR, volvé a llamar ${tool} con confirm=true y confirmation_token="${token}"` +
          (environment === "production" ? " y allow_production=true." : ".") +
          " Los campos sensibles están redactados en este preview.",
        no_network_call: true,
        warnings,
      });
    }

    // --- Fase EJECUCIÓN ---
    if (!verifyConfirmationToken(p.confirmationToken, endpoint, environment, subject)) {
      throw new BillerConfirmationError(
        "El confirmation_token no coincide con el payload/endpoint/ambiente actuales. " +
          "Hacé primero un dry-run (confirm=false) y reenviá el confirmation_token EXACTO devuelto.",
      );
    }

    const idempotencyKey = p.idempotencyKey ?? generateIdempotencyKey();
    const result = await executeWrite(ctx.getWriteContext(), {
      tool,
      endpoint,
      payload,
      query: p.query,
      idempotencyKey,
      allowProduction: p.allowProduction,
      rateLimitClass: p.rateLimitClass,
    });

    return jsonResult({
      mode: "executed",
      tool,
      endpoint,
      environment,
      http_status: result.status,
      idempotency_key: result.idempotency_key,
      response: result.data,
      audit_id: result.audit.audit_id,
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}
