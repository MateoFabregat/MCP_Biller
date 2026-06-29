import { describe, expect, it } from "vitest";
import { handleBuscarClientePorRut } from "../src/tools/buscarClientePorRut.js";
import { DGI_DATOS_ENTIDAD_EXAMPLE, DGI_NOMBRE_EXAMPLE } from "./fixtures.js";
import { makeCtx } from "./helpers.js";

describe("biller_buscar_cliente_por_rut", () => {
  // Requisito #12
  it("aclara que consulta DGI y NO confirma cliente Biller", async () => {
    const { ctx, getMock } = makeCtx({ response: DGI_DATOS_ENTIDAD_EXAMPLE });
    const res = await handleBuscarClientePorRut({ rut: "210475730011" }, ctx);

    const sc = res.structuredContent!;
    expect(sc.fuente).toBe("dgi");
    expect(sc.es_cliente_biller_confirmado).toBeNull();
    expect(String(sc.advertencia)).toMatch(/no/i);
    expect(String(sc.advertencia)).toMatch(/Biller/);
    expect(String(sc.advertencia)).toMatch(/DGI/);

    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/dgi/empresas/datos-entidad");
    expect(opts.rateLimitClass).toBe("dgi");
    expect(opts.query.rut).toBe("210475730011");

    const datos = sc.datos as Record<string, unknown>;
    expect(datos.ruc).toBe("210475730011");
    expect(datos.razon_social).toContain("ADMINISTRACION");
  });

  it("detalle='nombre' usa nombre-entidad, default tipoDocumento=2 y coacciona {} a null", async () => {
    const { ctx, getMock } = makeCtx({ response: DGI_NOMBRE_EXAMPLE });
    const res = await handleBuscarClientePorRut({ rut: "210475730011", detalle: "nombre" }, ctx);

    const opts = getMock.mock.calls[0]![0];
    expect(opts.path).toBe("/v2/dgi/empresas/nombre-entidad");
    expect(opts.query.documento).toBe("210475730011");
    expect(opts.query.tipoDocumento).toBe("2");

    const sc = res.structuredContent!;
    expect((sc.datos as Record<string, unknown>).primer_nombre).toBeNull(); // {} -> null
    expect((sc.datos as Record<string, unknown>).razon_social).toContain("ADMINISTRACION");
    expect(sc.tipo_documento).toBe("2");
  });

  it("propaga errores de API de forma segura (isError)", async () => {
    const { ctx } = makeCtx({
      impl: () => {
        throw Object.assign(new Error("boom"), {});
      },
    });
    const res = await handleBuscarClientePorRut({ rut: "1" }, ctx);
    expect(res.isError).toBe(true);
  });
});
