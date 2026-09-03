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

/**
 * Lo que el gate mira para decidir si producción está preparada, ya reducido a
 * las preguntas de sí o no que importan.
 *
 * Existe para que la regla se escriba UNA vez. Estaba escrita dos —acá y en
 * `biller_health_check`—, sobre dos formas distintas del mismo dato (una usa
 * `undefined`, la otra `null`), y dos listas que hay que acordarse de editar
 * juntas terminan diciendo cosas distintas: el health decía "listo" mientras el
 * gate bloqueaba, que es la peor combinación posible para quien está por
 * facturar. Los NOMBRES de lo que falta viven acá y en ningún otro lado.
 */
export interface PreparacionProduccion {
  auditPersistente: boolean;
  idempotenciaFiscalPersistente: boolean;
  tieneTopeDeMonto: boolean;
  valorUiVigente: boolean;
  replayWebhookPersistente: boolean;
  /** `null` si no hay canal de WhatsApp configurado. */
  kapso: {
    idempotenciaPersistente: boolean;
    /** true si la ruta del webhook entrante existe (hay secreto configurado). */
    webhookHabilitado: boolean;
  } | null;
}

/** Configuración mínima sin la cual un POST real no tiene recuperación segura. */
export function faltantesParaProduccion(p: PreparacionProduccion): string[] {
  const faltantes: string[] = [];
  if (!p.auditPersistente) faltantes.push("BILLER_AUDIT_LOG_PATH o BILLER_DATA_DIR");
  if (!p.idempotenciaFiscalPersistente) {
    faltantes.push("BILLER_IDEMPOTENCY_LOG_PATH o BILLER_DATA_DIR");
  }
  if (!p.tieneTopeDeMonto) faltantes.push("al menos un BILLER_MAX_MONTO_<MONEDA>");
  if (!p.valorUiVigente) faltantes.push("BILLER_VALOR_UI y BILLER_VALOR_UI_FECHA");
  if (p.kapso !== null && !p.kapso.idempotenciaPersistente) {
    faltantes.push("KAPSO_IDEMPOTENCY_LOG_PATH o BILLER_DATA_DIR");
  }
  if (p.kapso?.webhookHabilitado && !p.replayWebhookPersistente) {
    faltantes.push("BILLER_WEBHOOK_REPLAY_LOG_PATH o BILLER_DATA_DIR");
  }
  return faltantes;
}

/** La misma pregunta, hecha sobre la config cargada. */
export function preparacionDeConfig(config: BillerConfig): PreparacionProduccion {
  return {
    auditPersistente: Boolean(config.auditLogPath),
    idempotenciaFiscalPersistente: Boolean(config.idempotencyLogPath),
    tieneTopeDeMonto: Object.keys(config.maxMontos).length > 0,
    valorUiVigente: config.valorUi !== undefined && config.valorUiFecha !== undefined,
    replayWebhookPersistente: Boolean(config.webhookReplayLogPath),
    kapso:
      config.kapso === undefined
        ? null
        : {
            idempotenciaPersistente: Boolean(config.kapso.idempotencyLogPath),
            webhookHabilitado: config.kapso.webhookSecret !== undefined,
          },
  };
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
    const faltantes = faltantesParaProduccion(preparacionDeConfig(config));
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
