import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { resumirFacturacion } from "../src/services/resumenFacturacion.js";
import {
  AcumuladorUyu,
  convertirAUyu,
  esMonedaBase,
} from "../src/services/tipoCambio.js";
import { handleResumenFacturacion } from "../src/tools/resumenFacturacion.js";
import { makeCtx } from "./helpers.js";

describe("convertirAUyu", () => {
  it("la moneda base no se convierte y su tasa es 1", () => {
    expect(convertirAUyu(1000, "UYU", null)).toEqual({
      monto_uyu: 1000,
      tasa: 1,
      origen: "moneda_base",
    });
    // La API manda "1.000" en pesos: si se usara como tasa, daría lo mismo,
    // pero el origen tiene que decir que no hubo conversión.
    expect(convertirAUyu(1000, "UYU", 1).origen).toBe("moneda_base");
    expect(esMonedaBase("uyu")).toBe(true);
    expect(esMonedaBase("USD")).toBe(false);
  });

  it("usa la cotización del propio comprobante", () => {
    const c = convertirAUyu(100, "USD", 38.397);
    expect(c.monto_uyu).toBe(3839.7);
    expect(c.tasa).toBe(38.397);
    expect(c.origen).toBe("tasa_del_comprobante");
  });

  // El peor error posible acá es silencioso y a la baja: una factura real
  // valuada en $0 baja el total sin que nadie lo note.
  it("NO convierte (y no inventa tasa) si la cotización falta o es 0", () => {
    for (const tasa of [null, 0, -3]) {
      const c = convertirAUyu(100, "USD", tasa);
      expect(c.monto_uyu).toBeNull();
      expect(c.origen).toBe("sin_tasa");
    }
  });
});

describe("AcumuladorUyu", () => {
  it("suma monedas distintas y pondera la tasa promedio por monto", () => {
    const acc = new AcumuladorUyu();
    acc.agregar(1000, "UYU", null);
    acc.agregar(100, "USD", 40); // 4000
    acc.agregar(900, "USD", 50); // 45000
    const r = acc.resultado();

    expect(r.total_uyu).toBe(50_000);
    expect(r.completo).toBe(true);
    expect(r.cobertura_pct).toBe(100);
    // Ponderada por monto: (40*100 + 50*900) / 1000 = 49, no 45.
    expect(r.por_moneda.USD!.tasa_promedio_ponderada).toBe(49);
    expect(r.por_moneda.USD!.total_original).toBe(1000);
  });

  it("una nota de crédito resta sin invertir el peso de la tasa promedio", () => {
    const acc = new AcumuladorUyu();
    acc.agregar(1000, "USD", 40);
    acc.agregar(-200, "USD", 40);
    const r = acc.resultado();
    expect(r.total_uyu).toBe(32_000);
    expect(r.por_moneda.USD!.tasa_promedio_ponderada).toBe(40);
  });

  it("declara la cobertura y avisa cuando algo quedó fuera del equivalente", () => {
    const acc = new AcumuladorUyu();
    acc.agregar(1000, "UYU", null);
    acc.agregar(100, "USD", null);
    const r = acc.resultado();

    expect(r.total_uyu).toBe(1000);
    expect(r.completo).toBe(false);
    expect(r.comprobantes_sin_tasa).toBe(1);
    expect(r.cobertura_pct).toBe(50);
    expect(r.warnings.join(" ")).toMatch(/SIN cotización/i);
  });

  it("avisa cuando las cotizaciones del período están muy dispersas", () => {
    const acc = new AcumuladorUyu();
    acc.agregar(100, "USD", 38);
    acc.agregar(100, "USD", 44);
    expect(acc.resultado().warnings.join(" ")).toMatch(/no se reproduce con una cotización única/i);
  });
});

// --- Integración con el resumen ---------------------------------------------

const MULTIMONEDA = normalizeComprobantesEmitidos([
  { id: 1, tipo_comprobante: 111, serie: "A", numero: 10, moneda: "UYU", total: 10_000, tasa_cambio: "1.000", estado: "Aceptado DGI", fecha_emision: "2026-06-05", cliente: { documento: "210475730011", razon_social: "ACME SA" } },
  { id: 2, tipo_comprobante: 111, serie: "A", numero: 11, moneda: "USD", total: 100, tasa_cambio: "38.397", estado: "Aceptado DGI", fecha_emision: "2026-06-10", cliente: { documento: "210475730011", razon_social: "ACME SA" } },
  { id: 3, tipo_comprobante: 112, serie: "A", numero: 12, moneda: "USD", total: 20, tasa_cambio: "38.500", estado: "Aceptado DGI", fecha_emision: "2026-06-12", cliente: { documento: "210475730011", razon_social: "ACME SA" } },
]);

describe("resumirFacturacion + equivalente en pesos", () => {
  it("mantiene el desglose por moneda Y da el total en pesos", () => {
    const r = resumirFacturacion(MULTIMONEDA, { incluir_anulados: false });

    // El dato primario no cambia: nada se convierte acá.
    expect(r.totales_por_moneda.UYU!.total).toBe(10_000);
    expect(r.totales_por_moneda.USD!.total).toBe(80); // 100 − 20 de NC
    expect(r.no_convertir_moneda).toBe(true);

    // 10.000 + 100*38.397 − 20*38.5 = 10.000 + 3839.7 − 770 = 13.069,70
    expect(r.equivalente_uyu.total_uyu).toBe(13_069.7);
    expect(r.equivalente_uyu.completo).toBe(true);
    expect(r.equivalente_uyu.metodo).toMatch(/tasa_cambio/);
  });

  it("el detalle lista exactamente los comprobantes que se sumaron, con su aporte", () => {
    const r = resumirFacturacion(MULTIMONEDA, {
      incluir_anulados: false,
      incluir_detalle: true,
    });

    expect(r.detalle).toHaveLength(3);
    expect(r.detalle_truncado).toBe(false);
    const nc = r.detalle.find((d) => d.id === 3)!;
    expect(nc.categoria).toBe("nota_credito");
    expect(nc.aporte).toBe(-20);
    expect(nc.aporte_uyu).toBe(-770);
    expect(nc.cliente_nombre).toBe("ACME SA");

    // La suma de los aportes en pesos tiene que dar el equivalente publicado:
    // si divergen, el detalle no es "las facturas de ese total".
    const suma = r.detalle.reduce((acc, d) => acc + (d.aporte_uyu ?? 0), 0);
    expect(Math.round(suma * 100) / 100).toBe(r.equivalente_uyu.total_uyu);
  });

  it("recorta el detalle sin recortar los totales, y lo avisa", () => {
    const r = resumirFacturacion(MULTIMONEDA, {
      incluir_anulados: false,
      incluir_detalle: true,
      limite_detalle: 1,
    });
    expect(r.detalle).toHaveLength(1);
    expect(r.detalle_truncado).toBe(true);
    expect(r.totales_por_moneda.UYU!.total).toBe(10_000);
    expect(r.warnings.join(" ")).toMatch(/TOTALES se calcularon sobre todos/);
  });

  it("sin detalle pedido, no devuelve comprobantes (respuesta chica por default)", () => {
    const r = resumirFacturacion(MULTIMONEDA, { incluir_anulados: false });
    expect(r.detalle).toHaveLength(0);
  });
});

describe("biller_resumen_facturacion_periodo — multimoneda y drill-down", () => {
  it("devuelve equivalente_uyu y los comprobantes cuando se piden", async () => {
    const { ctx } = makeCtx({
      response: [
        { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 10_000, tasa_cambio: "1.000", estado: "Aceptado DGI", fecha_emision: "2026-06-05", fecha_creacion: "2026-06-05 10:00:00" },
        { id: 2, tipo_comprobante: 111, moneda: "USD", total: 100, tasa_cambio: "38.397", estado: "Aceptado DGI", fecha_emision: "2026-06-10", fecha_creacion: "2026-06-10 10:00:00" },
      ],
    });

    const res = await handleResumenFacturacion(
      { periodo: "2026-06", incluir_comprobantes: true },
      ctx,
    );
    const sc = res.structuredContent!;

    const eq = sc.equivalente_uyu as { total_uyu: number; completo: boolean };
    expect(eq.total_uyu).toBe(13_839.7);
    expect(eq.completo).toBe(true);

    const comprobantes = sc.comprobantes as Array<{ id: number | null }>;
    // Las ventanas de consulta devuelven el mismo mock varias veces: la
    // deduplicación por id tiene que dejar un solo ejemplar de cada uno.
    expect(comprobantes.map((c) => c.id).sort()).toEqual([1, 2]);
    expect(sc.comprobantes_truncados).toBe(false);
  });

  it("por defecto NO incluye la lista de comprobantes", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handleResumenFacturacion({ periodo: "2026-06" }, ctx);
    expect(res.structuredContent!.comprobantes).toEqual([]);
  });
});
