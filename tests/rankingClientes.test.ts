// =============================================================================
// Ranking de clientes: las reglas que hacen que los números signifiquen algo.
// =============================================================================

import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { SIN_RECEPTOR, rankingClientes } from "../src/services/rankingClientes.js";

/** Arma un comprobante emitido crudo con lo mínimo que el ranking necesita. */
function crudo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tipo_comprobante: 111, // e-Factura (venta)
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15 10:00:00",
    cliente: { documento: "210000000011", razon_social: "ACME SA" },
    ...over,
  };
}

function ranking(crudos: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) {
  return rankingClientes(normalizeComprobantesEmitidos(crudos), {
    desde: "2026-06-01",
    hasta: "2026-06-30",
    ...opts,
  } as Parameters<typeof rankingClientes>[1]);
}

describe("agregación por cliente", () => {
  it("suma la facturación de un mismo cliente", () => {
    const r = ranking([crudo({ id: 1, total: 1000 }), crudo({ id: 2, total: 500 })]);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(1500);
    expect(r.clientes[0]!.comprobantes).toBe(2);
    expect(r.clientes[0]!.nombre).toBe("ACME SA");
  });

  it("ordena de mayor a menor facturación", () => {
    const r = ranking([
      crudo({ id: 1, total: 100, cliente: { documento: "A" } }),
      crudo({ id: 2, total: 900, cliente: { documento: "B" } }),
      crudo({ id: 3, total: 500, cliente: { documento: "C" } }),
    ]);
    expect(r.clientes.map((c) => c.rut)).toEqual(["B", "C", "A"]);
  });

  it("respeta el límite", () => {
    const crudos = Array.from({ length: 10 }, (_, i) =>
      crudo({ id: i, total: (i + 1) * 100, cliente: { documento: `RUT${i}` } }),
    );
    expect(ranking(crudos, { limite: 3 }).clientes).toHaveLength(3);
    // `clientes_totales` sigue informando el universo completo.
    expect(ranking(crudos, { limite: 3 }).clientes_totales).toBe(10);
  });
});

describe("reglas de negocio que definen si el número sirve", () => {
  it("las notas de crédito RESTAN de la facturación del cliente", () => {
    const r = ranking([
      crudo({ id: 1, tipo_comprobante: 111, total: 1000 }),
      crudo({ id: 2, tipo_comprobante: 112, total: 900 }), // NC de e-Factura
    ]);
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(100);
    expect(r.clientes[0]!.cantidad_notas_credito).toBe(1);
    expect(r.clientes[0]!.notas_credito_por_moneda["UYU"]).toBe(900);
  });

  it("los recibos NO cuentan como facturación", () => {
    const r = ranking([
      crudo({ id: 1, total: 1000 }),
      crudo({ id: 2, total: 1000, indicador_cobranza_propia: 1 }),
    ]);
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(1000);
    expect(r.comprobantes_analizados).toBe(1);
  });

  it("los eRemito/eResguardo no suman", () => {
    const r = ranking([crudo({ id: 1, total: 1000 }), crudo({ id: 2, tipo_comprobante: 181, total: 5000 })]);
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(1000);
  });

  it("por defecto excluye los comprobantes no aceptados por DGI", () => {
    const r = ranking([
      crudo({ id: 1, total: 1000 }),
      crudo({ id: 2, total: 9999, estado: "Rechazado DGI" }),
    ]);
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(1000);
  });

  it("con solo_aceptados=false cuenta todos los estados", () => {
    const r = ranking(
      [crudo({ id: 1, total: 1000 }), crudo({ id: 2, total: 500, estado: "Rechazado DGI" })],
      { solo_aceptados: false },
    );
    expect(r.clientes[0]!.facturado_por_moneda["UYU"]).toBe(1500);
  });

  it("NO convierte monedas: cada una va por separado", () => {
    const r = ranking([
      crudo({ id: 1, total: 1000, moneda: "UYU" }),
      crudo({ id: 2, total: 100, moneda: "USD" }),
    ]);
    const c = r.clientes[0]!;
    expect(c.facturado_por_moneda).toEqual({ UYU: 1000, USD: 100 });
    expect(r.warnings.some((w) => w.includes("SIN convertir"))).toBe(true);
  });

  it("ordena por la moneda de mayor facturación si no se especifica", () => {
    const r = ranking([
      crudo({ id: 1, total: 50, moneda: "USD", cliente: { documento: "A" } }),
      crudo({ id: 2, total: 9000, moneda: "UYU", cliente: { documento: "B" } }),
    ]);
    expect(r.moneda_orden).toBe("UYU");
    expect(r.clientes[0]!.rut).toBe("B");
  });
});

describe("nuevos y dormidos", () => {
  it('sin mirar hacia atrás, "es nuevo" es null y NO true', () => {
    // Este test decía `toBe(true)` y era el bug, no la especificación.
    //
    // La regla vieja —`primera_compra >= desde`— se evalúa sobre una lista YA
    // filtrada al período, donde por construcción no hay ninguna compra
    // anterior a `desde`. O sea que era verdadera SIEMPRE: todos los clientes
    // salían nuevos, y "ganaste N clientes nuevos" era el conteo de clientes.
    //
    // Para afirmar "nunca antes" hay que MIRAR antes. Sin eso, null.
    const r = ranking([crudo({ fecha_emision: "2026-06-10 10:00:00" })], {
      desde: "2026-06-01",
      hasta: "2026-06-30",
    });
    expect(r.clientes[0]!.es_nuevo).toBeNull();
    expect(r.nuevos).toBe(0);
  });

  it("con los RUTs previos, distingue al nuevo del de siempre", () => {
    const r = ranking(
      [
        crudo({ fecha_emision: "2026-06-10 10:00:00", cliente: { rut: "210000000011" } }),
        crudo({ fecha_emision: "2026-06-11 10:00:00", cliente: { rut: "210000000022" } }),
      ],
      {
        desde: "2026-06-01",
        hasta: "2026-06-30",
        ruts_previos: new Set(["210000000011"]), // este ya compraba antes
      },
    );
    const porRut = Object.fromEntries(r.clientes.map((c) => [c.rut, c.es_nuevo]));
    expect(porRut["210000000011"]).toBe(false);
    expect(porRut["210000000022"]).toBe(true);
    expect(r.nuevos).toBe(1);
  });

  it('"(sin receptor)" no es nuevo ni viejo: es null', () => {
    // Junta ventas de mostrador de personas distintas, así que la pregunta no
    // tiene respuesta para ese grupo.
    const r = ranking([crudo({ fecha_emision: "2026-06-10 10:00:00", cliente: null })], {
      desde: "2026-06-01",
      hasta: "2026-06-30",
      ruts_previos: new Set<string>(),
    });
    expect(r.clientes[0]!.es_nuevo).toBeNull();
  });

  it("los días sin comprar se miden contra el FIN DEL PERÍODO, no contra hoy", () => {
    // Período histórico cerrado: si midiera contra hoy, todos estarían dormidos.
    const r = ranking([crudo({ fecha_emision: "2026-06-20 10:00:00" })], {
      desde: "2026-06-01",
      hasta: "2026-06-30",
      dias_dormido: 90,
    });
    expect(r.clientes[0]!.dias_desde_ultima_compra).toBe(10);
    expect(r.clientes[0]!.esta_dormido).toBe(false);
  });

  it("marca dormido al que superó el umbral dentro del período", () => {
    const r = ranking([crudo({ fecha_emision: "2026-01-05 10:00:00" })], {
      desde: "2026-01-01",
      hasta: "2026-06-30",
      dias_dormido: 90,
    });
    expect(r.clientes[0]!.esta_dormido).toBe(true);
    expect(r.dormidos).toBe(1);
  });
});

describe("concentración de ingresos", () => {
  it("un cliente único da HHI 10000 y lectura de riesgo", () => {
    const r = ranking([crudo({ total: 1000 })]);
    expect(r.concentracion!.hhi).toBe(10_000);
    expect(r.concentracion!.top_1_pct).toBe(100);
    expect(r.concentracion!.interpretacion).toContain("MUY concentrada");
  });

  it("diez clientes iguales dan HHI 1000 y lectura de cartera diversificada", () => {
    const crudos = Array.from({ length: 10 }, (_, i) =>
      crudo({ id: i, total: 100, cliente: { documento: `RUT${i}` } }),
    );
    const r = ranking(crudos);
    expect(r.concentracion!.hhi).toBe(1000);
    expect(r.concentracion!.interpretacion).toContain("diversificada");
    expect(r.concentracion!.clientes_hasta_50_pct).toBe(5);
  });

  it("el grupo sin receptor NO infla la concentración", () => {
    // Sin la exclusión, "(sin receptor)" pesaría 90% y daría cartera concentrada
    // por un cliente que no existe: son ventas de mostrador de gente distinta.
    const r = ranking([
      crudo({ id: 1, total: 9000, cliente: null }),
      crudo({ id: 2, total: 500, cliente: { documento: "A" } }),
      crudo({ id: 3, total: 500, cliente: { documento: "B" } }),
    ]);
    expect(r.concentracion!.clientes_totales).toBe(2);
    expect(r.concentracion!.top_1_pct).toBe(50);
    expect(r.warnings.some((w) => w.includes(SIN_RECEPTOR))).toBe(true);
  });

  it("sin clientes identificados no hay concentración (null, no cero)", () => {
    const r = ranking([crudo({ cliente: null })]);
    expect(r.concentracion).toBeNull();
  });
});

describe("bordes", () => {
  it("una lista vacía no rompe", () => {
    const r = ranking([]);
    expect(r.clientes).toEqual([]);
    expect(r.concentracion).toBeNull();
    expect(r.clientes_totales).toBe(0);
  });

  it("avisa de los comprobantes sin fecha utilizable", () => {
    const r = ranking([crudo({ fecha_emision: null })]);
    expect(r.clientes[0]!.dias_desde_ultima_compra).toBeNull();
    expect(r.clientes[0]!.es_nuevo).toBeNull();
    expect(r.warnings.some((w) => w.includes("sin fecha de emisión"))).toBe(true);
  });

  it("el ticket promedio se calcula sobre la moneda de orden", () => {
    const r = ranking([crudo({ id: 1, total: 1000 }), crudo({ id: 2, total: 500 })]);
    expect(r.clientes[0]!.ticket_promedio).toBe(750);
  });
});

// =============================================================================
// A9 — Frecuencia de compra: cada cuánto compra cada cliente y cuándo se atrasó
// contra SU PROPIO ritmo (que llega antes que el corte absoluto de "dormido").
// =============================================================================

describe("frecuencia de compra", () => {
  /** Ranking sobre un semestre, para que entren varias compras espaciadas. */
  function semestre(crudos: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) {
    return rankingClientes(normalizeComprobantesEmitidos(crudos), {
      desde: "2026-01-01",
      hasta: "2026-06-30",
      ...opts,
    } as Parameters<typeof rankingClientes>[1]);
  }

  it("promedia los intervalos entre días distintos de compra", () => {
    // 1/6, 11/6, 21/6 -> dos intervalos de 10 días.
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-06-01" }),
      crudo({ id: 2, fecha_emision: "2026-06-11" }),
      crudo({ id: 3, fecha_emision: "2026-06-21" }),
    ]);
    expect(r.clientes[0]!.dias_con_compra).toBe(3);
    expect(r.clientes[0]!.dias_entre_compras_promedio).toBe(10);
  });

  it("tres facturas del mismo día son UNA visita, no tres", () => {
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-06-01" }),
      crudo({ id: 2, fecha_emision: "2026-06-01" }),
      crudo({ id: 3, fecha_emision: "2026-06-01" }),
    ]);
    expect(r.clientes[0]!.comprobantes).toBe(3);
    expect(r.clientes[0]!.dias_con_compra).toBe(1);
    expect(r.clientes[0]!.dias_entre_compras_promedio).toBeNull();
  });

  it("con menos de tres días de compra no estima un ritmo", () => {
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-06-01" }),
      crudo({ id: 2, fecha_emision: "2026-06-02" }),
    ]);
    // Un solo intervalo daría "compra cada 1 día" y lo marcaría atrasado el jueves.
    expect(r.clientes[0]!.dias_entre_compras_promedio).toBeNull();
    expect(r.clientes[0]!.atrasado_vs_su_frecuencia).toBe(false);
  });

  it("una nota de crédito no cuenta como visita", () => {
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-06-01" }),
      crudo({ id: 2, fecha_emision: "2026-06-11" }),
      crudo({ id: 3, fecha_emision: "2026-06-15", tipo_comprobante: 112, total: 200 }),
    ]);
    expect(r.clientes[0]!.dias_con_compra).toBe(2);
  });

  it("marca atrasado al cliente semanal que hace un mes que no aparece", () => {
    // Compra cada 7 días hasta el 1/6; el período cierra el 30/6 -> 29 días.
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-05-18" }),
      crudo({ id: 2, fecha_emision: "2026-05-25" }),
      crudo({ id: 3, fecha_emision: "2026-06-01" }),
    ]);
    const c = r.clientes[0]!;
    expect(c.dias_entre_compras_promedio).toBe(7);
    expect(c.dias_desde_ultima_compra).toBe(29);
    expect(c.atrasado_vs_su_frecuencia).toBe(true);
    // Y todavía NO está dormido: eso es exactamente el punto.
    expect(c.esta_dormido).toBe(false);
    expect(r.atrasados_vs_su_frecuencia).toBe(1);
    expect(r.warnings.some((w) => w.includes("su propio intervalo") || w.includes("SU PROPIO"))).toBe(true);
  });

  it("no marca atrasado al cliente que compra cada varios meses", () => {
    // Compra cada ~60 días; 29 días sin comprar es su ritmo normal.
    const r = semestre([
      crudo({ id: 1, fecha_emision: "2026-02-01" }),
      crudo({ id: 2, fecha_emision: "2026-04-02" }),
      crudo({ id: 3, fecha_emision: "2026-06-01" }),
    ]);
    expect(r.clientes[0]!.atrasado_vs_su_frecuencia).toBe(false);
  });

  it("el grupo sin receptor no tiene ritmo de compra", () => {
    const r = semestre([
      crudo({ id: 1, cliente: null, fecha_emision: "2026-06-01" }),
      crudo({ id: 2, cliente: null, fecha_emision: "2026-06-11" }),
      crudo({ id: 3, cliente: null, fecha_emision: "2026-06-21" }),
    ]);
    const anon = r.clientes.find((c) => c.rut === null)!;
    expect(anon.dias_con_compra).toBe(0);
    expect(anon.dias_entre_compras_promedio).toBeNull();
    expect(anon.atrasado_vs_su_frecuencia).toBe(false);
  });
});


describe("ticket promedio y monedas mezcladas", () => {
  it("el divisor son los comprobantes DE LA MONEDA de orden, no todos", () => {
    // Una factura de $1.000 y una de U$S 500 daban ticket $500: el monto en
    // pesos dividido por DOS comprobantes. La mitad del ticket real, sin que
    // nada falle ni avise.
    const r = ranking(
      [
        crudo({ fecha_emision: "2026-06-10 10:00:00", total: 1000, moneda: "UYU" }),
        crudo({ fecha_emision: "2026-06-11 10:00:00", total: 500, moneda: "USD" }),
      ],
      { desde: "2026-06-01", hasta: "2026-06-30", moneda: "UYU" },
    );
    expect(r.clientes[0]!.ticket_promedio).toBe(1000);
  });

  it("un cliente que solo compró en otra moneda tiene ticket null, no cero", () => {
    const r = ranking(
      [
        crudo({ fecha_emision: "2026-06-10 10:00:00", total: 1000, moneda: "UYU" }),
        crudo({
          fecha_emision: "2026-06-11 10:00:00",
          total: 500,
          moneda: "USD",
          cliente: { rut: "210000000099" },
        }),
      ],
      { desde: "2026-06-01", hasta: "2026-06-30", moneda: "UYU" },
    );
    const soloUsd = r.clientes.find((c) => c.rut === "210000000099");
    expect(soloUsd?.ticket_promedio).toBeNull();
  });
});
