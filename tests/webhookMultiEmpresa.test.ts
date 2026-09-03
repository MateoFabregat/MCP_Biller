// =============================================================================
// El webhook cuando hay más de una empresa en el proceso.
//
// EL AGUJERO QUE CIERRAN ESTOS TESTS. El `/mcp` era multi-empresa de verdad
// —el bearer autentica Y selecciona— pero el webhook entra ANTES del bearer, por
// diseño: su credencial es la firma HMAC porque quien llama es Kapso y no un
// cliente MCP. Sin nada con qué resolver empresa, atendía TODO con la config del
// proceso: la allowlist de remitentes de una empresa validando mensajes
// dirigidos a otra, el capability mode de una decidiendo si a un usuario de otra
// se le ofrece emitir, y el BorradorStore del proceso —salado con un `cacheId`
// ajeno— sin encontrar jamás el borrador de nadie.
//
// Ahora hay dos selectores que tienen que coincidir: el PATH elige el secreto
// (`/kapso/webhook/<id>`) y el `phone_number_id` del cuerpo firmado dice a qué
// número le escribieron. Lo que se prueba acá es sobre todo qué NO pasa.
// =============================================================================

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BorradorStoreMemoria, type BorradorStore } from "../src/kapso/borradorStore.js";
import { firmar } from "../src/kapso/webhook.js";
import { crearServidorMcp } from "../src/server.js";
import { createToolContext } from "../src/tools/register.js";
import {
  construirRegistro,
  entornoDe,
  TenantConfigError,
  type Tenant,
} from "../src/tenants/registry.js";
import {
  WEBHOOK_PATH,
  iniciarTransporteHttp,
  rutaWebhookTenant,
  type AmbitoWebhook,
} from "../src/transport/http.js";
import { makeConfig } from "./fixtures.js";

const TOKEN_A = "a".repeat(48);
const TOKEN_B = "b".repeat(48);

const SECRETO_A = "secreto-webhook-de-la-panaderia";
const SECRETO_B = "secreto-webhook-de-la-ferreteria";

const NUMERO_A = "111111111111111";
const NUMERO_B = "222222222222222";

/** Autorizado en A y NO en B: es el par que prueba que la allowlist es la buena. */
const REMITENTE_A = "59895923567";
/** Autorizado en B y no en A. */
const REMITENTE_B = "59897000111";

/** Un entorno de proceso limpio: nada que un tenant pueda heredar por accidente. */
const BASE: Record<string, string | undefined> = {
  BILLER_API_BASE_URL: "https://test.biller.uy",
};

function tenantsCrudos(): unknown[] {
  return [
    {
      id: "panaderia",
      nombre: "Panadería Rivera",
      auth_token: TOKEN_A,
      env: {
        BILLER_API_TOKEN: "token_biller_panaderia",
        BILLER_APPROVAL_SECRET: "approval-secret-panaderia-1234567890",
        BILLER_CAPABILITY_MODE: "write_enabled",
        BILLER_REMITENTES_AUTORIZADOS: REMITENTE_A,
        KAPSO_API_KEY: "kapso_a",
        KAPSO_PHONE_NUMBER_ID: NUMERO_A,
        KAPSO_WEBHOOK_SECRET: SECRETO_A,
      },
    },
    {
      id: "ferreteria",
      nombre: "Ferretería Sur",
      auth_token: TOKEN_B,
      env: {
        BILLER_API_TOKEN: "token_biller_ferreteria",
        BILLER_APPROVAL_SECRET: "approval-secret-ferreteria-1234567890",
        BILLER_CAPABILITY_MODE: "read_only",
        BILLER_REMITENTES_AUTORIZADOS: REMITENTE_B,
        KAPSO_API_KEY: "kapso_b",
        KAPSO_PHONE_NUMBER_ID: NUMERO_B,
        KAPSO_WEBHOOK_SECRET: SECRETO_B,
      },
    },
  ];
}

/** Payload con la forma real de la Cloud API. `numero` es a QUIÉN le escribieron. */
function eventoTexto(body: string, from: string, numero: string | null): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              ...(numero === null
                ? {}
                : { metadata: { display_phone_number: "598…", phone_number_id: numero } }),
              contacts: [{ profile: { name: "Quien sea" }, wa_id: from }],
              messages: [
                { from, id: "wamid.HBg", timestamp: "1780000000", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

interface Levantado {
  handle: { port: number; close: () => Promise<void> };
  url: (ruta: string) => string;
  /** El store de cada empresa, para plantar un borrador y probar `en_flujo`. */
  stores: Map<string, BorradorStore>;
}

/**
 * Levanta el transporte con las dos empresas configuradas, resolviendo el ámbito
 * igual que `index.ts`: config del overlay del tenant y un BorradorStore SALADO
 * con la identidad de esa empresa.
 */
async function levantarMultiEmpresa(crudos: unknown[] = tenantsCrudos()): Promise<Levantado> {
  const registro = construirRegistro(crudos, BASE);
  const stores = new Map<string, BorradorStore>();
  const configs = new Map<string, ReturnType<typeof loadConfig>>();

  const resolverAmbitoWebhook = (tenant: Tenant): AmbitoWebhook => {
    if (!stores.has(tenant.id)) {
      // La sal la da el token de Biller de la empresa, igual que en producción
      // (ahí sale del `cacheId` del cliente, que es sha256 de baseUrl+token).
      stores.set(tenant.id, new BorradorStoreMemoria({ sal: `sal-${tenant.id}` }));
      configs.set(tenant.id, loadConfig(entornoDe(tenant, BASE)));
    }
    return {
      tenantId: tenant.id,
      config: configs.get(tenant.id)!,
      borradores: stores.get(tenant.id)!,
    };
  };

  const handle = await iniciarTransporteHttp(
    // La config del PROCESO: sin Kapso y sin allowlist. Si algo cayera al
    // proceso, se notaría — y ese es justamente uno de los tests.
    makeConfig({ httpAuthToken: "bearer-del-proceso", httpPort: 0 }),
    () => crearServidorMcp(createToolContext({}), "read_only"),
    registro,
    undefined,
    { resolverAmbitoWebhook },
  );

  return {
    handle,
    url: (ruta) => `http://127.0.0.1:${handle.port}${ruta}`,
    stores,
  };
}

async function postear(
  url: string,
  payload: unknown,
  secreto: string | null,
): Promise<{ status: number; body: any }> {
  const cuerpo = JSON.stringify(payload);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secreto === null ? {} : { "x-hub-signature-256": firmar(cuerpo, secreto) }),
    },
    body: cuerpo,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// El registro: lo que no arranca
// ---------------------------------------------------------------------------

describe("el número de WhatsApp no se comparte entre empresas", () => {
  it("dos tenants con el mismo KAPSO_PHONE_NUMBER_ID no arrancan", () => {
    const crudos = tenantsCrudos() as { env: Record<string, string> }[];
    crudos[1]!.env.KAPSO_PHONE_NUMBER_ID = NUMERO_A;
    // Mismo filo que el `auth_token` y el `BILLER_API_TOKEN` duplicados: es un
    // copy-paste de la entrada de arriba, no se nota nunca porque las dos
    // empresas "andan", y el día que se nota es porque los mensajes de una
    // entraron en la contabilidad de la otra.
    expect(() => construirRegistro(crudos, BASE)).toThrow(TenantConfigError);
    expect(() => construirRegistro(crudos, BASE)).toThrow(/MISMO KAPSO_PHONE_NUMBER_ID/);
  });

  it("el índice por número queda armado y apunta a la empresa correcta", () => {
    const registro = construirRegistro(tenantsCrudos(), BASE);
    expect(registro.porPhoneNumberId.get(NUMERO_A)?.id).toBe("panaderia");
    expect(registro.porPhoneNumberId.get(NUMERO_B)?.id).toBe("ferreteria");
    expect(registro.porPhoneNumberId.get("999")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// La allowlist que se aplica es la de la empresa a la que le escribieron
// ---------------------------------------------------------------------------

describe("cada empresa contesta con SU barrera de entrada", () => {
  it("el remitente autorizado en A pasa por la ruta de A", async () => {
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("panaderia")),
        eventoTexto("hola", REMITENTE_A, NUMERO_A),
        SECRETO_A,
      );
      expect(res.status).toBe(200);
      expect(res.body.accion).toBe("responder");
      expect(res.body.via).toBe("saludo");
    } finally {
      await handle.close();
    }
  });

  it("EL MISMO teléfono, autorizado en A y no en B, se rechaza en B", async () => {
    // Este es el bug con nombre y apellido: antes la allowlist era la del
    // proceso, así que quien estaba autorizado en una empresa le hablaba a
    // todas. Acá el mensaje entra por la ruta de B, con el secreto de B y el
    // número de B: todo legítimo, y la respuesta tiene que ser "no sos de acá".
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("ferreteria")),
        eventoTexto("cuánto facturé", REMITENTE_A, NUMERO_B),
        SECRETO_B,
      );
      expect(res.status).toBe(200);
      expect(res.body.accion).toBe("rechazar");
      expect(res.body.motivo).toBe("no_autorizado");
      // Ni una pista de la empresa: contestar algo ya confirma que el número
      // atiende a alguien.
      expect(res.body.respuesta_sugerida).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it("y el remitente de B sí pasa por B: la barrera separa, no bloquea a todos", async () => {
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("ferreteria")),
        eventoTexto("hola", REMITENTE_B, NUMERO_B),
        SECRETO_B,
      );
      expect(res.body.accion).toBe("responder");
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// El borrador: la regresión de "pará, eran 3 no 2"
// ---------------------------------------------------------------------------

describe("el borrador de una empresa SÍ se encuentra", () => {
  it("una corrección en medio de una carga se delega, no se contesta con el menú", async () => {
    // ESTE ES EL CASO CARO, y el que el corpus de evals no puede ver: el
    // enrutador es puro y correcto, lo que estaba mal era el `en_flujo` que le
    // entraba. Con el store del PROCESO (salado con otro `cacheId`) la clave de
    // sesión de esta empresa no resuelve nunca, `en_flujo` da falso, "pará, eran
    // 3 no 2" cae en `desconocido` —que es autorrespondible— y el webhook le
    // contesta el MENÚ ENTERO a alguien que estaba corrigiendo una cantidad.
    const { handle, url, stores } = await levantarMultiEmpresa();
    try {
      const payload = eventoTexto("para, eran 3 no 2", REMITENTE_A, NUMERO_A);
      const ruta = url(rutaWebhookTenant("panaderia"));

      const sinBorrador = await postear(ruta, payload, SECRETO_A);
      expect(sinBorrador.body.accion).toBe("responder");
      expect(sinBorrador.body.mostrar_menu).toBe(true);

      // Se planta el borrador en el store DE ESA EMPRESA, con SU clave.
      const store = stores.get("panaderia")!;
      store.guardar(store.clave(REMITENTE_A), { clase_receptor: "consumidor_final" });

      const conBorrador = await postear(ruta, payload, SECRETO_A);
      // Delegar = se lo pasa al agente, que tiene al humano adelante. El webhook
      // sigue sin ejecutar nada que toque plata: leyó su propio estado.
      expect(conBorrador.body.accion).toBe("delegar");
      expect(conBorrador.body.via).toBe("flujo_emision");
    } finally {
      await handle.close();
    }
  });

  it("el borrador de una empresa no habilita el flujo de la otra", async () => {
    const { handle, url, stores } = await levantarMultiEmpresa();
    try {
      // La panadería tiene una carga abierta con este teléfono…
      await postear(
        url(rutaWebhookTenant("panaderia")),
        eventoTexto("hola", REMITENTE_A, NUMERO_A),
        SECRETO_A,
      );
      const storeA = stores.get("panaderia")!;
      storeA.guardar(storeA.clave(REMITENTE_B), { clase_receptor: "consumidor_final" });

      // …y eso no puede poner en flujo la conversación de la ferretería.
      const res = await postear(
        url(rutaWebhookTenant("ferreteria")),
        eventoTexto("para, eran 3 no 2", REMITENTE_B, NUMERO_B),
        SECRETO_B,
      );
      expect(res.body.accion).toBe("responder");
      expect(res.body.via).toBe("desconocido");
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Los dos selectores, y qué pasa cuando no coinciden
// ---------------------------------------------------------------------------

describe("el secreto lo selecciona el path", () => {
  it("un cuerpo firmado con el secreto de A contra la ruta de B da 401", async () => {
    // No hace falta comparar nada: el único secreto que la ruta de B conoce es
    // el de B. El mismatch no se chequea, no existe.
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("ferreteria")),
        eventoTexto("hola", REMITENTE_B, NUMERO_B),
        SECRETO_A,
      );
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_signature");
    } finally {
      await handle.close();
    }
  });

  it("una empresa que no existe da 404, sin decir cuáles existen", async () => {
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("no-existe")),
        eventoTexto("hola", REMITENTE_A, NUMERO_A),
        SECRETO_A,
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("panaderia");
    } finally {
      await handle.close();
    }
  });
});

describe("el phone_number_id del cuerpo tiene que decir lo mismo que el path", () => {
  it("ruta de A con el número de B: configuración cruzada, se rechaza", async () => {
    // La firma es válida —quien mandó esto tiene el secreto de A— así que no es
    // un ataque: es un webhook de Kapso apuntado a la URL de la otra empresa.
    // Sirve todo lo que sigue con los datos equivocados, así que no se sirve.
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("panaderia")),
        eventoTexto("hola", REMITENTE_A, NUMERO_B),
        SECRETO_A,
      );
      expect(res.status).toBe(200);
      expect(res.body.procesado).toBe(false);
      expect(res.body.motivo).toContain("otra empresa");
      // Cero interpretación: ni vía, ni menú, ni respuesta sugerida.
      expect(res.body.via).toBeUndefined();
      expect(res.body.accion).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it("un phone_number_id desconocido da 200, no se interpreta y NO cae al proceso", async () => {
    const { handle, url } = await levantarMultiEmpresa();
    try {
      const res = await postear(
        url(rutaWebhookTenant("panaderia")),
        // Remitente autorizado en A y saludo: si esto cayera al proceso o al
        // tenant de la ruta sin chequear, contestaría el menú.
        eventoTexto("hola", REMITENTE_A, "999999999999999"),
        SECRETO_A,
      );
      expect(res.status).toBe(200);
      expect(res.body.procesado).toBe(false);
      expect(res.body.motivo).toContain("ninguna empresa");
      expect(res.body.via).toBeUndefined();
      expect(res.body.mostrar_menu).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// La ruta vieja
// ---------------------------------------------------------------------------

describe("la ruta vieja con empresas configuradas", () => {
  it("devuelve 404 en vez de atender con la config del proceso", async () => {
    // Es el caso de alguien que migró a multi-empresa y se olvidó de cambiar la
    // URL en el panel de Kapso. Con 404 ese número queda mudo y el log en error
    // dice qué pasó; atendiéndolo, ese número contesta bien y factura mal.
    const { handle, url } = await levantarMultiEmpresa();
    try {
      for (const ruta of [WEBHOOK_PATH, `${WEBHOOK_PATH}/`]) {
        const res = await postear(
          url(ruta),
          eventoTexto("hola", REMITENTE_A, NUMERO_A),
          SECRETO_A,
        );
        expect(res.status).toBe(404);
      }
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// El modo de una sola empresa no cambió
// ---------------------------------------------------------------------------

describe("sin empresas configuradas, todo queda como estaba", () => {
  async function levantarMono() {
    const config = makeConfig({
      httpAuthToken: "bearer-de-prueba",
      httpPort: 0,
      kapso: {
        apiKey: "kapso_key",
        baseUrl: "https://api.kapso.ai",
        phoneNumberId: NUMERO_A,
        destinatariosPermitidos: [REMITENTE_A],
        webhookSecret: SECRETO_A,
      },
    });
    const handle = await iniciarTransporteHttp(config, () =>
      crearServidorMcp(createToolContext({}), "read_only"),
    );
    return { handle, url: (r: string) => `http://127.0.0.1:${handle.port}${r}` };
  }

  it("la ruta vieja sigue atendiendo con el secreto del proceso", async () => {
    const { handle, url } = await levantarMono();
    try {
      const res = await postear(
        url(WEBHOOK_PATH),
        eventoTexto("hola", REMITENTE_A, NUMERO_A),
        SECRETO_A,
      );
      expect(res.status).toBe(200);
      expect(res.body.accion).toBe("responder");
      expect(res.body.via).toBe("saludo");
    } finally {
      await handle.close();
    }
  });

  it("un phone_number_id cualquiera NO cambia nada: sin registro no hay a quién mapear", async () => {
    // Importante que esto siga andando: en mono-empresa el número receptor no es
    // un selector de nada, y ponerse a validarlo rompería todo despliegue que no
    // haya declarado KAPSO_PHONE_NUMBER_ID.
    const { handle, url } = await levantarMono();
    try {
      const res = await postear(
        url(WEBHOOK_PATH),
        eventoTexto("hola", REMITENTE_A, "otro-numero-cualquiera"),
        SECRETO_A,
      );
      expect(res.body.accion).toBe("responder");
    } finally {
      await handle.close();
    }
  });

  it("la ruta por empresa no existe en modo de una sola empresa", async () => {
    // Sin registro no hay id que resolver: aceptar cualquiera sería un alias
    // abierto de la ruta única.
    const { handle, url } = await levantarMono();
    try {
      const res = await postear(
        url(rutaWebhookTenant("lo-que-sea")),
        eventoTexto("hola", REMITENTE_A, NUMERO_A),
        SECRETO_A,
      );
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});
