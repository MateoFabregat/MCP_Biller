// =============================================================================
// Comparación de períodos, proyección de cierre, exposición cambiaria y
// ranking de proveedores.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  normalizeComprobantesEmitidos,
  normalizeComprobantesRecibidos,
} from "../src/biller/normalize.js";
import { compararPeriodos } from "../src/services/comparacion.js";
import { rankingProveedores } from "../src/services/proveedores.js";
import { periodoAnterior } from "../src/services/periodo.js";

function emitido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Math.random(),
    tipo_comprobante: 111,
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: "2026-06-15",
    ...over,
  };
}

const RANGO_ACTUAL = { desde: "2026-07-01", hasta: "2026-07-31" };
const RANGO_ANTERIOR = { desde: "2026-06-01", hasta: "2026-06-30" };

function comparar(
  act: Array<Record<string, unknown>>,
  ant: Array<Record<string, unknown>>,
  opts = {},
) {
  return compararPeriodos(
    normalizeComprobantesEmitidos(act),
    normalizeComprobantesEmitidos(ant),
    RANGO_ACTUAL,
    RANGO_ANTERIOR,
    opts,
  );
}

describe("período anterior automático", () => {
  it("un mes completo da el mes previo", () => {
    expect(periodoAnterior({ desde: "2026-07-01", hasta: "2026-07-31" })).toEqual({
      desde: "2026-06-01",
      hasta: "2026-06-30",
    });
  });

  it("marzo se compara contra febrero completo, aunque tenga menos días", () => {
    // Es la comparación que hace cualquier contador. Forzar "los 31 días
    // anteriores" daría un rango que arranca el 29 de enero: no significa nada.
    expect(periodoAnterior({ desde: "2026-03-01", hasta: "2026-03-31" })).toEqual({
      desde: "2026-02-01",
      hasta: "2026-02-28",
    });
  });

  it("enero se compara contra diciembre del año anterior", () => {
    expect(periodoAnterior({ desde: "2026-01-01", hasta: "2026-01-31" })).toEqual({
      desde: "2025-12-01",
      hasta: "2025-12-31",
    });
  });

  it("un rango que NO es mes completo usa la ventana previa del mismo largo", () => {
    // "Últimos 7 días" contra los 7 previos: acá sí, comparar largos distintos
    // sería el error.
    expect(periodoAnterior({ desde: "2026-07-10", hasta: "2026-07-16" })).toEqual({
      desde: "2026-07-03",
      hasta: "2026-07-09",
    });
  });
});

describe("variaciones", () => {
  it("calcula la variación porcentual", () => {
    const r = comparar([emitido({ total: 1500 })], [emitido({ total: 1000 })]);
    const uyu = r.variaciones.find((v) => v.moneda === "UYU")!;
    expect(uyu.absoluta).toBe(500);
    expect(uyu.porcentual).toBe(50);
    expect(uyu.lectura).toContain("subió");
  });

  it("una caída se reporta como caída", () => {
    const r = comparar([emitido({ total: 500 })], [emitido({ total: 1000 })]);
    expect(r.variaciones[0]!.porcentual).toBe(-50);
    expect(r.variaciones[0]!.lectura).toContain("bajó");
  });

  it("período anterior en cero da null, NO infinito", () => {
    // "Creció ∞%" no es una respuesta: es que no hay base de comparación.
    const r = comparar([emitido({ total: 1000 })], []);
    expect(r.variaciones[0]!.porcentual).toBeNull();
    expect(r.variaciones[0]!.lectura).toContain("no había facturación");
  });

  it("compara POR MONEDA, sin mezclar", () => {
    const r = comparar(
      [emitido({ total: 1000, moneda: "UYU" }), emitido({ total: 100, moneda: "USD" })],
      [emitido({ total: 2000, moneda: "UYU" }), emitido({ total: 50, moneda: "USD" })],
    );
    expect(r.variaciones).toHaveLength(2);
    expect(r.variaciones.find((v) => v.moneda === "UYU")!.porcentual).toBe(-50);
    expect(r.variaciones.find((v) => v.moneda === "USD")!.porcentual).toBe(100);
  });

  it("las notas de crédito restan y los recibos no cuentan", () => {
    const r = comparar(
      [
        emitido({ total: 1000 }),
        emitido({ total: 300, tipo_comprobante: 112 }),
        emitido({ total: 5000, indicador_cobranza_propia: 1 }),
      ],
      [emitido({ total: 700 })],
    );
    expect(r.actual.total_por_moneda["UYU"]).toBe(700);
    expect(r.variaciones[0]!.porcentual).toBe(0);
  });

  it("excluye los no aceptados por defecto", () => {
    const r = comparar([emitido({ total: 1000 }), emitido({ total: 9999, estado: "Rechazado DGI" })], []);
    expect(r.actual.total_por_moneda["UYU"]).toBe(1000);
  });

  it("el aviso de estado no cuenta documentos sin total o moneda", () => {
    const r = comparar(
      [
        emitido({ id: 1, total: 1000 }),
        emitido({ id: 2, estado: null, total: 500 }),
        emitido({ id: 3, estado: null, total: null }),
        emitido({ id: 4, estado: null, moneda: null }),
      ],
      [emitido({ id: 5, total: 500 })],
    );
    const warning = r.warnings.find((w) => w.includes("estado DGI reconocible"));
    expect(warning).toContain("1 comprobante(s) del período actual");
    expect(warning).toContain("0 del anterior");
    // La regresión no cambia los importes ni el conteo que sí son válidos.
    expect(r.actual.total_por_moneda).toEqual({ UYU: 1000 });
    expect(r.anterior.total_por_moneda).toEqual({ UYU: 500 });
    expect(r.actual.comprobantes).toBe(1);
  });
});

describe("proyección de cierre", () => {
  it("proyecta cuando el período sigue ABIERTO", () => {
    // 10 días transcurridos de 31, facturado 10.000 -> ~31.000 proyectado.
    //
    // La fecha va explícita: el fixture traía la de junio por default, o sea un
    // comprobante fuera del período que igual sumaba al total. Andaba de casualidad
    // mientras la proyección solo miraba la suma; al empezar a mirar QUÉ DÍA se
    // facturó, el fixture quedó al descubierto.
    const r = comparar(
      [emitido({ total: 10_000, fecha_emision: "2026-07-10" })],
      [emitido({ total: 20_000 })],
      { hoy: new Date("2026-07-10T12:00:00Z") },
    );
    expect(r.proyeccion).not.toBeNull();
    expect(r.proyeccion!.dias_transcurridos).toBe(10);
    expect(r.proyeccion!.dias_del_periodo).toBe(31);
    expect(r.proyeccion!.promedio_diario).toBe(1000);

    // EL NÚMERO CAMBIÓ A PROPÓSITO: antes daba 31.000 (1000/día × 31 días).
    //
    // Los 10.000 se facturaron un viernes, y en los 10 días corridos hubo dos
    // de fin de semana sin facturar un peso. Con eso, lo único que dicen los
    // datos es "hábil 1250, finde 0", y quedan 15 hábiles y 6 findes:
    // 10.000 + 15 × 1250 = 28.750. El run-rate calendario le asignaba plata a
    // seis días en los que este negocio, hasta donde se sabe, no factura.
    expect(r.proyeccion!.proyectado_al_cierre).toBe(28_750);
    expect(r.proyeccion!.promedio_habil).toBe(1250);
    expect(r.proyeccion!.promedio_finde).toBe(0);
    expect(r.proyeccion!.variacion_proyectada_pct).toBe(43.75);
  });

  it("NO proyecta un período ya cerrado", () => {
    // Proyectar algo terminado no es una proyección: es el dato.
    const r = comparar([emitido({ total: 10_000 })], [], { hoy: new Date("2026-08-15T12:00:00Z") });
    expect(r.proyeccion).toBeNull();
    expect(r.warnings.some((w) => w.includes("ya está cerrado"))).toBe(true);
  });

  it("la proyección viaja con su advertencia sobre el método", () => {
    const r = comparar([emitido({ total: 10_000, fecha_emision: "2026-07-10" })], [], {
      hoy: new Date("2026-07-10T12:00:00Z"),
    });
    expect(r.proyeccion!.metodo).toBe("run_rate_por_dia_de_semana");
    // La advertencia tiene que decir de dónde salió el número, no solo que es
    // aproximado: sin los dos promedios, un total distinto al run-rate obvio
    // parece un error de cálculo.
    expect(r.proyeccion!.advertencia).toContain("días hábiles");
    expect(r.proyeccion!.advertencia).toContain("fines de semana");
    expect(r.proyeccion!.advertencia).toContain("no como compromiso");
  });
});

describe("exposición cambiaria", () => {
  it("convierte usando la tasa del propio comprobante", () => {
    const r = comparar(
      [
        emitido({ total: 1000, moneda: "USD", tasa_cambio: "40.000" }),
        emitido({ total: 40_000, moneda: "UYU" }),
      ],
      [],
    );
    const usd = r.exposicion_cambiaria.find((e) => e.moneda === "USD")!;
    expect(usd.total_moneda_extranjera).toBe(1000);
    expect(usd.equivalente_local).toBe(40_000);
    expect(usd.tasa_promedio_ponderada).toBe(40);
  });

  it("la moneda local NO genera exposición", () => {
    const r = comparar([emitido({ total: 50_000, moneda: "UYU" })], []);
    expect(r.exposicion_cambiaria).toEqual([]);
  });

  it("calcula la sensibilidad a movimientos de la cotización", () => {
    const r = comparar([emitido({ total: 1000, moneda: "USD", tasa_cambio: "40.000" })], []);
    const usd = r.exposicion_cambiaria[0]!;
    const diez = usd.sensibilidad.find((s) => s.variacion_pct === 10)!;
    expect(diez.impacto_local).toBe(4000);
    const menosCinco = usd.sensibilidad.find((s) => s.variacion_pct === -5)!;
    expect(menosCinco.impacto_local).toBe(-2000);
  });

  it("un comprobante en USD sin tasa se avisa en vez de asumir 1:1", () => {
    // Asumir 1:1 daría un equivalente absurdamente bajo y sin ninguna señal.
    const r = comparar([emitido({ total: 1000, moneda: "USD", tasa_cambio: null })], []);
    expect(r.exposicion_cambiaria[0]!.equivalente_local).toBe(0);
    expect(r.warnings.some((w) => w.includes("no traen tasa de cambio"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

function recibido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo: 111,
    serie: "A",
    numero: 1,
    estado: "AE",
    fecha: "2026-06-10",
    rut_emisor: "210000000011",
    moneda: "UYU",
    total_neto: 1000,
    total_iva: 220,
    monto_total: 1220,
    total_retenido: 0,
    ...over,
  };
}

function proveedores(lista: Array<Record<string, unknown>>, opts = {}) {
  return rankingProveedores(normalizeComprobantesRecibidos(lista), opts);
}

describe("ranking de proveedores", () => {
  it("agrupa por RUT y ordena por monto", () => {
    const r = proveedores([
      recibido({ rut_emisor: "A", monto_total: 500 }),
      recibido({ rut_emisor: "B", monto_total: 2000, numero: 2 }),
      recibido({ rut_emisor: "A", monto_total: 500, numero: 3 }),
    ]);
    expect(r.proveedores.map((p) => p.rut_emisor)).toEqual(["B", "A"]);
    expect(r.proveedores[1]!.total_por_moneda["UYU"]).toBe(1000);
    expect(r.proveedores[1]!.comprobantes).toBe(2);
  });

  it("acumula IVA crédito y retenciones", () => {
    const r = proveedores([recibido({ total_iva: 220, total_retenido: 50 })]);
    expect(r.iva_credito_por_moneda["UYU"]).toBe(220);
    expect(r.retenciones_por_moneda["UYU"]).toBe(50);
  });

  it("una nota de crédito recibida reduce compra, IVA y retenciones", () => {
    const r = proveedores([
      recibido({ tipo: 111, monto_total: 1220, total_neto: 1000, total_iva: 220, total_retenido: 50 }),
      recibido({ tipo: 112, numero: 2, monto_total: 610, total_neto: 500, total_iva: 110, total_retenido: 20 }),
    ]);
    expect(r.total_por_moneda.UYU).toBe(610);
    expect(r.iva_credito_por_moneda.UYU).toBe(110);
    expect(r.retenciones_por_moneda.UYU).toBe(30);
  });

  it("no invierte dos veces una NC recibida que ya viene con importes negativos", () => {
    const r = proveedores([
      recibido({ tipo: 112, monto_total: -610, total_neto: -500, total_iva: -110, total_retenido: -20 }),
    ]);
    expect(r.total_por_moneda.UYU).toBe(-610);
    expect(r.iva_credito_por_moneda.UYU).toBe(-110);
    expect(r.retenciones_por_moneda.UYU).toBe(-20);
  });

  it("excluye los recibidos rechazados por DGI", () => {
    const r = proveedores([
      recibido({ monto_total: 1000 }),
      recibido({ monto_total: 9999, estado: "Rechazado DGI", numero: 2 }),
    ]);
    expect(r.total_por_moneda["UYU"]).toBe(1000);
    expect(r.warnings.some((w) => w.includes("rechazados"))).toBe(true);
  });

  it("SIEMPRE avisa que es devengado y no pagado", () => {
    // Es el caveat central de la tool: sin él, el número se lee como deuda.
    const r = proveedores([recibido()]);
    expect(r.warnings.some((w) => w.includes("DEVENGADO"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("cuánto le debo"))).toBe(true);
  });

  it("calcula la concentración del top 3", () => {
    const r = proveedores([
      recibido({ rut_emisor: "A", monto_total: 700 }),
      recibido({ rut_emisor: "B", monto_total: 200, numero: 2 }),
      recibido({ rut_emisor: "C", monto_total: 50, numero: 3 }),
      recibido({ rut_emisor: "D", monto_total: 50, numero: 4 }),
    ]);
    expect(r.concentracion_top_3_pct).toBe(95);
  });

  it("no convierte monedas", () => {
    const r = proveedores([
      recibido({ moneda: "UYU", monto_total: 1000 }),
      recibido({ moneda: "USD", monto_total: 100, numero: 2 }),
    ]);
    expect(r.total_por_moneda).toEqual({ UYU: 1000, USD: 100 });
    expect(r.warnings.some((w) => w.includes("NO se convierten"))).toBe(true);
  });

  it("una lista vacía no rompe", () => {
    const r = proveedores([]);
    expect(r.proveedores).toEqual([]);
    expect(r.concentracion_top_3_pct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proyección: el patrón semanal se aprende de los datos, no se supone.
//
// El plan (A5) pedía run-rate "sobre días hábiles" y el código dividía por días
// calendario. Las dos son una suposición sobre cuándo trabaja el negocio, y en
// Uruguay las dos se equivocan: el almacén factura los sábados y el estudio
// contable no.
// ---------------------------------------------------------------------------

describe("proyección de cierre por patrón semanal", () => {
  // Julio 2026: el 1 cae miércoles. Del 1 al 14 hay 10 hábiles y 4 de finde
  // (sáb 4, dom 5, sáb 11, dom 12).
  const HOY = new Date("2026-07-14T12:00:00Z");

  /** Un comprobante por día del 1 al 14, con el monto que diga `porDia`. */
  const hasta14 = (porDia: (iso: string, finde: boolean) => number) => {
    const out: Array<Record<string, unknown>> = [];
    for (let d = 1; d <= 14; d += 1) {
      const iso = `2026-07-${String(d).padStart(2, "0")}`;
      const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
      const monto = porDia(iso, dow === 0 || dow === 6);
      if (monto > 0) out.push(emitido({ fecha_emision: iso, total: monto }));
    }
    return out;
  };

  it("un negocio que NO factura los findes no proyecta findes", () => {
    // Estudio contable: 1000 cada día hábil, cero los sábados y domingos.
    // Antes, el promedio calendario (10.000/14 = 714) proyectaba plata en días
    // en los que este negocio no factura un peso.
    const r = comparar(hasta14((_iso, finde) => (finde ? 0 : 1000)), [], { hoy: HOY });
    expect(r.proyeccion?.metodo).toBe("run_rate_por_dia_de_semana");
    expect(r.proyeccion?.promedio_finde).toBe(0);
    expect(r.proyeccion?.promedio_habil).toBe(1000);
    // 23 días hábiles en julio 2026 × 1000. Ni un peso de fin de semana.
    expect(r.proyeccion?.proyectado_al_cierre).toBe(23_000);
  });

  it("un almacén que factura fuerte los sábados SÍ los proyecta", () => {
    // El caso que "días hábiles" habría roto: el finde es el mejor día.
    const r = comparar(hasta14((_iso, finde) => (finde ? 3000 : 1000)), [], { hoy: HOY });
    expect(r.proyeccion?.promedio_finde).toBe(3000);
    expect(r.proyeccion?.promedio_habil).toBe(1000);
    // 22.000 corridos + 13 hábiles × 1000 + 4 findes × 3000 = 47.000.
    expect(r.proyeccion?.proyectado_al_cierre).toBe(47_000);

    // Y NO coincide con el promedio plano — que es el punto. Acá da MENOS,
    // aunque el finde pague el triple, porque de los 17 días que faltan solo 4
    // son de fin de semana contra 4 de 14 en lo ya transcurrido. El run-rate
    // calendario no puede ver esa diferencia: promedia todos los días iguales.
    const plano = Math.round(((10 * 1000 + 4 * 3000) / 14) * 31);
    expect(r.proyeccion!.proyectado_al_cierre).toBeLessThan(plano);
  });

  it("sin un finde transcurrido NO se inventa un cero: se declara", () => {
    // El 2 de julio es jueves: todavía no pasó ningún sábado. Afirmar
    // "promedio_finde = 0" sería afirmar que el negocio cierra los sábados, que
    // es justo lo que no se sabe todavía.
    const r = comparar([emitido({ fecha_emision: "2026-07-01", total: 1000 })], [], {
      hoy: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.proyeccion?.metodo).toBe("run_rate_lineal");
    expect(r.proyeccion?.promedio_finde).toBeNull();
    expect(r.proyeccion?.advertencia).toContain("factura sábados");
  });

  it("un período cerrado sigue sin proyectar nada", () => {
    const r = comparar(hasta14(() => 1000), [], { hoy: new Date("2026-09-01T12:00:00Z") });
    expect(r.proyeccion).toBeNull();
  });
});
