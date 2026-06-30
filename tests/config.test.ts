import { describe, expect, it } from "vitest";
import { inspectConfig, loadConfig } from "../src/config.js";
import { BillerConfigError } from "../src/utils/errors.js";

describe("config", () => {
  // Requisito #1
  it("loadConfig lanza si falta BILLER_API_BASE_URL", () => {
    expect(() => loadConfig({ BILLER_API_TOKEN: "validtoken123" })).toThrow(BillerConfigError);
  });

  it("loadConfig lanza si BILLER_API_TOKEN tiene menos de 8 caracteres", () => {
    expect(() =>
      loadConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "short" }),
    ).toThrow(BillerConfigError);
  });

  it("loadConfig lanza si falta BILLER_API_TOKEN", () => {
    expect(() => loadConfig({ BILLER_API_BASE_URL: "https://test.biller.uy" })).toThrow(
      BillerConfigError,
    );
  });

  it("loadConfig normaliza la base URL (sin barra final) y aplica defaults", () => {
    const c = loadConfig({
      BILLER_API_BASE_URL: "https://test.biller.uy/",
      BILLER_API_TOKEN: "tok-12345",
    });
    expect(c.apiBaseUrl).toBe("https://test.biller.uy");
    expect(c.timeoutMs).toBe(30_000);
    expect(c.apiToken).toBe("tok-12345");
  });

  it("loadConfig acepta opcionales y timeout custom (con clamp)", () => {
    const c = loadConfig({
      BILLER_API_BASE_URL: "https://biller.uy",
      BILLER_API_TOKEN: "tok-12345",
      BILLER_DEFAULT_EMPRESA_RUT: "210475730011",
      BILLER_DEFAULT_SUCURSAL_ID: "7",
      BILLER_TIMEOUT_MS: "5000",
    });
    expect(c.defaultEmpresaRut).toBe("210475730011");
    expect(c.defaultSucursalId).toBe("7");
    expect(c.timeoutMs).toBe(5000);
  });

  // Requisito #2 (parcial): inspección nunca expone el token
  it("inspectConfig nunca incluye el token (solo has_token)", () => {
    const insp = inspectConfig({
      BILLER_API_BASE_URL: "https://test.biller.uy",
      BILLER_API_TOKEN: "SECRETO-XYZ",
    });
    expect(JSON.stringify(insp)).not.toContain("SECRETO-XYZ");
    expect(insp.hasToken).toBe(true);
    expect(insp).not.toHaveProperty("apiToken");
  });

  it("inspectConfig no lanza con env vacío y reporta faltantes", () => {
    const insp = inspectConfig({});
    expect(insp.missing).toContain("BILLER_API_BASE_URL");
    expect(insp.missing).toContain("BILLER_API_TOKEN");
    expect(insp.hasToken).toBe(false);
    expect(insp.apiBaseUrl).toBeNull();
  });

  describe("BILLER_CAPABILITY_MODE", () => {
    const base = { BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "tok-12345" };

    it("default es read_only cuando la variable no está seteada", () => {
      const c = loadConfig(base);
      expect(c.capabilityMode).toBe("read_only");
    });

    it("acepta write_enabled", () => {
      const c = loadConfig({ ...base, BILLER_CAPABILITY_MODE: "write_enabled" });
      expect(c.capabilityMode).toBe("write_enabled");
    });

    it("cualquier valor desconocido cae en read_only", () => {
      const c = loadConfig({ ...base, BILLER_CAPABILITY_MODE: "full_access" });
      expect(c.capabilityMode).toBe("read_only");
    });

    it("inspectConfig también expone capabilityMode", () => {
      const i = inspectConfig({ ...base, BILLER_CAPABILITY_MODE: "write_enabled" });
      expect(i.capabilityMode).toBe("write_enabled");
    });

    it("inspectConfig sin la variable devuelve read_only", () => {
      const i = inspectConfig(base);
      expect(i.capabilityMode).toBe("read_only");
    });
  });
});
