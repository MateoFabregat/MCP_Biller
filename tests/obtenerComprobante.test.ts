import { describe, expect, it } from "vitest";
import { handleObtenerComprobante } from "../src/tools/obtenerComprobante.js";
import { EMITIDO_EXAMPLE } from "./fixtures.js";
import { makeCtx } from "./helpers.js";

describe("biller_obtener_comprobante", () => {
  // Requisito #7
  it("rechaza si no se especifica id, numero_interno ni la terna", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({}, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rechaza tipo_comprobante sin serie+numero", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ tipo_comprobante: "101" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("acepta la terna completa y consulta el endpoint", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante(
      { tipo_comprobante: "101", serie: "C", numero: "2069514" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/comprobantes/obtener");
    expect(opts.query.tipo_comprobante).toBe("101");
    expect(opts.query.serie).toBe("C");
    expect(opts.query.numero).toBe("2069514");
    expect((res.structuredContent!.comprobante as Record<string, unknown>).id).toBe(53616);
    expect(res.structuredContent!.count).toBe(1);
  });

  it("acepta consulta por id", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "53616" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(getMock.mock.calls[0]![0].query.id).toBe("53616");
  });

  it("envía recibidos=1 cuando recibidos=true", async () => {
    const { ctx, getMock } = makeCtx({ response: [] });
    await handleObtenerComprobante({ id: "1", recibidos: true }, ctx);
    expect(getMock.mock.calls[0]![0].query.recibidos).toBe("1");
  });
});
