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
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(url).toBe("https://test.biller.uy/v2/comprobantes/obtener?sucursal=1");
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
