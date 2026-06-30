// =============================================================================
// Carga y validación de variables de entorno.
//
// - `loadConfig`   : estricta. Lanza BillerConfigError si falta lo requerido.
//                    La usan las tools que llaman a Biller.
// - `inspectConfig`: tolerante. Nunca lanza y NUNCA expone el token.
//                    La usa `biller_health_check` para diagnosticar.
// =============================================================================

import { BillerConfigError } from "./utils/errors.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export type BillerEnvironment = "test" | "production";

/**
 * Modo operativo central del servidor MCP.
 * - `read_only`    : solo se registran las 6 tools de lectura (default seguro).
 * - `write_enabled`: se registran también las 6 tools de escritura (con barreras).
 *
 * Controlado por la variable de entorno `BILLER_CAPABILITY_MODE`.
 * Default: `read_only`.
 */
export type BillerCapabilityMode = "read_only" | "write_enabled";

function parseCapabilityMode(raw: string | undefined): BillerCapabilityMode {
  return (raw ?? "").trim().toLowerCase() === "write_enabled" ? "write_enabled" : "read_only";
}

export interface BillerConfig {
  /** Base URL normalizada (sin barra final), p.ej. https://test.biller.uy */
  apiBaseUrl: string;
  /** Bearer token. Nunca se loguea ni se devuelve. */
  apiToken: string;
  /** Metadata local; NO se envía a la API (el token ya está atado a la empresa). */
  defaultEmpresaRut?: string;
  /** Valor por defecto del parámetro `sucursal` en /v2/comprobantes/obtener. */
  defaultSucursalId?: string;
  timeoutMs: number;
  logLevel: string;
  /** Ambiente derivado de la base URL (test si el host empieza con "test."). */
  environment: BillerEnvironment;
  /** Master switch de escritura. Si false, los POST no se ejecutan (sí el dry-run). */
  writeEnabled: boolean;
  /** Habilita ejecutar POST contra PRODUCCIÓN (además requiere allow_production=true). */
  allowProductionWrites: boolean;
  /** Ruta opcional de archivo para el audit log (además de stderr). */
  auditLogPath?: string;
  /** Modo operativo: qué tools se registran en el servidor MCP. */
  capabilityMode: BillerCapabilityMode;
}

/**
 * Deriva el ambiente desde la base URL. Conservador: solo se considera "test"
 * si el host empieza con "test." (p.ej. test.biller.uy); cualquier otra cosa se
 * trata como PRODUCCIÓN para exigir la habilitación explícita.
 */
export function detectEnvironment(baseUrl: string): BillerEnvironment {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return /^test\./.test(host) ? "test" : "production";
  } catch {
    return "production";
  }
}

function parseBool(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

export interface ConfigInspection {
  hasBaseUrl: boolean;
  apiBaseUrl: string | null;
  hasToken: boolean;
  defaultEmpresaRut: string | null;
  defaultSucursalId: string | null;
  timeoutMs: number;
  logLevel: string;
  environment: BillerEnvironment | null;
  writeEnabled: boolean;
  allowProductionWrites: boolean;
  auditLogPath: string | null;
  /** Modo operativo: qué tools se registran en el servidor MCP. */
  capabilityMode: BillerCapabilityMode;
  /** Nombres de variables requeridas que faltan. */
  missing: string[];
}

type Env = Record<string, string | undefined>;

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BillerConfigError(
      `BILLER_TIMEOUT_MS inválido: "${raw}". Debe ser un número positivo de milisegundos.`,
    );
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

/**
 * Carga estricta. Lanza BillerConfigError listando TODAS las variables
 * requeridas que falten.
 */
export function loadConfig(env: Env = process.env): BillerConfig {
  const missing: string[] = [];

  const baseUrlRaw = trimOrUndefined(env.BILLER_API_BASE_URL);
  if (!baseUrlRaw) missing.push("BILLER_API_BASE_URL");

  const token = trimOrUndefined(env.BILLER_API_TOKEN);
  if (!token) {
    missing.push("BILLER_API_TOKEN");
  } else if (token.length < 8) {
    missing.push("BILLER_API_TOKEN debe tener al menos 8 caracteres");
  }

  if (missing.length > 0) {
    throw new BillerConfigError(
      `Faltan variables de entorno requeridas: ${missing.join(", ")}. ` +
        `Configurá un archivo .env (ver .env.example) o exportalas en el entorno.`,
    );
  }

  // En este punto baseUrlRaw y token están definidos.
  const apiBaseUrl = normalizeBaseUrl(baseUrlRaw!);
  return {
    apiBaseUrl,
    apiToken: token!,
    defaultEmpresaRut: trimOrUndefined(env.BILLER_DEFAULT_EMPRESA_RUT),
    defaultSucursalId: trimOrUndefined(env.BILLER_DEFAULT_SUCURSAL_ID),
    timeoutMs: parseTimeout(env.BILLER_TIMEOUT_MS),
    logLevel: trimOrUndefined(env.LOG_LEVEL) ?? "info",
    environment: detectEnvironment(apiBaseUrl),
    writeEnabled: parseBool(env.BILLER_WRITE_ENABLED),
    allowProductionWrites: parseBool(env.BILLER_ALLOW_PRODUCTION_WRITES),
    auditLogPath: trimOrUndefined(env.BILLER_AUDIT_LOG_PATH),
    capabilityMode: parseCapabilityMode(env.BILLER_CAPABILITY_MODE),
  };
}

/**
 * Inspección tolerante para diagnóstico. NUNCA lanza, NUNCA expone el token
 * (solo informa `hasToken`).
 */
export function inspectConfig(env: Env = process.env): ConfigInspection {
  const baseUrlRaw = trimOrUndefined(env.BILLER_API_BASE_URL);
  const token = trimOrUndefined(env.BILLER_API_TOKEN);

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push("BILLER_API_BASE_URL");
  if (!token) missing.push("BILLER_API_TOKEN");

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    timeoutMs = parseTimeout(env.BILLER_TIMEOUT_MS);
  } catch {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  const apiBaseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : null;
  return {
    hasBaseUrl: Boolean(baseUrlRaw),
    apiBaseUrl,
    hasToken: Boolean(token),
    defaultEmpresaRut: trimOrUndefined(env.BILLER_DEFAULT_EMPRESA_RUT) ?? null,
    defaultSucursalId: trimOrUndefined(env.BILLER_DEFAULT_SUCURSAL_ID) ?? null,
    timeoutMs,
    logLevel: trimOrUndefined(env.LOG_LEVEL) ?? "info",
    environment: apiBaseUrl ? detectEnvironment(apiBaseUrl) : null,
    writeEnabled: parseBool(env.BILLER_WRITE_ENABLED),
    allowProductionWrites: parseBool(env.BILLER_ALLOW_PRODUCTION_WRITES),
    auditLogPath: trimOrUndefined(env.BILLER_AUDIT_LOG_PATH) ?? null,
    capabilityMode: parseCapabilityMode(env.BILLER_CAPABILITY_MODE),
    missing,
  };
}
