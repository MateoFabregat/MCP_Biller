import { describe, expect, it } from "vitest";
import { handleListarEmitidos } from "../src/tools/comprobantesEmitidos.js";
import { EMITIDO_EXAMPLE } from "./fixtures.js";
import { errorOf, makeCtx } from "./helpers.js";

describe("biller_listar_comprobantes_emitidos", () => {
  // Requisito #6
  it("llama a /v2/comprobantes/obtener con los params documentados", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos(
      { desde: "2026-06-01 00:00:00", hasta: "2026-06-07 23:59:59", sucursal: "5" },
      ctx,
    );

    expect(getMock).toHaveBeenCalledOnce();
    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/comprobantes/obtener");
    expect(opts.rateLimitClass).toBe("default");
    expect(opts.query.desde).toBe("2026-06-01 00:00:00");
    expect(opts.query.hasta).toBe("2026-06-07 23:59:59");
    expect(opts.query.sucursal).toBe("5");

    const sc = res.structuredContent!;
    expect(sc.count).toBe(1);
    expect(sc.pagination_supported).toBe(false);
    expect((sc.comprobantes as Array<Record<string, unknown>>)[0]!.tipo_comprobante).toBe(101);
    expect((sc.comprobantes as Array<Record<string, unknown>>)[0]!.numero).toBe(2069514);
  });

  // Requisito #15
  it("rechaza fechas con formato inválido (validación Zod)", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos({ desde: "2026/06/01" }, ctx);
    expect(res.isError).toBe(true);
    expect(errorOf(res).kind).toBe("validation");
    expect(getMock).not.toHaveBeenCalled();
  });

  // Requisito #6/validación de terna
  it("exige serie y numero cuando se envía tipo_comprobante", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos({ tipo_comprobante: "101" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("acepta la terna completa tipo_comprobante+serie+numero", async () => {
    const { ctx, getMock } = makeCtx({ response: [] });
    const res = await handleListarEmitidos(
      { tipo_comprobante: "101", serie: "C", numero: "2069514" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(getMock).toHaveBeenCalledOnce();
    const opts = getMock.mock.calls[0]![0];
    expect(opts.query.tipo_comprobante).toBe("101");
    expect(opts.query.serie).toBe("C");
    expect(opts.query.numero).toBe("2069514");
  });

  // Requisito #11 (warning de anulados al no haber campo documentado)
  it("advierte que no puede excluir anulados (sin campo de estado)", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos({ desde: "2026-06-01 00:00:00" }, ctx);
    const warnings = res.structuredContent!.warnings as string[];
    expect(warnings.some((w) => w.toLowerCase().includes("anulad"))).toBe(true);
  });

  // Filtro local de moneda
  it("filtra localmente por moneda", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos(
      { desde: "2026-06-01 00:00:00", moneda: "USD" },
      ctx,
    );
    expect(res.structuredContent!.count).toBe(0); // el ejemplo es UYU
  });

  // Aviso de paginación si el usuario pide page/cursor/offset
  it("avisa que la paginación no está soportada si se pide page/offset", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleListarEmitidos({ desde: "2026-06-01 00:00:00", page: 2 }, ctx);
    const warnings = res.structuredContent!.warnings as string[];
    expect(warnings.some((w) => w.toLowerCase().includes("paginación"))).toBe(true);
    expect(res.structuredContent!.pagination_supported).toBe(false);
  });
});
