import { describe, expect, it } from "vitest";
import { inspectConfig } from "../src/config.js";
import { METRICAS_NULAS } from "../src/observabilidad/metricas.js";
import { validarComprobante, ComprobanteBodySchema } from "../src/biller/cfeSchema.js";
import {
  UMBRAL_UI_RECEPTOR_DEFAULT,
  VALOR_UI_REFERENCIA,
  evaluarRequisitos,
  exigeReceptor,
  resolverUmbralReceptor,
} from "../src/biller/requisitos.js";
import { handleRequisitosComprobante } from "../src/tools/requisitosComprobante.js";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { makeCtx } from "./helpers.js";
import { BorradorStoreMemoria } from "../src/kapso/borradorStore.js";

// Valor de UI plausible para 2026, usado en los tests para que el umbral sea
// un número redondo: 5000 UI * 6.30 = $31.500.
const UI = 6.3;

describe("umbral de receptor (regla de las 5.000 UI)", () => {
  it("convierte el umbral a pesos con el valor de UI configurado", () => {
    const u = resolverUmbralReceptor({ valor_ui: UI, valor_ui_fecha: "2026-07-01" });
    expect(u.umbral_ui).toBe(UMBRAL_UI_RECEPTOR_DEFAULT);
    expect(u.umbral_uyu).toBe(31_500);
    expect(u.valor_ui_configurado).toBe(true);
    expect(u.nota).toContain("2026-07-01");
  });

  // Sin valor configurado el chequeo NO se apaga: se hace con un valor bajo,
  // que hace saltar la alerta de más y no de menos.
  it("sin valor de UI configurado usa el de referencia y lo declara", () => {
    const u = resolverUmbralReceptor();
    expect(u.valor_ui).toBe(VALOR_UI_REFERENCIA);
    expect(u.valor_ui_configurado).toBe(false);
    expect(u.nota).toMatch(/REFERENCIA/);
    expect(u.umbral_uyu).toBeLessThan(31_500);
  });

  // ISSUE 05: el valor de UI puede estar vencido o ser un tipeo, y antes
  // ninguna de las dos cosas se avisaba: caía al de referencia EN SILENCIO
  // (basura) o directamente no se chequeaba (vencido).
  it("un valor absurdo (tipeo: el punto decimal corrido) se ignora y avisa", () => {
    const u = resolverUmbralReceptor({ valor_ui: 63, valor_ui_fecha: "2026-08-25" });
    expect(u.valor_ui_configurado).toBe(false);
    expect(u.problema).toBe("absurdo");
    expect(u.valor_ui).toBe(VALOR_UI_REFERENCIA);
    expect(u.nota).toMatch(/IGNORANDO BILLER_VALOR_UI=63/);
  });

  // EL VALOR ES EL DEL 1º DE ENERO, Y VALE TODO EL AÑO.
  //
  // No es una decisión nuestra ni una tolerancia elegida a ojo: el decreto de
  // facturación electrónica fija el umbral de las 5.000 UI **al valor de la UI
  // del 1º de enero del año**, justamente para que el mismo comprobante no
  // cambie de régimen a mitad de año. Antes esto se trataba como un dato de
  // mercado que se pone viejo (15 días de tolerancia), y el efecto era el
  // contrario del buscado: el valor CORRECTO —el de enero— se marcaba vencido
  // en febrero y se lo reemplazaba por el de referencia.
  it("el valor del 1º de enero vale todo el año, incluido diciembre", () => {
    for (const hoy of ["2026-01-01", "2026-09-01", "2026-12-31"]) {
      const u = resolverUmbralReceptor({ valor_ui: UI, valor_ui_fecha: "2026-01-01", hoy });
      expect(u.valor_ui_configurado, hoy).toBe(true);
      expect(u.problema, hoy).toBeNull();
      expect(u.valor_ui, hoy).toBe(UI);
    }
  });

  it("al cambiar el año, el del enero anterior SÍ vence: hay que poner el nuevo", () => {
    const u = resolverUmbralReceptor({
      valor_ui: UI,
      valor_ui_fecha: "2026-01-01",
      hoy: "2027-01-02",
    });
    expect(u.valor_ui_configurado).toBe(false);
    expect(u.problema).toBe("vencido");
    expect(u.valor_ui).toBe(VALOR_UI_REFERENCIA);
    expect(u.nota).toMatch(/1º de enero de 2027/);
  });

  it("una fecha de este año que NO es el 1º de enero se usa, pero se avisa", () => {
    // El valor de julio es más alto que el de enero, así que el umbral en pesos
    // queda MÁS ALTO y se pide receptor MENOS veces: es la dirección cara. No
    // se ignora —es lo que el operador configuró y está en rango— pero se dice
    // con todas las letras cuál es el que fija el decreto.
    const u = resolverUmbralReceptor({
      valor_ui: UI,
      valor_ui_fecha: "2026-07-01",
      hoy: "2026-09-01",
    });
    expect(u.valor_ui_configurado).toBe(true);
    expect(u.nota).toMatch(/1º de enero/);
  });

  it("sin 'hoy' no se puede evaluar el año: no se marca vencido igual", () => {
    // Callers que no pasan `hoy` (ninguno del código de producción — solo
    // fixtures viejos) no rompen: el chequeo se saltea, no se inventa un
    // vencimiento.
    const u = resolverUmbralReceptor({ valor_ui: UI, valor_ui_fecha: "2020-01-01" });
    expect(u.valor_ui_configurado).toBe(true);
  });

  it("una fecha con formato inválido NO deja usar el valor", () => {
    const u = resolverUmbralReceptor({
      valor_ui: UI,
      valor_ui_fecha: "31/12/2026",
      hoy: "2026-09-01",
    });
    // ANTES el valor se usaba igual y solo se descartaba la fecha. Con la regla
    // anual eso dejó de ser tolerable: sin fecha legible no se puede saber de
    // qué AÑO es el valor, y el error dura los doce meses en vez de quince
    // días. Se cae al de referencia —que es conservador— y se dice por qué.
    expect(u.valor_ui_configurado).toBe(false);
    expect(u.problema).toBe("formato_invalido");
    expect(u.valor_ui_fecha).toBeNull();
    expect(u.nota).toMatch(/1º de enero/);
  });

  it("un e-Ticket con BILLER_VALOR_UI absurdo igual exige receptor con el umbral de referencia", () => {
    // El bug que esto cierra: un tipeo en la UI no puede hacer que el chequeo
    // se apague. Se sigue exigiendo receptor, calculado con la referencia.
    const r = exigeReceptor(101, 40_000, { valor_ui: 630, valor_ui_fecha: "2026-08-30" });
    expect(r.exige).toBe(true);
    expect(r.umbral.valor_ui_configurado).toBe(false);
  });

  it("un e-Ticket por encima del umbral exige receptor", () => {
    const r = exigeReceptor(101, 40_000, { valor_ui: UI });
    expect(r.exige).toBe(true);
    expect(r.motivo).toMatch(/supera el umbral/);
  });

  it("un e-Ticket por debajo del umbral no lo exige", () => {
    expect(exigeReceptor(101, 5_000, { valor_ui: UI }).exige).toBe(false);
  });

  it("la e-Factura exige receptor siempre, sin importar el monto", () => {
    const r = exigeReceptor(111, 100, { valor_ui: UI });
    expect(r.exige).toBe(true);
    expect(r.motivo).toMatch(/sin importar el monto/);
  });

  // Adivinar acá es peor que no contestar: una cotización inventada puede decir
  // "no hace falta receptor" sobre una factura que sí lo necesitaba.
  it("sin importe no afirma que no haga falta: lo marca como indeterminado", () => {
    const r = exigeReceptor(101, null, { valor_ui: UI });
    expect(r.exige).toBe(false);
    expect(r.indeterminado).toBe(true);
    expect(r.motivo).toMatch(/NO se pudo verificar/);
  });
});

describe("evaluarRequisitos", () => {
  it("con el cuerpo vacío pide lo obligatorio y UNA sola pregunta", () => {
    const ev = evaluarRequisitos(101, {}, { valor_ui: UI, total_uyu: 1000 });
    expect(ev.listo_para_emitir).toBe(false);
    expect(ev.siguiente_pregunta).not.toBeNull();
    expect(ev.faltantes.map((f) => f.campo)).toContain("items");
    // A monto bajo, el cliente es recomendado, no faltante.
    expect(ev.faltantes.map((f) => f.campo)).not.toContain("cliente");
  });

  it("el mismo e-Ticket por más plata pasa a exigir el cliente", () => {
    const ev = evaluarRequisitos(101, {}, { valor_ui: UI, total_uyu: 40_000 });
    expect(ev.faltantes.map((f) => f.campo)).toContain("cliente");
    expect(ev.reglas_dgi.join(" ")).toMatch(/supera el umbral/);
  });

  it("marca listo cuando ya están todos los obligatorios", () => {
    const ev = evaluarRequisitos(
      101,
      { sucursal: 347, moneda: "UYU", items: [{ concepto: "x", cantidad: 1, precio: 100 }] },
      { valor_ui: UI, total_uyu: 100 },
    );
    expect(ev.listo_para_emitir).toBe(true);
    expect(ev.siguiente_pregunta).toBeNull();
  });

  it("no vuelve a pedir la sucursal si hay una configurada por defecto", () => {
    const ev = evaluarRequisitos(
      101,
      { moneda: "UYU", items: [{ concepto: "x", cantidad: 1, precio: 100 }] },
      { valor_ui: UI, total_uyu: 100, sucursal_por_defecto: true },
    );
    expect(ev.faltantes.map((f) => f.campo)).not.toContain("sucursal");
  });

  it("una nota de crédito pide la referencia al comprobante original", () => {
    const ev = evaluarRequisitos(112, {}, { valor_ui: UI });
    expect(ev.faltantes.map((f) => f.campo)).toContain("referencias");
    expect(ev.reglas_dgi.join(" ")).toMatch(/mutuamente excluyentes/);
  });

  it("una exportación pide modalidad, cláusula, vía y NCM por ítem", () => {
    const ev = evaluarRequisitos(
      121,
      { sucursal: 1, moneda: "USD", items: [{ concepto: "x", cantidad: 1, precio: 10 }], cliente: { documento: "1" } },
      { valor_ui: UI },
    );
    const campos = ev.faltantes.map((f) => f.campo);
    expect(campos).toContain("modalidad_venta");
    expect(campos).toContain("clausula_venta");
    expect(campos).toContain("via_transporte");
    expect(campos).toContain("items[].ncm");
  });

  it("una venta a crédito pide el vencimiento (si no, no entra a cobranzas)", () => {
    const ev = evaluarRequisitos(
      111,
      { sucursal: 1, moneda: "UYU", forma_pago: 2, items: [{ concepto: "x", cantidad: 1, precio: 1 }], cliente: { documento: "1" } },
      { valor_ui: UI },
    );
    expect(ev.faltantes.map((f) => f.campo)).toContain("fecha_vencimiento");
  });

  it("el ejemplo mínimo de una e-Factura incluye el cliente; el de un ticket chico no", () => {
    expect(evaluarRequisitos(111, {}, { valor_ui: UI }).ejemplo_minimo.cliente).toBeDefined();
    expect(
      evaluarRequisitos(101, {}, { valor_ui: UI, total_uyu: 500 }).ejemplo_minimo.cliente,
    ).toBeUndefined();
  });
});

describe("biller_requisitos_comprobante", () => {
  it("no llama a la API y devuelve la próxima pregunta", () => {
    const { ctx, getMock } = makeCtx({ response: [] });
    const res = handleRequisitosComprobante({ tipo_comprobante: 111 }, ctx);
    expect(getMock).not.toHaveBeenCalled();

    const sc = res.structuredContent!;
    expect(sc.listo_para_emitir).toBe(false);
    expect(typeof sc.siguiente_pregunta).toBe("string");
    expect(String(sc.como_sigue)).toMatch(/dry-run/);
  });

  it("rechaza un tipo de comprobante que no existe en la tabla de valores", () => {
    const { ctx } = makeCtx({ response: [] });
    const res = handleRequisitosComprobante({ tipo_comprobante: 999 }, ctx);
    expect(res.isError).toBe(true);
  });

  it("contesta aunque el server no esté configurado (sirve para el onboarding)", () => {
    const ctx = {
      getConfig: () => {
        throw new Error("sin config");
      },
      getClient: () => {
        throw new Error("sin config");
      },
      getWriteContext: () => {
        throw new Error("sin config");
      },
      getApprovalCycle: () => {
        throw new Error("sin config");
      },
      metricas: METRICAS_NULAS,
    getBorradorStore: () => new BorradorStoreMemoria(),
    // El contexto de test no viene de un env: se inspecciona uno vacío, que es la
    // verdad (no hay config de tenant detrás) y nunca el `process.env` del runner.
    inspeccionar: () => inspectConfig({}),
    };
    const res = handleRequisitosComprobante({ tipo_comprobante: 101 }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent!.requisitos).toBeDefined();
  });
});

describe("emitir: la regla del umbral llega al preview", () => {
  const cuerpo = (total: number) => ({
    tipo_comprobante: 101,
    sucursal: 347,
    moneda: "UYU",
    montos_brutos: 1,
    items: [{ concepto: "Venta mostrador", cantidad: 1, precio: total, indicador_facturacion: 3 }],
  });

  it("un e-Ticket sin cliente por encima del umbral avisa en el dry-run", async () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const res = await handleEmitirComprobante({ comprobante: cuerpo(40_000) }, ctx);
    const warnings = (res.structuredContent!.warnings as string[]).join(" ");
    expect(warnings).toMatch(/RECEPTOR OBLIGATORIO/);
  });

  it("el mismo comprobante por debajo del umbral no molesta con eso", async () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const res = await handleEmitirComprobante({ comprobante: cuerpo(1_000) }, ctx);
    const warnings = (res.structuredContent!.warnings as string[]).join(" ");
    expect(warnings).not.toMatch(/RECEPTOR OBLIGATORIO/);
  });

  it("en USD sin tasa_cambio no afirma nada sobre el umbral: lo declara indeterminado", async () => {
    const { ctx } = makeCtx({ config: { valorUi: UI } });
    const body = { ...cuerpo(10_000), moneda: "USD" };
    const parsed = ComprobanteBodySchema.parse(body);
    const warnings = validarComprobante(parsed, { total_uyu: null, valor_ui: UI }).join(" ");
    expect(warnings).toMatch(/No se pudo verificar el umbral/);
  });
});

describe("un valor de UI mal configurado no puede pasar callado", () => {
  // Los dos los encontró el code review, y los dos van en la MISMA dirección
  // cara: el umbral en pesos queda MÁS ALTO de lo que corresponde, así que un
  // e-Ticket que debía exigir receptor identificado deja de exigirlo.
  const UI_ENERO = 6.4237;

  it("una fecha de mitad de año avisa donde se lee, no solo en la nota", () => {
    // El valor de julio es más alto que el de enero. Antes la nota "OJO: el
    // decreto fija esto con la UI del 1º de enero" existía pero solo se sumaba
    // a `advertencias` cuando el valor NO se usaba: justo en el caso peligroso
    // —se usa, y por eso el umbral queda inflado— no aparecía en ningún lado
    // que el operador mire.
    const req = evaluarRequisitos(
      101,
      { moneda: "UYU" },
      { total_uyu: 33_000, valor_ui: 6.7, valor_ui_fecha: "2026-07-01", hoy: "2026-09-01" },
    );
    // El umbral con la UI de julio da $33.500, así que estos $33.000 NO lo
    // superan y el receptor pasa a ser opcional. Con la UI de enero ($6,4237)
    // el umbral es $32.118 y sí lo supera: es exactamente el caso donde la
    // fecha equivocada cambia la obligación, y donde hace falta el aviso.
    expect(req.advertencias.join(" ")).toMatch(/1º de enero/);
  });

  it("una fecha ilegible no deja usar el valor como si estuviera vigente", () => {
    // "01/01/2023" no matchea aaaa-mm-dd, así que la fecha se descartaba… y el
    // valor quedaba `configurado: true`, `problema: null`. Un valor de hace tres
    // años pasaba el gate y el health sin una palabra. Con la regla anual el
    // silencio duraba el año entero.
    const u = resolverUmbralReceptor({
      valor_ui: 5.2,
      valor_ui_fecha: "01/01/2023",
      hoy: "2026-09-01",
    });
    expect(u.valor_ui_configurado).toBe(false);
    expect(u.problema).toBe("formato_invalido");
    expect(u.valor_ui).toBe(VALOR_UI_REFERENCIA);
  });

  it("el del 1º de enero de este año sigue pasando limpio", () => {
    const u = resolverUmbralReceptor({
      valor_ui: UI_ENERO,
      valor_ui_fecha: "2026-01-01",
      hoy: "2026-09-01",
    });
    expect(u.valor_ui_configurado).toBe(true);
    expect(u.problema).toBeNull();
    expect(u.nota).not.toMatch(/OJO/);
  });
});
