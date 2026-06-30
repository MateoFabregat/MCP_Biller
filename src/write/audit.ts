// =============================================================================
// Audit log de operaciones de escritura.
//
// Registra QUÉ se intentó/ejecutó, SIN secretos: nunca el token, nunca el
// payload completo (solo su hash + metadata no sensible). Va siempre a stderr
// y, si se configura BILLER_AUDIT_LOG_PATH, también a un archivo append-only.
// =============================================================================

import { appendFile } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { logger } from "../logger.js";

export type AuditPhase = "dry_run" | "executed" | "blocked" | "error";

export interface AuditEntry {
  audit_id: string;
  ts: string;
  tool: string;
  endpoint: string;
  environment: string;
  phase: AuditPhase;
  idempotency_key?: string;
  payload_sha256: string;
  http_status?: number;
  outcome?: string;
}

export interface AuditInput {
  tool: string;
  endpoint: string;
  environment: string;
  phase: AuditPhase;
  payloadSha256: string;
  idempotencyKey?: string;
  httpStatus?: number;
  outcome?: string;
}

export interface AuditSink {
  record(input: AuditInput): AuditEntry;
}

export class Auditor implements AuditSink {
  private readonly filePath?: string;

  constructor(rawFilePath?: string) {
    if (rawFilePath) {
      const resolved = path.resolve(rawFilePath);
      const base = path.resolve(".");
      if (resolved.startsWith(base + path.sep) || resolved === base) {
        this.filePath = resolved;
      } else {
        logger.warn("BILLER_AUDIT_LOG_PATH está fuera del directorio base permitido; el audit de archivo queda deshabilitado.", {
          path: rawFilePath,
          resolved,
          base,
        });
      }
    }
  }

  record(input: AuditInput): AuditEntry {
    const entry: AuditEntry = {
      audit_id: randomUUID(),
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

    // Siempre a stderr (vía logger), nunca a stdout.
    logger.info("biller.audit", { audit: entry });

    if (this.filePath) {
      appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8", (err) => {
        if (err) {
          logger.warn("No se pudo escribir el audit log en archivo.", {
            path: this.filePath,
            message: err.message,
          });
        }
      });
    }

    return entry;
  }
}
