// =============================================================================
// Orquestador de ejecución de escritura.
//
// Aplica, en orden, todas las barreras antes (y alrededor) del POST real:
//   1. Gate (write_enabled + producción)  -> audita "blocked" si no pasa.
//   2. Idempotencia in-process             -> evita doble ejecución.
//   3. POST vía writeClient                -> audita "executed"/"error".
// =============================================================================

import type { BillerConfig } from "../config.js";
import { BillerApiError, BillerIdempotencyError } from "../utils/errors.js";
import type { RateLimitClass } from "../utils/rateLimit.js";
import type { AuditEntry, AuditSink } from "./audit.js";
import { payloadHash } from "./confirm.js";
import { evaluateWriteGate } from "./gate.js";
import { BillerProductionBlockedError, BillerWriteDisabledError } from "../utils/errors.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { BillerWriteClient } from "./writeClient.js";

export interface WriteExecContext {
  config: BillerConfig;
  writeClient: BillerWriteClient;
  auditor: AuditSink;
  idempotency: IdempotencyStore;
}

export interface WriteExecInput {
  tool: string;
  endpoint: string;
  payload: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey: string;
  allowProduction: boolean;
  rateLimitClass?: RateLimitClass;
}

export interface WriteExecResult {
  status: number;
  data: unknown;
  audit: AuditEntry;
  idempotency_key: string;
}

export async function executeWrite(
  c: WriteExecContext,
  input: WriteExecInput,
): Promise<WriteExecResult> {
  const environment = c.config.environment;
  const payloadSha256 = payloadHash({ payload: input.payload, query: input.query ?? null });

  // 1. Gate
  const gate = evaluateWriteGate(c.config, { allowProduction: input.allowProduction });
  if (!gate.allowed) {
    c.auditor.record({
      tool: input.tool,
      endpoint: input.endpoint,
      environment,
      phase: "blocked",
      payloadSha256,
      idempotencyKey: input.idempotencyKey,
      outcome: gate.reason,
    });
    if (gate.reason === "write_disabled") throw new BillerWriteDisabledError();
    throw new BillerProductionBlockedError();
  }

  // 2. Idempotencia
  if (c.idempotency.has(input.idempotencyKey)) {
    c.auditor.record({
      tool: input.tool,
      endpoint: input.endpoint,
      environment,
      phase: "blocked",
      payloadSha256,
      idempotencyKey: input.idempotencyKey,
      outcome: "idempotency_replayed",
    });
    throw new BillerIdempotencyError(input.idempotencyKey);
  }

  // 3. POST
  try {
    const result = await c.writeClient.post({
      endpoint: input.endpoint,
      body: input.payload,
      query: input.query,
      idempotencyKey: input.idempotencyKey,
      allowProduction: input.allowProduction,
      rateLimitClass: input.rateLimitClass,
    });

    c.idempotency.markUsed(input.idempotencyKey);

    const audit = c.auditor.record({
      tool: input.tool,
      endpoint: input.endpoint,
      environment,
      phase: "executed",
      payloadSha256,
      idempotencyKey: input.idempotencyKey,
      httpStatus: result.status,
      outcome: "ok",
    });

    return { status: result.status, data: result.data, audit, idempotency_key: input.idempotencyKey };
  } catch (err) {
    c.auditor.record({
      tool: input.tool,
      endpoint: input.endpoint,
      environment,
      phase: "error",
      payloadSha256,
      idempotencyKey: input.idempotencyKey,
      httpStatus: err instanceof BillerApiError ? err.status : undefined,
      outcome: "error",
    });
    throw err;
  }
}
