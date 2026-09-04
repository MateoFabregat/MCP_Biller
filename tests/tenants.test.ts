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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, TENANT_IMPLICITO, type BillerConfig } from "../src/config.js";
import { autenticarConTenants } from "../src/tenants/acceso.js";
import { ContextosPorTenant } from "../src/tenants/contextos.js";
import {
  MIN_TENANT_TOKEN_LENGTH,
  RUTAS_DE_PERSISTENCIA,
  TenantConfigError,
  VARIABLES_QUE_NO_SE_HEREDAN,
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

const SIN_TENANTS: RegistroTenants = { tenants: [], porToken: new Map(), porPhoneNumberId: new Map() };

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

  it("un id con mayúsculas: en macOS/Windows/Docker Desktop sería el mismo directorio que en minúsculas", () => {
    expect(() =>
      construirRegistro([{ id: "Panaderia", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }]),
    ).toThrow(/minúsculas/);
  });

  it("un id de 49 caracteres: más largo que lo que acepta la etiqueta de métricas", () => {
    expect(() =>
      construirRegistro([{ id: "a".repeat(49), auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }]),
    ).toThrow(TenantConfigError);
  });

  it("un id con guiones y minúsculas de largo normal sigue pasando", () => {
    const r = construirRegistro([
      { id: "panaderia-rivera", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } },
    ]);
    expect(r.tenants[0]!.id).toBe("panaderia-rivera");
  });

  it("NO se degrada en silencio: un registro inválido tira, no devuelve vacío", () => {
    // Devolver "cero tenants" ante un JSON roto haría que TODAS las empresas
    // cayeran al tenant implícito del proceso — todas leyendo los datos de una.
    expect(() => construirRegistro("no soy un array")).toThrow(TenantConfigError);
  });
});

// --- Lo que un tenant NO puede compartir con otro ---------------------------

describe("dos tenants no pueden compartir la empresa ni el archivo", () => {
  it("el mismo BILLER_API_TOKEN: mismo espacio de borradores y emisión duplicada", () => {
    // Es el copy-paste de la entrada de arriba con el id cambiado. Los dos
    // tenants andan, y el día que se cruzan ya se emitió dos veces.
    expect(() =>
      construirRegistro(
        [
          { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "mismo" } },
          { id: "b", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "mismo" } },
        ],
        {},
      ),
    ).toThrow(/MISMO BILLER_API_TOKEN/);
  });

  it("la misma ruta de audit, idempotencia o borradores", () => {
    for (const variable of RUTAS_DE_PERSISTENCIA) {
      expect(() =>
        construirRegistro(
          [
            { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x", [variable]: "/data/uno.jsonl" } },
            { id: "b", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "y", [variable]: "/data/uno.jsonl" } },
          ],
          {},
        ),
      ).toThrow(/mismo archivo/);
    }
  });

  it("la misma ruta escrita distinto sigue siendo el mismo archivo", () => {
    // "./data/x.jsonl" y "data/x.jsonl" comparados como texto no chocan; como
    // archivo son uno solo, y adentro terminan el audit de las dos empresas.
    expect(() =>
      construirRegistro(
        [
          { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x", BILLER_AUDIT_LOG_PATH: "./data/a.log" } },
          { id: "b", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "y", BILLER_AUDIT_LOG_PATH: "data/a.log" } },
        ],
        {},
      ),
    ).toThrow(/mismo archivo/);
  });

  it("rutas distintas por empresa sí se aceptan", () => {
    const r = construirRegistro(
      [
        { id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x", BILLER_AUDIT_LOG_PATH: "/data/a.log" } },
        { id: "b", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "y", BILLER_AUDIT_LOG_PATH: "/data/b.log" } },
      ],
      {},
    );
    expect(r.tenants).toHaveLength(2);
  });
});

// --- Lo que un tenant NO hereda del proceso ---------------------------------

describe("lo sensible no se hereda: el overlay lo borra", () => {
  const PROCESO_CONTAMINADO: Record<string, string> = {
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_API_TOKEN: "token_de_la_empresa_del_proceso",
    KAPSO_API_KEY: "clave_whatsapp_de_otra_empresa",
    KAPSO_PHONE_NUMBER_ID: "numero_de_otra_empresa",
    KAPSO_DESTINATARIOS_PERMITIDOS: "59899000001",
    KAPSO_WEBHOOK_SECRET: "secreto_de_otra",
    BILLER_REMITENTES_AUTORIZADOS: "59899000002",
    BILLER_CAPABILITY_MODE: "write_enabled",
    BILLER_APPROVAL_SECRET: "approval-secret-de-la-empresa-del-proceso-123456",
    BILLER_WRITE_ENABLED: "true",
    BILLER_ALLOW_PRODUCTION_WRITES: "true",
    BILLER_DEFAULT_EMPRESA_RUT: "210000000000",
    BILLER_DEFAULT_SUCURSAL_ID: "999",
    BILLER_SUCURSALES_JSON: '{"centro":"999"}',
  };

  it("un tenant que no las declara NO las ve, aunque el proceso las tenga", () => {
    const r = construirRegistro(
      [{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "token_propio" } }],
      PROCESO_CONTAMINADO,
    );
    const entorno = entornoDe(r.tenants[0]!, PROCESO_CONTAMINADO);
    for (const variable of VARIABLES_QUE_NO_SE_HEREDAN) {
      // Heredar cualquiera de estas es, según cuál, mandar los mensajes de esta
      // empresa por el WhatsApp de otra, contestarle a los teléfonos de otra, o
      // emitir en producción con el permiso de otra.
      expect(entorno[variable]).toBeUndefined();
    }
    // Lo que describe al DESPLIEGUE y no al cliente sí se hereda: repetirlo
    // veinte veces solo agrega veinte lugares donde equivocarse.
    expect(entorno.BILLER_API_BASE_URL).toBe("https://test.biller.uy");
    expect(entorno.BILLER_API_TOKEN).toBe("token_propio");
  });

  it("lo que el tenant SÍ declara le queda a él", () => {
    const r = construirRegistro(
      [
        {
          id: "a",
          auth_token: TOKEN_A,
          env: {
            BILLER_API_TOKEN: "token_propio",
            KAPSO_API_KEY: "clave_propia",
            BILLER_CAPABILITY_MODE: "write_enabled",
            BILLER_APPROVAL_SECRET: "approval-secret-propio-del-tenant-123456789",
          },
        },
      ],
      PROCESO_CONTAMINADO,
    );
    const entorno = entornoDe(r.tenants[0]!, PROCESO_CONTAMINADO);
    expect(entorno.KAPSO_API_KEY).toBe("clave_propia");
    expect(entorno.BILLER_CAPABILITY_MODE).toBe("write_enabled");
    expect(entorno.BILLER_APPROVAL_SECRET).toBe("approval-secret-propio-del-tenant-123456789");
    expect(entorno.KAPSO_DESTINATARIOS_PERMITIDOS).toBeUndefined();
  });

  it("las rutas del proceso no se heredan en silencio: el tenant las declara o no arranca", () => {
    for (const variable of RUTAS_DE_PERSISTENCIA) {
      expect(() =>
        construirRegistro([{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }], {
          [variable]: "/data/compartido.jsonl",
        }),
      ).toThrow(new RegExp(variable));
    }
  });

  it("los topes de monto del proceso tampoco: heredarlos aplica el número de otro", () => {
    // Y borrarlos dejaría a la empresa sin tope, que es lo único entre una coma
    // mal puesta en un precio y un CFE por cien veces lo que valía.
    expect(() =>
      construirRegistro([{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }], {
        BILLER_MAX_MONTO_UYU: "500000",
      }),
    ).toThrow(/BILLER_MAX_MONTO/);

    const r = construirRegistro(
      [{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x", BILLER_MAX_MONTO_UYU: "80000" } }],
      { BILLER_MAX_MONTO_UYU: "500000" },
    );
    expect(entornoDe(r.tenants[0]!, { BILLER_MAX_MONTO_UYU: "500000" }).BILLER_MAX_MONTO_UYU).toBe("80000");
  });

  it("BILLER_ENABLE_IVA_ESTIMADO del proceso no se hereda: es un opt-in fiscal por empresa", () => {
    // Es una ESTIMACIÓN de IVA, no una preferencia técnica: prenderla en el
    // proceso no puede activarla para las veinte empresas del registro.
    const r = construirRegistro(
      [{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }],
      { BILLER_ENABLE_IVA_ESTIMADO: "true" },
    );
    const entorno = entornoDe(r.tenants[0]!, { BILLER_ENABLE_IVA_ESTIMADO: "true" });
    expect(entorno.BILLER_ENABLE_IVA_ESTIMADO).toBeUndefined();
  });

  it("si el proceso no tiene ninguna de esas, no molesta a nadie", () => {
    // El despliegue chico —dos tenants, nada global— tiene que seguir siendo
    // dos líneas de JSON y no un formulario de diez variables obligatorias.
    const r = construirRegistro([{ id: "a", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "x" } }], {});
    expect(r.tenants).toHaveLength(1);
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
    // Se cuentan OCURRENCIAS de la clave compuesta y no nombres de método: el
    // registro de sesiones se puede refactorear (y se refactoreó), lo que no
    // puede pasar es que alguna de las tres operaciones vuelva al id pelado.
    const compuesta = /\$\{auth\.tenant\?\.id \?\? "-"\}:\$\{/g;
    expect(fuente.match(compuesta) ?? []).toHaveLength(3);
    // Y ninguna operación sobre el mapa puede tomar el id de sesión crudo.
    expect(fuente).not.toMatch(/sesiones\.(registrar|quitar|obtener|get|set|delete)\(\s*(id|sessionIdRaw)\b/);
  });
});

// =============================================================================
// El modo sin tenants (stdio, server de escritorio) no se entera de nada.
// =============================================================================

describe("sin tenants configurados el entorno del proceso queda intacto", () => {
  it("cargarTenants con el entorno vacío devuelve cero tenants y no toca nada", async () => {
    const { cargarTenants } = await import("../src/tenants/registry.js");
    const proceso = {
      BILLER_API_TOKEN: "token_del_escritorio",
      KAPSO_API_KEY: "clave_del_escritorio",
      KAPSO_DESTINATARIOS_PERMITIDOS: "59899123456",
      BILLER_CAPABILITY_MODE: "write_enabled",
      BILLER_AUDIT_LOG_PATH: "./audit.log",
      BILLER_MAX_MONTO_UYU: "500000",
    };
    // Ninguna de las reglas nuevas aplica sin tenants: son reglas sobre el
    // AISLAMIENTO entre empresas, y acá hay una sola. Si alguna se colara, el
    // server de escritorio arrancaría sin WhatsApp y sin permiso de emitir.
    const registro = cargarTenants(proceso);
    expect(registro.tenants).toHaveLength(0);
    expect(registro.porToken.size).toBe(0);
  });
});

// =============================================================================
// BILLER_DATA_DIR: las rutas de persistencia derivadas del id de la empresa.
//
// La pregunta de fondo es una sola y es la de siempre: ¿pueden dos empresas
// terminar escribiendo en el mismo archivo? Antes la respuesta era "no, porque
// hay una validación que lo detecta"; con la derivación es "no, porque el id es
// único y está adentro de la ruta".
// =============================================================================

describe("BILLER_DATA_DIR deriva las rutas por empresa", () => {
  // Un directorio de verdad y descartable: `loadConfig` CREA el directorio
  // derivado, así que apuntar a "/var/lib/biller" ensuciaría la máquina.
  const DATA_DIR = mkdtempSync(join(tmpdir(), "biller-tenants-"));
  const CON_DATA_DIR = {
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_DATA_DIR: DATA_DIR,
  };

  function dosEmpresasSinRutas(): unknown[] {
    return [
      { id: "panaderia", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "tok_a_largo" } },
      { id: "ferreteria", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "tok_b_largo" } },
    ];
  }

  it("dos tenants NUNCA derivan la misma ruta", () => {
    const registro = construirRegistro(dosEmpresasSinRutas(), CON_DATA_DIR);
    const [a, b] = registro.tenants.map((t) => loadConfig(entornoDe(t, CON_DATA_DIR)));
    const rutas = (c: BillerConfig) => [c.auditLogPath, c.idempotencyLogPath, c.borradorStorePath];
    // Ninguna ruta de A aparece entre las de B, y ninguna quedó sin derivar.
    for (const r of rutas(a!)) {
      expect(r).toBeDefined();
      expect(rutas(b!)).not.toContain(r);
    }
    expect(a!.auditLogPath).toContain("/panaderia/");
    expect(b!.auditLogPath).toContain("/ferreteria/");
  });

  it("con BILLER_DATA_DIR, una ruta del PROCESO no se hereda: si se heredara, la explícita le ganaría a la derivada y las dos empresas escribirían en el mismo archivo", () => {
    const base = { ...CON_DATA_DIR, BILLER_AUDIT_LOG_PATH: "/tmp/audit-del-proceso.log" };
    const registro = construirRegistro(dosEmpresasSinRutas(), base);
    for (const t of registro.tenants) {
      const entorno = entornoDe(t, base);
      expect(entorno.BILLER_AUDIT_LOG_PATH).toBeUndefined();
      expect(loadConfig(entorno).auditLogPath).toContain(`/${t.id}/`);
    }
  });

  it("la declaración explícita gana sobre la derivación", () => {
    const registro = construirRegistro(
      [
        {
          id: "panaderia",
          auth_token: TOKEN_A,
          env: { BILLER_API_TOKEN: "tok_a_largo", BILLER_AUDIT_LOG_PATH: "/mnt/legacy/pan.log" },
        },
      ],
      CON_DATA_DIR,
    );
    const c = loadConfig(entornoDe(registro.tenants[0]!, CON_DATA_DIR));
    expect(c.auditLogPath).toBe("/mnt/legacy/pan.log");
    // Las otras dos sí se derivan: llena lo que nadie declaró, no pisa lo declarado.
    expect(c.idempotencyLogPath).toContain("/panaderia/");
  });

  it("una ruta escrita a mano que caiga encima de la DERIVADA de otra empresa no arranca", () => {
    expect(() =>
      construirRegistro(
        [
          { id: "panaderia", auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "tok_a" } },
          {
            id: "ferreteria",
            auth_token: TOKEN_B,
            env: {
              BILLER_API_TOKEN: "tok_b_largo",
              BILLER_AUDIT_LOG_PATH: join(DATA_DIR, "panaderia", "audit.jsonl"),
            },
          },
        ],
        CON_DATA_DIR,
      ),
    ).toThrow(TenantConfigError);
  });

  it("SIN BILLER_DATA_DIR sigue valiendo la regla vieja: ruta del proceso + tenant que no la declara = fatal", () => {
    expect(() =>
      construirRegistro(dosEmpresasSinRutas(), { BILLER_AUDIT_LOG_PATH: "/tmp/a.log" }),
    ).toThrow(/BILLER_DATA_DIR|no declara la suya/);
  });

  it("el id es un componente de ruta: los que se salen del directorio no arrancan", () => {
    for (const id of ["../otra", "a/b", "con espacio", "punto.uy"]) {
      expect(() =>
        construirRegistro([{ id, auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "t" } }], {}),
      ).toThrow(TenantConfigError);
    }
    // Y el id reservado de la empresa del proceso tampoco pasa (empieza con "_").
    expect(() =>
      construirRegistro(
        [{ id: TENANT_IMPLICITO, auth_token: TOKEN_A, env: { BILLER_API_TOKEN: "t" } }],
        {},
      ),
    ).toThrow(TenantConfigError);
  });

  it("el id del tenant viaja en el overlay y pisa lo que el JSON diga", () => {
    const registro = construirRegistro(
      [
        {
          id: "panaderia",
          auth_token: TOKEN_A,
          env: { BILLER_API_TOKEN: "tok_a_largo", BILLER_TENANT_ID: "ferreteria" },
        },
      ],
      CON_DATA_DIR,
    );
    // Un BILLER_TENANT_ID puesto a mano sería un tenant escribiendo en el
    // directorio de otro con la unicidad del id validada y sirviendo para nada.
    expect(entornoDe(registro.tenants[0]!, CON_DATA_DIR).BILLER_TENANT_ID).toBe("panaderia");
  });
});

// =============================================================================
// Mono-tenant: nada de esto cambió.
// =============================================================================

describe("el modo de una sola empresa no cambió", () => {
  it("sin BILLER_DATA_DIR no hay persistencia derivada, igual que siempre", () => {
    const c = loadConfig({ ...{
      BILLER_API_BASE_URL: "https://test.biller.uy",
      BILLER_API_TOKEN: "token_del_escritorio",
    } });
    expect(c.auditLogPath).toBeUndefined();
    expect(c.idempotencyLogPath).toBeUndefined();
    expect(c.borradorStorePath).toBeUndefined();
    expect(c.tenantId).toBe(TENANT_IMPLICITO);
    // Y el cache sigue prendido: nadie registró una resolución por empresa.
    expect(c.cacheEnabled).toBe(true);
  });

  it("con BILLER_DATA_DIR y sin registro, la única empresa tiene su directorio propio", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "biller-mono-"));
    const c = loadConfig({
      BILLER_API_BASE_URL: "https://test.biller.uy",
      BILLER_API_TOKEN: "token_del_escritorio",
      BILLER_DATA_DIR: dir,
    });
    expect(c.auditLogPath).toBe(join(dir, TENANT_IMPLICITO, "audit.jsonl"));
    // El directorio se crea: si no, el primer intento de emitir falla con un
    // ENOENT que no le dice nada a quien está facturando.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, TENANT_IMPLICITO))).toBe(true);
  });

  it("un BILLER_DATA_DIR que no se puede crear NO arranca, y el error dice qué hacer", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "biller-mono-"));
    // Un ARCHIVO donde tendría que ir el directorio: mkdir falla con EEXIST.
    writeFileSync(join(dir, TENANT_IMPLICITO), "no soy un directorio");
    expect(() =>
      loadConfig({
        BILLER_API_BASE_URL: "https://test.biller.uy",
        BILLER_API_TOKEN: "token_del_escritorio",
        BILLER_DATA_DIR: dir,
      }),
    ).toThrow(/BILLER_DATA_DIR/);
  });
});
