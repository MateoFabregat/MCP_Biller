import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { classifyCfe } from "../src/services/cfeTypes.js";
import { resumirFacturacion } from "../src/services/resumenFacturacion.js";
import { handleResumenFacturacion } from "../src/tools/resumenFacturacion.js";
import { EMITIDOS_CON_ESTADO } from "./fixtures.js";
import { makeCtx } from "./helpers.js";

// Todos llevan estado "Aceptado DGI" a propósito: desde que el criterio de
// estado se unificó (solo "Aceptado DGI" suma, ver `estadoDgi.ts`), un fixture
// sin `estado` no entra en ningún total, y estos casos miden signos y monedas,
// no el filtro de estado.
const VENTAS_Y_NOTAS = [
  { tipo_comprobante: 101, moneda: "UYU", total: 1000, estado: "Aceptado DGI" }, // venta +1000
  { tipo_comprobante: 111, moneda: "UYU", total: 500, estado: "Aceptado DGI" }, //  venta  +500
  { tipo_comprobante: 102, moneda: "UYU", total: 200, estado: "Aceptado DGI" }, //  NC     -200
  { tipo_comprobante: 103, moneda: "UYU", total: 50, estado: "Aceptado DGI" }, //   ND     +50
  { tipo_comprobante: 101, moneda: "USD", total: 30, estado: "Aceptado DGI" }, //   venta USD
];

describe("classifyCfe", () => {
  it("clasifica ventas (+1), NC (-1), ND (+1), especiales y desconocidos (0)", () => {
    expect(classifyCfe(101).signo).toBe(1);
    expect(classifyCfe(111).categoria).toBe("venta");
    expect(classifyCfe(102).signo).toBe(-1);
    expect(classifyCfe(112).categoria).toBe("nota_credito");
    expect(classifyCfe(103).signo).toBe(1);
    expect(classifyCfe(113).categoria).toBe("nota_debito");
    expect(classifyCfe(181).categoria).toBe("especial");
    expect(classifyCfe(181).suma_en_resumen).toBe(false);
    expect(classifyCfe(999).categoria).toBe("desconocido");
    expect(classifyCfe(null).categoria).toBe("desconocido");
  });

  // Un recibo se emite como e-Ticket (101) o e-Factura (111): por tipo es
  // idéntico a una venta. Lo único que lo distingue es el indicador.
  it("clasifica como cobranza (0) el CFE con indicador_cobranza_propia=1", () => {
    expect(classifyCfe(111, 1).categoria).toBe("cobranza");
    expect(classifyCfe(111, 1).signo).toBe(0);
    expect(classifyCfe(111, 1).suma_en_resumen).toBe(false);
    expect(classifyCfe(111, 1).etiqueta).toBe("Recibo de e-Factura");
    expect(classifyCfe(101, 1).etiqueta).toBe("Recibo de e-Ticket");
  });

  it("trata el indicador en 0, null o ausente como venta normal", () => {
    expect(classifyCfe(111, 0).categoria).toBe("venta");
    expect(classifyCfe(111, null).categoria).toBe("venta");
    expect(classifyCfe(111).categoria).toBe("venta");
  });
});

describe("resumirFacturacion (servicio)", () => {
  // Requisito #9
  it("suma ventas, resta notas de crédito y suma notas de débito", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });

    expect(r.totales_por_moneda.UYU!.total).toBe(1350); // 1000 + 500 - 200 + 50
    expect(r.totales_por_moneda.UYU!.comprobantes).toBe(4);
    expect(r.totales_por_tipo_comprobante["102"]!.signo).toBe(-1);
    expect(r.totales_por_tipo_comprobante["102"]!.total_por_moneda.UYU).toBe(-200);
    expect(r.totales_por_tipo_comprobante["103"]!.signo).toBe(1);
  });

  // El bug que esto evita: facturar 1000 a crédito y cobrarlo con un recibo de
  // 1000 reportaba 2000 facturados, porque el recibo es un CFE tipo 111.
  it("NO suma los recibos a la facturación: van aparte, en cobrado_por_moneda", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Aceptado DGI" },
      {
        tipo_comprobante: 111,
        moneda: "UYU",
        total: 1000,
        estado: "Aceptado DGI",
        indicador_cobranza_propia: 1,
      },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false });

    expect(r.totales_por_moneda.UYU).toEqual({ total: 1000, comprobantes: 1 });
    expect(r.cobrado_por_moneda.UYU).toEqual({ total: 1000, comprobantes: 1 });
    expect(r.totales_por_tipo_comprobante["111"]!.total_por_moneda.UYU).toBe(1000);
    expect(r.warnings.some((w) => w.includes("1 recibo(s) de cobranza"))).toBe(true);
  });

  it("no cuenta como cobrado un recibo que DGI no aceptó", () => {
    const list = normalizeComprobantesEmitidos([
      {
        tipo_comprobante: 111,
        moneda: "UYU",
        total: 700,
        estado: "Rechazado DGI",
        indicador_cobranza_propia: 1,
      },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.cobrado_por_moneda).toEqual({});
  });

  // Requisito #10
  it("separa por moneda y NO convierte", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(Object.keys(r.totales_por_moneda).sort()).toEqual(["USD", "UYU"]);
    expect(r.totales_por_moneda.USD!.total).toBe(30);
    expect(r.no_convertir_moneda).toBe(true);
  });

  // Requisito #11
  it("advierte que no puede excluir anulados (sin campo de estado)", () => {
    const list = normalizeComprobantesEmitidos(VENTAS_Y_NOTAS);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.warnings.some((w) => w.toLowerCase().includes("anulad"))).toBe(true);
  });

  // Criterio por defecto: solo "Aceptado DGI", que es como Biller muestra sus
  // propios totales. Contar rechazados/pendientes da un número que no coincide.
  it("por defecto cuenta SOLO los aceptados por DGI", () => {
    const list = normalizeComprobantesEmitidos(EMITIDOS_CON_ESTADO);
    const r = resumirFacturacion(list, { incluir_anulados: false });

    expect(r.solo_aceptados).toBe(true);
    expect(r.totales_por_moneda.UYU!.total).toBe(1000); // solo el aceptado
    // El total con todos los estados queda disponible para comparar.
    expect(r.totales_por_moneda_todos_los_estados.UYU!.total).toBe(1800);
    expect(r.conteo_por_estado["Aceptado DGI"]).toBe(1);
    expect(r.conteo_por_estado["Rechazado DGI"]).toBe(1);
    expect(r.conteo_por_estado["Pendiente DGI"]).toBe(1);
    expect(r.warnings.some((w) => /Aceptado DGI/.test(w) && /excluyeron/i.test(w))).toBe(true);
  });

  it("con solo_aceptados=false suma todo y avisa que no coincidirá con Biller", () => {
    const list = normalizeComprobantesEmitidos(EMITIDOS_CON_ESTADO);
    const r = resumirFacturacion(list, { incluir_anulados: false, solo_aceptados: false });

    expect(r.totales_por_moneda.UYU!.total).toBe(1800);
    expect(r.warnings.some((w) => /no va a coincidir/i.test(w))).toBe(true);
  });

  // El criterio unificado: un estado que no sabemos leer NO suma. Antes sí
  // sumaba acá y no sumaba en los rankings, y los dos números convivían.
  // Lo que hace tolerable la exclusión es el aviso, con el monto adentro.
  it("NO cuenta los comprobantes sin estado, y avisa cuántos y cuánto sumaban", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 111, moneda: "UYU", total: 100 },
      { tipo_comprobante: 111, moneda: "UYU", total: 400, estado: "Aceptado DGI" },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.totales_por_moneda.UYU!.total).toBe(400);
    // El total de referencia con todos los estados sigue mostrando los 500.
    expect(r.totales_por_moneda_todos_los_estados.UYU!.total).toBe(500);

    const aviso = r.warnings.find((w) => /SIN un estado DGI reconocible/i.test(w));
    expect(aviso).toBeDefined();
    expect(aviso).toMatch(/\$100/); // cuánto se dejó afuera, no solo cuántos
    expect(aviso).toMatch(/NO se contaron/);
  });

  // Con solo_aceptados=false el desconocido vuelve a entrar, y el aviso cambia
  // de sentido en vez de desaparecer.
  it("con solo_aceptados=false el estado desconocido cuenta y el aviso lo dice", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 111, moneda: "UYU", total: 100 },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false, solo_aceptados: false });
    expect(r.totales_por_moneda.UYU!.total).toBe(100);
    expect(r.warnings.some((w) => /Están contados en el total/i.test(w))).toBe(true);
  });

  // Un recibo sin estado reconocible tampoco entra en `cobrado_por_moneda`:
  // lo cobrado también se compara contra el panel de Biller.
  it("aplica el mismo criterio de estado a los recibos de cobranza", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 111, moneda: "UYU", total: 500, indicador_cobranza_propia: 1 },
      {
        tipo_comprobante: 111,
        moneda: "UYU",
        total: 300,
        indicador_cobranza_propia: 1,
        estado: "Aceptado DGI",
      },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.cobrado_por_moneda.UYU!.total).toBe(300);
    expect(r.warnings.some((w) => /fuera de 'cobrado_por_moneda'/i.test(w))).toBe(true);
  });

  it("no avisa de no aceptados cuando todos están aceptados", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Aceptado DGI" },
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: false });
    expect(r.warnings.some((w) => /excluyeron/i.test(w))).toBe(false);
  });

  // El corte que responde "¿cuánto vendí en cada lugar?".
  it("agrupa por sucursal y usa los nombres configurados", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 101, moneda: "UYU", total: 1000, sucursal: 6, estado: "Aceptado DGI" },
      { tipo_comprobante: 101, moneda: "UYU", total: 400, sucursal: 6, estado: "Aceptado DGI" },
      { tipo_comprobante: 101, moneda: "UYU", total: 250, sucursal: 7, estado: "Aceptado DGI" },
      { tipo_comprobante: 102, moneda: "UYU", total: 100, sucursal: 7, estado: "Aceptado DGI" },
    ]);
    const r = resumirFacturacion(list, {
      incluir_anulados: false,
      agrupar_por: ["sucursal"],
      nombres_sucursal: { "6": "Pocitos", "7": "Centro" },
    });

    expect(r.grupos).toHaveLength(2);
    // Ordenados por total descendente.
    expect(r.grupos[0]!.clave.sucursal).toBe("6");
    expect(r.grupos[0]!.etiqueta).toBe("Sucursal 6 (Pocitos)");
    expect(r.grupos[0]!.totales_por_moneda.UYU!.total).toBe(1400);
    expect(r.grupos[1]!.etiqueta).toBe("Sucursal 7 (Centro)");
    // La nota de crédito resta también dentro del grupo.
    expect(r.grupos[1]!.totales_por_moneda.UYU!.total).toBe(150);
  });

  it("agrupa por mes cruzado con sucursal", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 101, moneda: "UYU", total: 100, sucursal: 6, fecha_emision: "2026-06-10", estado: "Aceptado DGI" },
      { tipo_comprobante: 101, moneda: "UYU", total: 200, sucursal: 6, fecha_emision: "2026-07-02", estado: "Aceptado DGI" },
    ]);
    const r = resumirFacturacion(list, {
      incluir_anulados: false,
      agrupar_por: ["sucursal", "mes"],
    });
    expect(r.grupos).toHaveLength(2);
    expect(r.grupos.map((g) => g.clave.mes).sort()).toEqual(["2026-06", "2026-07"]);
  });

  it("excluye y advierte por falta de campos, especiales y no clasificables", () => {
    const list = normalizeComprobantesEmitidos([
      { tipo_comprobante: 101, moneda: "UYU", total: null, estado: "Aceptado DGI" }, // falta total
      { tipo_comprobante: 181, moneda: "UYU", total: 100, estado: "Aceptado DGI" }, // especial
      { tipo_comprobante: 999, moneda: "UYU", total: 100, estado: "Aceptado DGI" }, // desconocido
      { tipo_comprobante: 101, moneda: "UYU", total: 100, estado: "Aceptado DGI" }, // incluido
    ]);
    const r = resumirFacturacion(list, { incluir_anulados: true });
    expect(r.conteo_incluidos).toBe(1);
    expect(r.conteo_excluidos).toBe(3);
    expect(r.totales_por_moneda.UYU!.total).toBe(100);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe("biller_resumen_facturacion_periodo (tool)", () => {
  /**
   * Las mismas ventas, fechadas dentro de junio para pasar el filtro de emisión.
   * Llevan `id` porque es la clave con la que se deduplican las ventanas de
   * consulta (la API real siempre lo devuelve).
   */
  const VENTAS_JUNIO = VENTAS_Y_NOTAS.map((c, i) => ({
    ...c,
    id: 1000 + i,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15",
  }));

  it("integra fetch + agregación end-to-end", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_JUNIO });
    const res = await handleResumenFacturacion({ desde: "2026-06-01", hasta: "2026-06-30" }, ctx);

    expect(res.isError).toBeUndefined();
    expect(getMock.mock.calls[0]![0].path).toBe("/v2/comprobantes/obtener");
    const sc = res.structuredContent!;
    expect((sc.totales_por_moneda as Record<string, { total: number }>).UYU!.total).toBe(1350);
    expect((sc.totales_por_moneda as Record<string, { total: number }>).USD!.total).toBe(30);
    expect(sc.no_convertir_moneda).toBe(true);
    expect(sc.fuente).toBe("biller:/v2/comprobantes/obtener");
    expect((sc.periodo as { criterio: string }).criterio).toBe("fecha_emision");
  });

  it("acepta 'periodo' como mes y lo resuelve al rango completo", async () => {
    const { ctx } = makeCtx({ response: VENTAS_JUNIO });
    const res = await handleResumenFacturacion({ periodo: "2026-06" }, ctx);

    expect(res.isError).toBeUndefined();
    const periodo = res.structuredContent!.periodo as { desde: string; hasta: string };
    expect(periodo.desde).toBe("2026-06-01");
    expect(periodo.hasta).toBe("2026-06-30");
  });

  // La API filtra por fecha de CREACIÓN, así que se consulta con margen y se
  // filtra localmente por emisión: si no, una venta del 30/06 cargada el 02/07
  // quedaría afuera sin aviso.
  it("consulta un rango de creación más amplio que el período de emisión", async () => {
    const { ctx } = makeCtx({ response: VENTAS_JUNIO });
    const res = await handleResumenFacturacion({ periodo: "2026-06" }, ctx);

    const consultado = res.structuredContent!.rango_consultado_por_creacion as {
      desde: string;
      hasta: string;
    };
    expect(consultado.desde < "2026-06-01").toBe(true);
    expect(consultado.hasta > "2026-06-30").toBe(true);
  });

  it("parte los períodos largos en ventanas y deduplica por id", async () => {
    const { ctx, getMock } = makeCtx({
      response: [
        { id: 1, tipo_comprobante: 101, moneda: "UYU", total: 100, estado: "Aceptado DGI", fecha_emision: "2026-06-15" },
      ],
    });
    const res = await handleResumenFacturacion({ periodo: "2026-06" }, ctx);

    // Junio + margen -> varias ventanas de 7 días.
    expect(getMock.mock.calls.length).toBeGreaterThan(1);
    expect(res.structuredContent!.ventanas_consultadas as number).toBeGreaterThan(1);
    // El mismo comprobante vuelve en cada ventana: debe contarse una sola vez.
    expect((res.structuredContent!.totales_por_moneda as Record<string, { total: number }>).UYU!.total).toBe(100);
  });

  // Regresión: deduplicar por una clave compuesta (tipo+serie+número) colapsaba
  // ventas distintas que compartían esos campos. Perder una venta real de un
  // total fiscal es peor que arriesgar un duplicado.
  it("no descarta comprobantes distintos que vienen sin id", async () => {
    const { ctx } = makeCtx({
      response: [
        { tipo_comprobante: 101, moneda: "UYU", total: 1000, estado: "Aceptado DGI", fecha_emision: "2026-06-15" },
        { tipo_comprobante: 101, moneda: "USD", total: 30, estado: "Aceptado DGI", fecha_emision: "2026-06-15" },
      ],
    });
    const res = await handleResumenFacturacion({ desde: "2026-06-15", hasta: "2026-06-15" }, ctx);

    const totales = res.structuredContent!.totales_por_moneda as Record<string, { total: number }>;
    expect(totales.UYU!.total).toBe(1000);
    expect(totales.USD!.total).toBe(30);
    expect((res.structuredContent!.warnings as string[]).some((w) => /sin 'id'/.test(w))).toBe(true);
  });

  it("colapsa repeticiones idénticas sin id que devuelven varias ventanas", async () => {
    const { ctx } = makeCtx({
      response: [
        { tipo_comprobante: 101, moneda: "UYU", total: 1000, estado: "Aceptado DGI", fecha_emision: "2026-06-15" },
      ],
    });
    // Junio completo -> varias ventanas, todas devolviendo el mismo comprobante.
    const res = await handleResumenFacturacion({ periodo: "2026-06" }, ctx);

    expect((res.structuredContent!.ventanas_consultadas as number) > 1).toBe(true);
    const totales = res.structuredContent!.totales_por_moneda as Record<string, { total: number }>;
    expect(totales.UYU!.total).toBe(1000);
  });

  it("rechaza un período que no puede interpretar", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_JUNIO });
    const res = await handleResumenFacturacion({ periodo: "el mes pasado más o menos" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rechaza desde/hasta con formato inválido", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_Y_NOTAS });
    const res = await handleResumenFacturacion({ desde: "ayer", hasta: "hoy" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rechaza un período invertido", async () => {
    const { ctx, getMock } = makeCtx({ response: VENTAS_Y_NOTAS });
    const res = await handleResumenFacturacion({ desde: "2026-06-30", hasta: "2026-06-01" }, ctx);
    expect(res.isError).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });
});
