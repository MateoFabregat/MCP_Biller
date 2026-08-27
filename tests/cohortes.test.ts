// =============================================================================
// A10 — Cohortes de clientes.
//
// El test que más importa es el de la contaminación: la primera cohorte SIEMPRE
// mezcla altas reales con clientes preexistentes, porque el "alta" es la primera
// compra dentro del rango. Si eso no queda marcado, el número miente hacia
// arriba y nadie tiene forma de saberlo.
// =============================================================================

import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { calcularCohortes, mesesEntre, offsetMeses } from "../src/services/cohortes.js";

function crudo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tipo_comprobante: 111,
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: "2026-01-15 10:00:00",
    cliente: { documento: "A", razon_social: "ACME SA" },
    ...over,
  };
}

function cohortes(crudos: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) {
  return calcularCohortes(
    normalizeComprobantesEmitidos(crudos),
    { desde: "2026-01-01", hasta: "2026-04-30" },
    opts as Parameters<typeof calcularCohortes>[2],
  );
}

describe("helpers de meses", () => {
  it("cuenta el offset cruzando el año", () => {
    expect(offsetMeses("2025-11", "2026-02")).toBe(3);
    expect(offsetMeses("2026-03", "2026-03")).toBe(0);
  });

  it("enumera los meses del rango, inclusive", () => {
    expect(mesesEntre("2025-11-05", "2026-02-28")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("armado de cohortes", () => {
  it("agrupa por el mes de la primera compra", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-01-10" }),
      crudo({ id: 2, cliente: { documento: "B" }, fecha_emision: "2026-02-10" }),
      crudo({ id: 3, cliente: { documento: "A" }, fecha_emision: "2026-03-10" }),
    ]);
    expect(r.cohortes.map((c) => c.mes_alta)).toEqual(["2026-01", "2026-02"]);
    expect(r.cohortes[0]!.clientes).toBe(1);
    expect(r.cohortes[1]!.clientes).toBe(1);
  });

  it("mide la retención sobre el tamaño original de la cohorte", () => {
    const r = cohortes([
      // Dos clientes entran en febrero; solo uno vuelve en marzo.
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-02-05" }),
      crudo({ id: 2, cliente: { documento: "B" }, fecha_emision: "2026-02-06" }),
      crudo({ id: 3, cliente: { documento: "A" }, fecha_emision: "2026-03-05" }),
    ]);
    const feb = r.cohortes.find((c) => c.mes_alta === "2026-02")!;
    expect(feb.clientes).toBe(2);
    expect(feb.meses[0]!.retencion_pct).toBe(100); // mes 0
    expect(feb.meses[1]!.offset).toBe(1);
    expect(feb.meses[1]!.clientes_activos).toBe(1);
    expect(feb.meses[1]!.retencion_pct).toBe(50);
  });

  it("acumula la facturación de la cohorte y su valor por cliente", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-02-05", total: 1000 }),
      crudo({ id: 2, cliente: { documento: "B" }, fecha_emision: "2026-02-06", total: 500 }),
      crudo({ id: 3, cliente: { documento: "A" }, fecha_emision: "2026-03-05", total: 300 }),
    ]);
    const feb = r.cohortes.find((c) => c.mes_alta === "2026-02")!;
    expect(feb.facturado_total).toBe(1800);
    expect(feb.valor_por_cliente).toBe(900);
  });

  it("las notas de crédito restan de la cohorte", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-02-05", total: 1000 }),
      crudo({
        id: 2,
        cliente: { documento: "A" },
        fecha_emision: "2026-02-20",
        tipo_comprobante: 112,
        total: 400,
      }),
    ]);
    expect(r.cohortes[0]!.facturado_total).toBe(600);
  });
});

describe("la contaminación del primer mes", () => {
  it("marca la primera cohorte y la deja fuera de la curva promedio", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "VIEJO" }, fecha_emision: "2026-01-10" }),
      crudo({ id: 2, cliente: { documento: "VIEJO" }, fecha_emision: "2026-02-10" }),
      crudo({ id: 3, cliente: { documento: "NUEVO" }, fecha_emision: "2026-02-10" }),
    ]);
    const ene = r.cohortes.find((c) => c.mes_alta === "2026-01")!;
    const feb = r.cohortes.find((c) => c.mes_alta === "2026-02")!;
    expect(ene.posible_contaminada).toBe(true);
    expect(feb.posible_contaminada).toBe(false);

    // La cohorte de enero retiene 100% al mes siguiente; la de febrero, 0%.
    // Si enero entrara al promedio, la curva diría 50% en vez de 0%.
    const offset1 = r.retencion_promedio.find((p) => p.offset === 1);
    expect(offset1?.cohortes).toBe(1);
    expect(offset1?.retencion_pct).toBe(0);
  });

  it("respeta meses_de_gracia y lo reporta", () => {
    const r = cohortes(
      [
        crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-01-10" }),
        crudo({ id: 2, cliente: { documento: "B" }, fecha_emision: "2026-02-10" }),
        crudo({ id: 3, cliente: { documento: "C" }, fecha_emision: "2026-03-10" }),
      ],
      { meses_de_gracia: 2 },
    );
    expect(r.meses_de_gracia).toBe(2);
    expect(r.cohortes.filter((c) => c.posible_contaminada).map((c) => c.mes_alta)).toEqual([
      "2026-01",
      "2026-02",
    ]);
    expect(r.warnings.some((w) => w.includes("posible_contaminada"))).toBe(true);
  });

  it("con meses_de_gracia=0 no marca ninguna", () => {
    const r = cohortes([crudo({ id: 1, cliente: { documento: "A" } })], { meses_de_gracia: 0 });
    expect(r.meses_de_gracia).toBe(0);
    expect(r.cohortes[0]!.posible_contaminada).toBe(false);
  });
});

describe("exclusiones", () => {
  it("las ventas sin receptor no forman cohorte", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: [] }),
      crudo({ id: 2, cliente: { documento: "A" } }),
    ]);
    expect(r.clientes_totales).toBe(1);
    expect(r.warnings.some((w) => w.includes("sin receptor"))).toBe(true);
  });

  it("los recibos no cuentan como compra", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-02-10" }),
      crudo({
        id: 2,
        cliente: { documento: "A" },
        fecha_emision: "2026-03-10",
        indicador_cobranza_propia: 1,
      }),
    ]);
    const feb = r.cohortes.find((c) => c.mes_alta === "2026-02")!;
    // Pagar en marzo no es volver a comprar en marzo.
    expect(feb.meses[1]!.clientes_activos).toBe(0);
  });

  it("por defecto solo cuenta los aceptados por DGI", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" } }),
      crudo({ id: 2, cliente: { documento: "B" }, estado: "Rechazado DGI" }),
    ]);
    expect(r.clientes_totales).toBe(1);
  });
});

describe("monedas", () => {
  it("la retención cuenta al cliente aunque haya facturado en otra moneda", () => {
    const r = cohortes([
      crudo({ id: 1, cliente: { documento: "A" }, fecha_emision: "2026-02-05", total: 5000 }),
      crudo({
        id: 2,
        cliente: { documento: "A" },
        fecha_emision: "2026-03-05",
        moneda: "USD",
        total: 100,
      }),
    ]);
    const feb = r.cohortes[0]!;
    expect(r.moneda_orden).toBe("UYU");
    expect(feb.meses[1]!.clientes_activos).toBe(1); // volvió: eso es retención
    expect(feb.meses[1]!.facturado).toBe(0); // pero el importe no se convierte
    expect(r.warnings.some((w) => w.includes("SOLO de UYU"))).toBe(true);
  });
});

describe("rangos cortos", () => {
  it("avisa cuando el rango no da para una curva", () => {
    const r = calcularCohortes(
      normalizeComprobantesEmitidos([crudo({ fecha_emision: "2026-01-15" })]),
      { desde: "2026-01-01", hasta: "2026-01-31" },
    );
    expect(r.warnings.some((w) => w.includes("con menos de tres"))).toBe(true);
    expect(r.lectura).toContain("No hay cohortes limpias");
  });
});
