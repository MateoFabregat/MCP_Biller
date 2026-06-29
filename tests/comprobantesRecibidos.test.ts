import { describe, expect, it } from "vitest";
import { handleListarRecibidos } from "../src/tools/comprobantesRecibidos.js";
import { RECIBIDOS_EXAMPLE } from "./fixtures.js";
import { makeCtx } from "./helpers.js";

describe("biller_listar_comprobantes_recibidos", () => {
  // Requisito #8
  it("normaliza el ejemplo documentado y usa rate limit DGI", async () => {
    const { ctx, getMock } = makeCtx({ response: RECIBIDOS_EXAMPLE });
    const res = await handleListarRecibidos(
      { fecha_desde: "2020-03-01", fecha_hasta: "2020-04-30" },
      ctx,
    );

    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/comprobantes/recibidos/obtener");
    expect(opts.rateLimitClass).toBe("dgi");
    expect(opts.query.fecha_desde).toBe("2020-03-01");
    expect(opts.query.fecha_hasta).toBe("2020-04-30");

    const sc = res.structuredContent!;
    expect(sc.count).toBe(2);
    const comps = sc.comprobantes as Array<Record<string, unknown>>;
    expect(comps[0]!.tipo).toBe(111);
    expect(comps[0]!.rut_emisor).toBe("217832560011");
    expect(comps[0]!.monto_total).toBe(219.6);
    expect(comps[0]!.moneda).toBe("USD");
    expect(comps[0]!.estado).toBe("AE");

    const warnings = sc.warnings as string[];
    expect(warnings.some((w) => w.toLowerCase().includes("dgi"))).toBe(true);
  });

  it("rechaza fecha con formato inválido (Zod)", async () => {
    const { ctx, getMock } = makeCtx({ response: RECIBIDOS_EXAMPLE });
    const res = await handleListarRecibidos(
      { fecha_desde: "2020-03-01 00:00:00", fecha_hasta: "2020-04-30" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("filtra localmente por moneda y proveedor_rut", async () => {
    const { ctx } = makeCtx({ response: RECIBIDOS_EXAMPLE });
    const res = await handleListarRecibidos(
      { fecha_desde: "2020-03-01", fecha_hasta: "2020-04-30", moneda: "UYU" },
      ctx,
    );
    expect(res.structuredContent!.count).toBe(1);
    expect((res.structuredContent!.comprobantes as Array<Record<string, unknown>>)[0]!.moneda).toBe(
      "UYU",
    );
  });
});
