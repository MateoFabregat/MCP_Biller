// =============================================================================
// GUARDA DE EQUIVALENCIA: optimizar la consulta no puede mover un número.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// Las tres optimizaciones de consulta —la ventana compartida (`services/
// ventana.ts`), la grilla global de cache (`services/periodo.ts`) y el detalle
// por id en paralelo (`biller/traerDetalles.ts`)— cambian CÓMO se pide la
// información, nunca CUÁL. Pero las tres tocan el camino por el que pasa cada
// total que este producto le muestra a un dueño de almacén, y un error ahí no
// se ve: el número sigue teniendo forma de número.
//
// Los tests unitarios de cada tool prueban su lógica con listas armadas a mano.
// Lo que NO prueban es la cadena entera —resolver período → ventanear →
// deduplicar → recortar por emisión → agregar— sobre un dataset con la forma
// de la API real (listado SIN `items`, detalle por `id` CON `items`, fechas de
// creación distintas de las de emisión, recibos que imputan por concepto).
//
// Este archivo congela la salida COMPLETA de las tres tools más caras sobre ese
// dataset. Si una optimización mueve un peso, acá sale rojo.
//
// QUÉ SE EXCLUYE DEL SNAPSHOT, Y POR QUÉ
//
// `ventanas_consultadas` y los warnings que hablan de ventanas SÍ pueden
// cambiar: son la unidad de trabajo, no el resultado. La grilla global cambia
// dónde caen los cortes. Todo lo demás —cada total, cada conteo, cada fila de
// detalle, cada saldo— está adentro y tiene que quedar idéntico.
//
// EL ORDEN DE LAS LISTAS SE CONGELA APARTE
//
// Las listas de comprobantes salen en el orden en que la deduplicación los fue
// viendo, o sea en orden de VENTANA de creación. Ese orden nunca fue una
// promesa —cambiaba según qué período se pidiera, porque los cortes arrancaban
// en `rango.desde`— pero sí decide QUÉ filas sobreviven a un `limite_detalle`.
//
// Así que va en dos snapshots: el del CONTENIDO, con las listas ordenadas por
// id (ahí no puede moverse ni un peso), y el del ORDEN, aparte. Un cambio de
// orden tiene que verse y decidirse; no tiene que poder esconderse adentro de
// un diff de cuatro mil líneas.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillerGetOptions } from "../src/biller/client.js";
import { handleCuentaCorriente } from "../src/tools/cuentaCorriente.js";
import { handleRankingProductos } from "../src/tools/rankingProductos.js";
import { handleResumenFacturacion } from "../src/tools/resumenFacturacion.js";
import type { ToolResult } from "../src/tools/shared.js";
import { makeCtx } from "./helpers.js";

// --- El dataset -------------------------------------------------------------

const DIA_MS = 86_400_000;
/** Ancla del dataset. Fijo: un snapshot que depende del reloj no es una guarda. */
const HOY = new Date("2026-07-15T12:00:00Z");
const INICIO = Date.parse("2026-03-02T00:00:00Z");

const CLIENTES = [
  { id: 1, tipo_documento: "RUT", documento: "217832560011", razon_social: "Carbonell SA" },
  { id: 2, tipo_documento: "RUT", documento: "210475730011", razon_social: "ANCAP" },
  { id: 3, tipo_documento: "RUT", documento: "179414290004", razon_social: "Distribuidora del Este" },
];

const PRODUCTOS = [
  { codigo: "P1", concepto: "Acero inoxidable" },
  { codigo: "P2", concepto: "Tornillo Phillips" },
  { codigo: "P3", concepto: "Chapa galvanizada" },
];

const SUCURSALES = [347, 912];

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 60 comprobantes con la forma REAL de la API.
 *
 * Mezcla deliberada: e-Ticket y e-Factura, notas de crédito, recibos de
 * cobranza propia, dos monedas, dos sucursales, tres clientes, estados
 * distintos, contado y crédito, y una fecha de creación que va hasta tres días
 * por detrás de la de emisión (que es lo que obliga al margen y al recorte
 * local).
 */
function construirDataset(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 60; i += 1) {
    const emision = INICIO + i * 2 * DIA_MS;
    const creacion = emision + (i % 4) * DIA_MS;
    const esRecibo = i % 9 === 4;
    const esNc = !esRecibo && i % 13 === 11;
    const tipo = esNc ? 112 : i % 3 === 0 ? 101 : 111;
    const moneda = i % 5 === 0 ? "USD" : "UYU";
    const total = 1000 + i * 137;
    const contado = i % 7 === 3;
    const prod = PRODUCTOS[i % PRODUCTOS.length]!;
    const prodExtra = PRODUCTOS[(i + 1) % PRODUCTOS.length]!;

    const items = esRecibo
      ? [
          {
            codigo: null,
            // Así es como Biller escribe la imputación de un recibo: en el
            // CONCEPTO del ítem, no en un campo `referencias`.
            concepto: `Cobro e-Factura A-${1000 + i - 1}`,
            cantidad: "1.000",
            precio: String(total),
          },
        ]
      : [
          {
            id: 900000 + i * 2,
            codigo: prod.codigo,
            concepto: prod.concepto,
            cantidad: String(1 + (i % 4)),
            precio: String(100 + (i % 7) * 10),
            impuesto_tasa: "0.220",
          },
          ...(i % 3 === 0
            ? [
                {
                  id: 900001 + i * 2,
                  codigo: prodExtra.codigo,
                  concepto: prodExtra.concepto,
                  cantidad: "2.000",
                  precio: String(250 + (i % 5) * 5),
                  impuesto_tasa: "0.220",
                },
              ]
            : []),
        ];

    out.push({
      id: 50000 + i,
      tipo_comprobante: tipo,
      serie: "A",
      numero: 1000 + i,
      moneda,
      tasa_cambio: moneda === "USD" ? "40.500" : null,
      indicador_cobranza_propia: esRecibo ? 1 : 0,
      tot_iva_tasa_min: 0,
      tot_iva_tasa_bas: Math.round(total * 0.18),
      tot_iva_tasa_otra: null,
      descuentosRecargos: null,
      total: String(total),
      estado: i % 11 === 10 ? "Pendiente DGI" : "Aceptado DGI",
      sucursal: SUCURSALES[i % SUCURSALES.length],
      cliente: CLIENTES[i % CLIENTES.length],
      esNotaAjuste: esNc,
      fecha_creacion: `${iso(creacion)} 10:00:00`,
      fecha_emision: iso(emision),
      fecha_vencimiento: esRecibo || contado ? null : iso(emision + 15 * DIA_MS),
      cae: { numero: "76747726", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: "2027-01-01" },
      items,
    });
  }
  return out;
}

const DATASET = construirDataset();

/**
 * Fake de la API con su asimetría más importante: el LISTADO no trae `items`,
 * el detalle por `id` sí. Sin eso el N+1 de productos no se ejercitaría.
 */
function responder(o: BillerGetOptions): unknown {
  const q = (o.query ?? {}) as Record<string, string | undefined>;

  if (q.id !== undefined) {
    const encontrado = DATASET.find((c) => String(c.id) === String(q.id));
    return encontrado === undefined ? [] : [encontrado];
  }

  const desde = String(q.desde ?? "0000-01-01").slice(0, 10);
  const hasta = String(q.hasta ?? "9999-12-31").slice(0, 10);
  return DATASET.filter((c) => {
    const creacion = String(c.fecha_creacion).slice(0, 10);
    if (creacion < desde || creacion > hasta) return false;
    if (q.sucursal !== undefined && String(c.sucursal) !== String(q.sucursal)) return false;
    return true;
  }).map(({ items: _items, ...resto }) => ({ ...resto, items: null }));
}

function contexto() {
  return makeCtx({
    impl: responder,
    config: { sucursales: { "347": "Pocitos", "912": "Centro" } },
  });
}

// --- Normalización ----------------------------------------------------------

/** Un warning que habla de cuántas ventanas se pidieron: es costo, no resultado. */
const HABLA_DE_VENTANAS = /ventanas/i;

/** ¿Es una lista de comprobantes, o sea algo con `id` adentro? */
function esListaConId(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((e) => typeof e === "object" && e !== null && "id" in e)
  );
}

/** Ordena por id toda lista de comprobantes, a cualquier profundidad. */
function ordenarListas(valor: unknown): unknown {
  if (esListaConId(valor)) {
    return [...valor]
      .sort((a, b) => Number(a.id ?? Number.MAX_SAFE_INTEGER) - Number(b.id ?? Number.MAX_SAFE_INTEGER))
      .map(ordenarListas);
  }
  if (Array.isArray(valor)) return valor.map(ordenarListas);
  if (typeof valor === "object" && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, ordenarListas(v)]),
    );
  }
  return valor;
}

/**
 * Saca del snapshot lo único que una optimización de consulta PUEDE mover.
 * Todo lo demás queda adentro y tiene que ser idéntico.
 */
function soloResultado(res: ToolResult): Record<string, unknown> {
  const structured = res.structuredContent;
  if (structured === undefined) throw new Error("la tool no devolvió structuredContent");
  const { ventanas_consultadas: _v, warnings, ...resto } = structured as Record<string, unknown> & {
    warnings?: string[];
  };
  return {
    ...(ordenarListas(resto) as Record<string, unknown>),
    warnings: (warnings ?? []).filter((w) => !HABLA_DE_VENTANAS.test(w)),
  };
}

/** El orden en que salieron las listas de comprobantes, congelado aparte. */
function ordenDeIds(res: ToolResult): Record<string, Array<number | null>> {
  const out: Record<string, Array<number | null>> = {};
  for (const [clave, valor] of Object.entries(res.structuredContent ?? {})) {
    if (esListaConId(valor)) out[clave] = valor.map((e) => (e.id as number | null) ?? null);
  }
  return out;
}

// --- Los casos congelados ---------------------------------------------------

beforeAll(() => {
  // Solo `Date`: los timers reales siguen andando, así que nada se cuelga
  // esperando un setTimeout que nadie avanza.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOY);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("biller_resumen_facturacion_periodo no cambia ni un peso", () => {
  it("mes completo, agrupado por sucursal y moneda, con detalle", async () => {
    const { ctx } = contexto();
    const res = await handleResumenFacturacion(
      {
        periodo: "2026-05",
        agrupar_por: ["sucursal", "moneda"],
        incluir_comprobantes: true,
      },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("rango largo por desde/hasta, todos los estados", async () => {
    const { ctx } = contexto();
    const res = await handleResumenFacturacion(
      { desde: "2026-03-02", hasta: "2026-06-27", solo_aceptados: false, agrupar_por: ["mes"] },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("filtrado a una sucursal", async () => {
    const { ctx } = contexto();
    const res = await handleResumenFacturacion({ periodo: "2026-04", sucursal: "347" }, ctx);
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });
});

describe("biller_cuenta_corriente no cambia un saldo", () => {
  it("defaults: imputa por referencias leídas del detalle de cada recibo", async () => {
    const { ctx } = contexto();
    const res = await handleCuentaCorriente({ dias_atras: 200 }, ctx);
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("sin imputación por referencias: FIFO, sin el N+1", async () => {
    const { ctx } = contexto();
    const res = await handleCuentaCorriente(
      { dias_atras: 200, imputar_por_referencias: false },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("incluyendo canceladas y contado", async () => {
    const { ctx } = contexto();
    const res = await handleCuentaCorriente(
      { dias_atras: 200, incluir_canceladas: true, solo_a_credito: false },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });
});

describe("biller_ranking_productos no cambia un ranking", () => {
  it("período largo, N+1 completo", async () => {
    const { ctx } = contexto();
    const res = await handleRankingProductos(
      { desde: "2026-03-02", hasta: "2026-06-27", max_comprobantes: 60 },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("truncado por max_comprobantes: la cobertura declarada también se congela", async () => {
    const { ctx } = contexto();
    const res = await handleRankingProductos(
      { desde: "2026-03-02", hasta: "2026-06-27", max_comprobantes: 12 },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });

  it("una sola moneda, ordenado por USD", async () => {
    const { ctx } = contexto();
    const res = await handleRankingProductos(
      { desde: "2026-03-02", hasta: "2026-06-27", moneda: "USD", limite: 10 },
      ctx,
    );
    expect(soloResultado(res)).toMatchSnapshot("contenido");
    expect(ordenDeIds(res)).toMatchSnapshot("orden");
  });
});
