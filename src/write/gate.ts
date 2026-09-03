// =============================================================================
// Gate de escritura: decide si una ejecución POST puede proceder.
//
// Barreras (todas deben pasar):
//   1. BILLER_WRITE_ENABLED=true (master switch).
//   2. Si el ambiente es producción: BILLER_ALLOW_PRODUCTION_WRITES=true
//      Y el argumento allow_production=true (doble confirmación).
//
// El dry-run/preview NO pasa por acá (no hay red); solo la ejecución real.
// =============================================================================

import type { BillerConfig } from "../config.js";
import { BillerProductionBlockedError, BillerWriteDisabledError } from "../utils/errors.js";

export interface GateRequest {
  /** Confirmación explícita del caller para operar en producción. */
  allowProduction: boolean;
}

export interface GateDecision {
  allowed: boolean;
  environment: BillerConfig["environment"];
  write_enabled: boolean;
  allow_production_env: boolean;
  reason?: string;
}

/** Configuración mínima sin la cual un POST real no tiene recuperación segura. */
export function faltantesParaProduccion(config: BillerConfig): string[] {
  const faltantes: string[] = [];
  if (!config.auditLogPath) faltantes.push("BILLER_AUDIT_LOG_PATH o BILLER_DATA_DIR");
  if (!config.idempotencyLogPath) {
    faltantes.push("BILLER_IDEMPOTENCY_LOG_PATH o BILLER_DATA_DIR");
  }
  if (Object.keys(config.maxMontos).length === 0) {
    faltantes.push("al menos un BILLER_MAX_MONTO_<MONEDA>");
  }
  if (config.valorUi === undefined || config.valorUiFecha === undefined) {
    faltantes.push("BILLER_VALOR_UI y BILLER_VALOR_UI_FECHA");
  }
  if (config.kapso && !config.kapso.idempotencyLogPath) {
    faltantes.push("KAPSO_IDEMPOTENCY_LOG_PATH o BILLER_DATA_DIR");
  }
  if (config.kapso?.webhookSecret && !config.webhookReplayLogPath) {
    faltantes.push("BILLER_WEBHOOK_REPLAY_LOG_PATH o BILLER_DATA_DIR");
  }
  return faltantes;
}

/** Evalúa el gate SIN lanzar (útil para previews informativos). */
export function evaluateWriteGate(config: BillerConfig, req: GateRequest): GateDecision {
  const base: Omit<GateDecision, "allowed" | "reason"> = {
    environment: config.environment,
    write_enabled: config.writeEnabled,
    allow_production_env: config.allowProductionWrites,
  };

  if (!config.writeEnabled) {
    return { ...base, allowed: false, reason: "write_disabled" };
  }
  if (config.environment === "production" && !(config.allowProductionWrites && req.allowProduction)) {
    return { ...base, allowed: false, reason: "production_blocked" };
  }
  if (config.environment === "production") {
    const faltantes = faltantesParaProduccion(config);
    if (faltantes.length > 0) {
      return { ...base, allowed: false, reason: `production_not_ready:${faltantes.join(", ")}` };
    }
  }
  return { ...base, allowed: true };
}

/** Igual que evaluateWriteGate pero LANZA si no está permitido. */
export function assertWriteAllowed(config: BillerConfig, req: GateRequest): void {
  const decision = evaluateWriteGate(config, req);
  if (decision.allowed) return;
  if (decision.reason === "write_disabled") throw new BillerWriteDisabledError();
  const detalle = decision.reason?.startsWith("production_not_ready:")
    ? decision.reason.slice("production_not_ready:".length)
    : undefined;
  throw new BillerProductionBlockedError(detalle);
}
