// =============================================================================
// Utilidades compartidas por las tools MCP.
// =============================================================================

import { z, type ZodError } from "zod";
import type { BillerClient } from "../biller/client.js";
import type { CacheDetalles } from "../biller/traerDetalles.js";
import type { BillerConfig, ConfigInspection } from "../config.js";
import type { BorradorStore } from "../kapso/borradorStore.js";
import type { Metricas } from "../observabilidad/metricas.js";
import { redactSecrets, toSafeError } from "../utils/errors.js";
import type { WriteExecContext } from "../write/execute.js";
import type { ApprovalCycle } from "../write/confirm.js";

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
  /** Ciclo único de emisión/verificación de approvals para esta empresa. */
  getApprovalCycle: () => ApprovalCycle;
  /**
   * Métricas de uso de ESTA empresa.
   *
   * Va en el contexto y no en un singleton por el mismo motivo que el store de
   * idempotencia: el contexto ya es por tenant. Un registro global haría que la
   * tool de métricas de una empresa mostrara cuánto usa el sistema la otra, que
   * es información comercial de un tercero.
   *
   * Nunca es `undefined`: cuando no hay que medir, es `METRICAS_NULAS`. Un
   * `if (metricas)` repetido en quince lugares es la forma más segura de que en
   * el dieciseisavo falte.
   */
  metricas: Metricas;
  /**
   * Borradores de emisión a medio cargar de ESTA empresa.
   *
   * Por tenant por el mismo motivo que las métricas y la idempotencia, pero acá
   * el motivo es más duro: un store compartido dejaría que una empresa leyera,
   * con solo adivinar una clave de sesión, qué está por facturarle otra y a
   * quién. Es el dato comercial más sensible que maneja el server.
   */
  getBorradorStore: () => BorradorStore;
  /** Cache de detalles propiedad de ESTA empresa, no del proceso. */
  getDetallesCache?: () => CacheDetalles;
  /**
   * Diagnóstico de la configuración DE ESTA EMPRESA, ya sin secretos.
   *
   * POR QUÉ ESTÁ ACÁ Y NO EN UNA ESTRUCTURA LATERAL. El `env` con el que se
   * construyó un contexto es parte de lo que ese contexto ES: en multi-empresa
   * cada tenant es un overlay de variables, y `inspectConfig()` sin argumento
   * lee `process.env`. Una tool que quiera diagnosticarse y no encuentre esto en
   * la interfaz va a caer en `process.env` — y el health check de una empresa va
   * a contestar con el RUT, la URL de la API y la ruta del audit log de otra.
   * Ese fue el bug; que el dato viva en la interfaz es lo que impide repetirlo.
   *
   * POR QUÉ `ConfigInspection` Y NO EL `env` CRUDO. Exponer el env sería la
   * versión trivial y la peor: `env.BILLER_API_TOKEN` queda al alcance de
   * cualquiera de las treinta y cuatro tools, y con él la posibilidad de que un
   * token se cuele en una respuesta, en un warning o en un log. `ConfigInspection`
   * ya nace sin secretos (el token viaja como `hasToken: boolean`) y es
   * exactamente lo que el diagnóstico necesita: la decisión de qué es seguro
   * mostrar se toma UNA vez, en `config.ts`, y no en cada consumidor. Interfaz
   * chica, decisión adentro.
   */
  inspeccionar: () => ConfigInspection;
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
    const config = ctx.getConfig();
    return [
      config.apiToken,
      config.approvalSecret ?? undefined,
      config.kapso?.apiKey,
      config.httpAuthToken,
    ];
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
