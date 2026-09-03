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
    expect(written!.cobertura).toEqual({
      paginacion: true,
      estados: true,
      terna_incompleta: false,
      iva_numerico_recibidos: true,
    });
  });

  it("crea el artefacto 0600 desde el primer byte", () => {
    const path = join(mkdtempSync(join(tmpdir(), "biller-contrato-")), "evidencia.json");
    writeArtifact(path, { ok: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"ok": true');
  });

  it("registra el 422 de la terna incompleta sin conservar mensajes upstream", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options: unknown) => ({
      status: 422,
      text: async () => JSON.stringify([
        { field: "numero", message: "Numero no puede estar vacío." },
        { field: "serie", message: "Serie no puede estar vacío." },
      ]),
    }) as Response);
    let written: Record<string, any> | undefined;
    await runReadonlyContract({
      env: { BILLER_CONTRATO_READONLY: "1", BILLER_API_BASE_URL: TEST_BASE_URL, BILLER_API_TOKEN: "x" },
      fetchImpl,
      write: (_path: string, artifact: Record<string, any>) => { written = artifact; },
    });
    expect(written!.sondas[2]).toEqual({
      sonda: "tipo_sin_serie_numero_rechazado",
      http_status: 422,
      evidencia_disponible: true,
      campos_error: ["numero", "serie"],
    });
    expect(JSON.stringify(written)).not.toContain("vacío");
  });

  it("la allowlist preserva solo hechos fiscales mínimos", () => {
    expect(sanitizarComprobante({ id: 1, total: 2, iva: 3, nombre: "No sale" })).toEqual({ id: 1, tipo_comprobante: null, estado: null, moneda: null, total: 2, iva: 3 });
  });

  it("marca explícitamente como inconclusa una sonda sin comprobantes", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "[]" }) as Response);
    let written: Record<string, any> | undefined;
    await runReadonlyContract({
      env: { BILLER_CONTRATO_READONLY: "1", BILLER_API_BASE_URL: TEST_BASE_URL, BILLER_API_TOKEN: "x" },
      fetchImpl,
      write: (_path: string, artifact: Record<string, any>) => { written = artifact; },
    });
    expect(written!.sondas.every((sonda: Record<string, unknown>) => sonda.evidencia_disponible === false)).toBe(true);
    expect(written!.cobertura).toEqual({
      paginacion: false,
      estados: false,
      terna_incompleta: false,
      iva_numerico_recibidos: false,
    });
  });

  it("no confunde otro 422 con la terna incompleta documentada", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 422,
      text: async () => JSON.stringify([{ field: "fecha", message: ["inválida"] }]),
    }) as Response);
    let written: Record<string, any> | undefined;
    await runReadonlyContract({
      env: { BILLER_CONTRATO_READONLY: "1", BILLER_API_BASE_URL: TEST_BASE_URL, BILLER_API_TOKEN: "x" },
      fetchImpl,
      write: (_path: string, artifact: Record<string, any>) => { written = artifact; },
    });
    expect(written!.sondas[2]).toEqual({
      sonda: "tipo_sin_serie_numero_rechazado",
      http_status: 422,
      evidencia_disponible: false,
      campos_error: ["otro"],
    });
    expect(written!.cobertura.terna_incompleta).toBe(false);
  });
});
