// =============================================================================
// Posición de IVA: la aritmética y, sobre todo, los caveats.
//
// El riesgo de esta funcionalidad no es equivocarse en la suma: es que alguien
// confunda la estimación con una declaración jurada. Varios de estos tests
// fijan justamente eso.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  normalizeComprobantesEmitidos,
  normalizeComprobantesRecibidos,
} from "../src/biller/normalize.js";
import { LIMITACIONES_IVA, calcularPosicionIva } from "../src/services/posicionIva.js";

function emitido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tipo_comprobante: 111,
    moneda: "UYU",
    total: 1220,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15 10:00:00",
    tot_iva_tasa_bas: 220,
    ...over,
  };
}

function recibido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo: 111,
    serie: "A",
    numero: 1,
    estado: "Aceptado",
    fecha: "2026-06-10",
    rut_emisor: "210000000011",
    moneda: "UYU",
    total_neto: 500,
    total_iva: 110,
    monto_total: 610,
    total_retenido: 0,
    ...over,
  };
}

function calcular(
  emitidos: Array<Record<string, unknown>>,
  recibidos: Array<Record<string, unknown>> = [],
  opts = {},
) {
  return calcularPosicionIva(
    normalizeComprobantesEmitidos(emitidos),
    normalizeComprobantesRecibidos(recibidos),
    opts,
  );
}

describe("aritmética de la posición", () => {
  it("débito menos crédito", () => {
    const r = calcular([emitido({ tot_iva_tasa_bas: 220 })], [recibido({ total_iva: 110 })]);
    const uyu = r.por_moneda[0]!;
    expect(uyu.debito.total).toBe(220);
    expect(uyu.credito).toBe(110);
    expect(uyu.posicion).toBe(110);
    expect(r.lectura).toContain("A PAGAR");
  });

  it("suma las tres tasas por separado y en el total", () => {
    const r = calcular([
      emitido({ tot_iva_tasa_min: 50, tot_iva_tasa_bas: 220, tot_iva_tasa_otra: 30 }),
    ]);
    const d = r.por_moneda[0]!.debito;
    expect(d).toMatchObject({ tasa_minima: 50, tasa_basica: 220, tasa_otra: 30, total: 300 });
  });

  it("crédito mayor que débito da posición negativa y lectura de crédito a favor", () => {
    const r = calcular([emitido({ tot_iva_tasa_bas: 100 })], [recibido({ total_iva: 400 })]);
    expect(r.por_moneda[0]!.posicion).toBe(-300);
    expect(r.lectura).toContain("CRÉDITO FISCAL");
  });

  it("una nota de crédito RESTA IVA débito", () => {
    const r = calcular([
      emitido({ id: 1, tipo_comprobante: 111, tot_iva_tasa_bas: 220 }),
      emitido({ id: 2, tipo_comprobante: 112, tot_iva_tasa_bas: 220 }),
    ]);
    expect(r.por_moneda[0]!.debito.total).toBe(0);
  });

  it("una nota de crédito recibida RESTA IVA crédito", () => {
    const r = calcular(
      [emitido({ tot_iva_tasa_bas: 220 })],
      [recibido({ tipo: 111, total_iva: 110 }), recibido({ tipo: 112, numero: 2, total_iva: 40 })],
    );
    expect(r.por_moneda[0]!.credito).toBe(70);
    expect(r.por_moneda[0]!.posicion).toBe(150);
  });

  it("no invierte dos veces una NC recibida que ya trae IVA negativo", () => {
    const r = calcular([], [recibido({ tipo: 112, total_iva: -40 })]);
    expect(r.por_moneda[0]!.credito).toBe(-40);
  });

  it("los recibos no generan IVA débito", () => {
    const r = calcular([
      emitido({ id: 1, tot_iva_tasa_bas: 220 }),
      emitido({ id: 2, tot_iva_tasa_bas: 220, indicador_cobranza_propia: 1 }),
    ]);
    expect(r.por_moneda[0]!.debito.total).toBe(220);
    expect(r.emitidos_analizados).toBe(1);
  });
});

describe("estados DGI", () => {
  it("por defecto los emitidos no aceptados no generan débito", () => {
    const r = calcular([
      emitido({ id: 1, tot_iva_tasa_bas: 220 }),
      emitido({ id: 2, tot_iva_tasa_bas: 999, estado: "Rechazado DGI" }),
    ]);
    expect(r.por_moneda[0]!.debito.total).toBe(220);
  });

  it("'Envío no corresponde' genera débito porque no es un rechazo", () => {
    const r = calcular([emitido({ estado: "Envío no corresponde", tot_iva_tasa_bas: 220 })]);
    expect(r.por_moneda[0]!.debito.total).toBe(220);
  });

  it("un recibido rechazado no da crédito fiscal", () => {
    const r = calcular(
      [emitido()],
      [recibido({ total_iva: 110 }), recibido({ numero: 2, total_iva: 999, estado: "Rechazado DGI" })],
    );
    expect(r.por_moneda[0]!.credito).toBe(110);
  });
});

describe("monedas", () => {
  it("NO convierte: cada moneda tiene su propia posición", () => {
    const r = calcular(
      [emitido({ id: 1, moneda: "UYU", tot_iva_tasa_bas: 220 }), emitido({ id: 2, moneda: "USD", tot_iva_tasa_bas: 22 })],
      [recibido({ moneda: "UYU", total_iva: 100 })],
    );
    expect(r.por_moneda).toHaveLength(2);
    const uyu = r.por_moneda.find((m) => m.moneda === "UYU")!;
    const usd = r.por_moneda.find((m) => m.moneda === "USD")!;
    expect(uyu.posicion).toBe(120);
    expect(usd.posicion).toBe(22);
    expect(r.warnings.some((w) => w.includes("NO se convirtieron"))).toBe(true);
  });
});

describe("retenciones", () => {
  it("se informan aparte y NO se descuentan de la posición", () => {
    const r = calcular(
      [emitido({ tot_iva_tasa_bas: 220 })],
      [recibido({ total_iva: 0, total_retenido: 500 })],
    );
    expect(r.por_moneda[0]!.retenciones_sufridas).toBe(500);
    expect(r.por_moneda[0]!.posicion).toBe(220);
  });
});

describe("caveats: lo que evita que esto se confunda con una declaración", () => {
  it("siempre se marca como estimación", () => {
    expect(calcular([emitido()]).es_estimacion).toBe(true);
  });

  it("las limitaciones viajan en la respuesta, no solo en la documentación", () => {
    const r = calcular([emitido()]);
    expect(r.limitaciones).toBe(LIMITACIONES_IVA);
    expect(r.limitaciones.some((l) => l.includes("NO es una declaración jurada"))).toBe(true);
    expect(r.limitaciones.some((l) => l.includes("prorrata"))).toBe(true);
  });

  it("la lectura remite al contador cuando da a pagar", () => {
    expect(calcular([emitido()], [recibido({ total_iva: 0 })]).lectura).toContain("contador");
  });

  it("avisa fuerte si no hay compras: el número NO es la posición", () => {
    const r = calcular([emitido()], []);
    expect(r.warnings.some((w) => w.includes("SIN crédito fiscal"))).toBe(true);
  });

  it("avisa de emitidos sin IVA en ninguna tasa", () => {
    const r = calcular([emitido({ tot_iva_tasa_bas: 0 })]);
    expect(r.warnings.some((w) => w.includes("no informan IVA"))).toBe(true);
  });
});

describe("bordes", () => {
  it("sin comprobantes lo dice explícitamente", () => {
    const r = calcular([], []);
    expect(r.por_moneda).toEqual([]);
    expect(r.moneda_principal).toBeNull();
    expect(r.lectura).toContain("No hay comprobantes");
  });

  it("un recibido sin moneda queda fuera y se avisa", () => {
    const r = calcular([emitido()], [recibido({ moneda: null })]);
    expect(r.recibidos_analizados).toBe(0);
    expect(r.warnings.some((w) => w.includes("sin moneda"))).toBe(true);
  });

  it("la moneda principal es la de mayor posición absoluta", () => {
    const r = calcular([
      emitido({ id: 1, moneda: "USD", tot_iva_tasa_bas: 10 }),
      emitido({ id: 2, moneda: "UYU", tot_iva_tasa_bas: 5000 }),
    ]);
    expect(r.moneda_principal).toBe("UYU");
  });
});
