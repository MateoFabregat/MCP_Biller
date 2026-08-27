import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { compararPeriodos } from "../src/services/comparacion.js";
import { calcularCuentaCorriente } from "../src/services/cuentaCorriente.js";
import { construirDigest } from "../src/services/digest.js";
import { rankingClientes } from "../src/services/rankingClientes.js";
import { detectarRiesgoPlata, type AlertaPlata } from "../src/services/riesgoPlata.js";
import { handlePlataEnRiesgo } from "../src/tools/plataEnRiesgo.js";
import { makeCtx } from "./helpers.js";

interface Fila {
  id?: number;
  tipo?: number;
  rut?: string;
  nombre?: string;
  total: number;
  moneda?: string;
  emision: string;
  vencimiento?: string;
  cobranza?: 0 | 1;
}

let siguienteId = 1;

function cfe(f: Fila) {
  return {
    id: f.id ?? siguienteId++,
    tipo_comprobante: f.tipo ?? 111,
    serie: "A",
    numero: siguienteId,
    moneda: f.moneda ?? "UYU",
    total: f.total,
    estado: "Aceptado DGI",
    indicador_cobranza_propia: f.cobranza ?? 0,
    fecha_emision: f.emision,
    fecha_creacion: `${f.emision} 10:00:00`,
    fecha_vencimiento: f.vencimiento ?? null,
    cliente:
      f.rut === undefined ? [] : { documento: f.rut, razon_social: f.nombre ?? `Cliente ${f.rut}` },
  };
}

function lista(filas: Fila[]) {
  return normalizeComprobantesEmitidos(filas.map(cfe));
}

const RANGO_ACTUAL = { desde: "2026-07-01", hasta: "2026-07-31" };
const RANGO_PREVIO = { desde: "2026-06-01", hasta: "2026-06-30" };

function rankear(filas: Fila[], rango: { desde: string; hasta: string }) {
  return rankingClientes(lista(filas), { desde: rango.desde, hasta: rango.hasta, limite: 100 });
}

function tipos(alertas: AlertaPlata[]): string[] {
  return alertas.map((a) => a.tipo);
}

describe("riesgoPlata — N1 cliente bueno que se está yendo", () => {
  const previo: Fila[] = [
    { rut: "1", nombre: "Grande SA", total: 100_000, emision: "2026-06-10" },
    { rut: "2", nombre: "Fiel SRL", total: 50_000, emision: "2026-06-12" },
  ];

  it("detecta la caída contra el propio historial del cliente, no contra un monto fijo", () => {
    const actual: Fila[] = [
      { rut: "1", nombre: "Grande SA", total: 40_000, emision: "2026-07-10" }, // −60%
      { rut: "2", nombre: "Fiel SRL", total: 52_000, emision: "2026-07-12" }, // estable
    ];
    const r = detectarRiesgoPlata({
      ranking_actual: rankear(actual, RANGO_ACTUAL),
      ranking_previo: rankear(previo, RANGO_PREVIO),
    });

    const fugas = r.alertas.filter((a) => a.tipo === "cliente_en_fuga");
    expect(fugas).toHaveLength(1);
    expect(fugas[0]!.titulo).toContain("Grande SA");
    expect(fugas[0]!.monto_en_riesgo).toEqual([{ moneda: "UYU", monto: 60_000 }]);
    expect(fugas[0]!.accion).not.toBe("");
  });

  it("un cliente que desapareció del todo es crítico, no advertencia", () => {
    const r = detectarRiesgoPlata({
      ranking_actual: rankear([{ rut: "2", total: 50_000, emision: "2026-07-12" }], RANGO_ACTUAL),
      ranking_previo: rankear(previo, RANGO_PREVIO),
    });
    const fuga = r.alertas.find((a) => a.tipo === "cliente_en_fuga")!;
    expect(fuga.severidad).toBe("critica");
    expect(fuga.detalle).toMatch(/No emitió ningún comprobante/);
  });

  it("no dice nada cuando el negocio va igual (silencio si no hay novedad)", () => {
    const r = detectarRiesgoPlata({
      ranking_actual: rankear(
        [
          { rut: "1", total: 105_000, emision: "2026-07-10" },
          { rut: "2", total: 50_000, emision: "2026-07-12" },
        ],
        RANGO_ACTUAL,
      ),
      ranking_previo: rankear(previo, RANGO_PREVIO),
    });
    expect(tipos(r.alertas)).not.toContain("cliente_en_fuga");
  });
});

describe("riesgoPlata — N2 compra mucho y paga tarde", () => {
  // El cruce es el punto: ninguna de las dos mitades por separado es novedad.
  const facturas: Fila[] = [
    { id: 10, rut: "1", nombre: "Grande SA", total: 800_000, emision: "2026-04-01", vencimiento: "2026-04-30" },
    { id: 11, rut: "9", nombre: "Chico SRL", total: 5_000, emision: "2026-04-01", vencimiento: "2026-04-30" },
  ];

  it("alerta sobre el cliente grande atrasado y NO sobre el chico igual de atrasado", () => {
    const cuenta = calcularCuentaCorriente(lista(facturas), { hoy: new Date("2026-07-15T00:00:00Z") });
    const r = detectarRiesgoPlata({
      ranking_actual: rankear(facturas, { desde: "2026-04-01", hasta: "2026-07-31" }),
      cuenta,
    });

    const deudores = r.alertas.filter((a) => a.tipo === "deudor_grande");
    expect(deudores).toHaveLength(1);
    expect(deudores[0]!.titulo).toContain("Grande SA");
    expect(deudores[0]!.severidad).toBe("critica"); // > 60 días de atraso
    expect(deudores[0]!.monto_en_riesgo[0]!.monto).toBe(800_000);
  });

  it("sin cuenta corriente lo declara en la cobertura en vez de callarse", () => {
    const r = detectarRiesgoPlata({ ranking_actual: rankear(facturas, RANGO_ACTUAL) });
    const cob = r.cobertura.find((c) => c.tipo === "deudor_grande")!;
    expect(cob.evaluado).toBe(false);
    expect(cob.motivo).toMatch(/cuenta corriente/i);
  });
});

describe("riesgoPlata — N3 deuda entrando en zona incobrable", () => {
  const hoy = new Date("2026-07-15T00:00:00Z");

  it("avisa ANTES de los 90 días, con los días que faltan para cruzar", () => {
    // Vencida el 2026-05-10 -> 66 días de atraso al 15/07: dentro de la franja.
    const cuenta = calcularCuentaCorriente(
      lista([{ id: 20, rut: "1", total: 30_000, emision: "2026-04-10", vencimiento: "2026-05-10" }]),
      { hoy },
    );
    const r = detectarRiesgoPlata({
      ranking_actual: rankear([], RANGO_ACTUAL),
      cuenta,
    });
    const alerta = r.alertas.find((a) => a.tipo === "deuda_hacia_incobrable")!;
    expect(alerta.severidad).toBe("advertencia");
    expect(alerta.datos.dias_hasta_el_umbral).toBe(24);
    expect(alerta.monto_en_riesgo).toEqual([{ moneda: "UYU", monto: 30_000 }]);
  });

  it("la deuda que ya cruzó los 90 días es crítica y pide una decisión", () => {
    const cuenta = calcularCuentaCorriente(
      lista([{ id: 21, rut: "1", total: 30_000, emision: "2026-01-10", vencimiento: "2026-02-10" }]),
      { hoy },
    );
    const r = detectarRiesgoPlata({ ranking_actual: rankear([], RANGO_ACTUAL), cuenta });
    const alerta = r.alertas.find((a) => a.tipo === "deuda_hacia_incobrable")!;
    expect(alerta.severidad).toBe("critica");
    expect(alerta.accion).toMatch(/plan de pago|perdida/i);
  });

  it("la factura ya cobrada por un recibo no genera alerta", () => {
    const cuenta = calcularCuentaCorriente(
      lista([
        { id: 22, rut: "1", total: 30_000, emision: "2026-04-10", vencimiento: "2026-05-10" },
        { id: 23, rut: "1", total: 30_000, emision: "2026-05-15", cobranza: 1 },
      ]),
      { hoy },
    );
    const r = detectarRiesgoPlata({ ranking_actual: rankear([], RANGO_ACTUAL), cuenta });
    expect(tipos(r.alertas)).not.toContain("deuda_hacia_incobrable");
  });
});

describe("riesgoPlata — N4 concentración en alza", () => {
  it("avisa cuando el top 1 gana participación de un período al otro", () => {
    const previo = rankear(
      [
        { rut: "1", nombre: "Grande SA", total: 40_000, emision: "2026-06-10" },
        { rut: "2", total: 30_000, emision: "2026-06-11" },
        { rut: "3", total: 30_000, emision: "2026-06-12" },
      ],
      RANGO_PREVIO,
    );
    const actual = rankear(
      [
        { rut: "1", nombre: "Grande SA", total: 80_000, emision: "2026-07-10" },
        { rut: "2", total: 10_000, emision: "2026-07-11" },
        { rut: "3", total: 10_000, emision: "2026-07-12" },
      ],
      RANGO_ACTUAL,
    );
    const r = detectarRiesgoPlata({ ranking_actual: actual, ranking_previo: previo });
    const alerta = r.alertas.find((a) => a.tipo === "concentracion_en_alza")!;
    expect(alerta.datos.top_1_pct_anterior).toBe(40);
    expect(alerta.datos.top_1_pct_actual).toBe(80);
    expect(alerta.severidad).toBe("critica"); // pasó el 50%
  });
});

describe("riesgoPlata — N5 el mes proyecta por debajo", () => {
  it("avisa con los días que quedan y cuánto falta para igualar", () => {
    const actual = lista([{ rut: "1", total: 20_000, emision: "2026-07-05" }]);
    const anterior = lista([{ rut: "1", total: 100_000, emision: "2026-06-05" }]);
    const comparacion = compararPeriodos(actual, anterior, RANGO_ACTUAL, RANGO_PREVIO, {
      hoy: new Date("2026-07-10T00:00:00Z"),
    });
    const r = detectarRiesgoPlata({
      ranking_actual: rankear([{ rut: "1", total: 20_000, emision: "2026-07-05" }], RANGO_ACTUAL),
      comparacion,
    });
    const alerta = r.alertas.find((a) => a.tipo === "mes_por_debajo")!;
    expect(alerta.severidad).toBe("advertencia"); // quedan >= 7 días: hay margen
    expect(alerta.accion).toMatch(/clientes dormidos/i);
    expect(Number(alerta.datos.dias_restantes)).toBeGreaterThan(0);
  });
});

describe("riesgoPlata — N6 devoluciones disparadas", () => {
  it("avisa por el SALTO contra el propio período anterior, no por el nivel", () => {
    // Cliente con NC alta en ambos períodos: es su modo de operar, no una noticia.
    const estable: Fila[] = [
      { rut: "5", nombre: "Devuelve SA", total: 100_000, emision: "2026-06-05" },
      { rut: "5", tipo: 112, total: 25_000, emision: "2026-06-20" },
    ];
    const actualEstable: Fila[] = [
      { rut: "5", nombre: "Devuelve SA", total: 100_000, emision: "2026-07-05" },
      { rut: "5", tipo: 112, total: 25_000, emision: "2026-07-20" },
    ];
    const sinSalto = detectarRiesgoPlata({
      ranking_actual: rankear(actualEstable, RANGO_ACTUAL),
      ranking_previo: rankear(estable, RANGO_PREVIO),
    });
    expect(tipos(sinSalto.alertas)).not.toContain("devoluciones_disparadas");

    const conSalto = detectarRiesgoPlata({
      ranking_actual: rankear(
        [
          { rut: "5", nombre: "Devuelve SA", total: 100_000, emision: "2026-07-05" },
          { rut: "5", tipo: 112, total: 60_000, emision: "2026-07-20" },
        ],
        RANGO_ACTUAL,
      ),
      ranking_previo: rankear(
        [
          { rut: "5", nombre: "Devuelve SA", total: 100_000, emision: "2026-06-05" },
          { rut: "5", tipo: 112, total: 2_000, emision: "2026-06-20" },
        ],
        RANGO_PREVIO,
      ),
    });
    const alerta = conSalto.alertas.find((a) => a.tipo === "devoluciones_disparadas")!;
    expect(Number(alerta.datos.salto_pp)).toBeGreaterThan(10);
  });
});

// Hallazgos del code review: la alerta afirmaba hechos que no podía saber.
describe("riesgoPlata — no afirmar lo que no se puede saber", () => {
  it("un cliente que cambió de moneda NO 'se fue'", () => {
    const previo = rankear([{ rut: "1", nombre: "Grande SA", total: 100_000, emision: "2026-06-10" }], RANGO_PREVIO);
    const actual = rankear(
      [
        { rut: "1", nombre: "Grande SA", total: 2_000, moneda: "USD", emision: "2026-07-10" },
        { rut: "9", total: 500_000, emision: "2026-07-11" },
      ],
      RANGO_ACTUAL,
    );
    const alerta = detectarRiesgoPlata({ ranking_actual: actual, ranking_previo: previo }).alertas.find(
      (a) => a.tipo === "cliente_en_fuga",
    )!;

    expect(alerta.severidad).toBe("advertencia"); // no crítica
    expect(alerta.detalle).not.toMatch(/No emitió ningún comprobante/);
    expect(alerta.detalle).toMatch(/otra moneda/);
  });

  it("con el ranking recortado no afirma que el cliente no facturó", () => {
    const previo = rankear([{ rut: "1", nombre: "Grande SA", total: 100_000, emision: "2026-06-10" }], RANGO_PREVIO);
    // limite 1 sobre 2 clientes: la lista está truncada y "1" queda afuera.
    const actualRecortado = rankingClientes(
      lista([
        { rut: "9", total: 500_000, emision: "2026-07-11" },
        { rut: "1", nombre: "Grande SA", total: 1, emision: "2026-07-12" },
      ]),
      { desde: RANGO_ACTUAL.desde, hasta: RANGO_ACTUAL.hasta, limite: 1 },
    );
    const alerta = detectarRiesgoPlata({
      ranking_actual: actualRecortado,
      ranking_previo: previo,
    }).alertas.find((a) => a.tipo === "cliente_en_fuga")!;

    expect(alerta.detalle).not.toMatch(/No emitió ningún comprobante/);
    expect(alerta.severidad).toBe("advertencia");
  });

  it("lo que falta para igualar el mes se mide contra lo YA facturado", () => {
    const actual = lista([{ rut: "1", total: 20_000, emision: "2026-07-05" }]);
    const anterior = lista([{ rut: "1", total: 100_000, emision: "2026-06-05" }]);
    const comparacion = compararPeriodos(actual, anterior, RANGO_ACTUAL, RANGO_PREVIO, {
      hoy: new Date("2026-07-10T00:00:00Z"),
    });
    const alerta = detectarRiesgoPlata({
      ranking_actual: rankear([{ rut: "1", total: 20_000, emision: "2026-07-05" }], RANGO_ACTUAL),
      comparacion,
    }).alertas.find((a) => a.tipo === "mes_por_debajo")!;

    // 100.000 del mes anterior − 20.000 ya facturados = 80.000 por hacer.
    // Restar la proyección daría un número más chico y engañosamente alcanzable.
    expect(alerta.monto_en_riesgo[0]!.monto).toBe(80_000);
  });
});

describe("cuenta corriente — una reversión también es una estimación", () => {
  it("un período con solo cancelaciones no se declara de imputación exacta", () => {
    const cuenta = calcularCuentaCorriente(
      lista([
        { id: 1, rut: "1", total: 5_000, emision: "2026-07-01", cobranza: 1 },
        { id: 2, rut: "1", total: -5_000, emision: "2026-07-02", cobranza: 1 },
      ]),
      { hoy: new Date("2026-07-15T00:00:00Z") },
    );
    expect(cuenta.imputacion_exacta).toBe(false);
    expect(cuenta.estrategia).toBe("fifo");
  });

  it("un saldo a favor revertido a cero no genera el warning de saldo a favor", () => {
    const cuenta = calcularCuentaCorriente(
      lista([
        { id: 1, rut: "1", total: 5_000, emision: "2026-07-01", cobranza: 1 },
        { id: 2, rut: "1", total: -5_000, emision: "2026-07-02", cobranza: 1 },
      ]),
      { hoy: new Date("2026-07-15T00:00:00Z") },
    );
    expect(cuenta.warnings.join(" ")).not.toMatch(/no se pudieron imputar a ninguna factura/);
  });
});

describe("riesgoPlata — reglas transversales", () => {
  it("sin hallazgos devuelve la lista vacía (no inventa una alerta informativa)", () => {
    const r = detectarRiesgoPlata({
      ranking_actual: rankear([{ rut: "1", total: 100, emision: "2026-07-01" }], RANGO_ACTUAL),
      ranking_previo: rankear([{ rut: "1", total: 100, emision: "2026-06-01" }], RANGO_PREVIO),
    });
    expect(r.alertas).toEqual([]);
    expect(r.conteo_por_severidad.critica).toBe(0);
  });

  it("toda alerta trae acción y monto expuesto por moneda, sin convertir", () => {
    const cuenta = calcularCuentaCorriente(
      lista([
        { id: 30, rut: "1", nombre: "Grande SA", total: 800_000, emision: "2026-01-05", vencimiento: "2026-02-05" },
        { id: 31, rut: "1", nombre: "Grande SA", total: 5_000, moneda: "USD", emision: "2026-01-06", vencimiento: "2026-02-06" },
      ]),
      { hoy: new Date("2026-07-15T00:00:00Z") },
    );
    const r = detectarRiesgoPlata({
      ranking_actual: rankear(
        [{ rut: "1", nombre: "Grande SA", total: 800_000, emision: "2026-07-05" }],
        RANGO_ACTUAL,
      ),
      cuenta,
    });
    for (const a of r.alertas) {
      expect(a.accion.length).toBeGreaterThan(10);
    }
    const deudor = r.alertas.find((a) => a.tipo === "deudor_grande")!;
    const monedas = deudor.monto_en_riesgo.map((m) => m.moneda).sort();
    expect(monedas).toEqual(["USD", "UYU"]);
  });
});

describe("digest — sección de plata en riesgo", () => {
  it("va con monto y acción, y cuenta como accionable", () => {
    const cuenta = calcularCuentaCorriente(
      lista([{ id: 40, rut: "1", total: 30_000, emision: "2026-01-10", vencimiento: "2026-02-10" }]),
      { hoy: new Date("2026-07-15T00:00:00Z") },
    );
    const riesgo = detectarRiesgoPlata({ ranking_actual: rankear([], RANGO_ACTUAL), cuenta });
    const d = construirDigest({ fecha: "2026-07-15", riesgo });

    expect(d.secciones).toContain("plata_en_riesgo");
    expect(d.requiere_atencion).toBe(true);
    expect(d.texto).toContain("Plata en riesgo");
    expect(d.texto).toContain("$30.000");
  });

  it("sin riesgo no aparece la sección", () => {
    const d = construirDigest({ fecha: "2026-07-15" });
    expect(d.secciones).not.toContain("plata_en_riesgo");
    expect(d.texto).toContain("Sin alertas");
  });
});

describe("biller_plata_en_riesgo", () => {
  it("consulta UNA sola vez el rango que cubre los tres análisis", async () => {
    const { ctx, getMock } = makeCtx({ response: [] });
    const res = await handlePlataEnRiesgo({ periodo: "2026-07", dias_deuda: 30 }, ctx);
    const sc = res.structuredContent!;

    expect(sc.hay_riesgo).toBe(false);
    expect(sc.criterio).toBe("fecha_emision");
    expect((sc.periodo as { desde: string }).desde).toBe("2026-07-01");
    expect((sc.periodo_comparado as { desde: string }).desde).toBe("2026-06-01");

    // Todas las llamadas van al mismo endpoint de lectura: no hay N+1 por recibo.
    const paths = new Set(getMock.mock.calls.map((c) => (c[0] as { path: string }).path));
    expect([...paths]).toEqual(["/v2/comprobantes/obtener"]);
  });

  it("con incluir_deuda=false no mira la cuenta corriente y lo declara", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handlePlataEnRiesgo({ periodo: "2026-07", incluir_deuda: false }, ctx);
    const sc = res.structuredContent!;
    expect(sc.rango_deuda).toBeNull();
    const cobertura = sc.cobertura as Array<{ tipo: string; evaluado: boolean }>;
    expect(cobertura.find((c) => c.tipo === "deudor_grande")!.evaluado).toBe(false);
  });

  it("rechaza un período que no se puede interpretar", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handlePlataEnRiesgo({ periodo: "el trimestre que viene" }, ctx);
    expect(res.isError).toBe(true);
  });
});
