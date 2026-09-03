import { describe, expect, it, vi } from "vitest";
import { ejecutarProbePost } from "../scripts/contrato-post.mjs";

const PAYLOAD = JSON.stringify({ numero_interno: "probe-20260903", tipo_comprobante: 101 });
const BASE_ENV = {
  BILLER_API_BASE_URL: "https://test.biller.uy",
  BILLER_API_TOKEN: "token-dedicado-de-test",
  BILLER_CONTRATO_POST_ENABLED: "SI",
  BILLER_CONTRATO_POST_CONFIRM: "ENTIENDO_QUE_CREA_UN_CFE_DE_PRUEBA",
  BILLER_CONTRATO_POST_PAYLOAD_PATH: "/privado/probe.json",
  BILLER_CONTRATO_POST_EXECUTION_ID: "probe-20260903",
  BILLER_CONTRATO_POST_IDEMPOTENCY_KEY: "idem-probe-20260903",
};

const archivoPrivado = {
  readFile: () => PAYLOAD,
  stat: () => ({ mode: 0o100600 }),
};

describe("probe contractual de POST e idempotencia", () => {
  it.each([
    ["sin habilitación", { ...BASE_ENV, BILLER_CONTRATO_POST_ENABLED: undefined }],
    ["sin confirmación", { ...BASE_ENV, BILLER_CONTRATO_POST_CONFIRM: undefined }],
    ["contra otra base", { ...BASE_ENV, BILLER_API_BASE_URL: "https://api.biller.uy" }],
  ])("no toca la red %s", async (_caso, env) => {
    const fetchImpl = vi.fn();
    await expect(ejecutarProbePost({ env, fetchImpl, archivos: archivoPrivado })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechaza un payload legible por otros usuarios antes de llamar a la red", async () => {
    const fetchImpl = vi.fn();
    await expect(ejecutarProbePost({
      env: BASE_ENV,
      fetchImpl,
      archivos: { ...archivoPrivado, stat: () => ({ mode: 0o100644 }) },
    })).rejects.toThrow(/0600/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("repite exactamente body e idempotency key y confirma una sola coincidencia", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "El numero_interno no existe" }),
        { status: 422, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 42, numero_interno: "probe-20260903" },
      ]), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(ejecutarProbePost({ env: BASE_ENV, fetchImpl, archivos: archivoPrivado })).resolves.toEqual({
      statusPrimero: 201,
      statusSegundo: 200,
      coincidencias: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const primera = fetchImpl.mock.calls[1]!;
    const segunda = fetchImpl.mock.calls[2]!;
    expect(primera[0]).toBe("https://test.biller.uy/v2/comprobantes/crear");
    expect(segunda[0]).toBe(primera[0]);
    expect(segunda[1]?.body).toBe(primera[1]?.body);
    expect(segunda[1]?.headers["Idempotency-Key"]).toBe(primera[1]?.headers["Idempotency-Key"]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("numero_interno=probe-20260903");
    expect(String(fetchImpl.mock.calls[3]![0])).toContain("numero_interno=probe-20260903");
    for (const llamada of fetchImpl.mock.calls) expect(llamada[1]?.redirect).toBe("manual");
  });

  it("no declara idempotencia si el identificador ya existía o el segundo POST falla", async () => {
    const yaExistia = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ numero_interno: "probe-20260903" }]), { status: 200 }),
    );
    await expect(ejecutarProbePost({ env: BASE_ENV, fetchImpl: yaExistia, archivos: archivoPrivado }))
      .rejects.toThrow(/ya existe/);
    expect(yaExistia).toHaveBeenCalledTimes(1);

    const segundoFalla = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "El numero_interno no existe" }),
        { status: 422, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }))
      .mockResolvedValueOnce(new Response("{}", { status: 409 }));
    await expect(ejecutarProbePost({ env: BASE_ENV, fetchImpl: segundoFalla, archivos: archivoPrivado }))
      .rejects.toThrow(/segundo POST/);
    expect(segundoFalla).toHaveBeenCalledTimes(3);
  });

  it("falla cerrado ante un 422 que no sea el contrato conocido de inexistencia", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "fecha inválida" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(ejecutarProbePost({ env: BASE_ENV, fetchImpl, archivos: archivoPrivado }))
      .rejects.toThrow(/preflight/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechaza redirects sin seguirlos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: "https://otro.example/probe" } }),
    );
    await expect(ejecutarProbePost({ env: BASE_ENV, fetchImpl, archivos: archivoPrivado }))
      .rejects.toThrow(/preflight/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe("manual");
  });
});
