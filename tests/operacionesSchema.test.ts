// =============================================================================
// Schemas de recibos, pagos, clientes y productos.
//
// A diferencia de la emisión de CFE, estos endpoints SÍ declaran un JSON Schema
// con `required` en la doc de Biller. Cada caso de acá refleja ese `required`.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  ClienteCrearSchema,
  PagoBodySchema,
  ProductoSchema,
  ReciboBodySchema,
  validarClienteCrear,
  validarProducto,
  validarRecibo,
} from "../src/biller/operacionesSchema.js";

function errores(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, input: unknown): string {
  const r = schema.safeParse(input);
  if (r.success) return "";
  return r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
}

// --- Recibos ----------------------------------------------------------------

const RECIBO_OK = {
  tipo_comprobante: 111,
  forma_pago: 1,
  sucursal: 204,
  moneda: "UYU",
  cliente: {
    tipo_documento: 2,
    documento: "214987440015",
    razon_social: "Arcos Plateados SRL",
    sucursal: { direccion: "Amézaga 2100", ciudad: "Montevideo", pais: "UY" },
  },
  referencias: [{ padre: 79508, total: 1200 }],
  pago: { fecha: "2021-05-27", monto: 1800, referencia: "Transferencia Itaú 2185" },
};

describe("ReciboBodySchema", () => {
  it("acepta el ejemplo oficial", () => {
    expect(ReciboBodySchema.safeParse(RECIBO_OK).success).toBe(true);
  });

  it("exige cliente, moneda y pago (required del schema oficial)", () => {
    expect(errores(ReciboBodySchema, { ...RECIBO_OK, cliente: undefined })).toMatch(/cliente/);
    expect(errores(ReciboBodySchema, { ...RECIBO_OK, moneda: undefined })).toMatch(/moneda/);
    expect(errores(ReciboBodySchema, { ...RECIBO_OK, pago: undefined })).toMatch(/pago/);
  });

  it("exige tipo_documento y documento en el receptor", () => {
    expect(errores(ReciboBodySchema, { ...RECIBO_OK, cliente: { razon_social: "X" } }))
      .toMatch(/tipo_documento|documento/);
  });

  it("usa fechas ISO y explica la diferencia con dd/mm/aaaa", () => {
    const e = errores(ReciboBodySchema, {
      ...RECIBO_OK,
      pago: { ...RECIBO_OK.pago, fecha: "27/05/2021" },
    });
    expect(e).toMatch(/aaaa-mm-dd/);
  });

  it("rechaza días imposibles aunque Date.parse los normalice", () => {
    expect(
      errores(ReciboBodySchema, {
        ...RECIBO_OK,
        pago: { ...RECIBO_OK.pago, fecha: "2026-02-31" },
      }),
    ).toMatch(/fecha real/);
    expect(
      errores(ReciboBodySchema, {
        ...RECIBO_OK,
        fecha_emision: "2025-02-29",
      }),
    ).toMatch(/fecha real/);
  });

  it("rechaza un pago menor al total de las referencias", () => {
    const e = errores(ReciboBodySchema, {
      ...RECIBO_OK,
      referencias: [{ padre: 1, total: 2000 }],
      pago: { ...RECIBO_OK.pago, monto: 1000 },
    });
    expect(e).toMatch(/mayor o igual/);
  });

  it("avisa del Adelanto cuando el pago supera las referencias", () => {
    const body = ReciboBodySchema.parse({ ...RECIBO_OK, pago: { ...RECIBO_OK.pago, monto: 1800 } });
    expect(validarRecibo(body).some((w) => /Adelanto/.test(w))).toBe(true);
  });

  it("avisa que falta tasa_cambio en moneda extranjera", () => {
    const body = ReciboBodySchema.parse({ ...RECIBO_OK, moneda: "USD" });
    expect(validarRecibo(body).some((w) => /tasa_cambio/.test(w))).toBe(true);
  });
});

// --- Pagos ------------------------------------------------------------------

const PAGO_OK = {
  fecha: "2026-05-28",
  monto: 1500,
  referencia: "Transferencia BROU 12345",
  comprobantes: [
    { id: 79508, monto: 1000 },
    { id: 79509, monto: 500 },
  ],
};

describe("PagoBodySchema", () => {
  it("acepta el ejemplo oficial", () => {
    expect(PagoBodySchema.safeParse(PAGO_OK).success).toBe(true);
  });

  it("exige que el monto coincida con la suma de los comprobantes", () => {
    expect(errores(PagoBodySchema, { ...PAGO_OK, monto: 1600 })).toMatch(/no coincide/);
  });

  it("exige referencia (required del schema oficial)", () => {
    expect(errores(PagoBodySchema, { ...PAGO_OK, referencia: undefined })).toMatch(/referencia/);
  });

  it("exige al menos un comprobante", () => {
    expect(errores(PagoBodySchema, { ...PAGO_OK, comprobantes: [] })).toMatch(/al menos un/);
  });

  // "Fecha del pago en formato aaaa-mm-dd o dd/mm/aaaa" — único campo con ambos.
  it("acepta la fecha en ISO y en dd/mm/aaaa", () => {
    expect(PagoBodySchema.safeParse({ ...PAGO_OK, fecha: "2026-05-28" }).success).toBe(true);
    expect(PagoBodySchema.safeParse({ ...PAGO_OK, fecha: "28/05/2026" }).success).toBe(true);
    expect(errores(PagoBodySchema, { ...PAGO_OK, fecha: "28-05-2026" })).toMatch(/aaaa-mm-dd o dd\/mm\/aaaa/);
  });

  it("rechaza una fecha ISO imposible", () => {
    expect(errores(PagoBodySchema, { ...PAGO_OK, fecha: "2026-04-31" })).toMatch(/fecha real/);
  });

  it("permite montos negativos para revertir un pago", () => {
    const r = PagoBodySchema.safeParse({
      ...PAGO_OK,
      monto: -1500,
      comprobantes: [{ id: 79508, monto: -1500 }],
    });
    expect(r.success).toBe(true);
  });
});

// --- Clientes ---------------------------------------------------------------

describe("ClienteCrearSchema", () => {
  const CLIENTE_OK = {
    razon_social: "Chokora SRL",
    tipo_documento: 2,
    documento: "217832560011",
    direccion: "Los Arces 7635",
    ciudad: "Montevideo",
    departamento: "Montevideo",
    pais: "UY",
  };

  it("acepta los ejemplos oficiales (RUT y CI)", () => {
    expect(ClienteCrearSchema.safeParse(CLIENTE_OK).success).toBe(true);
    expect(
      ClienteCrearSchema.safeParse({
        nombre_fantasia: "Martín Perez",
        tipo_documento: 3,
        documento: "47348269",
        direccion: "18 de Julio esquina Ejido",
        ciudad: "Montevideo",
        departamento: "Montevideo",
        pais: "UY",
      }).success,
    ).toBe(true);
  });

  it("exige solo tipo_documento, documento y pais", () => {
    expect(errores(ClienteCrearSchema, { ...CLIENTE_OK, pais: undefined })).toMatch(/pais/);
    expect(errores(ClienteCrearSchema, { ...CLIENTE_OK, documento: undefined })).toMatch(/documento/);
    // razon_social NO es required: sin él, el parseo pasa.
    expect(ClienteCrearSchema.safeParse({ ...CLIENTE_OK, razon_social: undefined }).success).toBe(true);
  });

  it("avisa cuál es el nombre principal según el tipo de documento", () => {
    const body = ClienteCrearSchema.parse({ ...CLIENTE_OK, razon_social: undefined });
    expect(validarClienteCrear(body).some((w) => /razon_social/.test(w))).toBe(true);
  });
});

// --- Productos --------------------------------------------------------------

describe("ProductoSchema", () => {
  const PRODUCTO_OK = {
    codigo: "CAM 01",
    nombre: "Camiseta 01",
    descripcion: "Camiseta azul talles de S a L",
    moneda: "UYU",
    precio: "599",
    indicador_facturacion: 1,
    inventario: "5",
    es_servicio: false,
  };

  it("acepta los ejemplos oficiales (producto y servicio)", () => {
    expect(ProductoSchema.safeParse(PRODUCTO_OK).success).toBe(true);
    expect(
      ProductoSchema.safeParse({
        codigo: "LMP SLLN",
        nombre: "Limpieza de sillón",
        moneda: "UYU",
        precio: "1300",
        indicador_facturacion: 1,
        es_servicio: true,
      }).success,
    ).toBe(true);
  });

  it("exige los seis campos required del schema oficial", () => {
    for (const campo of ["codigo", "nombre", "precio", "moneda", "indicador_facturacion", "es_servicio"]) {
      expect(errores(ProductoSchema, { ...PRODUCTO_OK, [campo]: undefined })).toMatch(new RegExp(campo));
    }
  });

  // "Obligatorio cuando `indicador_facturacion` es 4 (Otra tasa)."
  it("exige impuesto_tasa cuando el indicador es 4 (Otra tasa)", () => {
    expect(errores(ProductoSchema, { ...PRODUCTO_OK, indicador_facturacion: 4 })).toMatch(/impuesto_tasa/);
    expect(
      ProductoSchema.safeParse({ ...PRODUCTO_OK, indicador_facturacion: 4, impuesto_tasa: 10.5 }).success,
    ).toBe(true);
  });

  it("avisa (sin bloquear) que un servicio no usa inventario", () => {
    const body = ProductoSchema.parse({ ...PRODUCTO_OK, es_servicio: true });
    expect(validarProducto(body).some((w) => /stock/.test(w))).toBe(true);
  });
});
