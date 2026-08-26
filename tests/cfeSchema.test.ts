// =============================================================================
// Schema del CFE: tabla de valores, formatos de fecha y reglas obligatorias.
//
// Los casos "válidos" son los EJEMPLOS OFICIALES de la doc de Biller
// (POST /v3/comprobantes/emitir): si el schema rechazara uno de ellos, estaría
// bloqueando una emisión legítima.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  ComprobanteBodySchema,
  formatFechaDgi,
  parseFechaDgi,
  validarComprobante,
} from "../src/biller/cfeSchema.js";

/** Extrae los mensajes de error de un parseo fallido. */
function errores(input: unknown): string[] {
  const r = ComprobanteBodySchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

const E_TICKET = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
  montos_brutos: 0,
  cliente: "-",
  items: [{ cantidad: 1, concepto: "Pelota de fútbol", precio: 200, indicador_facturacion: 3 }],
};

describe("ComprobanteBodySchema — ejemplos oficiales de la doc", () => {
  it("acepta el e-Ticket sin receptor", () => {
    expect(ComprobanteBodySchema.safeParse(E_TICKET).success).toBe(true);
  });

  it("acepta la e-Factura con descuentos globales y emails", () => {
    const ok = ComprobanteBodySchema.safeParse({
      tipo_comprobante: 111,
      forma_pago: 2,
      fecha_vencimiento: "31/12/2026",
      sucursal: 6,
      moneda: "UYU",
      cliente: {
        tipo_documento: 2,
        documento: "214987440015",
        razon_social: "Arcos Plateados SRL",
        nombre_fantasia: "McBurger",
        sucursal: {
          direccion: "Amézaga 2100",
          ciudad: "Montevideo",
          departamento: "Montevideo",
          pais: "UY",
        },
      },
      items: [
        {
          cantidad: 1,
          concepto: "Pelota de basketball",
          precio: 1000,
          indicador_facturacion: 3,
          descuento_tipo: "$",
          descuento_cantidad: 100,
        },
      ],
      descuentosRecargos: [
        { es_recargo: false, desc_rec_tipo: "%", glosa: "Promoción verano", valor: 10, indicador_facturacion: 3 },
      ],
      emails_notificacion: ["prueba@biller.uy"],
    });
    expect(ok.success).toBe(true);
  });

  it("acepta la nota de crédito con referencia tipo/serie/numero", () => {
    expect(
      ComprobanteBodySchema.safeParse({
        tipo_comprobante: 112,
        forma_pago: 1,
        sucursal: 303,
        moneda: "UYU",
        cliente: { tipo_documento: 2, documento: "214987440015", razon_social: "Arcos Plateados SRL" },
        items: [{ cantidad: 1, codigo: "12092", concepto: "Camión Mercedes", precio: 679, indicador_facturacion: 3 }],
        referencias: [{ tipo: 111, serie: "D", numero: 497383 }],
      }).success,
    ).toBe(true);
  });

  it("acepta la e-Factura de exportación completa", () => {
    expect(
      ComprobanteBodySchema.safeParse({
        tipo_comprobante: 121,
        forma_pago: 2,
        sucursal: 6,
        modalidad_venta: 1,
        clausula_venta: "CFR",
        via_transporte: 1,
        moneda: "UYU",
        cliente: { tipo_documento: 2, documento: "214987440015", razon_social: "Arcos Plateados SRL" },
        items: [{ cantidad: 1, concepto: "Pelota", precio: 1000, ncm: "EJR7", indicador_facturacion: 10 }],
      }).success,
    ).toBe(true);
  });

  it("acepta el e-Resguardo con retencionesPercepciones", () => {
    expect(
      ComprobanteBodySchema.safeParse({
        tipo_comprobante: 182,
        sucursal: 303,
        moneda: "UYU",
        cliente: { tipo_documento: 2, documento: "199389470037", razon_social: "Arcos Plateados SRL" },
        retencionesPercepciones: [{ codigo: "1144131", tasa: "2", monto_sujeto: "123400" }],
      }).success,
    ).toBe(true);
  });

  it("acepta el e-Remito con tipo_traslado", () => {
    expect(
      ComprobanteBodySchema.safeParse({
        tipo_comprobante: 181,
        fecha_emision: "29/07/2022",
        sucursal: 6,
        tipo_traslado: 1,
        cliente: { tipo_documento: 2, documento: "211003420017", razon_social: "Chokora SRL" },
        items: [{ codigo: "140", cantidad: 40, concepto: "Botellas de plástico 500ml" }],
      }).success,
    ).toBe(true);
  });

  // Varios ejemplos oficiales mandan números como string.
  it("acepta strings numéricos y los normaliza a número", () => {
    const r = ComprobanteBodySchema.safeParse({
      tipo_comprobante: "131",
      forma_pago: "1",
      moneda: "UYU",
      sucursal: "1",
      cliente: "-",
      items: [{ cantidad: "12", concepto: "Prueba", indicador_facturacion: "1", precio: "580" }],
      complementoFiscal: { nombre: "DA VINCI", tipo_documento: 2, documento: "210980330017", pais: "UY" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tipo_comprobante).toBe(131);
      expect(r.data.items![0]!.cantidad).toBe(12);
    }
  });

  it("acepta el e-Ticket con retenciones e indicador_agente_responsable", () => {
    expect(
      ComprobanteBodySchema.safeParse({
        tipo_comprobante: 101,
        fecha_emision: "15/05/2019",
        forma_pago: 1,
        sucursal: 1,
        moneda: "UYU",
        montos_brutos: 1,
        cliente: { tipo_documento: 6, documento: "123456", nombre_fantasia: "Pumas", pais: "AR" },
        items: [
          {
            codigo: 1,
            cantidad: 1,
            concepto: "Producto IVA Básico",
            precio: 10,
            indicador_facturacion: 3,
            indicador_agente_responsable: "A",
            retencionesPercepciones: [{ codigo: 1145143, tasa: "10.0", monto_sujeto: 400 }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("ComprobanteBodySchema — tabla de valores", () => {
  it("rechaza un tipo_comprobante no documentado y lista los válidos", () => {
    const errs = errores({ ...E_TICKET, tipo_comprobante: 999 });
    expect(errs.join()).toMatch(/tipo_comprobante/);
    expect(errs.join()).toMatch(/101/);
  });

  it("rechaza un indicador_facturacion fuera de 1..16", () => {
    expect(errores({ ...E_TICKET, items: [{ cantidad: 1, concepto: "X", precio: 1, indicador_facturacion: 99 }] }).join())
      .toMatch(/indicador_facturacion/);
  });

  it("rechaza forma_pago distinta de 1 o 2", () => {
    expect(errores({ ...E_TICKET, forma_pago: 3 }).join()).toMatch(/forma_pago/);
  });

  it("rechaza una clausula_venta inexistente", () => {
    const errs = errores({ ...E_TICKET, tipo_comprobante: 121, clausula_venta: "XYZ", modalidad_venta: 1, via_transporte: 1 });
    expect(errs.join()).toMatch(/clausula_venta/);
  });

  it("rechaza un tipo_documento de cliente no documentado", () => {
    expect(errores({ ...E_TICKET, cliente: { tipo_documento: 9, documento: "1" } }).join())
      .toMatch(/tipo_documento/);
  });

  it("aplica los largos máximos de DGI", () => {
    const errs = errores({
      ...E_TICKET,
      items: [{ cantidad: 1, concepto: "x".repeat(81), precio: 1, indicador_facturacion: 3 }],
    });
    expect(errs.join()).toMatch(/concepto/);
  });
});

describe("ComprobanteBodySchema — fechas dd/mm/aaaa", () => {
  it("rechaza formato ISO y explica cuál corresponde", () => {
    const errs = errores({ ...E_TICKET, fecha_emision: "2026-07-15" });
    expect(errs.join()).toMatch(/dd\/mm\/aaaa/);
  });

  it("rechaza una fecha que no existe", () => {
    expect(errores({ ...E_TICKET, fecha_emision: "31/02/2026" }).join()).toMatch(/fecha real/);
  });

  it("rechaza una fecha_emision anterior al mínimo documentado", () => {
    expect(errores({ ...E_TICKET, fecha_emision: "30/09/2011" }).join()).toMatch(/01\/10\/2011/);
  });

  it("rechaza una fecha_emision a más de dos meses a futuro", () => {
    const lejos = new Date();
    lejos.setUTCMonth(lejos.getUTCMonth() + 6);
    expect(errores({ ...E_TICKET, fecha_emision: formatFechaDgi(lejos) }).join()).toMatch(/dos meses/);
  });

  it("parseFechaDgi valida el calendario real", () => {
    expect(parseFechaDgi("29/02/2024")).not.toBeNull(); // bisiesto
    expect(parseFechaDgi("29/02/2023")).toBeNull();
    expect(parseFechaDgi("2024-02-29")).toBeNull();
  });
});

describe("ComprobanteBodySchema — reglas obligatorias de la doc", () => {
  it("rechaza referencias y referencia_global juntas (mutuamente excluyentes)", () => {
    const errs = errores({
      ...E_TICKET,
      tipo_comprobante: 102,
      referencias: [100],
      referencia_global: 1,
      razon_referencia: "x",
    });
    expect(errs.join()).toMatch(/mutuamente excluyentes/i);
  });

  it("exige razon_referencia cuando hay referencia_global", () => {
    const errs = errores({ ...E_TICKET, tipo_comprobante: 102, referencia_global: 1 });
    expect(errs.join()).toMatch(/razon_referencia/);
  });

  it("exige modalidad_venta, clausula_venta y via_transporte en exportación", () => {
    const errs = errores({
      ...E_TICKET,
      tipo_comprobante: 121,
      items: [{ cantidad: 1, concepto: "X", precio: 1, ncm: "AB1", indicador_facturacion: 10 }],
    });
    expect(errs.join()).toMatch(/modalidad_venta/);
    expect(errs.join()).toMatch(/clausula_venta/);
    expect(errs.join()).toMatch(/via_transporte/);
  });

  it("exige ncm en cada ítem de una exportación", () => {
    const errs = errores({
      ...E_TICKET,
      tipo_comprobante: 121,
      modalidad_venta: 1,
      clausula_venta: "FOB",
      via_transporte: 2,
      items: [{ cantidad: 1, concepto: "X", precio: 1, indicador_facturacion: 10 }],
    });
    expect(errs.join()).toMatch(/ncm/);
  });

  it("exige tipo_traslado en remitos", () => {
    expect(errores({ ...E_TICKET, tipo_comprobante: 181 }).join()).toMatch(/tipo_traslado/);
  });

  it("prohíbe retenciones en e-Factura de exportación", () => {
    const errs = errores({
      ...E_TICKET,
      tipo_comprobante: 121,
      modalidad_venta: 1,
      clausula_venta: "FOB",
      via_transporte: 2,
      items: [{ cantidad: 1, concepto: "X", precio: 1, ncm: "A1", indicador_facturacion: 10 }],
      retencionesPercepciones: [{ codigo: 1145143, tasa: 10, monto_sujeto: 100 }],
    });
    expect(errs.join()).toMatch(/no admite retenciones/);
  });

  it("exige indicador_agente_responsable en un ítem con retenciones fuera de e-Resguardo", () => {
    const errs = errores({
      ...E_TICKET,
      items: [
        {
          cantidad: 1,
          concepto: "X",
          precio: 1,
          indicador_facturacion: 3,
          retencionesPercepciones: [{ codigo: 1145143, tasa: 10, monto_sujeto: 100 }],
        },
      ],
    });
    expect(errs.join()).toMatch(/indicador_agente_responsable/);
  });

  it("exige descuento_cantidad cuando se declara descuento_tipo", () => {
    const errs = errores({
      ...E_TICKET,
      items: [{ cantidad: 1, concepto: "X", precio: 1, indicador_facturacion: 3, descuento_tipo: "%" }],
    });
    expect(errs.join()).toMatch(/descuento_cantidad/);
  });
});

describe("validarComprobante — avisos no bloqueantes", () => {
  const parse = (input: unknown) => ComprobanteBodySchema.parse(input);

  it("avisa cuando una e-Factura no tiene receptor", () => {
    const w = validarComprobante(parse({ ...E_TICKET, tipo_comprobante: 111, cliente: "-" }));
    expect(w.some((x) => /e-Factura/.test(x) && /receptor/.test(x))).toBe(true);
  });

  it("avisa cuando una nota de ajuste no referencia el CFE original", () => {
    const w = validarComprobante(parse({ ...E_TICKET, tipo_comprobante: 102 }));
    expect(w.some((x) => /nota de ajuste/.test(x))).toBe(true);
  });

  it("avisa cuando falta sucursal", () => {
    const w = validarComprobante(parse({ ...E_TICKET, sucursal: undefined }));
    expect(w.some((x) => /sucursal/.test(x))).toBe(true);
  });

  it("avisa cuando falta numero_interno (sin él no hay deduplicación)", () => {
    const w = validarComprobante(parse(E_TICKET));
    expect(w.some((x) => /numero_interno/.test(x))).toBe(true);
  });

  it("avisa si el nombre principal no corresponde al tipo de documento", () => {
    const w = validarComprobante(
      parse({ ...E_TICKET, cliente: { tipo_documento: 2, documento: "214987440015", nombre_fantasia: "X" } }),
    );
    expect(w.some((x) => /razon_social/.test(x))).toBe(true);
  });

  it("avisa si un descuento global no afecta a ningún ítem", () => {
    const w = validarComprobante(
      parse({
        ...E_TICKET,
        descuentosRecargos: [{ es_recargo: false, desc_rec_tipo: "%", glosa: "X", valor: 10, indicador_facturacion: 1 }],
      }),
    );
    expect(w.some((x) => /no coincide con el de ningún ítem/.test(x))).toBe(true);
  });

  it("no avisa de receptor faltante en un e-Ticket (es opcional)", () => {
    const w = validarComprobante(parse(E_TICKET));
    expect(w.some((x) => /receptor/.test(x))).toBe(false);
  });

  // Sin el importe, la regla del umbral de UI no se puede evaluar. Que el
  // silencio sea el default evita un warning inútil en cada e-Ticket; el aviso
  // aparece solo cuando el llamador SÍ intentó calcular el total y no pudo.
  it("solo avisa que no pudo verificar el umbral si el llamador pasó total_uyu: null", () => {
    const sinContexto = validarComprobante(parse(E_TICKET));
    expect(sinContexto.some((x) => /umbral/.test(x))).toBe(false);

    const conIntento = validarComprobante(parse(E_TICKET), { total_uyu: null });
    expect(conIntento.some((x) => /No se pudo verificar el umbral/.test(x))).toBe(true);
  });
});
