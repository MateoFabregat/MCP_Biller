// =============================================================================
// El cache de ventanas se apaga POR EMPRESA.
//
// Lo que se prueba es el CABLEADO, que es lo que faltaba: el mecanismo de
// resolución por `cacheId` existía desde hace rato y no lo llamaba nadie, o sea
// que `BILLER_CACHE_ENABLED` seguía siendo del proceso y apagar el cache para
// diagnosticar un total que no cerraba en una empresa lo apagaba para las veinte.
//
// Por eso el test intercepta `registrarHabilitacionCache` en vez de mirar los
// contadores del cache: lo que puede volver a romperse es que nadie la llame.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import { construirRegistro } from "../src/tenants/registry.js";

/** La resolución que `ContextosPorTenant` enchufa al arrancar. */
let resolucion: ((cacheId: string) => boolean | undefined) | null = null;

vi.mock("../src/services/periodo.js", async (importActual) => {
  const real = await importActual<typeof import("../src/services/periodo.js")>();
  return {
    ...real,
    registrarHabilitacionCache: (fn: ((cacheId: string) => boolean | undefined) | null) => {
      resolucion = fn;
    },
  };
});

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

const BASE = {
  BILLER_API_BASE_URL: "https://test.biller.uy",
  BILLER_API_TOKEN: "token_del_proceso_largo",
};

const REGISTRO = [
  {
    id: "apagada",
    auth_token: TOKEN_A,
    // La que está diagnosticando un total que no le cierra.
    env: { BILLER_API_TOKEN: "tok_a_largo", BILLER_CACHE_ENABLED: "false" },
  },
  {
    // La que no opina: tiene que quedar exactamente como estaba.
    id: "callada",
    auth_token: TOKEN_B,
    env: { BILLER_API_TOKEN: "tok_b_largo" },
  },
];

describe("habilitación de cache por empresa", () => {
  beforeEach(() => {
    resolucion = null;
  });

  it("ContextosPorTenant enchufa la resolución al construirse", async () => {
    const { ContextosPorTenant } = await import("../src/tenants/contextos.js");
    new ContextosPorTenant(BASE);
    expect(resolucion).not.toBeNull();
  });

  it("apagar el cache de una empresa no lo apaga para la otra", async () => {
    const { ContextosPorTenant } = await import("../src/tenants/contextos.js");
    const registro = construirRegistro(REGISTRO, BASE);
    const contextos = new ContextosPorTenant(BASE);
    const apagada = contextos.para(registro.tenants[0]!);
    const callada = contextos.para(registro.tenants[1]!);

    const idApagada = apagada.getClient().cacheId;
    const idCallada = callada.getClient().cacheId;
    // Si los dos cacheId fueran iguales el test pasaría por la razón
    // equivocada: son sha256(baseUrl+token) y los tokens son distintos.
    expect(idApagada).not.toBe(idCallada);

    expect(resolucion!(idApagada)).toBe(false);
    // `undefined` no es `false`: es "no opino", y el cache cae al default del
    // proceso. Devolver `false` acá sería apagarle el cache a quien no pidió nada.
    expect(resolucion!(idCallada)).toBeUndefined();
    // Y un cacheId que no es de ningún tenant tampoco opina.
    expect(resolucion!("cacheid-de-nadie")).toBeUndefined();
  });

  it("sin registro de tenants nadie opina: el modo de una sola empresa queda igual", async () => {
    const { ContextosPorTenant } = await import("../src/tenants/contextos.js");
    const contextos = new ContextosPorTenant(BASE);
    // Un despliegue mono-tenant nunca llama a `para()`, así que el índice queda
    // vacío y toda consulta cae al default del proceso.
    expect(contextos.tamano).toBe(0);
    expect(resolucion!("cualquiera")).toBeUndefined();
  });
});
