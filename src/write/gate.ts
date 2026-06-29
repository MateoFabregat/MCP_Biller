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
  return { ...base, allowed: true };
}

/** Igual que evaluateWriteGate pero LANZA si no está permitido. */
export function assertWriteAllowed(config: BillerConfig, req: GateRequest): void {
  const decision = evaluateWriteGate(config, req);
  if (decision.allowed) return;
  if (decision.reason === "write_disabled") throw new BillerWriteDisabledError();
  throw new BillerProductionBlockedError();
}
