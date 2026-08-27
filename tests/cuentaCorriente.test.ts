import { describe, expect, it } from "vitest";
import { normalizeComprobanteEmitido } from "../src/biller/normalize.js";
import type { ComprobanteEmitido } from "../src/biller/types.js";
import {
  calcularCuentaCorriente,
  referenciasDeCobranza,
  referenciasDesdeItems,
} from "../src/services/cuentaCorriente.js";

const HOY = new Date("2026-07-27T12:00:00Z");

function dia(offset: number): string {
  return new Date(HOY.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

interface Raw {
  id?: number;
  tipo?: number;
  total?: number;
  moneda?: string;
  /** Vencimiento como offset en días respecto de HOY. null = contado. */
  venceEn?: number | null;
  emitidaHace?: number;
  estado?: string;
  rut?: string;
  cobranza?: number;
  referencias?: unknown;
}

function cfe(raw: Raw = {}): ComprobanteEmitido {
  const venceEn = raw.venceEn === undefined ? 10 : raw.venceEn;
  return normalizeComprobanteEmitido({
    id: raw.id ?? 1,
    tipo_comprobante: raw.tipo ?? 111,
    serie: "A",
    numero: raw.id ?? 1,
    moneda: raw.moneda ?? "UYU",
    total: raw.total ?? 1000,
    estado: raw.estado ?? "Aceptado DGI",
    fecha_emision: dia(-(raw.emitidaHace ?? 30)),
    fecha_vencimiento: venceEn === null ? null : dia(venceEn),
    indicador_cobranza_propia: raw.cobranza ?? 0,
    cliente: { documento: raw.rut ?? "217832560011", razon_social: "Carbonell SA" },
    ...(raw.referencias === undefined ? {} : { referencias: raw.referencias }),
  });
}

/** Recibo: mismo CFE pero marcado como cobranza. Sin vencimiento propio. */
function recibo(raw: Raw = {}): ComprobanteEmitido {
  return cfe({ ...raw, cobranza: 1, venceEn: null });
}

const opts = { hoy: HOY };

describe("referenciasDeCobranza", () => {
  it("lee la forma documentada [{ padre, total }]", () => {
    const r = recibo({ referencias: [{ padre: 500, total: 400 }] });
    expect(referenciasDeCobranza(r)).toEqual([{ padre: 500, total: 400 }]);
  });

  it("lee la forma corta [id] y los alias id/monto", () => {
    expect(referenciasDeCobranza(recibo({ referencias: [500] }))).toEqual([
      { padre: 500, total: null },
    ]);
    expect(referenciasDeCobranza(recibo({ referencias: [{ id: 7, monto: "250.50" }] }))).toEqual([
      { padre: 7, total: 250.5 },
    ]);
  });

  it("devuelve null cuando no hay referencias legibles, para que el llamador use FIFO", () => {
    expect(referenciasDeCobranza(recibo())).toBeNull();
    expect(referenciasDeCobranza(recibo({ referencias: [] }))).toBeNull();
  });
});

// Estos casos salen de datos REALES del ambiente de test (ids 387215/387222,
// consultados el 2026-07-28): el GET del recibo por id no devuelve
// `referencias`, devuelve `items` y la imputación va en el concepto.
describe("referenciasDesdeItems — la imputación viaja en el concepto del ítem", () => {
  const reciboConItems = (items: Array<{ concepto: string; precio: number; cantidad?: number }>) =>
    normalizeComprobanteEmitido({
      id: 900,
      tipo_comprobante: 111,
      serie: "MF",
      numero: 557735,
      moneda: "UYU",
      total: items.reduce((t, i) => t + i.precio * (i.cantidad ?? 1), 0),
      estado: "Aceptado DGI",
      indicador_cobranza_propia: 1,
      fecha_emision: dia(-1),
      cliente: { documento: "217832560011" },
      items: items.map((i, n) => ({
        id: n,
        concepto: i.concepto,
        precio: i.precio,
        cantidad: i.cantidad ?? 1,
        indicador_facturacion: 6,
      })),
    });

  it("lee la forma real 'e-Factura D-1236497' con el importe del ítem", () => {
    const r = referenciasDesdeItems(
      reciboConItems([{ concepto: "e-Factura D-1236497", precio: 1500 }]),
    );
    expect(r).toEqual([
      { padre: null, total: 1500, serie: "D", numero: 1236497, origen_texto: "e-Factura D-1236497" },
    ]);
  });

  it("ignora el ítem 'Adelanto': no está imputado a ninguna factura", () => {
    const r = referenciasDesdeItems(
      reciboConItems([
        { concepto: "e-Factura D-1236497", precio: 1500 },
        { concepto: "Adelanto", precio: 15500 },
      ]),
    );
    expect(r).toHaveLength(1);
    expect(r![0]!.total).toBe(1500);
  });

  it("un recibo que es solo adelanto no produce referencias (cae a FIFO)", () => {
    expect(referenciasDesdeItems(reciboConItems([{ concepto: "Adelanto", precio: 20000 }]))).toBeNull();
  });

  // El patrón corre sobre texto libre: de más vale no imputar que imputar mal.
  it("no inventa referencias con conceptos que no tienen forma de comprobante", () => {
    expect(
      referenciasDesdeItems(reciboConItems([{ concepto: "Pago servicios varios", precio: 100 }])),
    ).toBeNull();
    expect(
      referenciasDesdeItems(reciboConItems([{ concepto: "Contrato 2024-2026 renovado", precio: 100 }])),
    ).toBeNull();
  });

  it("imputa a la factura correcta por serie+número, no la más vieja", () => {
    const vieja = normalizeComprobanteEmitido({
      id: 1, tipo_comprobante: 111, serie: "MF", numero: 100, moneda: "UYU", total: 5000,
      estado: "Aceptado DGI", fecha_emision: dia(-60), fecha_vencimiento: dia(-30),
      indicador_cobranza_propia: 0, cliente: { documento: "217832560011" },
    });
    const nueva = normalizeComprobanteEmitido({
      id: 2, tipo_comprobante: 111, serie: "MF", numero: 200, moneda: "UYU", total: 3000,
      estado: "Aceptado DGI", fecha_emision: dia(-5), fecha_vencimiento: dia(25),
      indicador_cobranza_propia: 0, cliente: { documento: "217832560011" },
    });
    const cobro = reciboConItems([{ concepto: "e-Factura MF-200", precio: 3000 }]);

    const r = calcularCuentaCorriente([vieja, nueva, cobro], opts);
    expect(r.estrategia).toBe("exacta");
    expect(r.cobranzas[0]!.origen).toBe("items_concepto");
    // FIFO habría cobrado la vieja: la referencia manda.
    expect(r.documentos.find((d) => d.id === 1)!.saldo).toBe(5000);
    expect(r.documentos.find((d) => d.id === 2)).toBeUndefined(); // cancelada
  });
});

describe("recibo con total negativo (cancelación de cobro)", () => {
  const reciboSimple = (id: number, total: number, concepto: string) =>
    normalizeComprobanteEmitido({
      id, tipo_comprobante: 111, serie: "MF", numero: id, moneda: "UYU", total,
      estado: "Aceptado DGI", indicador_cobranza_propia: 1, fecha_emision: dia(-3 + id / 1000),
      cliente: { documento: "217832560011" },
      items: [{ id: 1, concepto, precio: Math.abs(total), cantidad: 1 }],
    });

  it("el adelanto cancelado deja el saldo a favor en cero, no en negativo", () => {
    const r = calcularCuentaCorriente(
      [reciboSimple(1, 17000, "Adelanto"), reciboSimple(2, -17000, "Adelanto")],
      opts,
    );
    expect(r.saldo_a_favor_por_moneda.UYU ?? 0).toBe(0);
    expect(r.totales.cobrado_por_moneda.UYU).toBe(0);
    expect(r.cobranzas.find((c) => c.recibo_id === 2)!.es_reversion).toBe(true);
  });

  it("cancelar un cobro imputado REABRE el saldo de la factura", () => {
    const factura = normalizeComprobanteEmitido({
      id: 10, tipo_comprobante: 111, serie: "MF", numero: 10, moneda: "UYU", total: 1000,
      estado: "Aceptado DGI", fecha_emision: dia(-30), fecha_vencimiento: dia(-5),
      indicador_cobranza_propia: 0, cliente: { documento: "217832560011" },
    });
    const conCobro = calcularCuentaCorriente([factura, reciboSimple(11, 1000, "Pago")], opts);
    expect(conCobro.saldo_por_moneda.UYU).toBeUndefined();

    const conCancelacion = calcularCuentaCorriente(
      [factura, reciboSimple(11, 1000, "Pago"), reciboSimple(12, -1000, "Pago")],
      opts,
    );
    expect(conCancelacion.saldo_por_moneda.UYU).toEqual({ total: 1000, comprobantes: 1 });
    expect(conCancelacion.documentos.find((d) => d.id === 10)!.estado_cobro).toBe("pendiente");
  });

  it("avisa cuando la cancelación no encuentra el cobro original", () => {
    const r = calcularCuentaCorriente([reciboSimple(2, -5000, "Adelanto")], opts);
    expect(r.warnings.join(" ")).toMatch(/no se pudo revertir por completo/i);
  });
});

describe("calcularCuentaCorriente", () => {
  it("descuenta un recibo TOTAL: la factura queda cancelada y sin saldo", () => {
    const r = calcularCuentaCorriente([cfe({ id: 1, total: 1000 }), recibo({ id: 2, total: 1000 })], opts);

    expect(r.saldo_por_moneda).toEqual({});
    expect(r.documentos).toEqual([]); // canceladas no se listan por defecto
    expect(r.conteo.documentos_pendientes).toBe(0);
    expect(r.totales.cobrado_por_moneda.UYU).toBe(1000);
  });

  it("descuenta un recibo PARCIAL y deja el saldo restante", () => {
    const r = calcularCuentaCorriente([cfe({ id: 1, total: 1000 }), recibo({ id: 2, total: 400 })], opts);

    expect(r.documentos).toHaveLength(1);
    expect(r.documentos[0]!.total).toBe(1000);
    expect(r.documentos[0]!.cobrado).toBe(400);
    expect(r.documentos[0]!.saldo).toBe(600);
    expect(r.documentos[0]!.estado_cobro).toBe("parcial");
    expect(r.saldo_por_moneda.UYU).toEqual({ total: 600, comprobantes: 1 });
  });

  it("imputa por referencias cuando la API las devuelve, y lo declara", () => {
    const r = calcularCuentaCorriente(
      [
        cfe({ id: 1, total: 1000, venceEn: -20 }), // más vieja: FIFO la elegiría
        cfe({ id: 2, total: 800, venceEn: 5 }),
        recibo({ id: 3, total: 300, referencias: [{ padre: 2, total: 300 }] }),
      ],
      opts,
    );

    expect(r.estrategia).toBe("exacta");
    expect(r.imputacion_exacta).toBe(true);
    expect(r.cobranzas[0]!.origen).toBe("referencias");
    // El cobro fue a la 2 aunque la 1 sea más vieja.
    expect(r.documentos.find((d) => d.id === 1)!.saldo).toBe(1000);
    expect(r.documentos.find((d) => d.id === 2)!.saldo).toBe(500);
  });

  it("sin referencias imputa FIFO (lo más viejo primero) y avisa que es estimación", () => {
    const r = calcularCuentaCorriente(
      [
        cfe({ id: 1, total: 1000, venceEn: -20 }),
        cfe({ id: 2, total: 800, venceEn: 5 }),
        recibo({ id: 3, total: 1200 }),
      ],
      opts,
    );

    expect(r.estrategia).toBe("fifo");
    expect(r.imputacion_exacta).toBe(false);
    expect(r.documentos.find((d) => d.id === 1)).toBeUndefined(); // cancelada
    expect(r.documentos.find((d) => d.id === 2)!.saldo).toBe(600); // 800 - 200
    expect(r.warnings.some((w) => w.includes("IMPUTACIÓN ESTIMADA (FIFO)"))).toBe(true);
  });

  it("el excedente NO se fuerza contra otras facturas: va a saldo a favor", () => {
    const r = calcularCuentaCorriente([cfe({ id: 1, total: 500 }), recibo({ id: 2, total: 900 })], opts);

    expect(r.saldo_por_moneda).toEqual({});
    expect(r.saldo_a_favor_por_moneda.UYU).toBe(400);
    expect(r.cobranzas[0]!.imputado).toBe(500);
    expect(r.cobranzas[0]!.sin_imputar).toBe(400);
    expect(r.warnings.some((w) => w.includes("no se pudieron imputar"))).toBe(true);
  });

  it("una nota de crédito reduce la deuda igual que un cobro", () => {
    const r = calcularCuentaCorriente(
      [cfe({ id: 1, total: 1000 }), cfe({ id: 2, tipo: 112, total: 300, venceEn: -1 })],
      opts,
    );

    expect(r.saldo_por_moneda.UYU!.total).toBe(700);
    expect(r.conteo.notas_credito).toBe(1);
  });

  it("no cruza la deuda entre clientes ni entre monedas", () => {
    const r = calcularCuentaCorriente(
      [
        cfe({ id: 1, total: 1000, rut: "111" }),
        cfe({ id: 2, total: 500, rut: "222" }),
        cfe({ id: 3, total: 200, moneda: "USD", rut: "111" }),
        recibo({ id: 4, total: 1000, rut: "111" }), // solo paga lo de 111 en UYU
      ],
      opts,
    );

    expect(r.saldo_por_moneda.UYU).toEqual({ total: 500, comprobantes: 1 });
    expect(r.saldo_por_moneda.USD).toEqual({ total: 200, comprobantes: 1 });
    expect(r.documentos.find((d) => d.id === 1)).toBeUndefined();
  });

  it("excluye el contado, que no genera cuenta corriente", () => {
    const r = calcularCuentaCorriente([cfe({ id: 1, total: 1000, venceEn: null })], opts);
    expect(r.excluidos.contado).toBe(1);
    expect(r.saldo_por_moneda).toEqual({});
  });

  it("marca el aging sobre el saldo NETO, no sobre el total facturado", () => {
    const r = calcularCuentaCorriente(
      [cfe({ id: 1, total: 1000, venceEn: -40, emitidaHace: 70 }), recibo({ id: 2, total: 700 })],
      opts,
    );

    expect(r.vencido_por_moneda.UYU).toEqual({ total: 300, comprobantes: 1 });
    expect(r.documentos[0]!.bucket).toBe("vencida_31_60");
    expect(r.por_cliente[0]!.dias_atraso_maximo).toBe(40);
  });

  it("avisa cuando un recibo referencia una factura fuera de la ventana", () => {
    const r = calcularCuentaCorriente(
      [cfe({ id: 1, total: 1000 }), recibo({ id: 2, total: 300, referencias: [{ padre: 999 }] })],
      opts,
    );

    expect(r.documentos[0]!.saldo).toBe(1000); // no se imputó a la que estaba
    expect(r.saldo_a_favor_por_moneda.UYU).toBe(300);
    expect(r.warnings.some((w) => w.includes("999"))).toBe(true);
  });

  it("ignora los comprobantes que DGI no aceptó", () => {
    const r = calcularCuentaCorriente(
      [cfe({ id: 1, total: 1000 }), recibo({ id: 2, total: 400, estado: "Rechazado DGI" })],
      opts,
    );

    expect(r.saldo_por_moneda.UYU!.total).toBe(1000);
    expect(r.excluidos.no_aceptados).toBe(1);
  });
});
