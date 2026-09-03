import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
  DEFAULT_RATE_LIMIT_DEFAULT_RPS,
  DEFAULT_RATE_LIMIT_DGI_RPS,
  MAX_RATE_LIMIT_RPS,
  TENANT_IMPLICITO,
  inspectConfig,
  loadConfig,
} from "../src/config.js";
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
      BILLER_APPROVAL_SECRET: "approval-secret-que-tampoco-debe-salir-123456",
    });
    expect(JSON.stringify(insp)).not.toContain("SECRETO-XYZ");
    expect(JSON.stringify(insp)).not.toContain("approval-secret-que-tampoco-debe-salir-123456");
    expect(insp.hasToken).toBe(true);
    expect(insp.approvalSecretConfigurado).toBe(true);
    expect(insp).not.toHaveProperty("apiToken");
  });

  it("inspectConfig no lanza con env vacío y reporta faltantes", () => {
    const insp = inspectConfig({});
    expect(insp.missing).toContain("BILLER_API_BASE_URL");
    expect(insp.missing).toContain("BILLER_API_TOKEN");
    expect(insp.hasToken).toBe(false);
    expect(insp.apiBaseUrl).toBeNull();
  });

  it("inspectConfig marca un token demasiado corto en missing (igual que loadConfig)", () => {
    // Antes: inspectConfig solo chequeaba presencia, así que un token de 7 chars
    // daba missing: [] -> health "ok", pero toda llamada fallaba con BillerConfigError.
    const insp = inspectConfig({
      BILLER_API_BASE_URL: "https://test.biller.uy",
      BILLER_API_TOKEN: "abc123", // 6 caracteres
    });
    expect(insp.missing).toContain("BILLER_API_TOKEN debe tener al menos 8 caracteres");
    expect(() =>
      loadConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "abc123" }),
    ).toThrow(BillerConfigError);
  });

  describe("BILLER_CAPABILITY_MODE", () => {
    const base = { BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: "tok-12345" };

    it("default es read_only cuando la variable no está seteada", () => {
      const c = loadConfig(base);
      expect(c.capabilityMode).toBe("read_only");
    });

    it("acepta write_enabled", () => {
      const c = loadConfig({
        ...base,
        BILLER_CAPABILITY_MODE: "write_enabled",
        BILLER_APPROVAL_SECRET: "test-approval-secret-with-more-than-32-characters",
      });
      expect(c.capabilityMode).toBe("write_enabled");
    });

    it("write_enabled exige una clave server-side para firmar approvals", () => {
      expect(() => loadConfig({ ...base, BILLER_CAPABILITY_MODE: "write_enabled" })).toThrow(
        /BILLER_APPROVAL_SECRET/,
      );
      expect(() =>
        loadConfig({
          ...base,
          BILLER_CAPABILITY_MODE: "write_enabled",
          BILLER_APPROVAL_SECRET: "demasiado-corta",
        }),
      ).toThrow(/32 caracteres/);
    });

    it("Kapso también exige la clave porque puede enviar recordatorios", () => {
      expect(() => loadConfig({ ...base, KAPSO_API_KEY: "kapso-key" })).toThrow(
        /BILLER_APPROVAL_SECRET/,
      );
      expect(
        loadConfig({
          ...base,
          KAPSO_API_KEY: "kapso-key",
          BILLER_APPROVAL_SECRET: "test-approval-secret-with-more-than-32-characters",
        }).approvalSecret,
      ).toHaveLength(49);
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

// =============================================================================
// El .env.example como contrato, no como sugerencia.
//
// Por qué esto es un test y no una revisión manual: una variable que el código
// LEE pero el ejemplo no NOMBRA es, en la práctica, invisible. Nadie la
// configura porque nadie sabe que existe. No es teórico — se descubrieron ocho
// de golpe, y entre ellas estaban las tres que más importan:
// BILLER_IDEMPOTENCY_LOG_PATH (sin ella la protección contra facturas
// duplicadas no sobrevive a un reinicio), BILLER_MAX_MONTO_* (el tope contra el
// error de coma) y BILLER_SERVERLESS_ALLOW_WRITES.
//
// Es la misma clase de error que el apéndice V4 del brainstorm ya había
// nombrado para otro módulo: "el schema lo acepta, la conversación nunca lo
// pregunta". Acá: el código la lee, la documentación nunca la ofrece.
// =============================================================================

describe("contrato del .env.example", () => {
  const raizProyecto = new URL("..", import.meta.url).pathname;

  /** Variables que el código lee de verdad, sacadas del fuente. */
  function variablesLeidas(): Set<string> {
    const out = new Set<string>();
    const recorrer = (dir: string): void => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          recorrer(ruta);
          continue;
        }
        if (!entrada.name.endsWith(".ts")) continue;
        const fuente = readFileSync(ruta, "utf8");
        for (const m of fuente.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) out.add(m[1]!);
      }
    };
    recorrer(join(raizProyecto, "src"));
    return out;
  }

  /** Variables que el ejemplo nombra, comentadas o no. */
  function variablesDocumentadas(): Set<string> {
    const texto = readFileSync(join(raizProyecto, ".env.example"), "utf8");
    const out = new Set<string>();
    for (const m of texto.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) out.add(m[1]!);
    // Las de prefijo se documentan por ejemplo (BILLER_MAX_MONTO_UYU) y se leen
    // por patrón, así que se registra también la familia.
    for (const v of [...out]) {
      const m = /^(BILLER_MAX_MONTO)_[A-Z]{3}$/.exec(v);
      if (m !== null) out.add(m[1]!);
    }
    return out;
  }

  it("toda variable que el código lee está nombrada en .env.example", () => {
    const documentadas = variablesDocumentadas();
    const faltantes = [...variablesLeidas()].filter((v) => !documentadas.has(v)).sort();
    expect(
      faltantes,
      `Variables leídas por src/ y ausentes de .env.example: ${faltantes.join(", ")}. ` +
        "Una variable indocumentada no se configura nunca: agregala al ejemplo diciendo qué " +
        "pasa si NO se configura, que es la parte que importa.",
    ).toEqual([]);
  });
});

// =============================================================================
// Los parámetros del transporte HTTP y el cache, ya en la config validada.
//
// Vivían leyéndose sueltos del entorno con un helper local en
// `transport/http.ts`, fuera de la validación y por lo tanto fuera del overlay
// de tenants. El test que importa es el del MODO DE FALLA: un valor basura no
// puede romper el arranque (quedarse sin server de facturación por un TTL mal
// tipeado es peor) pero tampoco puede pasar en silencio por bueno.
// =============================================================================

describe("parámetros del proceso en la config validada", () => {
  const MINIMA = {
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_API_TOKEN: "validtoken123",
  };

  it("BILLER_HTTP_SESSION_TTL_MS y BILLER_HTTP_MAX_SESSIONS se leen y se validan", () => {
    const c = loadConfig({
      ...MINIMA,
      BILLER_HTTP_SESSION_TTL_MS: "60000",
      BILLER_HTTP_MAX_SESSIONS: "10",
    });
    expect(c.httpSessionTtlMs).toBe(60_000);
    expect(c.httpMaxSessions).toBe(10);
  });

  it("un valor basura cae al default en vez de romper el arranque", () => {
    for (const malo of ["cero", "-1", "0"]) {
      const c = loadConfig({ ...MINIMA, BILLER_HTTP_MAX_SESSIONS: malo });
      expect(c.httpMaxSessions).toBe(DEFAULT_HTTP_MAX_SESSIONS);
    }
    expect(loadConfig(MINIMA).httpSessionTtlMs).toBe(DEFAULT_HTTP_SESSION_TTL_MS);
  });

  it("BILLER_CACHE_ENABLED viene prendido y solo el literal 'false' lo apaga", () => {
    expect(loadConfig(MINIMA).cacheEnabled).toBe(true);
    expect(loadConfig({ ...MINIMA, BILLER_CACHE_ENABLED: "false" }).cacheEnabled).toBe(false);
    expect(loadConfig({ ...MINIMA, BILLER_CACHE_ENABLED: "FALSE" }).cacheEnabled).toBe(false);
    // "0" es lo que escribe quien cree que apagó el cache: queda prendido y se
    // avisa por log, porque diagnosticar contra datos cacheados es el modo de
    // falla caro.
    expect(loadConfig({ ...MINIMA, BILLER_CACHE_ENABLED: "0" }).cacheEnabled).toBe(true);
  });

  it("inspectConfig reporta lo mismo y nunca lanza", () => {
    const i = inspectConfig({ ...MINIMA, BILLER_CACHE_ENABLED: "false" });
    expect(i.cacheEnabled).toBe(false);
    expect(i.tenantId).toBe(TENANT_IMPLICITO);
    expect(i.dataDir).toBeNull();
  });

  it("inspectConfig informa la ruta DERIVADA, que es el archivo que se va a usar de verdad, sin tocar el disco", () => {
    const i = inspectConfig({ ...MINIMA, BILLER_DATA_DIR: "/no/existe/ni/hace/falta" });
    expect(i.auditLogPath).toBe("/no/existe/ni/hace/falta/_proceso/audit.jsonl");
  });

  describe("rate limits efectivos", () => {
    it("usa 30 req/s normales y 1 req/s DGI cuando no se configuran", () => {
      const c = loadConfig(MINIMA);
      const i = inspectConfig(MINIMA);
      expect(c.rateLimitDefaultRps).toBe(DEFAULT_RATE_LIMIT_DEFAULT_RPS);
      expect(c.rateLimitDgiRps).toBe(DEFAULT_RATE_LIMIT_DGI_RPS);
      expect(i.rateLimitDefaultRps).toBe(DEFAULT_RATE_LIMIT_DEFAULT_RPS);
      expect(i.rateLimitDgiRps).toBe(DEFAULT_RATE_LIMIT_DGI_RPS);
      expect(i.configWarnings).toEqual([]);
    });

    it("acepta enteros positivos dentro del techo operativo", () => {
      const c = loadConfig({
        ...MINIMA,
        BILLER_RATE_LIMIT_DEFAULT_RPS: "12",
        BILLER_RATE_LIMIT_DGI_RPS: String(MAX_RATE_LIMIT_RPS),
      });
      expect(c.rateLimitDefaultRps).toBe(12);
      expect(c.rateLimitDgiRps).toBe(MAX_RATE_LIMIT_RPS);
    });

    it.each(["0", "-1", "1.5", "texto", "Infinity", String(MAX_RATE_LIMIT_RPS + 1)])(
      "cae al default y avisa para un valor inválido (%s)",
      (malo) => {
        const i = inspectConfig({ ...MINIMA, BILLER_RATE_LIMIT_DEFAULT_RPS: malo });
        expect(i.rateLimitDefaultRps).toBe(DEFAULT_RATE_LIMIT_DEFAULT_RPS);
        expect(i.configWarnings).toHaveLength(1);
        expect(i.configWarnings[0]).toContain("BILLER_RATE_LIMIT_DEFAULT_RPS");
      },
    );
  });
});
