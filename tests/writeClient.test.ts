import { describe, expect, it, vi } from "vitest";
import { BillerApiError, BillerProductionBlockedError, BillerWriteDisabledError } from "../src/utils/errors.js";
import { NoopRateLimiter } from "../src/utils/rateLimit.js";
import { BillerWriteClient } from "../src/write/writeClient.js";
import { TEST_TOKEN, makeConfig } from "./fixtures.js";

const noopLimiters = { default: new NoopRateLimiter(), dgi: new NoopRateLimiter() };

function jsonResponse(data: unknown, status = 201): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
function makeWriteClient(fetchImpl: typeof fetch, configOverrides = {}): BillerWriteClient {
  return new BillerWriteClient(makeConfig(configOverrides), { fetchImpl, rateLimiters: noopLimiters });
}

describe("BillerWriteClient (gate en el borde de red)", () => {
  it("NO ejecuta si la escritura está deshabilitada", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = makeWriteClient(fetchImpl as unknown as typeof fetch, { writeEnabled: false });
    await expect(
      client.post({ endpoint: "/v2/comprobantes/crear", body: {}, idempotencyKey: "k", allowProduction: false }),
    ).rejects.toBeInstanceOf(BillerWriteDisabledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bloquea producción salvo doble habilitación", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = makeWriteClient(fetchImpl as unknown as typeof fetch, {
      apiBaseUrl: "https://biller.uy",
      writeEnabled: true,
      allowProductionWrites: false,
    });
    await expect(
      client.post({ endpoint: "/v2/comprobantes/crear", body: {}, idempotencyKey: "k", allowProduction: true }),
    ).rejects.toBeInstanceOf(BillerProductionBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hace POST con Authorization Bearer e Idempotency-Key cuando está habilitado", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, serie: "C", numero: "9" }));
    const client = makeWriteClient(fetchImpl as unknown as typeof fetch, { writeEnabled: true });

    const out = await client.post({
      endpoint: "/v2/comprobantes/crear",
      body: { tipo_comprobante: 101 },
      idempotencyKey: "idem-42",
      allowProduction: false,
    });

    expect(out.status).toBe(201);
    expect((out.data as Record<string, unknown>).id).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test.biller.uy/v2/comprobantes/crear");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers["Idempotency-Key"]).toBe("idem-42");
    expect(init.body).toBe(JSON.stringify({ tipo_comprobante: 101 }));
  });

  it("no filtra el token en errores 422", async () => {
    const fetchImpl = vi.fn(async () => textResponse(`dato inválido, token=${TEST_TOKEN}`, 422));
    const client = makeWriteClient(fetchImpl as unknown as typeof fetch, { writeEnabled: true });

    let caught: unknown;
    try {
      await client.post({ endpoint: "/v2/comprobantes/crear", body: {}, idempotencyKey: "k", allowProduction: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillerApiError);
    const err = caught as BillerApiError;
    expect(err.status).toBe(422);
    expect(`${err.message} ${err.bodySnippet}`).not.toContain(TEST_TOKEN);
    expect(err.bodySnippet).toContain("[REDACTED]");
  });
});
