import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { classifyCfe } from "../src/services/cfeTypes.js";
import { resumirFacturacion } from "../src/services/resumenFacturacion.js";
import { handleResumenFacturacion } from "../src/tools/resumenFacturacion.js";
import { makeCtx } from "./helpers.js";

const VENTAS_Y_NOTAS = [
  { tipo_comprobante: 101, moneda: "UYU", total: 1000 }, // venta +1000
  { tipo_comprobante: 111, moneda: "UYU", total: 500 }, //  venta  +500
  { tipo_comprobante: 102, moneda: "UYU", total: 200 }, //  NC     -200
  { tipo_comprobante: 103, moneda: "UYU", total: 50 }, //   ND     +50
  { tipo_comprobante: 101, moneda: "USD", total: 30 }, //   venta USD
];

describe("classifyCfe", () => {
  it("clasifica ventas (+1), NC (-1), ND (+1), especiales y desconocidos (0)", () => {
    expect(classifyCfe(101).signo).toBe(1);
    expect(classifyCfe(111).categoria).toBe("venta");
    expect(classifyCfe(102).signo).toBe(-1);
    expect(classifyCfe(112).categoria).toBe("nota_credito");
    expect(classifyCfe(103).signo).toBe(1);
    expect(classifyCfe(113).categoria).toBe("nota_debito");
    expect(classifyCfe(181).categoria).toBe("especial");
    expect(classifyCfe(181).suma_en_resumen).toBe(false);
    expect(classifyCfe(999).categoria).toBe("desconocido");
    expect(classifyCfe(null).categoria).toBe("desconocido");
  });
});

describe("resumirFacturacion (servicio)", () => {
  // Requisito #9
  it("suma ventas, resta notas de crédito y suma notas de débito", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });

    expect(r.totales_por_moneda.UYU!.total).toBe(1350); // 1000 + 500 - 200 + 50
    expect(r.totales_por_moneda.UYU!.comprobantes).toBe(4);
    expect(r.totales_por_tipo_comprobante["102"]!.signo).toBe(-1);
    expect(r.totales_por_tipo_comprobante["102"]!.total_por_moneda.UYU).toBe(-200);
    expect(r.totales_por_tipo_comprobante["103"]!.signo).toBe(1);
  });

  // Requisito #10
  it("separa por moneda y NO convierte", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(Object.keys(r.totales_por_moneda).sort()).toEqual(["USD", "UYU"]);
    expect(r.totales_por_moneda.USD!.total).toBe(30);
    expect(r.no_convertir_moneda).toBe(true);
  });

  // Requisito #11
  it("advierte que no puede excluir anulados (sin campo de estado)", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.warnings.some((w) => w.toLowerCase().includes("anulad"))).toBe(true);
  });

  it("excluye y advierte por falta de campos, especiales y no clasificables", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 101, moneda: "UYU", total: null }, // falta total
      { tipo_comprobante: 181, moneda: "UYU", total: 100 }, // especial
      { tipo_comprobante: 999, moneda: "UYU", total: 100 }, // desconocido
      { tipo_comprobante: 101, moneda: "UYU", total: 100 }, // incluido
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: true });
    expect(r.conteo_incluidos).toBe(1);
    expect(r.conteo_excluidos).toBe(3);
    expect(r.totales_por_moneda.UYU!.total).toBe(100);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe("biller_resumen_facturacion_periodo (tool)", () => {
  it("integra fetch + agregación end-to-end", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_Y_NOTAS });
    const res = await handleResumenFacturacion(
      { desde: "2026-06-01 00:00:00", hasta: "2026-06-30 23:59:59" },
      ctx,
    );
    expect(getMock.mock.calls[0]![0].path).toBe("/v2/comprobantes/obtener");
    const sc = res.structuredContent!;
    expect((sc.totales_por_moneda as Record<string, { total: number }>).UYU!.total).toBe(1350);
    expect((sc.totales_por_moneda as Record<string, { total: number }>).USD!.total).toBe(30);
    expect(sc.no_convertir_moneda).toBe(true);
    expect(sc.fuente).toBe("biller:/v2/comprobantes/obtener");
  });

  it("rechaza desde/hasta con formato inválido", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_Y_NOTAS });
    const res = await handleResumenFacturacion({ desde: "ayer", hasta: "hoy" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });
});
