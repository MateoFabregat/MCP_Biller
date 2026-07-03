// =============================================================================
// Utilidades compartidas por las tools MCP.
// =============================================================================

import { z, type ZodError } from "zod";
import type { BillerClient } from "../biller/client.js";
import type { BillerConfig } from "../config.js";
import { redactSecrets, toSafeError } from "../utils/errors.js";
import type { WriteExecContext } from "../write/execute.js";

/** Resultado de tool compatible con CallToolResult del SDK. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Contexto inyectado a cada handler. `getConfig`/`getClient` lanzan
 * BillerConfigError si la configuración mínima no está presente; las tools lo
 * capturan y devuelven un error claro (sin exponer secretos).
 */
export interface ToolContext {
  getConfig: () => BillerConfig;
  getClient: () => BillerClient;
  /** Contexto de escritura (writeClient + auditor + idempotencia). Lanza si la config es inválida. */
  getWriteContext: () => WriteExecContext;
}

export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// --- Fragmentos Zod reutilizables ------------------------------------------

export const fechaHoraSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'Formato esperado: "aaaa-mm-dd hh:mm:ss" (ej: 2026-06-01 00:00:00).',
  );

export const fechaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: "aaaa-mm-dd" (ej: 2026-06-30).');

export const responseFormatSchema = z
  .enum(["json", "markdown"])
  .optional()
  .describe("Formato del texto devuelto: json (default) o markdown.");

/**
 * Parámetros de paginación que Biller NO documenta. Se aceptan para poder
 * advertir explícitamente al usuario que se ignoran (en vez de romper).
 */
export const paginationProbeSchema = {
  page: z.number().int().optional().describe("Ignorado: Biller no documenta paginación."),
  cursor: z.string().optional().describe("Ignorado: Biller no documenta paginación."),
  offset: z.number().int().optional().describe("Ignorado: Biller no documenta paginación."),
};

export function paginationWarnings(input: {
  page?: number;
  cursor?: string;
  offset?: number;
}): string[] {
  if (input.page !== undefined || input.cursor !== undefined || input.offset !== undefined) {
    return [
      "Biller no documenta paginación en su API pública. Los parámetros page/cursor/offset se ignoraron. " +
        "Usá 'limit' para acotar localmente los resultados ya recibidos.",
    ];
  }
  return [];
}

/**
 * Regla documentada: tipo_comprobante, serie y numero deben enviarse juntos o
 * ninguno. Se usa como `.superRefine(...)` en los inputs de las tools que
 * aceptan esa terna.
 */
export function trioSuperRefine(
  data: { tipo_comprobante?: string; serie?: string; numero?: string },
  ctx: z.RefinementCtx,
): void {
  const present = [data.tipo_comprobante, data.serie, data.numero].filter(
    (v) => v !== undefined && v !== "",
  ).length;
  if (present > 0 && present < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Para identificar por comprobante se deben enviar los tres campos juntos: " +
        "tipo_comprobante, serie y numero (o ninguno).",
      path: ["tipo_comprobante"],
    });
  }
}

// --- Helpers de resultado ---------------------------------------------------

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function jsonResult(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: pretty(structured) }],
    structuredContent: structured,
  };
}

export function dualResult(structured: Record<string, unknown>, markdown: string): ToolResult {
  return {
    content: [{ type: "text", text: markdown }],
    structuredContent: structured,
  };
}

/** Reúne secretos a redactar, tolerando que la config no esté disponible. */
export function collectSecrets(ctx: ToolContext): Array<string | undefined> {
  try {
    return [ctx.getConfig().apiToken];
  } catch {
    return [];
  }
}

// NOTA: los resultados de error NO incluyen `structuredContent`. El cliente MCP
// valida structuredContent contra el outputSchema aun en errores, así que un
// envelope { error } rompería esa validación. El error viaja como texto JSON
// dentro de `content` + `isError: true`.

export function validationErrorResult(error: ZodError, ctx: ToolContext): ToolResult {
  const secrets = collectSecrets(ctx);
  const issues = error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${redactSecrets(i.message, secrets)}`,
  );
  const safe = {
    kind: "validation" as const,
    message: `Parámetros inválidos. ${issues.join("; ")}`,
    details: issues.join("; "),
  };
  return {
    content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
    isError: true,
  };
}

export function errorToolResult(err: unknown, ctx: ToolContext): ToolResult {
  const safe = toSafeError(err, collectSecrets(ctx));
  return {
    content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
    isError: true,
  };
}

/**
 * Error de validación "manual" (sin ZodError), para reglas de negocio que no se
 * pueden expresar en el schema. Redacta secretos del mensaje.
 */
export function simpleErrorResult(
  message: string,
  ctx: ToolContext,
  kind: "validation" | "config" = "validation",
): ToolResult {
  const safe = { kind, message: redactSecrets(message, collectSecrets(ctx)) };
  return {
    content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
    isError: true,
  };
}

/** Aplica un `limit` local no destructivo, devolviendo también un warning. */
export function applyLimit<T>(
  list: T[],
  limit: number | undefined,
): { list: T[]; warnings: string[] } {
  if (limit !== undefined && list.length > limit) {
    return {
      list: list.slice(0, limit),
      warnings: [
        `Se aplicó un límite local de ${limit}: se recibieron ${list.length} comprobantes y se devuelven ${limit}. ` +
          "Esto NO es paginación de la API (no documentada); el resto no se descarta del lado de Biller.",
      ],
    };
  }
  return { list, warnings: [] };
}
