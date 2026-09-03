import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// El harness es JavaScript deliberadamente: se ejecuta sin compilar en una
// terminal de operador. Vitest lo importa para probar su frontera de seguridad.
import { TEST_BASE_URL, assertTestBaseUrl, runReadonlyContract, sanitizarComprobante, writeArtifact } from "../scripts/lib/contratoReadonly.mjs";

describe("harness de contrato read-only", () => {
  it("sin opt-in hace skip y no llama a la red", async () => {
    const fetchImpl = vi.fn();
    expect(await runReadonlyContract({ env: {}, fetchImpl })).toMatchObject({ skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechaza una URL que no es exactamente el ambiente TEST antes de la red", async () => {
    const fetchImpl = vi.fn();
    await expect(runReadonlyContract({ env: { BILLER_CONTRATO_READONLY: "1", BILLER_API_BASE_URL: "https://biller.uy", BILLER_API_TOKEN: "x" }, fetchImpl })).rejects.toThrow(TEST_BASE_URL);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertTestBaseUrl("https://test.biller.uy/otro")).toThrow(TEST_BASE_URL);
  });

  it("hace solo GET y serializa una allowlist, nunca headers, tokens, cuerpos o PII", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => ({ status: 200, text: async () => JSON.stringify({ comprobantes: [{
      id: 42, tipo_comprobante: 101, estado: "Aceptado DGI", moneda: "UYU", total: 123, iva: -22,
      rut: "219999830019", cliente: { nombre: "Ana", direccion: "Calle 1" }, token: "secret", body: "raw-body",
    }] }) }) as Response);
    let written: Record<string, any> | undefined;
    const result = await runReadonlyContract({
      env: { BILLER_CONTRATO_READONLY: "1", BILLER_API_BASE_URL: TEST_BASE_URL, BILLER_API_TOKEN: "bearer-secret" }, fetchImpl,
      now: () => new Date("2026-09-03T12:00:00.000Z"), artifactPath: "/ignored/artifact.json",
      write: (_path: string, artifact: Record<string, any>) => { written = artifact; },
    });
    expect(result.skipped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls) expect((call[1] as { method: string }).method).toBe("GET");
    const serialized = JSON.stringify(written);
    for (const secret of ["bearer-secret", "219999830019", "Ana", "Calle 1", "raw-body", "secret"]) expect(serialized).not.toContain(secret);
    expect(written!.tipo).toBe("evidencia_externa_pendiente_de_interpretacion");
    expect(written!.sondas[3].comprobantes[0].iva).toBe(-22);
  });

  it("crea el artefacto 0600 desde el primer byte", () => {
    const path = join(mkdtempSync(join(tmpdir(), "biller-contrato-")), "evidencia.json");
    writeArtifact(path, { ok: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"ok": true');
  });

  it("la allowlist preserva solo hechos fiscales mínimos", () => {
    expect(sanitizarComprobante({ id: 1, total: 2, iva: 3, nombre: "No sale" })).toEqual({ id: 1, tipo_comprobante: null, estado: null, moneda: null, total: 2, iva: 3 });
  });
});
