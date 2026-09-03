import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { inspectConfig } from "../src/config.js";
import { buildHealthStructured, handleHealthCheck, registerHealthCheck } from "../src/tools/health.js";
import { createToolContext } from "../src/tools/register.js";
import type { ToolResult } from "../src/tools/shared.js";

const inspectWithToken = () =>
  inspectConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "TOKENSECRETO" });

const inspectWriteEnabled = () =>
  inspectConfig({
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_API_TOKEN: "TOKENSECRETO",
    BILLER_CAPABILITY_MODE: "write_enabled",
    BILLER_WRITE_ENABLED: "true",
    BILLER_APPROVAL_SECRET: "test-approval-secret-with-more-than-32-characters",
  });

describe("biller_health_check", () => {
  it("no expone el token y reporta has_token=true", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken, verificado: () => true });
    expect(JSON.stringify(res)).not.toContain("TOKENSECRETO");
    expect(res.structuredContent?.has_token).toBe(true);
    expect(res.structuredContent?.status).toBe("ok");
    expect(res.structuredContent?.approval_secret_configurado).toBe(false);
  });

  it("status=config_incompleta cuando faltan variables", () => {
    const res = handleHealthCheck({}, { inspect: () => inspectConfig({}), verificado: () => true });
    expect(res.structuredContent?.status).toBe("config_incompleta");
    expect(res.structuredContent?.has_token).toBe(false);
    expect(res.structuredContent?.missing).toEqual(
      expect.arrayContaining(["BILLER_API_BASE_URL", "BILLER_API_TOKEN"]),
    );
  });

  it("response_format=markdown devuelve texto markdown sin token", () => {
    const res = handleHealthCheck({ response_format: "markdown" }, { inspect: inspectWithToken, verificado: () => true });
    const text = res.content[0]!.text;
    expect(text).toContain("# Biller MCP — health check");
    expect(text).toContain("has_token");
    expect(text).not.toContain("TOKENSECRETO");
  });

  it("capability_mode=read_only por defecto", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken, verificado: () => true });
    expect(res.structuredContent?.capability_mode).toBe("read_only");
    expect(res.structuredContent?.write_tools_registered).toBe(false);
    expect(res.structuredContent?.write_execution_enabled).toBe(false);
  });

  it("capability_mode=write_enabled cuando se configura la variable", () => {
    const res = handleHealthCheck({}, { inspect: inspectWriteEnabled, verificado: () => true });
    expect(res.structuredContent?.capability_mode).toBe("write_enabled");
    expect(res.structuredContent?.write_tools_registered).toBe(true);
    expect(res.structuredContent?.write_execution_enabled).toBe(true);
    expect(res.structuredContent?.approval_secret_configurado).toBe(true);
  });

  it("warnings vacíos en modo read_only con config mínima", () => {
    const res = handleHealthCheck({}, { inspect: inspectWithToken, verificado: () => true });
    expect(res.structuredContent?.warnings).toEqual([]);
    expect(res.structuredContent?.rate_limit_default_rps).toBe(30);
    expect(res.structuredContent?.rate_limit_dgi_rps).toBe(1);
  });

  it("expone un warning de health para un rate limit inválido", () => {
    const res = handleHealthCheck(
      {},
      {
        inspect: () =>
          inspectConfig({
            BILLER_API_BASE_URL: "https://test.biller.uy",
            BILLER_API_TOKEN: "TOKENSECRETO",
            BILLER_RATE_LIMIT_DEFAULT_RPS: "0",
          }),
        verificado: () => true,
      },
    );
    expect(res.structuredContent?.rate_limit_default_rps).toBe(30);
    expect((res.structuredContent?.warnings as string[]).some((w) => w.includes("BILLER_RATE_LIMIT_DEFAULT_RPS"))).toBe(true);
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
    const res = handleHealthCheck({ response_format: "markdown" }, { inspect: inspectWriteEnabled, verificado: () => true });
    const text = res.content[0]!.text;
    expect(text).toContain("capability_mode");
    expect(text).toContain("write_tools_registered");
    expect(text).toContain("write_execution_enabled");
  });
});

describe("biller_health_check sin remitente verificado", () => {
  // El RUT que NO tiene que salir. Es un dato identificatorio: con él, cualquiera
  // que conozca el número de WhatsApp confirma qué empresa está atrás.
  const RUT = "213658790011";
  const inspectConRut = () =>
    inspectConfig({
      BILLER_API_BASE_URL: "https://biller.uy",
      BILLER_API_TOKEN: "TOKENSECRETO",
      BILLER_DEFAULT_EMPRESA_RUT: RUT,
      BILLER_DEFAULT_SUCURSAL_ID: "suc-1",
      BILLER_AUDIT_LOG_PATH: "/var/log/biller/audit.jsonl",
    });

  const sinRemitente = (formato?: "json" | "markdown") =>
    handleHealthCheck(
      { response_format: formato },
      { inspect: inspectConRut, verificado: () => false },
    );

  it("la salida NO contiene el RUT, ni la URL, ni la ruta del audit log", () => {
    const res = sinRemitente();
    const crudo = JSON.stringify(res);
    expect(crudo).not.toContain(RUT);
    expect(crudo).not.toContain("biller.uy");
    expect(crudo).not.toContain("/var/log/biller");
    expect(crudo).not.toContain("suc-1");
  });

  it("degrada a booleanos sin perder el diagnóstico", () => {
    const s = sinRemitente().structuredContent!;
    expect(s.detalle_completo).toBe(false);
    expect(s.default_empresa_rut).toBeNull();
    expect(s.tiene_empresa_rut).toBe(true);
    expect(s.api_base_url).toBeNull();
    expect(s.audit_log_path).toBeNull();
    expect(s.tiene_audit_log).toBe(true);
    // Lo que hace que la excepción de la barrera valga la pena sigue estando.
    expect(s.environment).toBe("production");
    expect(s.status).toBe("ok");
    expect(s.has_token).toBe(true);
    expect(Array.isArray(s.missing)).toBe(true);
    expect(Array.isArray(s.warnings)).toBe(true);
  });

  it("el markdown tampoco filtra: la rama de texto refleja lo mismo", () => {
    const res = sinRemitente("markdown");
    const text = res.content[0]!.text;
    expect(text).not.toContain(RUT);
    expect(text).not.toContain("/var/log/biller");
    expect(text).toContain("oculto");
  });

  it("con remitente verificado sale el detalle completo de siempre", () => {
    const s = handleHealthCheck({}, { inspect: inspectConRut, verificado: () => true })
      .structuredContent!;
    expect(s.detalle_completo).toBe(true);
    expect(s.default_empresa_rut).toBe(RUT);
    expect(s.api_base_url).toBe("https://biller.uy");
    expect(s.audit_log_path).toBe("/var/log/biller/audit.jsonl");
  });
});

describe("registro de la tool: el health check es del TENANT, no del proceso", () => {
  // ESTE TEST EXISTE POR UN AGUJERO CONCRETO.
  //
  // `registerHealthCheck(server)` se llamaba sin contexto, y el default de la
  // dependencia caía a `inspectConfig()`, o sea a `process.env`. En multi-empresa
  // eso hacía que un tenant autenticado con SU bearer recibiera el RUT, la URL de
  // la API y la ruta del audit log del proceso — de otra empresa. Si alguien
  // vuelve a registrar la tool sin `ctx`, esto se pone rojo.
  const RUT_DEL_PROCESO = "999999990011";
  const RUT_DEL_TENANT = "213658790011";

  function registrarYLlamar(env: Record<string, string | undefined>) {
    const ctx = createToolContext(env);
    let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    const fakeServer = {
      registerTool: (_n: string, _c: unknown, h: unknown) => {
        handler = h as (args: Record<string, unknown>) => Promise<ToolResult>;
      },
    } as unknown as McpServer;
    registerHealthCheck(fakeServer, ctx);
    if (handler === undefined) throw new Error("la tool no se registró");
    return handler({});
  }

  it("reporta la config del contexto y no la del proceso", async () => {
    const previo = process.env.BILLER_DEFAULT_EMPRESA_RUT;
    process.env.BILLER_DEFAULT_EMPRESA_RUT = RUT_DEL_PROCESO;
    try {
      const res = await registrarYLlamar({
        BILLER_API_BASE_URL: "https://test.biller.uy",
        BILLER_API_TOKEN: "TOKENDELTENANT",
        BILLER_DEFAULT_EMPRESA_RUT: RUT_DEL_TENANT,
      });
      expect(res.structuredContent?.default_empresa_rut).toBe(RUT_DEL_TENANT);
      expect(JSON.stringify(res)).not.toContain(RUT_DEL_PROCESO);
    } finally {
      if (previo === undefined) delete process.env.BILLER_DEFAULT_EMPRESA_RUT;
      else process.env.BILLER_DEFAULT_EMPRESA_RUT = previo;
    }
  });

  it("con canal de WhatsApp y sin remitente autorizado, degrada", async () => {
    const res = await registrarYLlamar({
      BILLER_API_BASE_URL: "https://test.biller.uy",
      BILLER_API_TOKEN: "TOKENDELTENANT",
      BILLER_DEFAULT_EMPRESA_RUT: RUT_DEL_TENANT,
      KAPSO_API_KEY: "kapso-key",
      BILLER_REMITENTES_AUTORIZADOS: "59895923567",
    });
    expect(res.structuredContent?.detalle_completo).toBe(false);
    expect(JSON.stringify(res)).not.toContain(RUT_DEL_TENANT);
  });
});
