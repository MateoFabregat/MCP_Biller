// =============================================================================
// V5.1 — "Facturale lo de siempre a Pérez".
// =============================================================================

import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import {
  MUESTRAS_PERFIL,
  derivarPerfilCasa,
  elegirComprobanteARepetir,
  estadoDesdeComprobante,
} from "../src/services/repetirUltima.js";
import { aplicarDefaults, siguientePaso } from "../src/kapso/emision.js";
import { handleEmisionGuiada } from "../src/tools/emisionGuiada.js";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { interpretarMensaje } from "../src/kapso/menu.js";
import { makeCtx } from "./helpers.js";

const venta = (over: Record<string, unknown> = {}) => ({
  id: 1,
  tipo_comprobante: 111,
  moneda: "UYU",
  total: 13_000,
  estado: "Aceptado DGI",
  fecha_emision: "2026-08-10 10:00:00",
  cliente: { documento: "210000000011", razon_social: "PEREZ SA" },
  ...over,
});

const normalizar = (crudos: Array<Record<string, unknown>>) =>
  normalizeComprobantesEmitidos(crudos);

describe("elegirComprobanteARepetir", () => {
  it("elige la última VENTA aceptada, no el último comprobante", () => {
    // Repetir una nota de crédito sería acreditar de nuevo; repetir un rechazo
    // sería repetir el error. "Lo de siempre" es lo que salió bien.
    const elegido = elegirComprobanteARepetir(
      normalizar([
        venta({ id: 1, fecha_emision: "2026-08-01 10:00:00" }),
        venta({ id: 2, fecha_emision: "2026-08-20 10:00:00", tipo_comprobante: 112 }), // NC
        venta({ id: 3, fecha_emision: "2026-08-18 10:00:00", estado: "Rechazado DGI" }),
        venta({ id: 4, fecha_emision: "2026-08-15 10:00:00" }),
      ]),
    );
    expect(elegido?.id).toBe(4);
  });

  it("sin ventas aceptadas devuelve null, no lo menos malo", () => {
    expect(
      elegirComprobanteARepetir(normalizar([venta({ estado: "Rechazado DGI" })])),
    ).toBeNull();
  });
});

describe("estadoDesdeComprobante", () => {
  const detalle = () =>
    normalizar([
      venta({
        montos_brutos: 1,
        items: [
          { cantidad: 2, concepto: "bolsas de harina", precio: 6500, indicador_facturacion: 3 },
          { cantidad: 1, concepto: "levadura", precio: 300, indicador_facturacion: 3 },
        ],
      }),
    ])[0]!;

  it("copia ítems, precios, IVA y montos_brutos; deduce la clase del receptor", () => {
    const r = estadoDesdeComprobante(detalle());
    expect(r.items_copiados).toBe(2);
    expect(r.estado.clase_receptor).toBe("empresa");
    expect(r.estado.documento).toBe("210000000011");
    expect(r.estado.cliente_ya_facturado).toBe(true);
    expect(r.estado.montos_brutos).toBe(true);
    expect(r.estado.items?.[0]).toEqual({
      concepto: "bolsas de harina",
      precio: 6500,
      cantidad: 2,
      indicador_facturacion: 3,
    });
    expect(r.estado.items_cerrados).toBe(true);
  });

  it("NO copia la fecha: la factura nueva es de hoy", () => {
    // Copiar la fecha vieja es el error que el TTL del borrador existe para
    // evitar — la repetición no puede reintroducirlo por otra puerta.
    const r = estadoDesdeComprobante(detalle());
    expect(r.estado.fecha_emision).toBeUndefined();

    // Y "de hoy" dejó de costar una pregunta: `aplicarDefaults` la pone. Antes
    // este era el único paso que quedaba después de copiar todo; ahora la
    // repetición va derecho al preview, que es donde la fecha se verifica.
    expect(siguientePaso(r.estado, { hoy: "26/08/2026" }).paso).toBe("confirmar");
    expect(aplicarDefaults(r.estado, { hoy: "26/08/2026" }).estado.fecha_emision).toBe("26/08/2026");
  });

  it("NO copia adenda ni tasa de cambio", () => {
    const r = estadoDesdeComprobante(
      normalizar([venta({ adenda: "orden 442, entregar el lunes", tasa_cambio: 40.5 })])[0]!,
    );
    expect(r.estado.adenda).toBeUndefined();
    expect(r.estado.tasa_cambio).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// El perfil de la casa
//
// La regla que se prueba acá es FISCAL, no de UX: `montos_brutos` decide si el
// precio que dio el usuario lleva el IVA adentro o se le suma, o sea un 22% del
// total. Defaultearlo mal produce un comprobante perfectamente bien formado por
// el importe equivocado. Por eso el criterio no es "lo más frecuente" sino
// unanimidad sobre una muestra mínima, y por eso cada caso de borde tiene su
// test: 5 iguales alcanza, 4 y 1 no, y 4 comprobantes tampoco.
// ---------------------------------------------------------------------------

describe("derivarPerfilCasa: la unanimidad que protege el 22%", () => {
  /** Una venta aceptada de la casa, con todo lo que el perfil mira. */
  const cfe = (i: number, over: Record<string, unknown> = {}) =>
    venta({
      id: 100 + i,
      // Fechas decrecientes: el perfil mira las ÚLTIMAS, así que el orden importa.
      fecha_emision: `2026-08-${String(20 - i).padStart(2, "0")} 10:00:00`,
      montos_brutos: 1,
      forma_pago: 1,
      items: [{ cantidad: 1, concepto: "algo", precio: 1000, indicador_facturacion: 3 }],
      ...over,
    });

  const cinco = (over: (i: number) => Record<string, unknown> = () => ({})) =>
    normalizar(Array.from({ length: MUESTRAS_PERFIL }, (_, i) => cfe(i, over(i))));

  it("cinco CFE aceptados que coinciden → montos_brutos se defaultea", () => {
    const p = derivarPerfilCasa(cinco());
    expect(p.muestras).toBe(5);
    expect(p.montos_brutos).toBe(true);
    expect(p.derivado).toBe(true);
    expect(p.detalles.join(" ")).toContain("montos_brutos=true");
  });

  it("cuatro iguales y uno distinto → NO se defaultea: se sigue preguntando", () => {
    // Este es el test que le importa al guardián fiscal. Cuatro de cinco es una
    // mayoría abrumadora y no alcanza: la quinta factura dice que en esta casa
    // el criterio no es uno solo, y suponerlo cambia el total un 22%.
    const p = derivarPerfilCasa(cinco((i) => (i === 2 ? { montos_brutos: 0 } : {})));
    expect(p.muestras).toBe(5);
    expect(p.montos_brutos).toBeUndefined();
    expect(p.detalles.join(" ")).toContain("NO coinciden");
  });

  it("menos de cinco comprobantes → no hay perfil, aunque todos coincidan", () => {
    const p = derivarPerfilCasa(normalizar([cfe(0), cfe(1), cfe(2), cfe(3)]));
    expect(p.muestras).toBe(4);
    expect(p.montos_brutos).toBeUndefined();
    expect(p.indicador_facturacion).toBeUndefined();
    expect(p.moneda).toBeUndefined();
    expect(p.forma_pago).toBeUndefined();
    expect(p.detalles.join(" ")).toContain("Sin perfil");
  });

  it("un campo que la API no devolvió en todos tampoco alcanza", () => {
    // Cinco comprobantes, pero solo cuatro traen el campo: son cuatro votos, no
    // cinco. "Todos los que contestaron coinciden" no es unanimidad.
    const p = derivarPerfilCasa(cinco((i) => (i === 1 ? { montos_brutos: null } : {})));
    expect(p.montos_brutos).toBeUndefined();
  });

  it("solo votan las ventas ACEPTADAS por DGI", () => {
    // Mismo criterio que cualquier total del proyecto. Un rechazo no facturó
    // nada y una nota de crédito no es una venta: si votaran, el perfil se
    // derivaría de documentos que no describen lo que la casa cobra.
    const conBasura = normalizar([
      ...Array.from({ length: MUESTRAS_PERFIL }, (_, i) => cfe(i)),
      cfe(9, { estado: "Rechazado DGI", montos_brutos: 0 }),
      cfe(10, { tipo_comprobante: 112, montos_brutos: 0 }),
    ]);
    expect(derivarPerfilCasa(conBasura).montos_brutos).toBe(true);

    // Y si el rechazo es el que hace falta para llegar a cinco, no llega.
    const sinMuestra = normalizar([
      ...Array.from({ length: 4 }, (_, i) => cfe(i)),
      cfe(4, { estado: "Rechazado DGI" }),
    ]);
    expect(derivarPerfilCasa(sinMuestra).muestras).toBe(4);
  });

  it("la tasa de IVA se deriva igual: unánime, y un comprobante mezclado no vota", () => {
    expect(derivarPerfilCasa(cinco()).indicador_facturacion).toBe(3);

    const mezclado = cinco((i) =>
      i === 0
        ? {
            items: [
              { cantidad: 1, concepto: "a", precio: 100, indicador_facturacion: 3 },
              { cantidad: 1, concepto: "b", precio: 100, indicador_facturacion: 2 },
            ],
          }
        : {},
    );
    // El comprobante con dos tasas no tiene "una tasa": sale de la muestra, y
    // sin él quedan cuatro votos, que no son cinco.
    expect(derivarPerfilCasa(mezclado).indicador_facturacion).toBeUndefined();
  });

  it("moneda y forma de pago se conforman con mayoría, pero no con un empate", () => {
    // Riesgo bajo y visible: la moneda sale en cada línea del preview y la
    // forma de pago sale escrita en la línea de supuestos.
    const mayoria = derivarPerfilCasa(cinco((i) => (i < 2 ? { moneda: "USD" } : {})));
    expect(mayoria.moneda).toBe("UYU");
    expect(mayoria.forma_pago).toBe(1);

    // 2 y 2 y 1: el más votado representa al 40% de las facturas. Eso no es una
    // costumbre, así que no se defaultea nada.
    const empate = derivarPerfilCasa(
      cinco((i) => (i < 2 ? { moneda: "USD" } : i < 4 ? { moneda: "UYU" } : { moneda: "EUR" })),
    );
    expect(empate.moneda).toBeUndefined();
  });

  it("el perfil no lleva texto de ningún comprobante: solo códigos y conteos", () => {
    // Va a salir hacia el modelo en `perfil_casa.porque`. Si arrastrara el
    // concepto o la razón social de un comprobante, la barrera de salida
    // tendría que envolverlo — y sería texto de la conversación de otra venta
    // metido en el borrador de esta.
    const p = derivarPerfilCasa(cinco());
    const texto = p.detalles.join(" ");
    expect(texto).not.toContain("algo");
    expect(texto).not.toContain("PEREZ");
  });
});

describe("el flujo entero: repetir → completar conceptos al emitir", () => {
  const SESION = "+59899123456";

  it("repetir_ultima_de deja el flujo en CERO preguntas: derecho al preview", async () => {
    const { ctx } = makeCtx({
      impl: (opts) => {
        // La misma respuesta sirve para el listado y el detalle: el detalle es
        // por id y trae items.
        return [
          venta({
            items: [
              { cantidad: 2, concepto: "bolsas de harina", precio: 6500, indicador_facturacion: 3 },
            ],
            montos_brutos: 1,
          }),
        ];
      },
    });
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          { sesion: SESION, repetir_ultima_de: "210000000011", forma_pago: 1 },
          ctx,
        )
      ).content[0]!.text,
    );
    // "Facturale lo de siempre a Pérez" ahora no pregunta NADA: los ítems, el
    // IVA y la forma de pago vienen copiados, y la fecha —lo único que faltaba—
    // es hoy por default y sale escrita en el preview.
    expect(r.paso).toBe("confirmar");
    expect(r.listo_para_requisitos).toBe(true);
    expect(r.defaults_aplicados).toContain("fecha_emision");
    // El concepto NO viaja en la respuesta: quedó en el store.
    expect(JSON.stringify(r)).not.toContain("bolsas de harina");
    expect(r.estado_entendido.items[0].concepto_cargado).toBe(true);
  });

  it("al emitir con la misma sesión, los conceptos se completan solos", async () => {
    const { ctx } = makeCtx({
      impl: () => [
        venta({
          items: [
            { cantidad: 2, concepto: "bolsas de harina", precio: 6500, indicador_facturacion: 3 },
          ],
          montos_brutos: 1,
        }),
      ],
      postResponse: { id: 99, serie: "A", numero: "1" },
      config: { environment: "test", writeEnabled: true },
    });
    const guiada = JSON.parse(
      (
        await handleEmisionGuiada(
          { sesion: SESION, repetir_ultima_de: "210000000011", forma_pago: 1 },
          ctx,
        )
      ).content[0]!.text,
    );

    // El agente arma el comprobante desde el borrador, SIN conceptos (no los
    // tiene: nunca le llegaron). El server los completa desde la sesión.
    const dry = await handleEmitirComprobante(
      {
        sesion: guiada.sesion.id,
        comprobante: {
          tipo_comprobante: 111,
          forma_pago: 1,
          sucursal: 6,
          moneda: "UYU",
          montos_brutos: 1,
          cliente: "-",
          items: [{ cantidad: 2, precio: 6500, indicador_facturacion: 3 }],
        },
      },
      ctx,
    );
    expect(dry.isError).not.toBe(true);
    const sc = dry.structuredContent as Record<string, any>;
    expect(sc.mode).toBe("dry_run");
  });

  it("un concepto que el agente SÍ mandó no se pisa", async () => {
    const { ctx, borradores } = makeCtx({
      postResponse: { id: 99 },
      config: { environment: "test", writeEnabled: true },
    });
    // Borrador con un concepto guardado…
    await handleEmisionGuiada(
      { sesion: SESION, items: [{ concepto: "harina vieja", precio: 100 }] },
      ctx,
    );
    // …pero el usuario lo cambió a último momento y el agente lo mandó.
    const args = {
      sesion: SESION,
      comprobante: {
        tipo_comprobante: 101,
        forma_pago: 1,
        sucursal: 6,
        moneda: "UYU",
        montos_brutos: 0,
        cliente: "-",
        items: [{ cantidad: 1, concepto: "harina nueva", precio: 100, indicador_facturacion: 3 }],
      },
    };
    const dry = await handleEmitirComprobante(args, ctx);
    expect(dry.isError).not.toBe(true);
    expect((args.comprobante.items[0] as any).concepto).toBe("harina nueva");
  });
});

describe("V5.2 — en_flujo", () => {
  const W = { capabilityMode: "write_enabled" as const };

  it('"pará, eran 3 no 2" en flujo es una respuesta del flujo, no desconocido', () => {
    const r = interpretarMensaje("pará, eran 3 no 2", { ...W, en_flujo: true });
    expect(r.via).toBe("flujo_emision");
    expect(r.mostrar_menu).toBe(false);
  });

  it('un número pelado en flujo contesta "¿cuántos?", no elige del menú', () => {
    const r = interpretarMensaje("3", { ...W, en_flujo: true });
    expect(r.via).toBe("flujo_emision");
  });

  it('"menú" sigue sacando del flujo: es el pedido explícito de salir', () => {
    const r = interpretarMensaje("menú", { ...W, en_flujo: true });
    expect(r.via).toBe("saludo");
    expect(r.mostrar_menu).toBe(true);
  });

  it('"cancelá" en flujo sigue frenando', () => {
    expect(interpretarMensaje("cancela", { ...W, en_flujo: true }).via).toBe("cancelacion");
  });

  it("fuera de flujo, nada cambia", () => {
    expect(interpretarMensaje("pará, eran 3 no 2", W).via).not.toBe("flujo_emision");
  });

  it('"lo de siempre" enruta a la intención de repetir', () => {
    const r = interpretarMensaje("facturale lo de siempre a perez", W);
    expect(r.opcion?.id).toBe("menu:repetir");
  });
});
