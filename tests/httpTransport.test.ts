// =============================================================================
// Transporte HTTP: autenticación y superficie expuesta.
//
// Exponer este server por HTTP es lo que habilita conectarlo a Kapso, y también
// lo que lo pone al alcance de cualquiera que encuentre el puerto. Estos tests
// fijan que sin credencial no se pasa, y que el único endpoint sin auth no
// devuelve ningún dato del negocio.
// =============================================================================

import { describe, expect, it } from "vitest";
import { request, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MIN_HTTP_TOKEN_LENGTH,
  autenticar,
  compararSeguro,
  extraerBearer,
  validarTokenDeArranque,
} from "../src/transport/httpAuth.js";
import { HEALTH_PATH, MCP_PATH, iniciarTransporteHttp } from "../src/transport/http.js";
import { makeConfig } from "./fixtures.js";

const TOKEN_VALIDO = "a".repeat(64);

function reqCon(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

describe("extracción del bearer", () => {
  it("acepta el formato estándar", () => {
    expect(extraerBearer("Bearer abc123")).toBe("abc123");
  });

  it("es insensible a mayúsculas y tolera espacios", () => {
    expect(extraerBearer("  bearer   abc123  ")).toBe("abc123");
  });

  it("devuelve null si falta o tiene otro esquema", () => {
    expect(extraerBearer(undefined)).toBeNull();
    expect(extraerBearer("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extraerBearer("abc123")).toBeNull();
  });
});

describe("comparación en tiempo constante", () => {
  it("acepta el token correcto", () => {
    expect(compararSeguro(TOKEN_VALIDO, TOKEN_VALIDO)).toBe(true);
  });

  it("rechaza tokens distintos y de distinto largo sin lanzar", () => {
    expect(compararSeguro(TOKEN_VALIDO, "b".repeat(64))).toBe(false);
    expect(compararSeguro(TOKEN_VALIDO, "corto")).toBe(false);
    expect(compararSeguro("", TOKEN_VALIDO)).toBe(false);
  });

  it("rechaza un prefijo correcto (no compara de a caracteres)", () => {
    expect(compararSeguro(`${TOKEN_VALIDO.slice(0, 63)}b`, TOKEN_VALIDO)).toBe(false);
  });
});

describe("autenticación de la request", () => {
  it("deja pasar el token correcto", () => {
    expect(autenticar(reqCon(`Bearer ${TOKEN_VALIDO}`), TOKEN_VALIDO)).toEqual({ ok: true });
  });

  it("401 si falta el header", () => {
    const r = autenticar(reqCon(), TOKEN_VALIDO);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("401 si el token es incorrecto", () => {
    const r = autenticar(reqCon("Bearer incorrecto"), TOKEN_VALIDO);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("SIN token configurado se rechaza TODO, no se deja pasar", () => {
    // Esta es la garantía central: "no hay token configurado" jamás puede
    // interpretarse como "no hace falta autenticar".
    for (const noConfigurado of [undefined, ""]) {
      const r = autenticar(reqCon(`Bearer ${TOKEN_VALIDO}`), noConfigurado);
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    // Ni siquiera presentando un token vacío que "coincida".
    expect(autenticar(reqCon("Bearer "), "")).toMatchObject({ ok: false });
  });

  it("el mensaje de error nunca incluye el token esperado", () => {
    const r = autenticar(reqCon("Bearer mal"), TOKEN_VALIDO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(TOKEN_VALIDO);
  });
});

describe("validación del token al arrancar", () => {
  it("exige que exista", () => {
    expect(validarTokenDeArranque(undefined)).toHaveLength(1);
    expect(validarTokenDeArranque("")).toHaveLength(1);
  });

  it("rechaza tokens cortos", () => {
    const problemas = validarTokenDeArranque("x".repeat(MIN_HTTP_TOKEN_LENGTH - 1));
    expect(problemas.some((p) => p.includes("demasiado corto"))).toBe(true);
  });

  it("rechaza valores de ejemplo aunque sean largos", () => {
    const problemas = validarTokenDeArranque(`changeme${"x".repeat(60)}`);
    expect(problemas.some((p) => p.includes("valor de ejemplo"))).toBe(true);
  });

  it("acepta un token generado al azar", () => {
    expect(validarTokenDeArranque("f3a9c1e0".repeat(8))).toEqual([]);
  });
});

describe("server HTTP end-to-end", () => {
  /** Arranca en un puerto efímero para no chocar con nada. */
  async function arrancar(token: string | undefined, allowedHosts: string[] = []) {
    const config = makeConfig({
      httpAuthToken: token,
      httpPort: 0,
      httpHost: "127.0.0.1",
      httpAllowedHosts: allowedHosts,
    });
    const handle = await iniciarTransporteHttp(config, () => new McpServer({ name: "t", version: "0" }));
    return { handle, base: `http://127.0.0.1:${handle.port}` };
  }

  /**
   * Un `initialize` con el Host que pondría un proxy público.
   *
   * Va con `node:http` y no con `fetch` a propósito: `Host` es un header
   * prohibido para fetch, que lo pisa con el del destino. Un test escrito con
   * fetch pasaría sin probar nada.
   */
  function initializeCon(puerto: number, host: string): Promise<string> {
    const cuerpo = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: puerto,
          path: MCP_PATH,
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN_VALIDO}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": Buffer.byteLength(cuerpo),
            host,
          },
        },
        (res) => {
          let datos = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (datos += c));
          res.on("end", () => resolve(datos));
        },
      );
      req.on("error", reject);
      req.end(cuerpo);
    });
  }

  // Este par de tests existe por una falla concreta: con el server detrás de un
  // túnel, Kapso recibía "Invalid Host header" y ninguna tool llegaba a
  // ejecutarse. La protección contra DNS rebinding estaba bien puesta; lo que
  // faltaba era poder declarar el hostname público SIN apagarla.
  it("rechaza un Host público que no fue declarado", async () => {
    const { handle } = await arrancar(TOKEN_VALIDO);
    try {
      expect(await initializeCon(handle.port, "tunel-cualquiera.ngrok-free.dev")).toContain(
        "Invalid Host header",
      );
    } finally {
      await handle.close();
    }
  });

  it("acepta el Host público declarado, con la protección igual encendida", async () => {
    const publico = "tunel-declarado.ngrok-free.dev";
    const { handle } = await arrancar(TOKEN_VALIDO, [publico]);
    try {
      expect(await initializeCon(handle.port, publico)).not.toContain("Invalid Host header");
      // Declarar uno no abre la puerta a los demás.
      expect(await initializeCon(handle.port, "otro-tunel.ngrok-free.dev")).toContain(
        "Invalid Host header",
      );
    } finally {
      await handle.close();
    }
  });

  it("/healthz responde sin auth y no filtra datos del negocio", async () => {
    const { handle, base } = await arrancar(TOKEN_VALIDO);
    try {
      const res = await fetch(`${base}${HEALTH_PATH}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Solo liveness: nada de config, tools, RUT ni tokens.
      expect(Object.keys(body).sort()).toEqual(["status", "transport"]);
      expect(JSON.stringify(body)).not.toContain(TOKEN_VALIDO);
    } finally {
      await handle.close();
    }
  });

  it("/mcp sin Authorization devuelve 401 y no procesa nada", async () => {
    const { handle, base } = await arrancar(TOKEN_VALIDO);
    try {
      const res = await fetch(`${base}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      // El error viaja como JSON-RPC para que el cliente MCP lo entienda.
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("Authorization");
    } finally {
      await handle.close();
    }
  });

  it("/mcp con token incorrecto devuelve 401", async () => {
    const { handle, base } = await arrancar(TOKEN_VALIDO);
    try {
      const res = await fetch(`${base}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("sin token configurado, /mcp rechaza incluso con Authorization presente", async () => {
    const { handle, base } = await arrancar(undefined);
    try {
      const res = await fetch(`${base}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_VALIDO}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("una ruta desconocida no revela nada y devuelve 404", async () => {
    const { handle, base } = await arrancar(TOKEN_VALIDO);
    try {
      const res = await fetch(`${base}/admin`);
      expect(res.status).toBe(404);
      const texto = await res.text();
      expect(texto).not.toContain(TOKEN_VALIDO);
      expect(texto).toContain(MCP_PATH);
    } finally {
      await handle.close();
    }
  });

  it("las respuestas no se cachean", async () => {
    const { handle, base } = await arrancar(TOKEN_VALIDO);
    try {
      const res = await fetch(`${base}${HEALTH_PATH}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await handle.close();
    }
  });
});
