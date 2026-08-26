// =============================================================================
// Ranking de productos: agregación pura + el N+1 acotado de la tool.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { BillerGetOptions } from "../src/biller/client.js";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import {
  SIN_IDENTIFICAR,
  UMBRAL_DISPERSION_PCT,
  rankingProductos,
} from "../src/services/rankingProductos.js";
import { handleRankingProductos } from "../src/tools/rankingProductos.js";
import { makeCtx } from "./helpers.js";

/** Arma un comprobante emitido crudo CON items, lo mínimo que el ranking necesita. */
function crudo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tipo_comprobante: 111, // e-Factura (venta)
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15 10:00:00",
    cliente: { documento: "210000000011", razon_social: "ACME SA" },
    items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }],
    ...over,
  };
}

function ranking(crudos: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) {
  return rankingProductos(
    normalizeComprobantesEmitidos(crudos),
    opts as Parameters<typeof rankingProductos>[1],
  );
}

describe("agregación por producto", () => {
  it("agrupa por código cuando el ítem lo trae", () => {
    const r = ranking([
      crudo({ id: 1, items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 5, precio: 100 }] }),
      crudo({ id: 2, items: [{ codigo: "P1", concepto: "Otro nombre igual", cantidad: 5, precio: 100 }] }),
    ]);
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0]!.unidades).toBe(10);
    expect(r.productos[0]!.comprobantes).toBe(2);
  });

  it("agrupa por concepto normalizado cuando no hay código", () => {
    const r = ranking([
      crudo({ id: 1, items: [{ codigo: null, concepto: "  Tornillo   Phillips ", cantidad: 5, precio: 10 }] }),
      crudo({ id: 2, items: [{ codigo: null, concepto: "tornillo phillips", cantidad: 5, precio: 10 }] }),
    ]);
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0]!.unidades).toBe(10);
  });

  it("agrupa bajo SIN_IDENTIFICAR cuando no hay código ni concepto", () => {
    const r = ranking([
      crudo({ id: 1, items: [{ codigo: null, concepto: null, cantidad: 5, precio: 10 }] }),
    ]);
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0]!.codigo).toBeNull();
    expect(r.productos[0]!.concepto).toBeNull();
    expect(r.warnings.some((w) => w.includes(SIN_IDENTIFICAR))).toBe(true);
  });

  it("clientes_distintos cuenta RUTs distintos", () => {
    const r = ranking([
      crudo({ id: 1, cliente: { documento: "A" } }),
      crudo({ id: 2, cliente: { documento: "B" } }),
      crudo({ id: 3, cliente: { documento: "A" } }),
    ]);
    expect(r.productos[0]!.clientes_distintos).toBe(2);
  });

  it("respeta el límite mostrando el total en productos_totales", () => {
    const crudos = Array.from({ length: 5 }, (_, i) =>
      crudo({
        id: i,
        items: [{ codigo: `P${i}`, concepto: `Producto ${i}`, cantidad: 1, precio: (i + 1) * 100 }],
      }),
    );
    const r = ranking(crudos, { limite: 2 });
    expect(r.productos).toHaveLength(2);
    expect(r.productos_totales).toBe(5);
  });
});

describe("reglas de negocio que definen si el número sirve", () => {
  it("las notas de crédito RESTAN unidades e importe (10 vendidas, 3 devueltas = 7 netas)", () => {
    const r = ranking([
      crudo({
        id: 1,
        tipo_comprobante: 111, // venta
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }],
      }),
      crudo({
        id: 2,
        tipo_comprobante: 112, // NC de e-Factura
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 3, precio: 100 }],
      }),
    ]);
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0]!.unidades).toBe(7);
    expect(r.productos[0]!.importe_por_moneda["UYU"]).toBe(700);
  });

  it("los recibos y eRemitos no aportan al ranking de productos", () => {
    const r = ranking([
      crudo({ id: 1, items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }] }),
      crudo({
        id: 2,
        indicador_cobranza_propia: 1,
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 999, precio: 100 }],
      }),
      crudo({
        id: 3,
        tipo_comprobante: 181, // eRemito
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 999, precio: 100 }],
      }),
    ]);
    expect(r.productos[0]!.unidades).toBe(10);
  });

  it("por defecto excluye comprobantes no aceptados por DGI", () => {
    const r = ranking([
      crudo({ id: 1, items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }] }),
      crudo({
        id: 2,
        estado: "Rechazado DGI",
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 999, precio: 100 }],
      }),
    ]);
    expect(r.productos[0]!.unidades).toBe(10);
  });

  it("un comprobante sin 'items' se ignora y se avisa, sin romper el resto", () => {
    const conItems = crudo({ id: 1 });
    const sinItems = crudo({ id: 2 });
    delete (sinItems as Record<string, unknown>).items;

    const r = rankingProductos(normalizeComprobantesEmitidos([conItems, sinItems]));
    expect(r.comprobantes_analizados).toBe(1);
    expect(r.warnings.some((w) => w.includes("no traían 'items'"))).toBe(true);
  });
});

describe("dispersión de precios", () => {
  it("detecta al cliente que compra más barato el mismo producto", () => {
    const r = ranking([
      crudo({
        id: 1,
        cliente: { documento: "CARO", razon_social: "Cliente Caro" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }],
      }),
      crudo({
        id: 2,
        cliente: { documento: "BARATO", razon_social: "Cliente Barato" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 80 }],
      }),
    ]);
    const p = r.productos[0]!;
    expect(p.precio_unitario_min).toBe(80);
    expect(p.precio_unitario_max).toBe(100);
    expect(p.dispersion_pct).toBe(25); // (100-80)/80*100
    expect(p.dispersion_alta).toBe(true); // 25 >= UMBRAL_DISPERSION_PCT (20)
    // El cliente más barato aparece primero.
    expect(p.clientes_precio[0]!.rut).toBe("BARATO");
    expect(p.clientes_precio[0]!.precio_unitario_promedio).toBe(80);
    expect(p.clientes_precio[1]!.rut).toBe("CARO");
  });

  it("con poca variación NO marca dispersion_alta", () => {
    const r = ranking([
      crudo({
        id: 1,
        cliente: { documento: "A" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }],
      }),
      crudo({
        id: 2,
        cliente: { documento: "B" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 105 }],
      }),
    ]);
    const p = r.productos[0]!;
    expect(p.dispersion_pct).toBe(5);
    expect(p.dispersion_alta).toBe(false);
  });

  it("las notas de crédito no distorsionan la dispersión de precio", () => {
    const r = ranking([
      crudo({
        id: 1,
        tipo_comprobante: 111,
        cliente: { documento: "A" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 10, precio: 100 }],
      }),
      crudo({
        id: 2,
        tipo_comprobante: 112, // NC: no debería tocar min/max/dispersión
        cliente: { documento: "A" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 3, precio: 1 }],
      }),
    ]);
    const p = r.productos[0]!;
    expect(p.precio_unitario_min).toBe(100);
    expect(p.precio_unitario_max).toBe(100);
    expect(p.dispersion_pct).toBe(0);
  });
});

describe("promedio ponderado por cantidad", () => {
  it("difiere del promedio simple cuando las cantidades no son iguales", () => {
    const r = ranking([
      crudo({
        id: 1,
        cliente: { documento: "A" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 1, precio: 100 }],
      }),
      crudo({
        id: 2,
        cliente: { documento: "B" },
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 9, precio: 200 }],
      }),
    ]);
    const p = r.productos[0]!;
    const promedioSimple = (100 + 200) / 2; // 150
    const promedioPonderado = (1 * 100 + 9 * 200) / (1 + 9); // 190
    expect(p.precio_unitario_promedio_ponderado).toBe(promedioPonderado);
    expect(p.precio_unitario_promedio_ponderado).not.toBe(promedioSimple);
  });
});

describe("multimoneda", () => {
  it("no suma UYU con USD", () => {
    const r = ranking([
      crudo({
        id: 1,
        moneda: "UYU",
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 5, precio: 100 }],
      }),
      crudo({
        id: 2,
        moneda: "USD",
        items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 5, precio: 10 }],
      }),
    ]);
    const p = r.productos[0]!;
    expect(p.importe_por_moneda).toEqual({ UYU: 500, USD: 50 });
    expect(r.monedas_presentes).toEqual(["USD", "UYU"]);
    expect(r.warnings.some((w) => w.includes("SIN convertir"))).toBe(true);
  });

  it("ordena por la moneda de mayor importe si no se especifica", () => {
    const r = ranking([
      crudo({
        id: 1,
        moneda: "USD",
        items: [{ codigo: "BARATO", concepto: "Producto barato", cantidad: 1, precio: 50 }],
      }),
      crudo({
        id: 2,
        moneda: "UYU",
        items: [{ codigo: "CARO", concepto: "Producto caro", cantidad: 1, precio: 9000 }],
      }),
    ]);
    expect(r.moneda_orden).toBe("UYU");
    expect(r.productos[0]!.codigo).toBe("CARO");
  });
});

describe("bordes", () => {
  it("una lista vacía no rompe", () => {
    const r = ranking([]);
    expect(r.productos).toEqual([]);
    expect(r.productos_totales).toBe(0);
    expect(r.comprobantes_analizados).toBe(0);
  });

  it("declara siempre el warning de metodología de agrupación y de márgenes", () => {
    const r = ranking([crudo()]);
    expect(r.warnings.some((w) => w.includes("se agrupa por"))).toBe(true);
    expect(r.warnings.some((w) => w.toLowerCase().includes("margen"))).toBe(true);
  });
});

// =============================================================================
// Tool: biller_ranking_productos — el N+1 acotado.
// =============================================================================

describe("tool biller_ranking_productos", () => {
  /** Comprobante "de listado" (sin items), como devuelve la consulta por período. */
  function listado(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      tipo_comprobante: 111,
      moneda: "UYU",
      total: 1000,
      estado: "Aceptado DGI",
      fecha_emision: "2026-06-02",
      cliente: { documento: "210000000011", razon_social: "ACME SA" },
      ...over,
    };
  }

  /** Mismo comprobante pero con el detalle ('items') que solo trae la consulta por id. */
  function detalle(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...listado(over),
      items: [{ codigo: "P1", concepto: "Producto Uno", cantidad: 1, precio: over.total ?? 1000 }],
    };
  }

  function implPorId(
    porPeriodo: unknown[],
    detallesPorId: Record<string, unknown>,
    fallarIds: string[] = [],
  ) {
    return (o: BillerGetOptions) => {
      const id = o.query?.id as string | undefined;
      if (id === undefined) return porPeriodo;
      if (fallarIds.includes(id)) throw new Error("falla simulada de red");
      const d = detallesPorId[id];
      return d ? [d] : [];
    };
  }

  it("declara la cobertura cuando trunca por max_comprobantes", async () => {
    const porPeriodo = [
      listado({ id: 1, total: 1000 }),
      listado({ id: 2, total: 800 }),
      listado({ id: 3, total: 500 }),
      listado({ id: 4, total: 300 }),
      listado({ id: 5, total: 200 }),
    ];
    const detallesPorId: Record<string, unknown> = {
      "1": detalle({ id: 1, total: 1000 }),
      "2": detalle({ id: 2, total: 800 }),
    };

    const { ctx } = makeCtx({ impl: implPorId(porPeriodo, detallesPorId) });
    const res = await handleRankingProductos(
      {
        desde: "2026-06-01",
        hasta: "2026-06-05",
        max_comprobantes: 2,
        ventana_dias: 30,
      },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const cobertura = res.structuredContent!.cobertura as {
      comprobantes_del_periodo: number;
      comprobantes_analizados: number;
      cobertura_importe_pct: number | null;
    };
    expect(cobertura.comprobantes_del_periodo).toBe(5);
    expect(cobertura.comprobantes_analizados).toBe(2);
    // (1000 + 800) / (1000+800+500+300+200) * 100 = 64.29 (redondeado)
    expect(cobertura.cobertura_importe_pct).toBe(64.29);
    expect(
      (res.structuredContent!.warnings as string[]).some(
        (w) => w.includes("max_comprobantes") && w.includes("Cobertura"),
      ),
    ).toBe(true);
  });

  it("un comprobante cuyo detalle falla no rompe el ranking", async () => {
    const porPeriodo = [listado({ id: 1, total: 1000 }), listado({ id: 2, total: 500 })];
    const detallesPorId: Record<string, unknown> = {
      "1": detalle({ id: 1, total: 1000 }),
      // id 2 falla: no está en detallesPorId Y además tira error.
    };

    const { ctx } = makeCtx({ impl: implPorId(porPeriodo, detallesPorId, ["2"]) });
    const res = await handleRankingProductos(
      { desde: "2026-06-01", hasta: "2026-06-05", ventana_dias: 30 },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const productos = res.structuredContent!.productos as Array<{ codigo: string | null }>;
    expect(productos).toHaveLength(1);
    expect(productos[0]!.codigo).toBe("P1");
    expect(
      (res.structuredContent!.warnings as string[]).some((w) => w.includes("no se pudieron consultar por 'id'")),
    ).toBe(true);
  });
});
