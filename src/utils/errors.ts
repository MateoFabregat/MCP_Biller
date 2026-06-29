// =============================================================================
// Errores normalizados y seguros (nunca exponen el token).
// =============================================================================

/**
 * Reemplaza cualquier aparición del/los secreto(s) por `[REDACTED]` dentro de
 * un string. Defensa en profundidad: aunque la API no debería devolver el
 * token, garantizamos que jamás se propague en mensajes de error o logs.
 */
export function redactSecrets(input: string, secrets: Array<string | undefined>): string {
  let out = input;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      // Reemplazo literal (sin regex) para evitar problemas con metacaracteres.
      out = out.split(secret).join("[REDACTED]");
    }
  }
  // Por las dudas, redactar cualquier header Authorization que se haya colado.
  out = out.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]");
  return out;
}

export type BillerErrorKind =
  | "config"
  | "validation"
  | "api"
  | "timeout"
  | "network"
  | "readonly"
  | "parse"
  | "write_disabled"
  | "production_blocked"
  | "confirmation"
  | "idempotency";

export interface SafeErrorShape {
  kind: BillerErrorKind;
  message: string;
  status?: number;
  details?: string;
}

/** Base de todos los errores del MCP. El mensaje ya viene redactado. */
export class BillerError extends Error {
  public readonly kind: BillerErrorKind;

  constructor(kind: BillerErrorKind, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }

  toSafe(): SafeErrorShape {
    return { kind: this.kind, message: this.message };
  }
}

/** Configuración faltante o inválida (env vars). */
export class BillerConfigError extends BillerError {
  constructor(message: string) {
    super("config", message);
  }
}

/** Violación de la restricción read-only (intento de método != GET). */
export class BillerReadOnlyViolationError extends BillerError {
  constructor(method: string) {
    super(
      "readonly",
      `Operación bloqueada: este MCP es estrictamente read-only y solo permite GET. ` +
        `Método solicitado: ${String(method).toUpperCase()}.`,
    );
  }
}

/** Timeout de la request HTTP. */
export class BillerTimeoutError extends BillerError {
  constructor(timeoutMs: number) {
    super("timeout", `La solicitud a Biller superó el timeout de ${timeoutMs} ms.`);
  }
}

/** Error de red (no se pudo conectar, DNS, etc.). */
export class BillerNetworkError extends BillerError {
  constructor(message: string) {
    super("network", `Error de red al contactar Biller: ${message}`);
  }
}

/** Respuesta no-2xx de la API de Biller, con mensaje claro por código. */
export class BillerApiError extends BillerError {
  public readonly status: number;
  public readonly bodySnippet?: string;

  constructor(status: number, bodySnippet?: string) {
    super("api", BillerApiError.messageForStatus(status));
    this.status = status;
    this.bodySnippet = bodySnippet;
  }

  static messageForStatus(status: number): string {
    switch (status) {
      case 400:
        return "Biller respondió 400 (Bad Request): la solicitud tiene sintaxis o parámetros inválidos.";
      case 403:
        return "Biller respondió 403 (Forbidden): el token no tiene privilegios para esta operación.";
      case 404:
        return "Biller respondió 404 (Not Found): el recurso consultado no existe.";
      case 422:
        return "Biller respondió 422: la solicitud es sintácticamente correcta pero contiene datos inválidos.";
      case 429:
        return (
          "Biller respondió 429 (rate limit): se superó el límite de solicitudes. " +
          "Biller permite 1 req/seg para consultas a DGI y comprobantes recibidos, y 30 req/seg para el resto. " +
          "Esperá unos segundos y reintentá."
        );
      case 500:
        return "Biller respondió 500: error interno del servidor de Biller. Reintentá más tarde.";
      default:
        return `Biller respondió con el código de estado ${status}.`;
    }
  }

  override toSafe(): SafeErrorShape {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      details: this.bodySnippet,
    };
  }
}

/** Error al parsear la respuesta de Biller (JSON inválido, etc.). */
export class BillerParseError extends BillerError {
  constructor(message: string) {
    super("parse", `No se pudo interpretar la respuesta de Biller: ${message}`);
  }
}

// --- Errores de la capa de escritura ("escritura con barreras") -------------

/** La escritura está deshabilitada (BILLER_WRITE_ENABLED != true). */
export class BillerWriteDisabledError extends BillerError {
  constructor() {
    super(
      "write_disabled",
      "La escritura está DESHABILITADA. Para ejecutar operaciones POST configurá " +
        "BILLER_WRITE_ENABLED=true. El preview (dry-run) sí está disponible sin esa variable.",
    );
  }
}

/** Se intentó escribir contra producción sin la habilitación explícita. */
export class BillerProductionBlockedError extends BillerError {
  constructor() {
    super(
      "production_blocked",
      "Escritura contra PRODUCCIÓN bloqueada. Las operaciones POST contra biller.uy (producción) " +
        "emiten/anulan comprobantes reales ante DGI. Para habilitarlas se requiere " +
        "BILLER_ALLOW_PRODUCTION_WRITES=true Y el argumento allow_production=true. " +
        "Recomendación: probá primero en https://test.biller.uy.",
    );
  }
}

/** El confirm/confirmation_token no coincide con el payload (human-in-the-loop). */
export class BillerConfirmationError extends BillerError {
  constructor(message: string) {
    super("confirmation", message);
  }
}

/** La misma idempotency_key ya se ejecutó en este proceso. */
export class BillerIdempotencyError extends BillerError {
  constructor(key: string) {
    super(
      "idempotency",
      `La idempotency_key "${key}" ya fue ejecutada en esta sesión: se evita una segunda ejecución ` +
        "para no duplicar el comprobante/operación. Usá una key nueva si realmente querés repetir.",
    );
  }
}

/**
 * Convierte cualquier error a una forma segura para devolver al modelo.
 * Si no es un BillerError conocido, se devuelve un mensaje genérico
 * (nunca el stack ni datos potencialmente sensibles).
 */
export function toSafeError(err: unknown, secrets: Array<string | undefined> = []): SafeErrorShape {
  if (err instanceof BillerError) {
    const safe = err.toSafe();
    return {
      ...safe,
      message: redactSecrets(safe.message, secrets),
      details: safe.details ? redactSecrets(safe.details, secrets) : undefined,
    };
  }
  if (err instanceof Error) {
    return { kind: "network", message: redactSecrets(err.message, secrets) };
  }
  return { kind: "network", message: "Error desconocido." };
}
