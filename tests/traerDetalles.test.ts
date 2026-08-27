// =============================================================================
// El detalle por id: paralelismo acotado, reintento y cache por credencial.
//
// El test que más importa NO es ninguno de los de velocidad: es "dos empresas
// no comparten detalles". Un `id` de comprobante es un número chico y
// secuencial, así que dos empresas colisionan a la primera. Un cache sin la
// credencial en la clave le serviría a una empresa el comprobante de otra, y
// además en silencio — los datos se ven perfectamente normales.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import type { BillerClient, BillerGetOptions } from "../src/biller/client.js";
import { CONCURRENCIA } from "../src/biller/traerVentanas.js";
import { traerPorId } from "../src/biller/traerDetalles.js";
import { BillerApiError } from "../src/utils/errors.js";

/** Un comprobante crudo con lo mínimo, y con `items` (que solo vienen por id). */
function crudo(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tipo_comprobante: 111,
    serie: "A",
    numero: id,
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    // Vieja a propósito: cae en el TTL largo, así que el cache no expira
    // adentro de un test.
    fecha_emision: "2020-01-15",
    items: [{ codigo: "P1", concepto: "Producto", cantidad: 1, precio: 1000 }],
    ...over,
  };
}

/** Cliente falso con identidad propia (sin `cacheId` no se cachea, y es a propósito). */
function cliente(
  impl: (o: BillerGetOptions) => unknown | Promise<unknown>,
  cacheId = `test-${Math.random().toString(36).slice(2)}`,
) {
  const get = vi.fn(async (o: BillerGetOptions) => impl(o));
  return { client: { get, cacheId } as unknown as BillerClient, get };
}

const idDe = (o: BillerGetOptions): number => Number((o.query as { id: string }).id);

// ---------------------------------------------------------------------------

describe("trae todo lo pedido, en el orden pedido", () => {
  it("devuelve un mapa con los detalles y ninguna falla", async () => {
    const { client, get } = cliente((o) => [crudo(idDe(o))]);
    const r = await traerPorId(client, [3, 1, 2]);

    expect([...r.detalles.keys()]).toEqual([3, 1, 2]);
    expect(r.fallidos).toEqual([]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("el orden es el de los ids, no el de llegada", async () => {
    // Sin orden estable, dos corridas idénticas devuelven rankings distintos.
    const { client } = cliente(async (o) => {
      const id = idDe(o);
      await new Promise((res) => setTimeout(res, id === 1 ? 30 : 1));
      return [crudo(id)];
    });
    const r = await traerPorId(client, [1, 2, 3, 4]);
    expect([...r.detalles.keys()]).toEqual([1, 2, 3, 4]);
  });

  it("lista vacía no cuelga ni llama a nadie", async () => {
    const { client, get } = cliente(() => []);
    const r = await traerPorId(client, []);
    expect(r.detalles.size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("paralelismo acotado", () => {
  it("nunca hay más de `concurrencia` requests en vuelo", async () => {
    let enVuelo = 0;
    let pico = 0;
    const { client } = cliente(async (o) => {
      enVuelo += 1;
      pico = Math.max(pico, enVuelo);
      await new Promise((res) => setTimeout(res, 3));
      enVuelo -= 1;
      return [crudo(idDe(o))];
    });

    await traerPorId(client, Array.from({ length: 30 }, (_, i) => i + 1));
    expect(pico).toBeLessThanOrEqual(CONCURRENCIA);
    expect(pico).toBeGreaterThan(1);
  });

  it("el default queda dentro del límite documentado de Biller (30 req/s)", () => {
    // 500 requests simultáneas para contestar "¿qué productos vendo más?"
    // harían fallar el resto de las integraciones de esa empresa por culpa
    // nuestra.
    expect(CONCURRENCIA).toBeLessThanOrEqual(6);
  });

  it("respeta una concurrencia más baja si se la piden", async () => {
    let enVuelo = 0;
    let pico = 0;
    const { client } = cliente(async (o) => {
      enVuelo += 1;
      pico = Math.max(pico, enVuelo);
      await new Promise((res) => setTimeout(res, 3));
      enVuelo -= 1;
      return [crudo(idDe(o))];
    });
    await traerPorId(client, [1, 2, 3, 4, 5, 6], { concurrencia: 2 });
    expect(pico).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------

describe("reintento", () => {
  it("un 500 transitorio se reintenta y el comprobante entra igual", async () => {
    // Sin esto, un hipo de la API sacaba un comprobante del ranking en silencio.
    let intentos = 0;
    const { client } = cliente((o) => {
      if (idDe(o) === 7) {
        intentos += 1;
        if (intentos === 1) throw new BillerApiError(500);
      }
      return [crudo(idDe(o))];
    });

    const r = await traerPorId(client, [7]);
    expect(r.detalles.has(7)).toBe(true);
    expect(r.fallidos).toEqual([]);
    expect(intentos).toBe(2);
  });

  it("un 404 NO se reintenta: es una respuesta, no una falla", async () => {
    let intentos = 0;
    const { client } = cliente(() => {
      intentos += 1;
      throw new BillerApiError(404);
    });
    const r = await traerPorId(client, [7]);
    expect(intentos).toBe(1);
    expect(r.fallidos).toEqual([{ id: 7, motivo: "error" }]);
  });

  it("una falla individual no aborta el resto", async () => {
    const { client } = cliente((o) => {
      if (idDe(o) === 2) throw new BillerApiError(404);
      return [crudo(idDe(o))];
    });
    const r = await traerPorId(client, [1, 2, 3]);
    expect([...r.detalles.keys()]).toEqual([1, 3]);
    expect(r.fallidos).toEqual([{ id: 2, motivo: "error" }]);
  });

  it("distingue el error de la respuesta vacía", async () => {
    // No son lo mismo: la cuenta corriente avisa del error y se queda callada
    // con el recibo que simplemente no declara a qué se imputó.
    const { client } = cliente((o) => (idDe(o) === 2 ? [] : [crudo(idDe(o))]));
    const r = await traerPorId(client, [1, 2]);
    expect(r.fallidos).toEqual([{ id: 2, motivo: "sin_respuesta" }]);
  });
});

// ---------------------------------------------------------------------------

describe("cache", () => {
  it("la segunda vuelta no le pide nada a la API", async () => {
    const { client, get } = cliente((o) => [crudo(idDe(o))]);

    await traerPorId(client, [11, 12, 13]);
    expect(get).toHaveBeenCalledTimes(3);

    const segunda = await traerPorId(client, [11, 12, 13]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(segunda.desdeCache).toBe(3);
    expect(segunda.detalles.size).toBe(3);
  });

  it("`sinCache` vuelve a pedir", async () => {
    const { client, get } = cliente((o) => [crudo(idDe(o))]);
    await traerPorId(client, [21]);
    await traerPorId(client, [21], { sinCache: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("una respuesta vacía NO se cachea: un hipo no puede volverse una ausencia de 30 minutos", async () => {
    let vacia = true;
    const { client, get } = cliente((o) => (vacia ? [] : [crudo(idDe(o))]));

    expect((await traerPorId(client, [31])).detalles.size).toBe(0);
    vacia = false;
    expect((await traerPorId(client, [31])).detalles.size).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // SEC-A6: el cache devolvía la REFERENCIA, no una copia.
  //
  // `cacheVentanas.ts` ya copiaba, con el motivo escrito: quien recibe la lista
  // la ordena o la filtra in place. Acá pesa más, porque lo que se puede
  // envenenar no es el orden de una lista sino el CONTENIDO de un comprobante
  // —sus ítems, su total, su estado— servido después a otra tool que lo cree
  // recién traído de la API.
  // -------------------------------------------------------------------------
  it("mutar lo devuelto NO envenena lo que va a recibir la próxima pregunta", async () => {
    const { client, get } = cliente((o) => [crudo(idDe(o), { total: 1000 })]);

    const primera = await traerPorId(client, [41]);
    const detalle = primera.detalles.get(41)!;
    (detalle as unknown as Record<string, unknown>).total = 999_999;
    (detalle as unknown as Record<string, unknown>).estado = "Rechazado DGI";
    detalle.items?.push({ codigo: "X", concepto: "inyectado", cantidad: 1, precio: 1 } as never);

    const segunda = await traerPorId(client, [41]);
    expect(get).toHaveBeenCalledTimes(1); // salió del cache: es el caso que importa
    expect(segunda.detalles.get(41)?.total).toBe(1000);
    expect(segunda.detalles.get(41)?.estado).toBe("Aceptado DGI");
    expect(segunda.detalles.get(41)?.items).toHaveLength(1);
  });

  it("tampoco al revés: mutar DESPUÉS de guardar no toca lo guardado", async () => {
    // El objeto que se entrega y el que se guarda no pueden ser el mismo. Si el
    // llamador lo muta apenas lo recibe, el cache no se tiene que enterar.
    const compartido = crudo(42, { total: 2000 });
    const { client, get } = cliente(() => [compartido]);

    const primera = await traerPorId(client, [42]);
    // El normalizador ya devuelve objetos nuevos, así que se muta el resultado.
    (primera.detalles.get(42) as unknown as Record<string, unknown>).total = -1;

    const segunda = await traerPorId(client, [42]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(segunda.detalles.get(42)?.total).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Lo más importante del archivo
// ---------------------------------------------------------------------------

describe("dos empresas no comparten detalles", () => {
  it("el mismo id con credenciales distintas son dos entradas distintas", async () => {
    const a = cliente((o) => [crudo(idDe(o), { total: 111 })], "empresa-a");
    const b = cliente((o) => [crudo(idDe(o), { total: 222 })], "empresa-b");

    await traerPorId(a.client, [40404]);
    const deB = await traerPorId(b.client, [40404]);

    // Si compartieran clave, B recibiría el comprobante de A sin enterarse.
    expect(b.get).toHaveBeenCalledTimes(1);
    expect(deB.desdeCache).toBe(0);
    expect(deB.detalles.get(40404)!.total).toBe(222);
  });

  it("un cliente SIN identidad no se cachea", async () => {
    // Apareció de verdad con los clientes falsos de los tests: sin `cacheId`
    // todos compartían la clave vacía y los datos de un caso aparecían en otro.
    // En producción ese mismo síntoma es una fuga entre empresas.
    const get = vi.fn(async (o: BillerGetOptions) => [crudo(idDe(o))]);
    const sinId = { get } as unknown as BillerClient;

    await traerPorId(sinId, [50505]);
    await traerPorId(sinId, [50505]);

    expect(get).toHaveBeenCalledTimes(2);
  });
});
