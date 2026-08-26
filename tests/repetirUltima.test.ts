// =============================================================================
// V5.1 — "Facturale lo de siempre a Pérez".
// =============================================================================

import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import {
  elegirComprobanteARepetir,
  estadoDesdeComprobante,
} from "../src/services/repetirUltima.js";
import { siguientePaso } from "../src/kapso/emision.js";
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
    // Con todo copiado, lo próximo que pregunta el flujo ES la fecha.
    expect(siguientePaso(r.estado).paso).toBe("fecha");
  });

  it("NO copia adenda ni tasa de cambio", () => {
    const r = estadoDesdeComprobante(
      normalizar([venta({ adenda: "orden 442, entregar el lunes", tasa_cambio: 40.5 })])[0]!,
    );
    expect(r.estado.adenda).toBeUndefined();
    expect(r.estado.tasa_cambio).toBeUndefined();
  });
});

describe("el flujo entero: repetir → completar conceptos al emitir", () => {
  const SESION = "+59899123456";

  it("repetir_ultima_de deja el flujo a UNA pregunta (la fecha)", async () => {
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
    expect(r.paso).toBe("fecha");
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
