import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
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

  it.skipIf(process.platform === "win32")(
    "aprieta el permiso a 0600 aunque el archivo YA EXISTÍA con otro permiso (umask del operador)",
    () => {
      // El `mode` de appendFileSync solo aplica AL CREAR: un archivo que ya
      // existía —rotado con `cp`, o el directorio armado a mano antes de
      // arrancar— se queda con el permiso con el que lo creó otro. El audit es
      // el rastro fiscal de lo emitido: no puede quedar legible para cualquiera
      // con acceso al disco.
      const dir = mkdtempSync(path.join(tmpdir(), "biller-audit-preexistente-"));
      created.push(dir);
      const file = path.join(dir, "audit.log");
      closeSync(openSync(file, "w"));
      chmodSync(file, 0o644);

      const auditor = new Auditor(file);
      auditor.record({
        tool: "biller_emitir_comprobante",
        endpoint: "/v2/comprobantes/crear",
        environment: "test",
        phase: "executed",
        payloadSha256: "deadbeef",
      });

      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );
});
