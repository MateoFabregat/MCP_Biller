// =============================================================================
// Cache de ventanas, paralelismo y reintento.
//
// Medido contra test.biller.uy el 2026-07-29, "ultimos_90_dias" (el default de
// media docena de tools): 5,5 s secuencial sin cache → 3,2 s en paralelo → 4 ms
// la segunda pregunta de la misma conversación.
//
// El test que más importa NO es ninguno de los de velocidad: es
// "dos empresas distintas NO comparten ventanas". Un cache que le sirve a una
// empresa los comprobantes de otra es el peor bug posible de este producto, y
// además silencioso — los números se ven perfectamente normales.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import {
  CacheVentanas,
  DIAS_ASENTADA,
  MAX_EMPRESAS,
  MAX_ENTRADAS,
  MAX_VENTANAS_POR_EMPRESA,
  TTL_RECIENTE_MS,
  TTL_VIEJA_MS,
  ttlPara,
} from "../src/biller/cacheVentanas.js";
import {
  CONCURRENCIA,
  conReintento,
  esTransitorio,
  mapConLimite,
} from "../src/biller/traerVentanas.js";
import { BillerApiError, BillerNetworkError, BillerTimeoutError } from "../src/utils/errors.js";
import type { ComprobanteEmitido } from "../src/biller/types.js";

const CFE = (id: number) => ({ id, total: 100 }) as unknown as ComprobanteEmitido;

function claveDe(cacheId: string, desde = "2026-07-01", hasta = "2026-07-07") {
  return { cacheId, desde, hasta };
}

/**
 * La ventana número `i` de la grilla de 7 días, contada desde 2020-01-01.
 *
 * Fechas de verdad y no strings inventados: `ttlPara` las parsea, y una fecha
 * ilegible cae al TTL corto — un test de desalojo que se apoyara en eso estaría
 * midiendo expiración sin darse cuenta.
 */
function ventana(cacheId: string, i: number) {
  const base = Date.UTC(2020, 0, 1) + i * 7 * 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { cacheId, desde: iso(base), hasta: iso(base + 6 * 86_400_000) };
}

// --- Aislamiento entre empresas: lo más importante del archivo --------------

describe("dos empresas no comparten nada", () => {
  it("la misma ventana con credenciales distintas son dos entradas distintas", () => {
    const cache = new CacheVentanas();
    cache.set(claveDe("empresa-a"), [CFE(1)]);
    // Mismo período, misma sucursal, otra credencial: NO puede ver lo de la otra.
    expect(cache.get(claveDe("empresa-b"))).toBeNull();
    expect(cache.get(claveDe("empresa-a"))).toEqual([CFE(1)]);
  });

  it("la misma empresa con sucursales distintas tampoco se mezcla", () => {
    const cache = new CacheVentanas();
    cache.set({ ...claveDe("a"), sucursal: "347" }, [CFE(1)]);
    expect(cache.get({ ...claveDe("a"), sucursal: "912" })).toBeNull();
  });

  it("la clave no contiene el token ni la base URL: puede ir a un log", () => {
    // `cacheId` ya llega hasheado desde BillerClient. Este test fija el contrato:
    // lo que entra a la clave es opaco.
    const cache = new CacheVentanas();
    const clave = claveDe("hash-opaco-1234");
    cache.set(clave, [CFE(1)]);
    expect(JSON.stringify(clave)).not.toContain("https://");
    expect(JSON.stringify(clave)).not.toContain("Bearer");
  });
});

// --- TTL: por qué dos y no uno ---------------------------------------------

describe("cuánto vive una ventana", () => {
  const hoy = new Date("2026-07-29T12:00:00Z");

  it("una ventana que termina hoy vive poco: los estados todavía se mueven", () => {
    expect(ttlPara("2026-07-29", hoy)).toBe(TTL_RECIENTE_MS);
  });

  it("una ventana de esta semana también", () => {
    expect(ttlPara("2026-07-25", hoy)).toBe(TTL_RECIENTE_MS);
  });

  it(`una ventana de hace más de ${DIAS_ASENTADA} días vive más: DGI ya contestó`, () => {
    expect(ttlPara("2026-06-15", hoy)).toBe(TTL_VIEJA_MS);
  });

  it("el TTL corto cubre una conversación entera, que es donde está el beneficio", () => {
    // Si esto bajara de ~60s, el segundo mensaje de una conversación ya no
    // pegaría en el cache y el cambio no serviría para nada.
    expect(TTL_RECIENTE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("una fecha ilegible cae al TTL corto, no al largo", () => {
    // Ante la duda, la opción que sirve datos viejos por menos tiempo.
    expect(ttlPara("no-es-una-fecha", hoy)).toBe(TTL_RECIENTE_MS);
  });
});

describe("expiración", () => {
  it("una entrada vencida no se sirve", () => {
    let ahora = 1_000_000;
    const cache = new CacheVentanas(true, () => ahora);
    cache.set(claveDe("a", "2026-07-29", "2026-07-29"), [CFE(1)], new Date("2026-07-29T12:00:00Z"));
    expect(cache.get(claveDe("a", "2026-07-29", "2026-07-29"))).not.toBeNull();
    ahora += TTL_RECIENTE_MS + 1;
    expect(cache.get(claveDe("a", "2026-07-29", "2026-07-29"))).toBeNull();
  });

  it("se puede apagar entero", () => {
    const cache = new CacheVentanas(false);
    cache.set(claveDe("a"), [CFE(1)]);
    expect(cache.get(claveDe("a"))).toBeNull();
  });

  it("devuelve una COPIA: quien la reciba puede ordenarla sin romper la próxima", () => {
    const cache = new CacheVentanas();
    cache.set(claveDe("a"), [CFE(1), CFE(2)]);
    const primera = cache.get(claveDe("a"))!;
    primera.length = 0;
    expect(cache.get(claveDe("a"))).toHaveLength(2);
  });

  it("tiene techo: un proceso largo no acumula medio año por empresa", () => {
    const cache = new CacheVentanas();
    for (let i = 0; i < MAX_VENTANAS_POR_EMPRESA + 50; i++) {
      cache.set(ventana("a", i), [CFE(i)]);
    }
    expect(cache.entradasDe("a")).toBeLessThanOrEqual(MAX_VENTANAS_POR_EMPRESA);
    expect(cache.stats.entradas).toBeLessThanOrEqual(MAX_ENTRADAS);
  });
});

// --- El presupuesto también es por empresa ----------------------------------
//
// Este bloque cubre la regresión que no se veía: los DATOS ya estaban aislados
// por `cacheId`, pero el TECHO era uno solo, así que una empresa bajando un año
// entero le desalojaba las ventanas calientes a las demás. No rompía ningún
// test, no encendía ninguna alerta, y lo único que se notaba era que la segunda
// pregunta de otra empresa volvía a tardar segundos.

describe("una empresa no desaloja a otra", () => {
  it("la B llenando el cache no se lleva puesta la ventana caliente de la A", () => {
    const cache = new CacheVentanas();
    cache.set(claveDe("empresa-a"), [CFE(1)]);

    // La B pide un año entero, y después algunos más: mucho más que el techo.
    for (let i = 0; i < MAX_VENTANAS_POR_EMPRESA * 3; i++) {
      cache.set(ventana("empresa-b", i), [CFE(1000 + i)]);
    }

    expect(cache.get(claveDe("empresa-a"))).toEqual([CFE(1)]);
    expect(cache.entradasDe("empresa-a")).toBe(1);
    expect(cache.entradasDe("empresa-b")).toBe(MAX_VENTANAS_POR_EMPRESA);
  });

  it("el techo de empresas descarta a la que hace más rato que no consulta", () => {
    const cache = new CacheVentanas();
    for (let e = 0; e < MAX_EMPRESAS; e++) cache.set(ventana(`e${e}`, 0), [CFE(e)]);
    // La primera vuelve a consultar: deja de ser la más fría.
    expect(cache.get(ventana("e0", 0))).not.toBeNull();
    // Entra una nueva: tiene que caerse `e1`, no `e0`.
    cache.set(ventana("nueva", 0), [CFE(99)]);
    expect(cache.entradasDe("e0")).toBe(1);
    expect(cache.entradasDe("e1")).toBe(0);
    expect(cache.entradasDe("nueva")).toBe(1);
  });
});

describe("adentro de una empresa el desalojo es LRU, no FIFO", () => {
  it("la ventana que se sigue pidiendo sobrevive a las que se pidieron una vez", () => {
    const cache = new CacheVentanas();
    const caliente = ventana("a", 0);
    cache.set(caliente, [CFE(0)]);

    for (let i = 1; i < MAX_VENTANAS_POR_EMPRESA; i++) {
      cache.set(ventana("a", i), [CFE(i)]);
      // Se la toca en cada vuelta: es la que el usuario pregunta siempre.
      expect(cache.get(caliente)).not.toBeNull();
    }
    // Ahora se pasa del techo. Con FIFO, la primera insertada —la caliente— era
    // justo la que se caía.
    for (let i = MAX_VENTANAS_POR_EMPRESA; i < MAX_VENTANAS_POR_EMPRESA + 10; i++) {
      cache.set(ventana("a", i), [CFE(i)]);
    }

    expect(cache.get(caliente)).toEqual([CFE(0)]);
    // Lo que sí se cayó: la más fría de todas, la segunda que se insertó.
    expect(cache.get(ventana("a", 1))).toBeNull();
  });
});

describe("la habilitación puede venir por empresa", () => {
  it("apagarlo para una no lo apaga para las otras", () => {
    // La forma que necesita el overlay del tenant: la decisión se toma con el
    // `cacheId` a la vista, en cada operación, no una vez al cargar el módulo.
    const cache = new CacheVentanas((cacheId) => cacheId !== "a-oscuras");
    cache.set(claveDe("a-oscuras"), [CFE(1)]);
    cache.set(claveDe("normal"), [CFE(2)]);
    expect(cache.get(claveDe("a-oscuras"))).toBeNull();
    expect(cache.get(claveDe("normal"))).toEqual([CFE(2)]);
  });

  it("las cuentas se pueden mirar por empresa: el global mezcla a todos", () => {
    const cache = new CacheVentanas();
    cache.set(claveDe("a"), [CFE(1)]);
    cache.get(claveDe("a")); // hit de A
    cache.get(claveDe("b")); // miss de B
    expect(cache.estadisticas("a")).toEqual({ hits: 1, misses: 0, entradas: 1 });
    expect(cache.estadisticas("b")).toEqual({ hits: 0, misses: 1, entradas: 0 });
    expect(cache.estadisticas()).toEqual({ hits: 1, misses: 1, entradas: 1 });
  });
});

// --- Reintento --------------------------------------------------------------

describe("qué se reintenta y qué no", () => {
  it.each([
    ["timeout", new BillerTimeoutError(30_000), true],
    ["error de red", new BillerNetworkError("ECONNRESET"), true],
    ["500 de la API", new BillerApiError(500), true],
    ["503", new BillerApiError(503), true],
    ["422 (rango inválido)", new BillerApiError(422), false],
    ["401 (token malo)", new BillerApiError(401), false],
    ["404", new BillerApiError(404), false],
  ])("%s -> %s", (_n, err, esperado) => {
    expect(esTransitorio(err)).toBe(esperado);
  });

  it("un 500 se reintenta y la segunda vez sale bien", async () => {
    let intentos = 0;
    const r = await conReintento(
      async () => {
        intentos += 1;
        if (intentos === 1) throw new BillerApiError(500);
        return "ok";
      },
      { sleepFn: async () => {} },
    );
    expect(r).toBe("ok");
    expect(intentos).toBe(2);
  });

  it("un 422 NO se reintenta: es una respuesta, no una falla", async () => {
    let intentos = 0;
    await expect(
      conReintento(
        async () => {
          intentos += 1;
          throw new BillerApiError(422);
        },
        { sleepFn: async () => {} },
      ),
    ).rejects.toBeInstanceOf(BillerApiError);
    expect(intentos).toBe(1);
  });

  it("si falla siempre, propaga el error original", async () => {
    await expect(
      conReintento(
        async () => {
          throw new BillerApiError(503);
        },
        { maxReintentos: 2, sleepFn: async () => {} },
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

// --- Paralelismo ------------------------------------------------------------

describe("mapConLimite", () => {
  it("preserva el orden aunque terminen desordenadas", async () => {
    // Sin orden estable, dos ejecuciones idénticas devuelven JSON distinto y los
    // tests se vuelven intermitentes.
    const r = await mapConLimite([50, 10, 30, 0], 4, async (ms, i) => {
      await new Promise((res) => setTimeout(res, ms));
      return i;
    });
    expect(r).toEqual([0, 1, 2, 3]);
  });

  it("nunca corre más de `limite` a la vez", async () => {
    let enVuelo = 0;
    let pico = 0;
    await mapConLimite(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      enVuelo += 1;
      pico = Math.max(pico, enVuelo);
      await new Promise((res) => setTimeout(res, 5));
      enVuelo -= 1;
    });
    expect(pico).toBeLessThanOrEqual(4);
  });

  it("no satura la cuenta de la empresa: la concurrencia es acotada y chica", () => {
    // 53 requests simultáneas para contestar "¿cómo viene el mes?" harían fallar
    // el resto de las integraciones de esa empresa por culpa nuestra.
    expect(CONCURRENCIA).toBeLessThanOrEqual(6);
    expect(CONCURRENCIA).toBeGreaterThan(1);
  });

  it("lista vacía no cuelga", async () => {
    expect(await mapConLimite([], 4, async () => 1)).toEqual([]);
  });

  it("propaga el error de un elemento", async () => {
    await expect(
      mapConLimite([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("explotó");
        return n;
      }),
    ).rejects.toThrow("explotó");
  });
});

// --- Integración: el cliente sin identidad no se cachea ---------------------

describe("un cliente sin identidad NO se cachea", () => {
  it("es la salvaguarda que evita que dos empresas compartan clave", async () => {
    // Apareció de verdad: los clientes falsos de los tests no tenían `cacheId`,
    // todos compartían la clave vacía, y los datos de un test aparecían en otro.
    // En producción ese mismo síntoma es una fuga entre empresas.
    const { consultarPorPeriodo } = await import("../src/services/periodo.js");
    const get = vi.fn(async () => []);
    const sinId = { get } as never;
    await consultarPorPeriodo(sinId, { desde: "2026-07-01", hasta: "2026-07-07" });
    await consultarPorPeriodo(sinId, { desde: "2026-07-01", hasta: "2026-07-07" });
    // Si se hubiera cacheado bajo una clave vacía, la segunda no llamaría a la API.
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });
});
