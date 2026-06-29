import { vi } from "vitest";
import type { BillerClient, BillerGetOptions } from "../src/biller/client.js";
import type { BillerConfig } from "../src/config.js";
import type { ToolContext } from "../src/tools/shared.js";
import type { AuditEntry, AuditInput, AuditSink } from "../src/write/audit.js";
import { IdempotencyStore } from "../src/write/idempotency.js";
import type { PostOptions, PostResult } from "../src/write/writeClient.js";
import type { BillerWriteClient } from "../src/write/writeClient.js";
import { makeConfig } from "./fixtures.js";

export interface FakeCtxOptions {
  /** Respuesta fija de client.get(). */
  response?: unknown;
  /** Implementación dinámica de client.get(). Prioridad sobre `response`. */
  impl?: (opts: BillerGetOptions) => unknown | Promise<unknown>;
  /** Respuesta de writeClient.post(). */
  postResponse?: unknown;
  postStatus?: number;
  /** Implementación dinámica de writeClient.post(). */
  postImpl?: (opts: PostOptions) => PostResult | Promise<PostResult>;
  config?: Partial<BillerConfig>;
}

export interface FakeCtx {
  ctx: ToolContext;
  getMock: ReturnType<typeof vi.fn>;
  postMock: ReturnType<typeof vi.fn>;
  config: BillerConfig;
  auditEntries: AuditEntry[];
  idempotency: IdempotencyStore;
}

export function makeCtx(opts: FakeCtxOptions = {}): FakeCtx {
  const getMock = vi.fn(async (o: BillerGetOptions) =>
    opts.impl ? await opts.impl(o) : opts.response,
  );
  const client = { get: getMock } as unknown as BillerClient;

  const postMock = vi.fn(async (o: PostOptions): Promise<PostResult> => {
    if (opts.postImpl) return opts.postImpl(o);
    return { status: opts.postStatus ?? 201, data: opts.postResponse ?? {} };
  });
  const writeClient = { post: postMock } as unknown as BillerWriteClient;

  const config = makeConfig(opts.config);
  const auditEntries: AuditEntry[] = [];
  const auditor: AuditSink = {
    record(input: AuditInput): AuditEntry {
      const entry: AuditEntry = {
        audit_id: `audit-${auditEntries.length}`,
        ts: new Date().toISOString(),
        tool: input.tool,
        endpoint: input.endpoint,
        environment: input.environment,
        phase: input.phase,
        idempotency_key: input.idempotencyKey,
        payload_sha256: input.payloadSha256,
        http_status: input.httpStatus,
        outcome: input.outcome,
      };
      auditEntries.push(entry);
      return entry;
    },
  };
  const idempotency = new IdempotencyStore();

  const ctx: ToolContext = {
    getConfig: () => config,
    getClient: () => client,
    getWriteContext: () => ({ config, writeClient, auditor, idempotency }),
  };

  return { ctx, getMock, postMock, config, auditEntries, idempotency };
}

/** Extrae el error de un ToolResult (los errores van como JSON en content text). */
export function errorOf(res: { content: Array<{ text: string }>; isError?: boolean }): {
  kind: string;
  message: string;
  status?: number;
  details?: string;
} {
  const parsed = JSON.parse(res.content[0]!.text) as { error: { kind: string; message: string } };
  return parsed.error;
}

/** Contexto cuya configuración no existe (simula falta de env vars). */
export function makeUnconfiguredCtx(): ToolContext {
  const fail = (): never => {
    throw new Error("no config");
  };
  return {
    getConfig: fail,
    getClient: fail,
    getWriteContext: fail,
  };
}
