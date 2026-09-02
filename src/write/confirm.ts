// =============================================================================
// Aprobación de acciones con consecuencias.
//
// Flujo público: dry-run -> preview + confirmation_token -> confirm=true.
// El token v2 lleva un HMAC hecho con una clave que solo conoce el servidor.
// El formato anterior usaba SHA-256 sin clave y no se acepta.
//
// Formato: v2.<issuedAtMs>.<hmac-sha256-base64url>
// =============================================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify } from "../utils/stableStringify.js";

export { stableStringify };

export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const TOKEN_VERSION = "v2" as const;
const POLICY_VERSION = 1;
const MAC_BYTES = 32;

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export interface ApprovalScope {
  /** Clave exclusiva del servidor/tenant. Nunca entra al token ni a logs. */
  secret: string;
  environment: string;
  tenantId: string;
  companyId?: string | null;
  policyVersion?: number;
}

export interface ApprovalRequest {
  /** Ruta o nombre lógico de la acción: impide reutilizar el token en otra tool. */
  endpoint: string;
  /** Body/query ya validados, normalizados y limpiados por la tool. */
  subject: unknown;
  /** Identidad opaca de la conversación; null en el uso local por stdio. */
  actorIdentity?: string | null;
}

export type ConfirmationCheck =
  | { ok: true }
  | {
      ok: false;
      motivo: "ausente" | "formato" | "no_coincide" | "vencido";
      mensaje: string;
    };

function formatoInvalido(): ConfirmationCheck {
  return {
    ok: false,
    motivo: "formato",
    mensaje:
      "El confirmation_token no tiene el formato seguro vigente (v2). Usá el valor tal cual lo " +
      "devolvió el dry-run. Los tokens anteriores no se aceptan: repetí el dry-run y revisá el preview nuevo.",
  };
}

function noCoincide(): ConfirmationCheck {
  return {
    ok: false,
    motivo: "no_coincide",
    mensaje:
      "El confirmation_token no corresponde a esta operación, empresa o conversación, o el payload " +
      "cambió respecto del preview. NO se ejecuta. Repetí el dry-run con los datos actuales y pedile " +
      "al usuario que revise el preview nuevo.",
  };
}

/** Emite y verifica todos los tokens de una empresa desde una sola costura. */
export class ApprovalCycle {
  private readonly policyVersion: number;

  constructor(private readonly scope: ApprovalScope) {
    if (scope.secret.length < 32) {
      throw new Error("BILLER_APPROVAL_SECRET debe tener al menos 32 caracteres.");
    }
    this.policyVersion = scope.policyVersion ?? POLICY_VERSION;
  }

  issue(request: ApprovalRequest, issuedAt: number = Date.now()): string {
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("No se puede emitir un confirmation_token con timestamp inválido.");
    }
    return `${TOKEN_VERSION}.${issuedAt}.${this.mac(request, issuedAt).toString("base64url")}`;
  }

  verify(
    provided: string | undefined,
    request: ApprovalRequest,
    opciones: { ahora?: number; ttlMs?: number } = {},
  ): ConfirmationCheck {
    if (!provided || provided.trim() === "") {
      return {
        ok: false,
        motivo: "ausente",
        mensaje:
          "Falta el confirmation_token. Ejecutá primero la operación en modo dry-run, mostrale el " +
          "preview al usuario, y recién con su aprobación reenviá confirm=true con el token devuelto.",
      };
    }

    // El texto también es parte del contrato de idempotencia: aceptar dos
    // representaciones del mismo MAC permitiría derivar dos keys para una sola
    // aprobación. Por eso no se recorta ni se normaliza lo recibido.
    if (provided !== provided.trim()) return formatoInvalido();
    const partes = provided.split(".");
    if (
      partes.length !== 3 ||
      partes[0] !== TOKEN_VERSION ||
      !/^\d+$/.test(partes[1] ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(partes[2] ?? "")
    ) {
      return formatoInvalido();
    }

    const issuedAt = Number(partes[1]);
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0 ||
      String(issuedAt) !== partes[1]
    ) {
      return formatoInvalido();
    }

    let recibido: Buffer;
    try {
      recibido = Buffer.from(partes[2]!, "base64url");
    } catch {
      return formatoInvalido();
    }
    if (recibido.length !== MAC_BYTES || recibido.toString("base64url") !== partes[2]) {
      return formatoInvalido();
    }

    const esperado = this.mac(request, issuedAt);
    if (!timingSafeEqual(recibido, esperado)) return noCoincide();

    const ahora = opciones.ahora ?? Date.now();
    const ttl = opciones.ttlMs ?? CONFIRMATION_TTL_MS;
    if (!Number.isFinite(ahora) || !Number.isFinite(ttl) || ttl < 0) return formatoInvalido();

    const edadMs = ahora - issuedAt;
    if (edadMs > ttl) {
      const minutos = Math.round(edadMs / 60_000);
      return {
        ok: false,
        motivo: "vencido",
        mensaje:
          `El confirmation_token venció: se emitió hace ${minutos} minuto(s) y la ventana es de ` +
          `${Math.round(ttl / 60_000)}. Repetí el dry-run y confirmá sobre el preview nuevo.`,
      };
    }
    if (edadMs < -MAX_FUTURE_SKEW_MS) {
      return {
        ok: false,
        motivo: "formato",
        mensaje: "El confirmation_token está fechado en el futuro. Repetí el dry-run.",
      };
    }

    return { ok: true };
  }

  private mac(request: ApprovalRequest, issuedAt: number): Buffer {
    const authenticated = stableStringify({
      version: 2,
      issuedAt,
      endpoint: request.endpoint,
      environment: this.scope.environment,
      tenantId: this.scope.tenantId,
      companyId: this.scope.companyId ?? null,
      actorIdentity: request.actorIdentity ?? null,
      policyVersion: this.policyVersion,
      subject: request.subject,
    });
    return createHmac("sha256", this.scope.secret).update(authenticated).digest();
  }
}
