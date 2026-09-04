import { describe, expect, it, vi } from "vitest";
import { BillerClient } from "../src/biller/client.js";
import { BillerApiError } from "../src/utils/errors.js";
import { NoopRateLimiter } from "../src/utils/rateLimit.js";
import { EMITIDO_EXAMPLE, RECIBIDOS_EXAMPLE_TEXT, TEST_TOKEN, makeConfig } from "./fixtures.js";

const noopLimiters = { default: new NoopRateLimiter(), dgi: new NoopRateLimiter() };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

function makeClient(fetchImpl: typeof fetch, config = makeConfig()): BillerClient {
  return new BillerClient(config, { fetchImpl, rateLimiters: noopLimiters });
}

describe("BillerClient", () => {
  // Requisito #3 (envía Authorization Bearer)
  it("envía Authorization: Bearer y method GET", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(EMITIDO_EXAMPLE));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.get({ path: "/v2/comprobantes/obtener", query: { sucursal: "1" } });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(url).toBe("https://test.biller.uy/v2/comprobantes/obtener?sucursal=1");
  });

  it("corta una respuesta exitosa que supera el límite seguro", async () => {
    const fetchImpl = vi.fn(async () => textResponse("x".repeat(2 * 1024 * 1024 + 1)));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.get({ path: "/v2/comprobantes/obtener" })).rejects.toThrow(
      /supera el límite seguro/,
    );
  });

  it("buildUrl normaliza base con barra final y arma el query string", () => {
    const client = makeClient(
      (async () => jsonResponse([])) as unknown as typeof fetch,
      makeConfig({ apiBaseUrl: "https://test.biller.uy/" }),
    );
    expect(client.buildUrl("/v2/x", { a: "1", b: undefined, c: 2, d: null })).toBe(
      "https://test.biller.uy/v2/x?a=1&c=2",
    );
  });

  // Requisito #3 (el token nunca aparece en errores)
  it("no filtra el token en los errores (lo redacta del body)", async () => {
    const fetchImpl = vi.fn(async () => textResponse(`fallo interno con token ${TEST_TOKEN}`, 500));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    let caught: unknown;
    try {
      await client.get({ path: "/v2/comprobantes/obtener" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillerApiError);
    const err = caught as BillerApiError;
    expect(err.status).toBe(500);
    const serialized = `${err.message} ${JSON.stringify(err.toSafe())}`;
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(err.bodySnippet).toContain("[REDACTED]");
  });

  // Requisito #14 (manejo de 429 con mensaje claro)
  it("mapea 429 a un mensaje claro de rate limit", async () => {
    const fetchImpl = vi.fn(async () => textResponse("Too Many Requests", 429));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    let caught: unknown;
    try {
      await client.get({ path: "/v2/dgi/empresas/datos-entidad", rateLimitClass: "dgi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillerApiError);
    const err = caught as BillerApiError;
    expect(err.status).toBe(429);
    expect(err.message).toContain("429");
    expect(err.message.toLowerCase()).toContain("límite");
  });

  // Respuestas text/plain con JSON dentro (caso recibidos)
  it("parsea respuestas text/plain que contienen JSON", async () => {
    const fetchImpl = vi.fn(async () => textResponse(RECIBIDOS_EXAMPLE_TEXT));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const data = await client.get<unknown[]>({ path: "/v2/comprobantes/recibidos/obtener" });
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect((data[0] as Record<string, unknown>).estado).toBe("AE");
  });
});

describe("un 429 de Biller no es un error del usuario", () => {
  // Los limitadores locales evitan pasarse por culpa nuestra, pero no cubren
  // que Biller conteste 429 igual: otro proceso de la misma empresa usando el
  // mismo token, o un límite de ellos que no conocemos. Hoy eso subía como
  // error y el usuario leía "no se pudo consultar" por algo que se resuelve
  // esperando 200 ms.
  const esperaInstantanea = { esperar: async () => {} };

  it("reintenta un GET y devuelve el dato cuando el segundo intento anda", async () => {
    let intentos = 0;
    const fetchImpl = vi.fn(async () => {
      intentos += 1;
      return intentos === 1 ? jsonResponse({ error: "rate limit" }, 429) : jsonResponse(EMITIDO_EXAMPLE);
    });
    const client = new BillerClient(makeConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiters: noopLimiters,
      ...esperaInstantanea,
    });

    const r = await client.get({ path: "/v2/comprobantes/obtener" });
    expect(r).toBeDefined();
    expect(intentos).toBe(2);
  });

  it("se rinde con un techo bajo y deja el 429 como error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "rate limit" }, 429));
    const client = new BillerClient(makeConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiters: noopLimiters,
      ...esperaInstantanea,
    });

    await expect(client.get({ path: "/v2/comprobantes/obtener" })).rejects.toThrow();
    // Tres intentos en total: el original y dos reintentos. Insistir más
    // convierte una espera en un timeout, que es peor que el error.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("un 422 NO se reintenta: el cuerpo está mal y va a estar mal de nuevo", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "campo faltante" }, 422));
    const client = new BillerClient(makeConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiters: noopLimiters,
      ...esperaInstantanea,
    });

    await expect(client.get({ path: "/v2/comprobantes/obtener" })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
