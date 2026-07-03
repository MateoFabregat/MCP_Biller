import { describe, expect, it } from "vitest";
import { handleObtenerComprobante } from "../src/tools/obtenerComprobante.js";
import { EMITIDO_EXAMPLE, EMITIDO_USD_EXAMPLE } from "./fixtures.js";
import { makeCtx } from "./helpers.js";

describe("biller_obtener_comprobante", () => {
  // Requisito #7
  it("rechaza si no se especifica id, numero_interno ni la terna", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({}, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rechaza tipo_comprobante sin serie+numero", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ tipo_comprobante: "101" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("acepta la terna completa y consulta el endpoint", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante(
      { tipo_comprobante: "101", serie: "C", numero: "2069514" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/comprobantes/obtener");
    expect(opts.query.tipo_comprobante).toBe("101");
    expect(opts.query.serie).toBe("C");
    expect(opts.query.numero).toBe("2069514");
    expect((res.structuredContent!.comprobante as Record<string, unknown>).id).toBe(53616);
    expect(res.structuredContent!.count).toBe(1);
  });

  it("acepta consulta por id", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "53616" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(getMock.mock.calls[0]![0].query.id).toBe("53616");
  });

  it("envía recibidos=1 cuando recibidos=true", async () => {
    const { ctx, getMock } = makeCtx({ response: [] });
    await handleObtenerComprobante({ id: "1", recibidos: true }, ctx);
    expect(getMock.mock.calls[0]![0].query.recibidos).toBe("1");
  });

  it("expone tasa_cambio en comprobantes USD", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_USD_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "99001" }, ctx);
    expect(res.isError).toBeUndefined();
    const comp = res.structuredContent!.comprobante as Record<string, unknown>;
    expect(comp.tasa_cambio).toBe(38.397);
    expect(comp.moneda).toBe("USD");
  });

  it("tasa_cambio es null en comprobantes UYU (campo ausente)", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "53616" }, ctx);
    const comp = res.structuredContent!.comprobante as Record<string, unknown>;
    expect(comp.tasa_cambio).toBeNull();
  });

  it("preserva campos crudos no mapeados en campos_extra", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_USD_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "99001" }, ctx);
    const comp = res.structuredContent!.comprobante as Record<string, unknown>;
    const extra = comp.campos_extra as Record<string, unknown>;
    expect(extra.campo_no_documentado).toBe("valor-X");
    // tasa_cambio se mapea a clave tipada, NO debe duplicarse en campos_extra.
    expect("tasa_cambio" in extra).toBe(false);
    // campos_presentes sigue listando todas las claves crudas.
    expect(comp.campos_presentes).toContain("tasa_cambio");
    expect(comp.campos_presentes).toContain("campo_no_documentado");
  });

  it("expone los campos reales tipados (estado, sucursal, numero_interno, adenda)", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_USD_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "99001" }, ctx);
    const comp = res.structuredContent!.comprobante as Record<string, unknown>;
    expect(comp.estado).toBe("Aceptado DGI");
    expect(comp.sucursal).toBe(347);
    expect(comp.numero_interno).toBe("INT-001");
    expect(comp.adenda).toBe("Método de pago: Transferencia");
    expect(comp.montos_brutos).toBe(0);
    // total viene como string "610.00" y se normaliza a número.
    expect(comp.total).toBe(610);
    // Ninguno de estos campos tipados debe caer en campos_extra.
    const extra = comp.campos_extra as Record<string, unknown>;
    for (const k of ["estado", "sucursal", "numero_interno", "adenda", "montos_brutos"]) {
      expect(k in extra).toBe(false);
    }
  });

  it("tipa los items[] con números normalizados y campos_extra por ítem", async () => {
    const { ctx } = makeCtx({ response: EMITIDO_USD_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "99001" }, ctx);
    const comp = res.structuredContent!.comprobante as Record<string, unknown>;
    const items = comp.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.cantidad).toBe(1); // "1.000" -> 1
    expect(it0.precio).toBe(1200); // "1200.000000" -> 1200
    expect(it0.impuesto_tasa).toBe(0.22); // "0.220" -> 0.22
    expect(it0.indicador_facturacion).toBe(3);
    expect(it0.concepto).toBe("Acero Inoxidable");
    // Campo de ítem no mapeado preservado.
    expect((it0.campos_extra as Record<string, unknown>).campo_item_raro).toBe("z");
  });

  it("funciona sin sucursal configurada (default null)", async () => {
    const { ctx, getMock } = makeCtx({ response: EMITIDO_EXAMPLE });
    const res = await handleObtenerComprobante({ id: "53616" }, ctx);
    expect(res.isError).toBeUndefined();
    // sin BILLER_DEFAULT_SUCURSAL_ID, no se envía sucursal al endpoint.
    expect(getMock.mock.calls[0]![0].query.sucursal).toBeUndefined();
  });
});
