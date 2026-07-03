import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Auditor } from "../src/write/audit.js";

describe("Auditor file sink", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    created.length = 0;
  });

  it("escribe el audit en una ruta ABSOLUTA fuera del CWD (config del operador)", () => {
    // tmpdir() es absoluto y queda fuera del CWD del proceso: el guard viejo
    // (restringido a CWD) lo rechazaba en silencio. Ahora debe persistirse.
    const dir = mkdtempSync(path.join(tmpdir(), "biller-audit-"));
    created.push(dir);
    const file = path.join(dir, "audit.log");

    const auditor = new Auditor(file);
    const entry = auditor.record({
      tool: "biller_emitir_comprobante",
      endpoint: "/v2/comprobantes/crear",
      environment: "test",
      phase: "executed",
      payloadSha256: "deadbeef",
    });

    expect(existsSync(file)).toBe(true);
    const logged = JSON.parse(readFileSync(file, "utf8").trim());
    expect(logged.audit_id).toBe(entry.audit_id);
    expect(logged.phase).toBe("executed");
    // El audit guarda solo el hash del payload, nunca el payload completo.
    expect(logged.payload_sha256).toBe("deadbeef");
  });
});
