import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { firmar } from "../src/kapso/webhook.js";
import { HolderRegistroTenants } from "../src/tenants/holder.js";
import { ContextosPorTenant } from "../src/tenants/contextos.js";
import { crearManejadorRecargaTenants } from "../src/tenants/recarga.js";
import { construirRegistro, entornoDe } from "../src/tenants/registry.js";
import {
  MCP_PATH,
  RegistroSesiones,
  iniciarTransporteHttp,
  rutaWebhookTenant,
} from "../src/transport/http.js";
import { makeConfig } from "./fixtures.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const BASE = { BILLER_API_BASE_URL: "https://test.biller.uy" };

function registro(id: string, authToken: string) {
  return construirRegistro([
    { id, auth_token: authToken, env: { BILLER_API_TOKEN: `api-${id}` } },
  ], BASE);
}

function registroDos(tokenA = TOKEN_A, apiA = "api-panaderia") {
  return construirRegistro([
    { id: "panaderia", auth_token: tokenA, env: { BILLER_API_TOKEN: apiA } },
    { id: "ferreteria", auth_token: TOKEN_B, env: { BILLER_API_TOKEN: "api-ferreteria" } },
  ], BASE);
}

async function llamar(base: string, token: string): Promise<Response> {
  return fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("consumidores del registro vigente", () => {
  it("la autenticación de cada request usa el snapshot publicado más reciente", async () => {
    const holder = new HolderRegistroTenants(registro("panaderia", TOKEN_A));
    const config = makeConfig({ httpPort: 0, httpHost: "127.0.0.1", httpAuthToken: undefined });
    const vistos: Array<string | null> = [];
    const handle = await iniciarTransporteHttp(
      config,
      (tenant) => {
        vistos.push(tenant?.id ?? null);
        return new McpServer({ name: "t", version: "0" });
      },
      holder,
    );
    const base = `http://127.0.0.1:${handle.port}`;

    try {
      expect((await llamar(base, TOKEN_A)).status).not.toBe(401);
      expect(vistos).toEqual(["panaderia"]);

      holder.reemplazar(registro("ferreteria", TOKEN_B));

      expect((await llamar(base, TOKEN_A)).status).toBe(401);
      expect((await llamar(base, TOKEN_B)).status).not.toBe(401);
      expect(vistos).toEqual(["panaderia", "ferreteria"]);
    } finally {
      await handle.close();
    }
  });

  it("el webhook resuelve una empresa agregada desde el snapshot vigente", async () => {
    const vacio = construirRegistro([], BASE);
    const holder = new HolderRegistroTenants(vacio);
    const secreto = "secreto-webhook-recargado";
    const phoneNumberId = "111111111111111";
    const remitente = "59899123456";
    const agregado = construirRegistro([
      {
        id: "panaderia",
        auth_token: TOKEN_A,
        env: {
          BILLER_API_TOKEN: "api-panaderia",
          BILLER_APPROVAL_SECRET: "approval-secret-panaderia-1234567890",
          BILLER_CAPABILITY_MODE: "read_only",
          KAPSO_API_KEY: "api-kapso-panaderia",
          KAPSO_WEBHOOK_SECRET: secreto,
          KAPSO_PHONE_NUMBER_ID: phoneNumberId,
          BILLER_REMITENTES_AUTORIZADOS: remitente,
        },
      },
    ], BASE);
    const resueltos: string[] = [];
    const config = makeConfig({ httpPort: 0, httpHost: "127.0.0.1", httpAuthToken: TOKEN_B });
    const handle = await iniciarTransporteHttp(
      config,
      () => new McpServer({ name: "t", version: "0" }),
      holder,
      undefined,
      {
        resolverAmbitoWebhook: (tenant) => {
          resueltos.push(tenant.id);
          return { tenantId: tenant.id, config: loadConfig(entornoDe(tenant, BASE)) };
        },
      },
    );

    try {
      holder.reemplazar(agregado);
      const payload = {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "598…", phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: "Cliente" }, wa_id: remitente }],
          messages: [{ from: remitente, id: "wamid.reload", timestamp: "1780000000", type: "text", text: { body: "hola" } }],
        } }] }],
      };
      const cuerpo = JSON.stringify(payload);
      const response = await fetch(
        `http://127.0.0.1:${handle.port}${rutaWebhookTenant("panaderia")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo, secreto) },
          body: cuerpo,
        },
      );
      expect(response.status).toBe(200);
      expect(resueltos).toEqual(["panaderia"]);
    } finally {
      await handle.close();
    }
  });
});

describe("invalidación selectiva de contextos", () => {
  it("reconstruye el tenant cambiado y conserva por identidad el que no cambió", () => {
    const anterior = registroDos();
    const contextos = new ContextosPorTenant(BASE);
    const contextoPanaderia = contextos.para(anterior.tenants[0]!);
    const contextoFerreteria = contextos.para(anterior.tenants[1]!);
    const siguiente = registroDos(TOKEN_A, "api-panaderia-nueva");

    expect(contextos.invalidarCambios(anterior, siguiente)).toEqual(["panaderia"]);
    expect(contextos.para(siguiente.tenants[0]!)).not.toBe(contextoPanaderia);
    expect(contextos.para(siguiente.tenants[1]!)).toBe(contextoFerreteria);
  });

  it("invalida al rotar auth_token aunque el entorno sea idéntico y también al eliminar", () => {
    const anterior = registroDos();
    const contextos = new ContextosPorTenant(BASE);
    const contextoPanaderia = contextos.para(anterior.tenants[0]!);
    contextos.para(anterior.tenants[1]!);
    const rotado = registroDos("c".repeat(64));

    expect(contextos.invalidarCambios(anterior, rotado)).toEqual(["panaderia"]);
    expect(contextos.para(rotado.tenants[0]!)).not.toBe(contextoPanaderia);

    const soloPanaderia = construirRegistro([
      { id: "panaderia", auth_token: "c".repeat(64), env: { BILLER_API_TOKEN: "api-panaderia" } },
    ], BASE);
    expect(contextos.invalidarCambios(rotado, soloPanaderia)).toEqual(["ferreteria"]);
    expect(contextos.tamano).toBe(1);
  });
});

describe("invalidación de sesiones por tenant", () => {
  it("una sesión que termina de inicializar después de la revocación no puede registrarse", () => {
    const sesiones = new RegistroSesiones();
    const generacionVieja = sesiones.generacionTenant("panaderia");
    const transporte = { cerrado: false, close: () => {
      transporte.cerrado = true;
      return Promise.resolve();
    } };

    sesiones.cerrarTenant("panaderia");

    expect(sesiones.registrarSiVigente(
      "panaderia:sesion-tardia",
      "panaderia",
      generacionVieja,
      transporte as never,
    )).toBe(false);
    expect(transporte.cerrado).toBe(true);
    expect(sesiones.obtener("panaderia:sesion-tardia")).toBeUndefined();
  });

  it("el handle cierra los transportes afectados y preserva los demás", async () => {
    const sesiones = new RegistroSesiones();
    const crearTransporteFalso = () => {
      const transporte = { cerrado: false, close: () => {
        transporte.cerrado = true;
        return Promise.resolve();
      } };
      return transporte;
    };
    const a1 = crearTransporteFalso();
    const a2 = crearTransporteFalso();
    const b1 = crearTransporteFalso();
    sesiones.registrar("panaderia:1", a1 as never);
    sesiones.registrar("panaderia:2", a2 as never);
    sesiones.registrar("ferreteria:1", b1 as never);
    const config = makeConfig({ httpPort: 0, httpHost: "127.0.0.1", httpAuthToken: TOKEN_A });
    const handle = await iniciarTransporteHttp(
      config,
      () => new McpServer({ name: "t", version: "0" }),
      undefined,
      undefined,
      { registroSesiones: sesiones },
    );

    try {
      expect(handle.cerrarSesionesTenants(["panaderia"])).toBe(2);
      expect(a1.cerrado).toBe(true);
      expect(a2.cerrado).toBe(true);
      expect(b1.cerrado).toBe(false);
      expect(sesiones.obtener("ferreteria:1")).toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

describe("recarga atómica del registro", () => {
  it("una carga válida invalida estado afectado y recién después publica", () => {
    const anterior = registroDos();
    const siguiente = registroDos(TOKEN_A, "api-panaderia-nueva");
    const holder = new HolderRegistroTenants(anterior);
    const contextos = new ContextosPorTenant(BASE);
    const contextoAnterior = contextos.para(anterior.tenants[0]!);
    const cerrados: string[][] = [];
    const recargar = crearManejadorRecargaTenants({
      env: { ...BASE, BILLER_TENANTS_PATH: "/config/tenants.json" },
      holder,
      contextos,
      cerrarSesiones: (ids) => {
        expect(holder.actual()).toBe(anterior);
        cerrados.push([...ids]);
        return ids.length;
      },
      cargar: () => siguiente,
    });

    expect(recargar()).toEqual({ estado: "recargado", afectados: ["panaderia"], sesionesCerradas: 1 });
    expect(holder.actual()).toBe(siguiente);
    expect(cerrados).toEqual([["panaderia"]]);
    expect(contextos.para(siguiente.tenants[0]!)).not.toBe(contextoAnterior);
  });

  it("una carga inválida conserva snapshot, contextos y sesiones", () => {
    const anterior = registroDos();
    const holder = new HolderRegistroTenants(anterior);
    const contextos = new ContextosPorTenant(BASE);
    const contextoAnterior = contextos.para(anterior.tenants[0]!);
    let cierres = 0;
    const recargar = crearManejadorRecargaTenants({
      env: { ...BASE, BILLER_TENANTS_PATH: "/config/tenants.json" },
      holder,
      contextos,
      cerrarSesiones: () => {
        cierres += 1;
        return 0;
      },
      cargar: () => { throw new Error("registro inválido"); },
    });

    expect(recargar()).toMatchObject({ estado: "error" });
    expect(holder.actual()).toBe(anterior);
    expect(contextos.para(anterior.tenants[0]!)).toBe(contextoAnterior);
    expect(cierres).toBe(0);
  });

  it("sin fuente de tenants es un no-op y ni siquiera intenta cargar", () => {
    const anterior = construirRegistro([], BASE);
    const holder = new HolderRegistroTenants(anterior);
    let cargas = 0;
    const recargar = crearManejadorRecargaTenants({
      env: BASE,
      holder,
      contextos: new ContextosPorTenant(BASE),
      cerrarSesiones: () => 0,
      cargar: () => {
        cargas += 1;
        return anterior;
      },
    });

    expect(recargar()).toEqual({ estado: "sin_fuente" });
    expect(cargas).toBe(0);
  });
});
