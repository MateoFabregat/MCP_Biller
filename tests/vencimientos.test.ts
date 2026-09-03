import { describe, expect, it } from "vitest";
import { normalizeComprobanteEmitido } from "../src/biller/normalize.js";
import type { ComprobanteEmitido } from "../src/biller/types.js";
import {
  analizarVencimientos,
  clasificarBucket,
  diasEntre,
  esVencido,
} from "../src/services/vencimientos.js";
import { handleVencimientos } from "../src/tools/vencimientos.js";
import { makeCtx } from "./helpers.js";

const HOY = new Date("2026-07-27T12:00:00Z");

/** Desplazamiento en días respecto de HOY, en aaaa-mm-dd. */
function dia(offset: number): string {
  return new Date(HOY.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

interface FacturaRaw {
  id?: number;
  tipo?: number;
  /** Vencimiento como offset en días respecto de HOY. null = sin fecha. */
  venceEn?: number | null;
  /** Emisión como días hacia atrás desde HOY. Default: 30 días antes del vencimiento. */
  emitidaHace?: number;
  total?: number;
  moneda?: string;
  estado?: string;
  cliente?: unknown;
  /** 1 = el comprobante es un recibo de cobranza, no una venta. */
  cobranza?: number;
}

function factura(raw: FacturaRaw = {}): ComprobanteEmitido {
  const venceEn = raw.venceEn === undefined ? -10 : raw.venceEn;
  const emision =
    raw.emitidaHace !== undefined ? dia(-raw.emitidaHace) : dia((venceEn ?? 0) - 30);
  return normalizeComprobanteEmitido({
    id: raw.id ?? 1,
    tipo_comprobante: raw.tipo ?? 111,
    serie: "A",
    numero: 100,
    moneda: raw.moneda ?? "UYU",
    total: raw.total ?? 1000,
    estado: raw.estado ?? "Aceptado DGI",
    fecha_emision: emision,
    fecha_vencimiento: venceEn === null ? null : dia(venceEn),
    indicador_cobranza_propia: raw.cobranza ?? 0,
    cliente: raw.cliente ?? { documento: "217832560011", razon_social: "Proveedor SA" },
  });
}

describe("diasEntre / clasificarBucket", () => {
  it("cuenta días calendario en UTC sin que lo corra el huso horario", () => {
    expect(diasEntre("2026-07-27", "2026-08-03")).toBe(7);
    expect(diasEntre("2026-08-03", "2026-07-27")).toBe(-7);
    expect(diasEntre("2026-07-27", "2026-07-27")).toBe(0);
  });

  it("clasifica los bordes de cada tramo", () => {
    expect(clasificarBucket(-91)).toBe("vencida_mas_90");
    expect(clasificarBucket(-90)).toBe("vencida_61_90");
    expect(clasificarBucket(-61)).toBe("vencida_61_90");
    expect(clasificarBucket(-60)).toBe("vencida_31_60");
    expect(clasificarBucket(-31)).toBe("vencida_31_60");
    expect(clasificarBucket(-30)).toBe("vencida_1_30");
    expect(clasificarBucket(-1)).toBe("vencida_1_30");
    expect(clasificarBucket(0)).toBe("vence_hoy");
    expect(clasificarBucket(7)).toBe("vence_en_7");
    expect(clasificarBucket(8)).toBe("vence_en_30");
    expect(clasificarBucket(31)).toBe("vence_despues");
  });

  it("esVencido solo es true para los tramos pasados", () => {
    expect(esVencido("vencida_1_30")).toBe(true);
    expect(esVencido("vence_hoy")).toBe(false);
  });
});

describe("analizarVencimientos", () => {
  it("separa lo vencido de lo por vencer y lo suma por moneda", () => {
    const res = analizarVencimientos(
      [
        factura({ id: 1, venceEn: -45, total: 1000 }),
        factura({ id: 2, venceEn: 3, total: 500 }),
        factura({ id: 3, venceEn: 2, total: 200, moneda: "USD" }),
      ],
      { hoy: HOY, horizonte_dias: 7 },
    );

    expect(res.conteo_incluidos).toBe(3);
    expect(res.vencido_por_moneda.UYU).toEqual({ total: 1000, comprobantes: 1 });
    expect(res.por_vencer_por_moneda.UYU).toEqual({ total: 500, comprobantes: 1 });
    expect(res.por_vencer_por_moneda.USD).toEqual({ total: 200, comprobantes: 1 });
    // No se convierte moneda: USD y UYU quedan en buckets separados.
    expect(res.totales_por_moneda.USD?.total).toBe(200);
  });

  it("ordena las facturas de la más vencida a la más lejana", () => {
    const res = analizarVencimientos(
      [
        factura({ id: 1, venceEn: 5 }),
        factura({ id: 2, venceEn: -100 }),
        factura({ id: 3, venceEn: -2 }),
      ],
      { hoy: HOY, horizonte_dias: 7 },
    );
    expect(res.facturas.map((f) => f.id)).toEqual([2, 3, 1]);
    expect(res.facturas[0]!.bucket).toBe("vencida_mas_90");
  });

  it("descarta el contado con la heurística vencimiento == emisión", () => {
    const res = analizarVencimientos(
      [factura({ id: 1, emitidaHace: 5, venceEn: -5 })],
      { hoy: HOY, horizonte_dias: 7 },
    );
    expect(res.conteo_incluidos).toBe(0);
    expect(res.excluidos.contado).toBe(1);
    expect(res.warnings.some((w) => w.includes("CONTADO"))).toBe(true);
  });

  it("con solo_a_credito=false incluye el contado", () => {
    const res = analizarVencimientos(
      [factura({ id: 1, emitidaHace: 5, venceEn: -5 })],
      { hoy: HOY, horizonte_dias: 7, solo_a_credito: false },
    );
    expect(res.conteo_incluidos).toBe(1);
  });

  it("no lista notas de crédito como cobrables", () => {
    const res = analizarVencimientos([factura({ id: 1, tipo: 112, venceEn: -3 })], {
      hoy: HOY,
      horizonte_dias: 7,
    });
    expect(res.conteo_incluidos).toBe(0);
    expect(res.excluidos.no_cobrable).toBe(1);
  });

  it("incluye notas de débito, que sí generan cobro", () => {
    const res = analizarVencimientos([factura({ id: 1, tipo: 113, venceEn: -3 })], {
      hoy: HOY,
      horizonte_dias: 7,
    });
    expect(res.conteo_incluidos).toBe(1);
  });

  it("excluye lo no aceptado por DGI salvo que se pida lo contrario", () => {
    const comprobantes = [factura({ id: 1, estado: "Rechazado DGI", venceEn: -3 })];
    expect(analizarVencimientos(comprobantes, { hoy: HOY, horizonte_dias: 7 }).excluidos
      .no_aceptados).toBe(1);
    expect(
      analizarVencimientos(comprobantes, { hoy: HOY, horizonte_dias: 7, solo_aceptados: false })
        .conteo_incluidos,
    ).toBe(1);
  });

  it("respeta el horizonte hacia adelante", () => {
    const res = analizarVencimientos([factura({ id: 1, venceEn: 20 })], {
      hoy: HOY,
      horizonte_dias: 7,
    });
    expect(res.conteo_incluidos).toBe(0);
    expect(res.excluidos.fuera_de_rango).toBe(1);
  });

  it("con incluir_vencidas=false deja solo lo que todavía no venció", () => {
    const res = analizarVencimientos(
      [factura({ id: 1, venceEn: -3 }), factura({ id: 2, venceEn: 3 })],
      { hoy: HOY, horizonte_dias: 7, incluir_vencidas: false },
    );
    expect(res.facturas.map((f) => f.id)).toEqual([2]);
  });

  it("agrupa por cliente con el atraso máximo y el nombre legible", () => {
    const cliente = { documento: "217832560011", razon_social: "Carbonell SA" };
    const res = analizarVencimientos(
      [
        factura({ id: 1, venceEn: -50, total: 1000, cliente }),
        factura({ id: 2, venceEn: -10, total: 300, cliente }),
        factura({ id: 3, venceEn: -5, total: 100, cliente: { documento: "111", nombre: "Otro" } }),
      ],
      { hoy: HOY, horizonte_dias: 7 },
    );

    const primero = res.por_cliente[0]!;
    expect(primero.cliente_rut).toBe("217832560011");
    expect(primero.cliente_nombre).toBe("Carbonell SA");
    expect(primero.vencido_por_moneda.UYU).toEqual({ total: 1300, comprobantes: 2 });
    expect(primero.dias_atraso_maximo).toBe(50);
    // Ordenado por monto vencido: el de 100 va después.
    expect(res.por_cliente[1]!.cliente_rut).toBe("111");
  });

  it("avisa SIEMPRE que las cobranzas no están imputadas", () => {
    const res = analizarVencimientos([factura({ id: 1 })], { hoy: HOY, horizonte_dias: 7 });
    expect(res.warnings.some((w) => w.includes("SIN IMPUTAR COBRANZAS"))).toBe(true);
  });

  // Un recibo se emite como e-Ticket/e-Factura: por tipo es indistinguible de
  // una venta. Si se cuela, el listado reclama plata que ya se cobró.
  it("NO lista un recibo como pendiente de cobro", () => {
    const res = analizarVencimientos(
      [factura({ id: 1, total: 1000 }), factura({ id: 2, total: 400, cobranza: 1 })],
      { hoy: HOY, horizonte_dias: 7 },
    );
    expect(res.facturas.map((f) => f.id)).toEqual([1]);
    expect(res.totales_por_moneda.UYU).toEqual({ total: 1000, comprobantes: 1 });
  });

  it("avisa cuando hay recibos en la ventana, porque el monto mostrado sobra", () => {
    const res = analizarVencimientos([factura({ id: 2, total: 400, cobranza: 1 })], {
      hoy: HOY,
      horizonte_dias: 7,
    });
    expect(res.warnings.some((w) => w.includes("1 recibo(s) de cobranza"))).toBe(true);
  });

  it("cuenta los comprobantes sin fecha de vencimiento en vez de descartarlos en silencio", () => {
    const res = analizarVencimientos([factura({ id: 1, venceEn: null })], {
      hoy: HOY,
      horizonte_dias: 7,
    });
    expect(res.excluidos.sin_fecha_vencimiento).toBe(1);
    expect(res.warnings.some((w) => w.includes("fecha_vencimiento"))).toBe(true);
  });
});

describe("tool biller_vencimientos", () => {
  it("devuelve el aging y marca cobranzas_imputadas=false", async () => {
    const hoyReal = new Date(); // fecha-uy:allow el fixture genera fechas relativas al reloj real
    const diaReal = (offset: number): string =>
      new Date(hoyReal.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

    const { ctx } = makeCtx({
      response: [
        {
          id: 1,
          tipo_comprobante: 111,
          serie: "A",
          numero: 10,
          moneda: "UYU",
          total: 1500,
          estado: "Aceptado DGI",
          fecha_emision: diaReal(-3),
          fecha_vencimiento: diaReal(2),
          cliente: { documento: "217832560011", razon_social: "Carbonell SA" },
        },
      ],
    });

    const res = await handleVencimientos({ dias_atras: 7, horizonte_dias: 7 }, ctx);
    const out = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeUndefined();
    expect(out.cobranzas_imputadas).toBe(false);
    expect(out.por_vencer_por_moneda).toEqual({ UYU: { total: 1500, comprobantes: 1 } });
    expect((out.facturas as unknown[]).length).toBe(1);
    expect((out.warnings as string[]).some((w) => w.includes("SIN IMPUTAR COBRANZAS"))).toBe(true);
  });

  it("rechaza un horizonte fuera de rango", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handleVencimientos({ horizonte_dias: 5000 }, ctx);
    expect(res.isError).toBe(true);
  });
});
