// =============================================================================
// Cálculo local de totales de un CFE (preview de emisión).
// =============================================================================

import { describe, expect, it } from "vitest";
import { ComprobanteBodySchema } from "../src/biller/cfeSchema.js";
import { calcularTotales, formatearTotales } from "../src/services/calcularTotales.js";

const parse = (input: Record<string, unknown>) => ComprobanteBodySchema.parse(input);

const BASE = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
};

describe("calcularTotales", () => {
  it("suma IVA a la tasa básica cuando montos_brutos es falso", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        montos_brutos: 0,
        items: [{ cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 }],
      }),
    );
    expect(t.subtotal).toBe(200);
    expect(t.total_iva).toBe(44); // 200 * 22%
    expect(t.total).toBe(244);
    expect(t.iva_por_tasa["22"]).toBe(44);
    expect(t.exacto).toBe(true);
  });

  it("desagrega el IVA hacia atrás cuando montos_brutos es verdadero", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        montos_brutos: 1,
        items: [{ cantidad: 1, concepto: "Pelota", precio: 244, indicador_facturacion: 3 }],
      }),
    );
    expect(t.total).toBe(244); // el precio ya incluía IVA
    expect(t.subtotal).toBe(200);
    expect(t.total_iva).toBe(44);
    expect(t.supuestos.some((s) => /montos_brutos/.test(s))).toBe(true);
  });

  it("aplica la tasa mínima (10%) al indicador 2", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 2 }] }),
    );
    expect(t.total_iva).toBe(10);
    expect(t.total).toBe(110);
  });

  it("no cobra IVA sobre ítems exentos", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 1 }] }),
    );
    expect(t.total_iva).toBe(0);
    expect(t.total).toBe(100);
  });

  it("multiplica por cantidad", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 3, concepto: "X", precio: 100, indicador_facturacion: 1 }] }),
    );
    expect(t.total).toBe(300);
  });

  it("aplica descuentos y recargos de ítem", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          // 1000 - 100 = 900
          { cantidad: 1, concepto: "A", precio: 1000, indicador_facturacion: 1, descuento_tipo: "$", descuento_cantidad: 100 },
          // 2*100 = 200 + 10% = 220
          { cantidad: 2, concepto: "B", precio: 100, indicador_facturacion: 1, recargo_tipo: "%", recargo_cantidad: 10 },
        ],
      }),
    );
    expect(t.subtotal).toBe(1120);
  });

  it("aplica descuentos globales sobre los ítems del mismo indicador", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [{ cantidad: 1, concepto: "X", precio: 1000, indicador_facturacion: 1 }],
        descuentosRecargos: [
          { es_recargo: false, desc_rec_tipo: "%", glosa: "Promo", valor: 10, indicador_facturacion: 1 },
        ],
      }),
    );
    expect(t.ajustes_globales).toBe(-100);
    expect(t.subtotal).toBe(900);
  });

  it("marca el total como inexacto ante una tasa que no puede determinar", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 4 }] }),
    );
    expect(t.exacto).toBe(false);
    expect(t.advertencias.some((a) => /no se puede\s+determinar/.test(a))).toBe(true);
  });

  it("excluye del total los ítems no facturables", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          { cantidad: 1, concepto: "Vendido", precio: 100, indicador_facturacion: 1 },
          { cantidad: 1, concepto: "No facturable", precio: 999, indicador_facturacion: 6 },
        ],
      }),
    );
    expect(t.total).toBe(100);
    expect(t.lineas.find((l) => l.concepto === "No facturable")!.aporta_al_total).toBe(false);
  });

  it("calcula las retenciones aparte, sin sumarlas al total", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          {
            cantidad: 1,
            concepto: "X",
            precio: 100,
            indicador_facturacion: 1,
            indicador_agente_responsable: "A",
            retencionesPercepciones: [{ codigo: 1145143, tasa: 10, monto_sujeto: 400 }],
          },
        ],
      }),
    );
    expect(t.total_retenciones_percepciones).toBe(40); // 10% de 400
    expect(t.total).toBe(100); // no se suma
  });

  it("formatea una línea legible para la confirmación", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 200, indicador_facturacion: 3 }] }),
    );
    const texto = formatearTotales(t);
    expect(texto).toContain("244");
    expect(texto).toContain("UYU");
  });
});
