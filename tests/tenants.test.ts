// =============================================================================
// Varias empresas en un mismo despliegue.
//
// Lo que se prueba acá es AISLAMIENTO, no funcionalidad. La pregunta de fondo de
// cada test es la misma: ¿hay alguna forma de que una empresa vea los datos de
// otra? Por eso hay tantos tests sobre configuraciones inválidas: el modo de
// falla que importa no es "no anda", es "anda y devuelve los números de otro".
// =============================================================================

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { autenticarConTenants } from "../src/tenants/acceso.js";
import { ContextosPorTenant } from "../src/tenants/contextos.js";
import {
  MIN_TENANT_TOKEN_LENGTH,
  TenantConfigError,
  construirRegistro,
  entornoDe,
  resolverTenant,
  type RegistroTenants,
} from "../src/tenants/registry.js";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

const DOS_EMPRESAS = [
  {
    id: "panaderia",
    nombre: "Panadería Rivera",
    auth_token: TOKEN_A,
    env: { BILLER_API_TOKEN: "token_biller_panaderia", BILLER_DEFAULT_SUCURSAL_ID: "347" },
  },
  {
    id: "ferreteria",
    nombre: "Ferretería Sur",
    auth_token: TOKEN_B,
    env: { BILLER_API_TOKEN: "token_biller_ferreteria", BILLER_DEFAULT_SUCURSAL_ID: "912" },
  },
];

function req(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

const SIN_TENANTS: RegistroTenants = { tenants: [], porToken: new Map() };

// --- El registro rechaza lo que no se puede aislar --------------------------

describe("configuraciones que NO se aceptan", () => {
  it("dos tenants con el mismo token: las dos empresas verían una sola", () => {
    expect(() =>
      construirRegistro([
        { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } },
        { id: "b", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "y" } },
      ]),
    ).toThrow(TenantConfigError);
  });

  it("dos tenants con el mismo id", () => {
    expect(() =>
      construirRegistro([
        { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } },
        { id: "a", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "y" } },
      ]),
    ).toThrow(/únicos/);
  });

  it("un tenant SIN BILLER_API_TOKEN propio leería la contabilidad del proceso", () => {
    expect(() => construirRegistro([{ id: "a", auth_token: TOKEN_A, env: {} }])).toThrow(
      /BILLER_API_TOKEN/,
    );
  });

  it("un token corto: es lo único que separa una empresa de otra", () => {
    expect(() =>
      construirRegistro([{ id: "a", auth_token: "corto", env: { BILLER_API_TOKEN: "x" } }]),
    ).toThrow(new RegExp(String(MIN_TENANT_TOKEN_LENGTH)));
  });

  it("sin id, sin token, o con forma equivocada", () => {
    expect(() => construirRegistro([{ auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }])).toThrow(/id/);
    expect(() => construirRegistro([{ id: "a", env: { BILLER_API_TOKEN: "x" } }])).toThrow(/auth_token/);
    expect(() => construirRegistro({ id: "a" })).toThrow(/ARRAY/);
  });

  it("NO se degrada en silencio: un registro inválido tira, no devuelve vacío", () => {
    // Devolver "cero tenants" ante un JSON roto haría que TODAS las empresas
    // cayeran al tenant implícito del proceso — todas leyendo los datos de una.
    expect(() => construirRegistro("no soy un array")).toThrow(TenantConfigError);
  });
});

// --- Resolución por token ---------------------------------------------------

describe("el token elige la empresa", () => {
  const registro = construirRegistro(DOS_EMPRESAS);

  it("cada token lleva a su empresa", () => {
    expect(resolverTenant(registro, TOKEN_A)?.id).toBe("panaderia");
    expect(resolverTenant(registro, TOKEN_B)?.id).toBe("ferreteria");
  });

  it("un token que no está no lleva a ninguna", () => {
    expect(resolverTenant(registro, "z".repeat(32))).toBeNull();
    expect(resolverTenant(registro, "")).toBeNull();
    expect(resolverTenant(registro, null)).toBeNull();
  });

  it("el overlay pisa, no completa", () => {
    const entorno = entornoDe(registro.tenants[0]!, {
      BILLER_API_TOKEN: "token_del_proceso",
      BILLER_API_BASE_URL: "https://test.biller.uy",
    });
    // Si el token del proceso sobreviviera como fallback, un tenant mal
    // configurado leería la contabilidad de otra empresa en vez de fallar.
    expect(entorno.BILLER_API_TOKEN).toBe("token_biller_panaderia");
    expect(entorno.BILLER_API_BASE_URL).toBe("https://test.biller.uy");
  });

  it("dos empresas no comparten ni el token de Biller ni la sucursal", () => {
    const a = entornoDe(registro.tenants[0]!, {});
    const b = entornoDe(registro.tenants[1]!, {});
    expect(a.BILLER_API_TOKEN).not.toBe(b.BILLER_API_TOKEN);
    expect(a.BILLER_DEFAULT_SUCURSAL_ID).not.toBe(b.BILLER_DEFAULT_SUCURSAL_ID);
  });
});

// --- La puerta --------------------------------------------------------------

describe("autenticar y elegir empresa son UNA decisión", () => {
  const registro = construirRegistro(DOS_EMPRESAS);

  it("el bearer de una empresa entra como esa empresa", () => {
    const r = autenticarConTenants(req(`Bearer ${TOKEN_A}`), undefined, registro);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tenant?.id).toBe("panaderia");
  });

  it("con tenants configurados, el token GLOBAL deja de servir", () => {
    // Aceptarlo obligaría a contestar "¿de qué empresa es esta request?", y la
    // única respuesta posible sería la config del proceso: datos de otro.
    const global = "g".repeat(32);
    const r = autenticarConTenants(req(`Bearer ${global}`), global, registro);
    expect(r.ok).toBe(false);
  });

  it("no se puede elegir empresa por header: el token es el único selector", () => {
    const conHeader = {
      headers: { authorization: `Bearer ${TOKEN_A}`, "x-biller-tenant": "ferreteria" },
    } as unknown as IncomingMessage;
    const r = autenticarConTenants(conHeader, undefined, registro);
    expect(r.ok && r.tenant?.id).toBe("panaderia");
  });

  it("el rechazo no dice cuántas empresas hay ni si el token existe", () => {
    const r = autenticarConTenants(req(`Bearer ${"z".repeat(32)}`), undefined, registro);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("Token inválido.");
    expect(r.message).not.toContain("panaderia");
    expect(r.message).not.toContain("2");
  });

  it("sin Authorization, 401", () => {
    const r = autenticarConTenants(req(), undefined, registro);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});

// --- Compatibilidad hacia atrás ---------------------------------------------

describe("sin tenants configurados no cambia nada", () => {
  it("el token global sigue siendo la credencial, y el tenant es null", () => {
    const global = "g".repeat(32);
    const r = autenticarConTenants(req(`Bearer ${global}`), global, SIN_TENANTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tenant).toBeNull();
  });

  it("un token equivocado sigue rechazando", () => {
    expect(autenticarConTenants(req("Bearer otro"), "g".repeat(32), SIN_TENANTS).ok).toBe(false);
  });

  it("sin token configurado se rechaza todo, como antes", () => {
    const r = autenticarConTenants(req("Bearer lo-que-sea"), undefined, SIN_TENANTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
  });
});

// --- Los contextos no se comparten ------------------------------------------

describe("un contexto por empresa", () => {
  const registro = construirRegistro(DOS_EMPRESAS);

  it("cada empresa tiene el suyo", () => {
    const contextos = new ContextosPorTenant({ BILLER_API_BASE_URL: "https://test.biller.uy" });
    const a = contextos.para(registro.tenants[0]!);
    const b = contextos.para(registro.tenants[1]!);
    // Compartir el contexto compartiría el store de idempotencia: una clave ya
    // usada por una empresa bloquearía la emisión de la otra.
    expect(a).not.toBe(b);
    expect(contextos.tamano).toBe(2);
  });

  it("el de una empresa se reusa entre requests (o no hay idempotencia)", () => {
    const contextos = new ContextosPorTenant({ BILLER_API_BASE_URL: "https://test.biller.uy" });
    expect(contextos.para(registro.tenants[0]!)).toBe(contextos.para(registro.tenants[0]!));
    expect(contextos.tamano).toBe(1);
  });

  it("cada contexto carga la config de SU empresa", () => {
    const contextos = new ContextosPorTenant({ BILLER_API_BASE_URL: "https://test.biller.uy" });
    const a = contextos.para(registro.tenants[0]!).getConfig();
    const b = contextos.para(registro.tenants[1]!).getConfig();
    expect(a.apiToken).toBe("token_biller_panaderia");
    expect(b.apiToken).toBe("token_biller_ferreteria");
    expect(a.defaultSucursalId).toBe("347");
    expect(b.defaultSucursalId).toBe("912");
  });
});

// =============================================================================
// Aislamiento de sesiones HTTP entre empresas.
//
// El mapa de sesiones se indexa por `mcp-session-id`, que lo manda el CLIENTE.
// Sin el tenant adelante, un tenant autenticado que presentara el id de sesión
// de otro recibía el server de ese otro: su propia credencial válida, la
// contabilidad ajena. El id es un UUID —adivinarlo no es viable— pero aparece
// en headers y en logs de proxy, y "difícil de adivinar" no es lo mismo que
// "no sirve aunque lo tengas".
// =============================================================================

describe("las sesiones HTTP no se cruzan entre empresas", () => {
  it("la clave de sesión lleva el id del tenant adelante", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync(
      new URL("../src/transport/http.ts", import.meta.url),
      "utf8",
    );
    // Las tres operaciones sobre el mapa —lookup, alta y baja— tienen que usar
    // la clave compuesta. Que una sola quede con el id pelado reabre el agujero.
    expect(fuente).toContain("`${auth.tenant?.id ?? \"-\"}:${sessionIdRaw}`");
    expect(fuente).toContain("sesiones.set(`${auth.tenant?.id ?? \"-\"}:${id}`");
    expect(fuente).toContain("sesiones.delete(`${auth.tenant?.id ?? \"-\"}:${id}`)");
  });
});
