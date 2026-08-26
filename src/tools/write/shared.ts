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
import { formatearTotales, type TotalesEstimados } from "../../services/calcularTotales.js";
import type { RateLimitClass } from "../../utils/rateLimit.js";
import { BillerConfirmationError } from "../../utils/errors.js";
import { checkConfirmationToken, computeConfirmationToken } from "../../write/confirm.js";
import { executeWrite } from "../../write/execute.js";
import { evaluateWriteGate } from "../../write/gate.js";
import { generateIdempotencyKey } from "../../write/idempotency.js";
import { errorToolResult, jsonResult, type ToolContext, type ToolResult } from "../shared.js";

// El preview existe para que un humano verifique A QUIÉN le está facturando.
// Ocultar del todo el receptor (documento/razón social) hacía que confirmar una
// e-Factura fuera imposible de auditar: se podía aprobar una factura al cliente
// equivocado sin forma de notarlo. Por eso se ENMASCARA parcialmente en vez de
// redactar: queda suficiente para reconocer al cliente, no para copiarlo entero.
//
// tipo_documento es un código de categoría numérico (2=RUT, 3=CI): no es PII por
// sí mismo, así que no se toca.
const CAMPOS_ENMASCARADOS = new Set([
  "rut", "documento", "email", "telefono", "direccion", "domicilio",
]);

/** Deja visible el inicio del valor y enmascara la cola: "2149874400**". */
function enmascarar(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.includes("@")) {
    // Email: usuario visible en parte + dominio completo (sirve para verificar).
    const [usuario, dominio] = value.split("@");
    const visible = usuario.slice(0, Math.min(3, usuario.length));
    return `${visible}${"*".repeat(Math.max(1, usuario.length - visible.length))}@${dominio}`;
  }
  if (value.length <= 4) return value;
  const visibles = Math.max(4, Math.ceil(value.length * 0.7));
  return value.slice(0, visibles) + "*".repeat(value.length - visibles);
}

function maskPayloadPreview(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(maskPayloadPreview);
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      CAMPOS_ENMASCARADOS.has(k) ? enmascarar(v) : maskPayloadPreview(v),
    ]),
  );
}

/**
 * Completa `sucursal` con BILLER_DEFAULT_SUCURSAL_ID si el cuerpo no la trae.
 * Tolera que la config no exista: en ese caso `runWriteOperation` es quien
 * devuelve el error de configuración, con un mensaje mejor que el que daríamos acá.
 */
export function aplicarSucursalPorDefecto(
  payload: { sucursal?: number },
  ctx: ToolContext,
): void {
  if (payload.sucursal !== undefined) return;
  try {
    const raw = ctx.getConfig().defaultSucursalId;
    if (raw === undefined) return;
    const n = Number(raw);
    if (Number.isFinite(n)) payload.sucursal = n;
  } catch {
    /* config inválida: el error lo reporta runWriteOperation */
  }
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
  /**
   * El mismo `remitente` que agrega la barrera de entrada, declarado también acá.
   *
   * La barrera lo inyecta en el input de TODA tool y lo verifica antes del
   * handler, pero cada tool parsea sus args con su propio `z.object`, que
   * descarta las claves que no declara. Sin esta línea el valor llega al server,
   * se valida, y se pierde antes de que el audit log pueda escribirlo — o sea:
   * se sabe quién pidió la emisión justo hasta el momento de anotarlo.
   */
  remitente: z
    .string()
    .optional()
    .describe("Teléfono de quien pide la operación. Queda enmascarado en el audit log."),
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
  /** Totales calculados localmente en el dry-run de una emisión. */
  totales_estimados: z.unknown().optional(),
  /** Línea legible con el total, para la confirmación humana. */
  resumen: z.string().optional(),
  /** Resultado de haber mandado el preview como botones de WhatsApp (ver emitirComprobante). */
  confirmacion_whatsapp: z.unknown().optional(),
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
  /**
   * Totales calculados localmente, a mostrar SOLO en el dry-run. No entran en el
   * hash del token: son derivados del payload, no parte de lo que se envía.
   */
  totalesEstimados?: TotalesEstimados;
  /**
   * Quién pidió la operación. Va al audit log enmascarado y NO entra en el hash
   * del confirmation_token: si entrara, un dry-run pedido desde un teléfono y
   * confirmado desde otro daría "el payload cambió", que es un diagnóstico falso
   * para un caso legítimo (el dueño arranca la factura y la confirma el encargado).
   */
  remitente?: string;
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
        payload_preview: maskPayloadPreview(payload),
        query_preview: p.query ?? null,
        confirmation_token: token,
        idempotency_key: p.idempotencyKey ?? null,
        next_step:
          `Para EJECUTAR, volvé a llamar ${tool} con confirm=true y confirmation_token="${token}"` +
          (environment === "production" ? " y allow_production=true." : ".") +
          " Los documentos y contactos están parcialmente enmascarados en este preview.",
        no_network_call: true,
        ...(p.totalesEstimados !== undefined
          ? {
              totales_estimados: p.totalesEstimados,
              resumen: formatearTotales(p.totalesEstimados),
            }
          : {}),
        warnings,
      });
    }

    // --- Fase EJECUCIÓN ---
    // El chequeo distingue el motivo: "vencido" se arregla repitiendo el
    // dry-run, "no coincide" significa que el payload cambió. Devolver el mismo
    // mensaje para los dos hace que el modelo reintente lo que no debe.
    const check = checkConfirmationToken(p.confirmationToken, endpoint, environment, subject);
    if (!check.ok) {
      throw new BillerConfirmationError(check.mensaje);
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
      remitente: p.remitente,
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
