import { describe, expect, it } from "vitest";
import { ComprobanteBodySchema } from "../src/biller/cfeSchema.js";
import { calcularTotales } from "../src/services/calcularTotales.js";
import {
  NOTA_CREDITO_DE,
  NOTA_DEBITO_DE,
  planAnulacion,
  type ComprobanteAAnular,
} from "../src/services/anulacion.js";
import { handleRequisitosComprobante } from "../src/tools/requisitosComprobante.js";
import { makeCtx } from "./helpers.js";

const FACTURA: ComprobanteAAnular = {
  id: 388294,
  tipo_comprobante: 111,
  serie: "MF",
  numero: 559251,
  moneda: "UYU",
  total: 14640, // 12.000 + 22% de IVA
  fecha_emision: "2026-07-28",
  estado: "Aceptado DGI",
};

describe("planAnulacion — qué emitir para deshacer qué", () => {
  it("una venta se anula con su nota de crédito", () => {
    const p = planAnulacion(FACTURA);
    expect(p.accion).toBe("nota_credito");
    expect(p.tipo_a_emitir).toBe(112);
    expect(p.usa_endpoint_anular).toBe(true); // e-Factura sin NC previa
  });

  it("una nota de crédito se revierte con una nota de débito, y el original revive", () => {
    const p = planAnulacion({ ...FACTURA, tipo_comprobante: 112 });
    expect(p.accion).toBe("nota_debito_reversion");
    expect(p.tipo_a_emitir).toBe(113);
    expect(p.efecto).toMatch(/vuelve a tener validez/);
  });

  it("si ya hay una nota de crédito, avisa que otra acreditaría dos veces", () => {
    const p = planAnulacion(FACTURA, { ya_tiene_nota_credito: true });
    expect(p.usa_endpoint_anular).toBe(false);
    expect(p.advertencias.join(" ")).toMatch(/dos veces/);
    expect(p.advertencias.join(" ")).toMatch(/NOTA DE DÉBITO/);
  });

  it("un remito no se anula con nota de crédito y lo dice", () => {
    const p = planAnulacion({ ...FACTURA, tipo_comprobante: 181 });
    expect(p.accion).toBe("no_aplica");
    expect(p.advertencias.join(" ")).toMatch(/remito de ajuste/i);
  });

  it("avisa si el comprobante nunca fue aceptado por DGI", () => {
    const p = planAnulacion({ ...FACTURA, estado: "Pendiente DGI" });
    expect(p.advertencias.join(" ")).toMatch(/no tiene efecto fiscal/);
  });

  it("los mapas de tipos son consistentes: toda venta anulable se puede revertir", () => {
    for (const [venta, nc] of Object.entries(NOTA_CREDITO_DE)) {
      expect(NOTA_DEBITO_DE[nc], `falta la ND de la NC ${nc} (venta ${venta})`).toBeDefined();
    }
  });
});

// Este es el bug más caro que encontró el review: el cuerpo que la tool sugiere
// se copia y se emite tal cual. Si le falta `montos_brutos`, Biller interpreta
// el precio como neto y le suma el IVA otra vez.
describe("cuerpo sugerido de la nota — NO puede acreditar de más", () => {
  const cuerpoDe = (c: ComprobanteAAnular): Record<string, unknown> => {
    const p = planAnulacion(c, { ya_tiene_nota_credito: true }); // fuerza el cuerpo manual
    expect(p.cuerpo_sugerido).not.toBeNull();
    return p.cuerpo_sugerido!;
  };

  it("la nota de crédito totaliza EXACTAMENTE el total del original", () => {
    const cuerpo = cuerpoDe(FACTURA);
    const totales = calcularTotales(ComprobanteBodySchema.parse(cuerpo));
    expect(totales.total).toBe(14640); // no 17.860,80 (= 14.640 × 1,22)
  });

  it("declara montos_brutos: el total de un CFE ya trae el IVA adentro", () => {
    expect(cuerpoDe(FACTURA).montos_brutos).toBe(true);
  });

  it("el importe va POSITIVO: el signo lo da el tipo de comprobante", () => {
    const items = cuerpoDe({ ...FACTURA, total: -500 }).items as Array<{ precio: number }>;
    expect(items[0]!.precio).toBe(500);
  });

  it("referencia por id cuando lo hay, y por la terna cuando no", () => {
    expect(cuerpoDe(FACTURA).referencias).toEqual([388294]);
    expect(cuerpoDe({ ...FACTURA, id: null }).referencias).toEqual([
      { tipo: 111, serie: "MF", numero: 559251 },
    ]);
  });
});

// El umbral de DGI está en Unidades Indexadas, que son PESOS. Leer un importe en
// dólares como si fueran pesos contesta "el receptor es opcional" sobre un
// comprobante que sí lo necesita.
describe("umbral de 5.000 UI con moneda extranjera", () => {
  const UI = 6.3; // 5.000 UI = $31.500

  it("USD 1.000 sin cotización NO se declara por debajo del umbral", () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const res = handleRequisitosComprobante(
      { tipo_comprobante: 101, total_estimado: 1000, datos_conocidos: { moneda: "USD" } },
      ctx,
    );
    const sc = res.structuredContent!;
    expect((sc.advertencias as string[]).join(" ")).toMatch(/NO se pudo verificar el umbral/);
  });

  it("USD 1.000 CON cotización sí supera el umbral y exige receptor", () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const res = handleRequisitosComprobante(
      {
        tipo_comprobante: 101,
        total_estimado: 1000,
        tasa_cambio: 40,
        datos_conocidos: { moneda: "USD" },
      },
      ctx,
    );
    const faltantes = res.structuredContent!.faltantes as Array<{ campo: string }>;
    expect(faltantes.map((f) => f.campo)).toContain("cliente");
  });

  it("en pesos sigue funcionando igual que antes", () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const bajo = handleRequisitosComprobante({ tipo_comprobante: 101, total_estimado: 1000 }, ctx);
    const alto = handleRequisitosComprobante({ tipo_comprobante: 101, total_estimado: 40000 }, ctx);
    const campos = (r: typeof bajo) =>
      (r.structuredContent!.faltantes as Array<{ campo: string }>).map((f) => f.campo);
    expect(campos(bajo)).not.toContain("cliente");
    expect(campos(alto)).toContain("cliente");
  });
});
