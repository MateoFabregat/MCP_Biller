import { describe, expect, it } from "vitest";
import { inspectConfig } from "../src/config.js";
import { handleHealthCheck } from "../src/tools/health.js";

const inspectWithToken = () =>
  inspectConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "TOKENSECRETO" });

describe("biller_health_check", () => {
  // Requisito #2
  it("no expone el token y reporta has_token=true", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken });
    expect(JSON.stringify(res)).not.toContain("TOKENSECRETO");
    expect(res.structuredContent?.has_token).toBe(true);
    expect(res.structuredContent?.status).toBe("ok");
    expect(res.structuredContent?.read_only).toBe(true);
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
});
