// =============================================================================
// A8 — Ranking de sucursales: participación y evolución.
//
// Lo que se prueba acá no es que sume: es que la EVOLUCIÓN diga la verdad.
// Una sucursal que factura más y pesa menos, y una que desaparece del período,
// son los dos casos que un total agrupado no muestra.
// =============================================================================

import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { SIN_SUCURSAL, rankingSucursales } from "../src/services/sucursales.js";

function crudo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tipo_comprobante: 111, // e-Factura (venta)
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15 10:00:00",
    sucursal: 6,
    cliente: { documento: "210000000011", razon_social: "ACME SA" },
    ...over,
  };
}

function ranking(
  actuales: Array<Record<string, unknown>>,
  previos: Array<Record<string, unknown>> | null = null,
  opts: Record<string, unknown> = {},
) {
  return rankingSucursales(
    normalizeComprobantesEmitidos(actuales),
    previos === null ? null : normalizeComprobantesEmitidos(previos),
    opts as Parameters<typeof rankingSucursales>[2],
  );
}

describe("participación", () => {
  it("reparte el 100% entre las sucursales del período", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 750 }),
      crudo({ id: 2, sucursal: 7, total: 250 }),
    ]);
    expect(r.sucursales.map((s) => s.id)).toEqual(["6", "7"]);
    expect(r.sucursales[0]!.participacion_pct).toBe(75);
    expect(r.sucursales[1]!.participacion_pct).toBe(25);
  });

  it("las notas de crédito restan de su sucursal", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 1000 }),
      crudo({ id: 2, sucursal: 6, tipo_comprobante: 112, total: 400 }), // NC de e-Factura
    ]);
    expect(r.sucursales[0]!.facturado_por_moneda["UYU"]).toBe(600);
  });

  it("los recibos no cuentan como facturación", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 1000 }),
      crudo({ id: 2, sucursal: 6, total: 500, indicador_cobranza_propia: 1 }),
    ]);
    expect(r.sucursales[0]!.facturado_por_moneda["UYU"]).toBe(1000);
    expect(r.sucursales[0]!.comprobantes).toBe(1);
  });

  it("un comprobante sin sucursal NO se suma a ninguna sucursal real", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 1000 }),
      crudo({ id: 2, sucursal: null, total: 500 }),
    ]);
    const sinSuc = r.sucursales.find((s) => s.etiqueta === SIN_SUCURSAL);
    expect(sinSuc?.facturado_por_moneda["UYU"]).toBe(500);
    expect(sinSuc?.id).toBeNull();
    expect(r.sucursales.find((s) => s.id === "6")!.facturado_por_moneda["UYU"]).toBe(1000);
    expect(r.warnings.some((w) => w.includes("no traen sucursal"))).toBe(true);
  });

  it("cuenta clientes distintos, no comprobantes", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, cliente: { documento: "A" } }),
      crudo({ id: 2, sucursal: 6, cliente: { documento: "A" } }),
      crudo({ id: 3, sucursal: 6, cliente: { documento: "B" } }),
    ]);
    expect(r.sucursales[0]!.clientes_distintos).toBe(2);
    expect(r.sucursales[0]!.comprobantes).toBe(3);
  });

  it("usa el nombre configurado cuando existe", () => {
    const r = ranking([crudo({ sucursal: 6 })], null, { nombres: { "6": "Pocitos" } });
    expect(r.sucursales[0]!.etiqueta).toBe("Sucursal 6 (Pocitos)");
    expect(r.sucursales[0]!.nombre).toBe("Pocitos");
  });
});

describe("evolución", () => {
  it("una sucursal puede facturar MÁS y pesar MENOS", () => {
    // 6 crece 20% (1000 -> 1200) pero 7 se triplica: la participación de 6 cae.
    const r = ranking(
      [crudo({ id: 1, sucursal: 6, total: 1200 }), crudo({ id: 2, sucursal: 7, total: 3000 })],
      [crudo({ id: 3, sucursal: 6, total: 1000 }), crudo({ id: 4, sucursal: 7, total: 1000 })],
    );
    const seis = r.sucursales.find((s) => s.id === "6")!;
    expect(seis.variacion_pct).toBe(20);
    expect(seis.participacion_anterior_pct).toBe(50);
    expect(seis.salto_participacion_pp).toBeLessThan(0);
    expect(seis.lectura).toContain("subió 20%");
    expect(seis.lectura).toContain("perdió");
  });

  it("marca como relevante solo el movimiento que supera el umbral", () => {
    const r = ranking(
      [crudo({ id: 1, sucursal: 6, total: 900 }), crudo({ id: 2, sucursal: 7, total: 100 })],
      [crudo({ id: 3, sucursal: 6, total: 500 }), crudo({ id: 4, sucursal: 7, total: 500 })],
      { salto_pp: 10 },
    );
    // 6 pasó de 50% a 90%: 40 puntos, muy por encima del umbral.
    expect(r.movimientos_relevantes.length).toBe(2);

    const chico = ranking(
      [crudo({ id: 1, sucursal: 6, total: 510 }), crudo({ id: 2, sucursal: 7, total: 490 })],
      [crudo({ id: 3, sucursal: 6, total: 500 }), crudo({ id: 4, sucursal: 7, total: 500 })],
      { salto_pp: 10 },
    );
    expect(chico.movimientos_relevantes).toEqual([]);
  });

  it("una sucursal nueva no tiene variación porcentual infinita", () => {
    const r = ranking(
      [crudo({ id: 1, sucursal: 6, total: 1000 }), crudo({ id: 2, sucursal: 9, total: 500 })],
      [crudo({ id: 3, sucursal: 6, total: 1000 })],
    );
    const nueva = r.sucursales.find((s) => s.id === "9")!;
    expect(nueva.facturado_anterior).toBe(0);
    expect(nueva.variacion_pct).toBeNull();
  });

  it("una sucursal que dejó de facturar NO desaparece del ranking", () => {
    const r = ranking(
      [crudo({ id: 1, sucursal: 6, total: 1000 })],
      [crudo({ id: 2, sucursal: 6, total: 800 }), crudo({ id: 3, sucursal: 7, total: 600 })],
    );
    const muerta = r.sucursales.find((s) => s.id === "7");
    expect(muerta).toBeDefined();
    expect(muerta!.variacion_pct).toBe(-100);
    expect(muerta!.facturado_anterior).toBe(600);
    expect(r.warnings.some((w) => w.includes("NADA en este"))).toBe(true);
  });

  it("sin período previo no inventa evolución y lo dice", () => {
    const r = ranking([crudo({ sucursal: 6 })]);
    expect(r.con_comparacion).toBe(false);
    expect(r.sucursales[0]!.variacion_pct).toBeNull();
    expect(r.sucursales[0]!.salto_participacion_pp).toBeNull();
    expect(r.warnings.some((w) => w.includes("Sin período de comparación"))).toBe(true);
  });
});

describe("monedas", () => {
  it("no las mezcla y ordena por la de mayor facturación", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 100, moneda: "USD" }),
      crudo({ id: 2, sucursal: 7, total: 5000, moneda: "UYU" }),
    ]);
    expect(r.moneda_orden).toBe("UYU");
    expect(r.monedas_presentes).toEqual(["USD", "UYU"]);
    // La sucursal 6 no facturó nada en UYU: participación 0, sin convertir.
    const seis = r.sucursales.find((s) => s.id === "6")!;
    expect(seis.participacion_pct).toBe(0);
    expect(seis.facturado_por_moneda["USD"]).toBe(100);
    expect(r.warnings.some((w) => w.includes("SIN convertir"))).toBe(true);
  });
});

describe("estados DGI", () => {
  it("por defecto cuenta solo los aceptados", () => {
    const r = ranking([
      crudo({ id: 1, sucursal: 6, total: 1000 }),
      crudo({ id: 2, sucursal: 6, total: 500, estado: "Rechazado DGI" }),
    ]);
    expect(r.sucursales[0]!.facturado_por_moneda["UYU"]).toBe(1000);
  });

  // El título dice la condición a propósito: con el default (solo_aceptados
  // true) un estado desconocido NO se cuenta. Ver tests/estadoDgi.test.ts.
  it("con solo_aceptados=false un estado desconocido se cuenta, y se avisa", () => {
    const r = ranking([crudo({ id: 1, sucursal: 6, total: 1000, estado: null })], null, {
      solo_aceptados: false,
    });
    expect(r.sucursales[0]!.facturado_por_moneda["UYU"]).toBe(1000);
    expect(r.warnings.some((w) => w.includes("sin estado DGI reconocible"))).toBe(true);
  });
});
