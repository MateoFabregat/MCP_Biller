// =============================================================================
// La ventana compartida: el preámbulo de once tools, y la grilla que hace que
// dos preguntas seguidas no bajen dos veces lo mismo.
//
// EL NÚMERO QUE ESTE ARCHIVO CUIDA
//
// Una conversación real de WhatsApp —"¿cómo viene el mes?", "¿quién me debe?",
// "¿quién me compra más?"— bajaba 75 ventanas y NINGUNA se repetía: cada tool
// partía el período arrancando en su propio `desde`, así que tres consultas
// sobre datos casi idénticos no compartían ni una clave de cache.
//
// El test de abajo lo mide. Si alguien vuelve a anclar la partición al origen
// del rango, ese número sube y acá sale rojo.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillerGetOptions } from "../src/biller/client.js";
import { resolverRango, traerVentana, traerVentanaAmplia } from "../src/services/ventana.js";
import { handleCuentaCorriente } from "../src/tools/cuentaCorriente.js";
import { handleRankingClientes } from "../src/tools/rankingClientes.js";
import { handleResumenFacturacion } from "../src/tools/resumenFacturacion.js";
import { makeCtx } from "./helpers.js";

const HOY = new Date("2026-08-26T12:00:00Z");

beforeAll(() => {
  // Solo `Date`: los timers reales siguen andando y nada queda esperando un
  // setTimeout que nadie avanza.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOY);
});

afterAll(() => {
  vi.useRealTimers();
});

/** Un contexto cuyo cliente registra qué rangos de fecha se pidieron de verdad. */
function contextoQueRegistra() {
  const rangos: string[] = [];
  const fx = makeCtx({
    impl: (o: BillerGetOptions) => {
      const q = (o.query ?? {}) as Record<string, string | undefined>;
      if (q.id === undefined) {
        rangos.push(`${String(q.desde).slice(0, 10)}..${String(q.hasta).slice(0, 10)}`);
      }
      return [];
    },
  });
  return { ...fx, rangos };
}

function contadorCache(fx: ReturnType<typeof makeCtx>, resultado: "hit" | "miss"): number {
  const muestra = fx.metricas
    .instantanea()
    .muestras.find((m) => m.nombre === "cache.ventana" && m.etiquetas.resultado === resultado);
  return muestra?.valor ?? 0;
}

// ---------------------------------------------------------------------------
// Lo que la grilla vino a arreglar
// ---------------------------------------------------------------------------

describe("dos períodos solapados comparten ventanas", () => {
  it("la segunda consulta encuentra en memoria lo que trajo la primera", async () => {
    const fx = contextoQueRegistra();

    await traerVentana(fx.ctx, { rango: { desde: "2026-05-01", hasta: "2026-06-30" } });
    const trasLaPrimera = fx.rangos.length;
    expect(contadorCache(fx, "hit")).toBe(0);

    // Un período DISTINTO que se solapa casi entero con el anterior. Antes
    // producía cortes distintos y bajaba todo de nuevo.
    await traerVentana(fx.ctx, { rango: { desde: "2026-05-10", hasta: "2026-06-20" } });

    expect(contadorCache(fx, "hit")).toBeGreaterThan(0);
    // Y lo que importa: se pidieron MENOS ventanas que la primera vez, aunque
    // el rango sea casi el mismo.
    expect(fx.rangos.length - trasLaPrimera).toBeLessThan(trasLaPrimera);
  });

  it("la misma consulta dos veces no le pide nada a la API la segunda vez", async () => {
    const fx = contextoQueRegistra();
    const rango = { desde: "2026-05-01", hasta: "2026-05-31" };

    await traerVentana(fx.ctx, { rango });
    const primera = fx.rangos.length;
    await traerVentana(fx.ctx, { rango });

    expect(fx.rangos.length).toBe(primera);
    expect(contadorCache(fx, "hit")).toBe(primera);
  });

  it("`sinCache` vuelve a pedir todo: es el paso previo a algo que sale hacia afuera", async () => {
    const fx = contextoQueRegistra();
    const rango = { desde: "2026-05-01", hasta: "2026-05-31" };

    await traerVentana(fx.ctx, { rango });
    const primera = fx.rangos.length;
    await traerVentana(fx.ctx, { rango, sinCache: true });

    expect(fx.rangos.length).toBe(primera * 2);
  });
});

describe("la conversación de verdad", () => {
  // mes -> deudores -> clientes, que es la secuencia que se ve en producción.
  it("baja bastante menos que una ventana por pregunta", async () => {
    const fx = contextoQueRegistra();

    await handleResumenFacturacion({ periodo: "mes_actual" }, fx.ctx);
    await handleCuentaCorriente({ imputar_por_referencias: false }, fx.ctx);
    const antesDeClientes = fx.rangos.length;
    await handleRankingClientes({ periodo: "ultimos_90_dias" }, fx.ctx);

    // El ranking de clientes son 15 ventanas de consulta. Después de haber
    // preguntado por el mes y por los deudores, casi todas ya están en memoria:
    // antes de la grilla se bajaban las 15 de nuevo.
    expect(fx.rangos.length - antesDeClientes).toBeLessThanOrEqual(3);

    // Medido: 75 descargas antes de la grilla, 58 después. El número exacto
    // depende de en qué día del mes caiga `hoy`; el techo no.
    expect(fx.rangos.length).toBeLessThan(70);
    expect(contadorCache(fx, "hit")).toBeGreaterThan(10);
  });

  it("nunca se pide dos veces el mismo rango en la misma conversación", async () => {
    const fx = contextoQueRegistra();
    await handleResumenFacturacion({ periodo: "mes_actual" }, fx.ctx);
    await handleRankingClientes({ periodo: "ultimos_90_dias" }, fx.ctx);
    expect(new Set(fx.rangos).size).toBe(fx.rangos.length);
  });
});

// ---------------------------------------------------------------------------
// Aislamiento: el cache es del proceso, el contador es de la empresa
// ---------------------------------------------------------------------------

describe("dos empresas", () => {
  it("no comparten ventanas: cada `cacheId` es su propio universo", async () => {
    const a = contextoQueRegistra();
    const b = contextoQueRegistra();
    const rango = { desde: "2026-05-01", hasta: "2026-05-31" };

    await traerVentana(a.ctx, { rango });
    await traerVentana(b.ctx, { rango });

    // La empresa B pidió TODO a la API: nada de lo de A le sirvió.
    expect(b.rangos.length).toBe(a.rangos.length);
    expect(contadorCache(b, "hit")).toBe(0);
  });

  it("el contador de cache de una no cuenta el uso de la otra", async () => {
    // Un contador global de proceso le mostraría a una empresa cuánto consulta
    // la otra, que es información comercial de un tercero.
    const a = contextoQueRegistra();
    const b = contextoQueRegistra();

    await traerVentana(a.ctx, { rango: { desde: "2026-05-01", hasta: "2026-05-31" } });
    await traerVentana(a.ctx, { rango: { desde: "2026-05-01", hasta: "2026-05-31" } });

    expect(contadorCache(a, "hit")).toBeGreaterThan(0);
    expect(contadorCache(b, "hit") + contadorCache(b, "miss")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// El default de sucursal, que vivía copiado quince veces
// ---------------------------------------------------------------------------

describe("sucursal", () => {
  it("aplica el default de la empresa cuando no se pide ninguna", async () => {
    const fx = makeCtx({ response: [], config: { defaultSucursalId: "347" } });
    const v = await traerVentana(fx.ctx, { rango: { desde: "2026-05-01", hasta: "2026-05-07" } });
    expect(v.sucursal).toBe("347");
    expect((fx.getMock.mock.calls[0]![0] as BillerGetOptions).query!.sucursal).toBe("347");
  });

  it("lo que se pide explícitamente le gana al default", async () => {
    const fx = makeCtx({ response: [], config: { defaultSucursalId: "347" } });
    const v = await traerVentana(fx.ctx, {
      rango: { desde: "2026-05-01", hasta: "2026-05-07" },
      sucursal: "912",
    });
    expect(v.sucursal).toBe("912");
  });

  it("`null` ignora el default a propósito: es lo que necesita el ranking de sucursales", async () => {
    // Sin esta salida, el ranking de locales de una empresa con default
    // configurado mostraría siempre un solo local con participación 100%.
    const fx = makeCtx({ response: [], config: { defaultSucursalId: "347" } });
    const v = await traerVentana(fx.ctx, {
      rango: { desde: "2026-05-01", hasta: "2026-05-07" },
      sucursal: null,
    });
    expect(v.sucursal).toBeUndefined();
    expect((fx.getMock.mock.calls[0]![0] as BillerGetOptions).query!.sucursal).toBeUndefined();
  });

  it("una sucursal distinta es otra clave de cache", async () => {
    const fx = contextoQueRegistra();
    const rango = { desde: "2026-05-01", hasta: "2026-05-31" };
    await traerVentana(fx.ctx, { rango, sucursal: "347" });
    const primera = fx.rangos.length;
    await traerVentana(fx.ctx, { rango, sucursal: "912" });
    expect(fx.rangos.length).toBe(primera * 2);
  });
});

// ---------------------------------------------------------------------------
// El recorte fiscal, que es lo que hace que el número coincida con Biller
// ---------------------------------------------------------------------------

describe("recorte por fecha de emisión", () => {
  const CRUDOS = [
    // Emitida DENTRO del período pero cargada después: la consulta por creación
    // la trae gracias al margen, y el recorte la deja adentro.
    { id: 1, tipo_comprobante: 111, total: 100, moneda: "UYU", fecha_emision: "2026-05-30", fecha_creacion: "2026-06-02 10:00:00" },
    // Emitida FUERA del período y cargada adentro del rango de consulta: tiene
    // que quedar afuera. Es exactamente el comprobante que inflaría un total.
    { id: 2, tipo_comprobante: 111, total: 999, moneda: "UYU", fecha_emision: "2026-04-28", fecha_creacion: "2026-05-02 10:00:00" },
  ];

  it("deja adentro lo emitido en el período y saca lo de afuera", async () => {
    const fx = makeCtx({ response: CRUDOS });
    const v = await traerVentana(fx.ctx, { rango: { desde: "2026-05-01", hasta: "2026-05-31" } });
    expect(v.comprobantes.map((c) => c.id)).toEqual([1]);
    // Y lo crudo sigue disponible para quien mira varios sub-rangos.
    expect(v.crudos.map((c) => c.id).sort()).toEqual([1, 2]);
  });

  it("`traerVentanaAmplia` NO recorta, pero deja el recorte a mano", async () => {
    const fx = makeCtx({ response: CRUDOS });
    const v = await traerVentanaAmplia(fx.ctx, { rango: { desde: "2026-04-01", hasta: "2026-05-31" } });
    expect(v.comprobantes.map((c) => c.id).sort()).toEqual([1, 2]);
    expect(v.recorte({ desde: "2026-05-01", hasta: "2026-05-31" }).map((c) => c.id)).toEqual([1]);
    // Sin recorte no hay warning de recorte: no habla de un período que no es.
    expect(v.warnings_recorte).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// El preámbulo suelto
// ---------------------------------------------------------------------------

describe("resolverRango", () => {
  it("resuelve una expresión de período", () => {
    expect(resolverRango({ periodo: "2026-06" })).toEqual({
      ok: true,
      rango: { desde: "2026-06-01", hasta: "2026-06-30" },
    });
  });

  it("acepta desde/hasta explícitos", () => {
    expect(resolverRango({ desde: "2026-06-05", hasta: "2026-06-09" })).toEqual({
      ok: true,
      rango: { desde: "2026-06-05", hasta: "2026-06-09" },
    });
  });

  it("por defecto desde/hasta le gana a `periodo`, porque `periodo` suele venir de un default de schema", () => {
    const r = resolverRango({ periodo: "2026-01", desde: "2026-06-05", hasta: "2026-06-09" });
    expect(r).toEqual({ ok: true, rango: { desde: "2026-06-05", hasta: "2026-06-09" } });
  });

  it('con prioridad "periodo" gana `periodo`, que es lo que documenta el resumen', () => {
    const r = resolverRango({
      periodo: "2026-01",
      desde: "2026-06-05",
      hasta: "2026-06-09",
      prioridad: "periodo",
    });
    expect(r).toEqual({ ok: true, rango: { desde: "2026-01-01", hasta: "2026-01-31" } });
  });

  it("explica qué se aceptaba cuando no entiende la expresión", () => {
    const r = resolverRango({ periodo: "el mes pasado más o menos" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mes_pasado");
  });

  it("rechaza el rango invertido en vez de devolver silencio", () => {
    // Un rango invertido no devuelve cero resultados: devuelve cero ventanas.
    const r = resolverRango({ desde: "2026-06-30", hasta: "2026-06-01" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invertido");
  });

  it("pide el período cuando no vino ninguno", () => {
    const r = resolverRango({ desde: "2026-06-01" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Falta el período");
  });
});
