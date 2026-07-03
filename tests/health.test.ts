import { describe, expect, it } from "vitest";
import { inspectConfig } from "../src/config.js";
import { buildHealthStructured, handleHealthCheck } from "../src/tools/health.js";

const inspectWithToken = () =>
  inspectConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "TOKENSECRETO" });

const inspectWriteEnabled = () =>
  inspectConfig({
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_API_TOKEN: "TOKENSECRETO",
    BILLER_CAPABILITY_MODE: "write_enabled",
    BILLER_WRITE_ENABLED: "true",
  });

describe("biller_health_check", () => {
  it("no expone el token y reporta has_token=true", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken });
    expect(JSON.stringify(res)).not.toContain("TOKENSECRETO");
    expect(res.structuredContent?.has_token).toBe(true);
    expect(res.structuredContent?.status).toBe("ok");
  });

  it("status=config_incompleta cuando faltan variables", () => {
    const res = handleHealthCheck({}, { inspect: () => inspectConfig({}) });
    expect(res.structuredContent?.status).toBe("config_incompleta");
    expect(res.structuredContent?.has_token).toBe(false);
    expect(res.structuredContent?.missing).toEqual(
      expect.arrayContaining(["BILLER_API_BASE_URL", "BILLER_API_TOKEN"]),
    );
  });

  it("response_format=markdown devuelve texto markdown sin token", () => {
    const res = handleHealthCheck({ response_format: "markdown" }, { inspect: inspectWithToken });
    const text = res.content[0]!.text;
    expect(text).toContain("# Biller MCP — health check");
    expect(text).toContain("has_token");
    expect(text).not.toContain("TOKENSECRETO");
  });

  it("capability_mode=read_only por defecto", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken });
    expect(res.structuredContent?.capability_mode).toBe("read_only");
    expect(res.structuredContent?.write_tools_registered).toBe(false);
    expect(res.structuredContent?.write_execution_enabled).toBe(false);
  });

  it("capability_mode=write_enabled cuando se configura la variable", () => {
    const res = handleHealthCheck({}, { inspect: inspectWriteEnabled });
    expect(res.structuredContent?.capability_mode).toBe("write_enabled");
    expect(res.structuredContent?.write_tools_registered).toBe(true);
    expect(res.structuredContent?.write_execution_enabled).toBe(true);
  });

  it("warnings vacíos en modo read_only con config mínima", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken });
    expect(res.structuredContent?.warnings).toEqual([]);
  });

  it("warning cuando write_tools_registered=true pero write_execution_enabled=false", () => {
    const inspect = () =>
      inspectConfig({
        BILLER_API_BASE_URL: "https://test.biller.uy",
        BILLER_API_TOKEN: "tok",
        BILLER_CAPABILITY_MODE: "write_enabled",
        BILLER_WRITE_ENABLED: "false",
      });
    const s = buildHealthStructured(inspect());
    const warnings = s.warnings as string[];
    expect(warnings.some((w) => w.includes("BILLER_WRITE_ENABLED"))).toBe(true);
  });

  it("warning cuando write_execution_enabled=true pero write_tools no registradas", () => {
    const inspect = () =>
      inspectConfig({
        BILLER_API_BASE_URL: "https://test.biller.uy",
        BILLER_API_TOKEN: "tok",
        BILLER_CAPABILITY_MODE: "read_only",
        BILLER_WRITE_ENABLED: "true",
      });
    const s = buildHealthStructured(inspect());
    const warnings = s.warnings as string[];
    expect(warnings.some((w) => w.includes("BILLER_CAPABILITY_MODE=write_enabled"))).toBe(true);
  });

  it("warning de producción cuando write habilitado y allow_production=true", () => {
    const inspect = () =>
      inspectConfig({
        BILLER_API_BASE_URL: "https://biller.uy",
        BILLER_API_TOKEN: "tok",
        BILLER_CAPABILITY_MODE: "write_enabled",
        BILLER_WRITE_ENABLED: "true",
        BILLER_ALLOW_PRODUCTION_WRITES: "true",
      });
    const s = buildHealthStructured(inspect());
    const warnings = s.warnings as string[];
    expect(warnings.some((w) => w.includes("PRODUCCIÓN"))).toBe(true);
  });

  it("el markdown incluye capability_mode y write_tools_registered", () => {
    const res = handleHealthCheck({ response_format: "markdown" }, { inspect: inspectWriteEnabled });
    const text = res.content[0]!.text;
    expect(text).toContain("capability_mode");
    expect(text).toContain("write_tools_registered");
    expect(text).toContain("write_execution_enabled");
  });
});
