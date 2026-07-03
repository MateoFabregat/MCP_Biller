// =============================================================================
// Audit log de operaciones de escritura.
//
// Registra QUÉ se intentó/ejecutó, SIN secretos: nunca el token, nunca el
// payload completo (solo su hash + metadata no sensible). Va siempre a stderr
// y, si se configura BILLER_AUDIT_LOG_PATH, también a un archivo append-only.
// =============================================================================

import { appendFileSync } from "node:fs";
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
      // BILLER_AUDIT_LOG_PATH es configuración del operador, NO input no confiable:
      // quien puede setear env vars ya tiene acceso al sistema, así que un guard
      // contra "traversal" no aporta seguridad real y sí rompe rutas absolutas
      // legítimas de producción (p.ej. /var/log/biller/audit.log), deshabilitando
      // el audit a archivo en silencio. Se confía en el operador; la ruta debe ser
      // escribible y cualquier fallo de escritura se loguea en record().
      this.filePath = path.resolve(rawFilePath);
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
      // Escritura síncrona: la entrada se persiste antes de que record() retorne.
      // Con appendFile async (fire-and-forget) la línea podía perderse si el
      // proceso moría justo después de un POST ya marcado como ejecutado.
      try {
        appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (err) {
        logger.warn("No se pudo escribir el audit log en archivo.", {
          path: this.filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return entry;
  }
}
