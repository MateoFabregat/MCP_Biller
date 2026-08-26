import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
