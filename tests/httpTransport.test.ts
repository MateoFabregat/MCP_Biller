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
import {
  HEALTH_PATH,
  MCP_PATH,
  RegistroSesiones,
  iniciarTransporteHttp,
} from "../src/transport/http.js";
import { makeConfig, TEST_TOKEN } from "./fixtures.js";

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

// =============================================================================
// Registro de sesiones: TTL, techo LRU y aislamiento por tenant.
//
// La fuga que esto cubre es la única real del proceso largo: cada sesión es un
// transporte MÁS un McpServer con su ToolContext, y antes solo se sacaba del
// mapa cuando el cliente cerraba limpio. Un túnel cortado no cierra limpio.
//
// Todo con reloj inyectado: nada de sleeps ni timers reales.
// =============================================================================

describe("registro de sesiones HTTP", () => {
  /** Doble mínimo: lo único que importa es SI le llamaron a close(). */
  function transporteFalso(): { cerrado: boolean } & Record<string, unknown> {
    const t = { cerrado: false, close: () => { t.cerrado = true; return Promise.resolve(); } };
    return t as never;
  }

  function registro(ahora: () => number, opts: { ttlMs?: number; techo?: number } = {}) {
    return new RegistroSesiones({ ahora, ...opts });
  }

  it("una sesión vencida se CIERRA y se desaloja en el barrido", () => {
    let t = 0;
    const reg = registro(() => t, { ttlMs: 1000 });
    const transporte = transporteFalso();
    reg.registrar("a:1", transporte as never);

    t = 1001;
    reg.barrer();

    expect(reg.size).toBe(0);
    // Sacarla del mapa sin cerrar sería la misma fuga con otra cara.
    expect(transporte.cerrado).toBe(true);
  });

  it("una sesión vencida tampoco se devuelve si la piden directo", () => {
    let t = 0;
    const reg = registro(() => t, { ttlMs: 1000 });
    const transporte = transporteFalso();
    reg.registrar("a:1", transporte as never);
    t = 5000;
    expect(reg.obtener("a:1")).toBeUndefined();
    expect(transporte.cerrado).toBe(true);
  });

  it("una sesión que se sigue usando NO se cae por el mero paso del tiempo", () => {
    let t = 0;
    const reg = registro(() => t, { ttlMs: 1000 });
    const transporte = transporteFalso();
    reg.registrar("a:1", transporte as never);

    // Cada 900 ms alguien la usa: nunca llega a estar 1000 ms idle.
    for (let i = 0; i < 20; i += 1) {
      t += 900;
      expect(reg.obtener("a:1")).toBeDefined();
      reg.barrer();
    }

    expect(reg.size).toBe(1);
    expect(transporte.cerrado).toBe(false);
  });

  it("el techo desaloja la MENOS USADA recientemente, y la cierra", () => {
    let t = 0;
    const reg = registro(() => t, { techo: 2 });
    const vieja = transporteFalso();
    const media = transporteFalso();
    reg.registrar("a:vieja", vieja as never);
    t += 10;
    reg.registrar("a:media", media as never);

    // Se usa la primera: pasa a ser la MÁS reciente aunque sea la más antigua
    // de creación. Sin reinserción en el acceso, esto sería FIFO y caería ella.
    t += 10;
    expect(reg.obtener("a:vieja")).toBeDefined();

    t += 10;
    reg.registrar("a:nueva", transporteFalso() as never);

    expect(reg.size).toBe(2);
    expect(media.cerrado).toBe(true);
    expect(vieja.cerrado).toBe(false);
    expect(reg.obtener("a:vieja")).toBeDefined();
    expect(reg.obtener("a:media")).toBeUndefined();
  });

  it("el prefijo por tenant aísla: el mismo sessionId de otra empresa no resuelve", () => {
    const reg = registro(() => 0);
    const deA = transporteFalso();
    reg.registrar("empresaA:sesion-1", deA as never);

    // Mismo mcp-session-id, otro tenant autenticado: no hay nada para él.
    expect(reg.obtener("empresaB:sesion-1")).toBeUndefined();
    expect(reg.obtener("empresaA:sesion-1")).toBeDefined();
  });

  it("cerrarTenant cierra SOLO las sesiones de esa empresa (revocación futura)", () => {
    const reg = registro(() => 0);
    const a1 = transporteFalso();
    const a2 = transporteFalso();
    const b1 = transporteFalso();
    reg.registrar("empresaA:1", a1 as never);
    reg.registrar("empresaA:2", a2 as never);
    reg.registrar("empresaB:1", b1 as never);

    expect(reg.cerrarTenant("empresaA")).toBe(2);
    expect(a1.cerrado).toBe(true);
    expect(a2.cerrado).toBe(true);
    expect(b1.cerrado).toBe(false);
    expect(reg.size).toBe(1);
    expect(reg.obtener("empresaB:1")).toBeDefined();
  });

  it("cerrarTodo no confunde 'empresaAB' con 'empresaA'", () => {
    const reg = registro(() => 0);
    const ab = transporteFalso();
    reg.registrar("empresaAB:1", ab as never);
    expect(reg.cerrarTenant("empresaA")).toBe(0);
    expect(ab.cerrado).toBe(false);
  });

  it("cerrarTodo cierra los transportes, no solo vacía el mapa", () => {
    const reg = registro(() => 0);
    const uno = transporteFalso();
    reg.registrar("a:1", uno as never);
    reg.cerrarTodo();
    expect(reg.size).toBe(0);
    expect(uno.cerrado).toBe(true);
  });

  it("un close() que rechaza no tumba el proceso ni deja la entrada colgada", () => {
    let t = 0;
    const reg = registro(() => t, { ttlMs: 100 });
    reg.registrar("a:1", { close: () => Promise.reject(new Error("socket roto")) } as never);
    t = 1000;
    expect(() => reg.barrer()).not.toThrow();
    expect(reg.size).toBe(0);
  });
});

// =============================================================================
// /readyz: liveness no es lo mismo que "puede trabajar"
// =============================================================================
//
// `/healthz` contesta 200 mientras el proceso esté vivo, aunque el gate vaya a
// bloquear todos los POST por configuración incompleta. Un orquestador que solo
// mira liveness le manda tráfico igual, y el usuario descubre el problema
// intentando facturar. `/readyz` es la otra pregunta.

describe("/readyz — preparación, no latido", () => {
  async function arrancarCon(config: Parameters<typeof makeConfig>[0]) {
    const handle = await iniciarTransporteHttp(
      makeConfig({ httpPort: 0, httpHost: "127.0.0.1", ...config }),
      () => new McpServer({ name: "t", version: "0" }),
    );
    return { handle, base: `http://127.0.0.1:${handle.port}` };
  }

  const listaParaProduccion = {
    apiBaseUrl: "https://biller.uy",
    capabilityMode: "write_enabled" as const,
    writeEnabled: true,
    allowProductionWrites: true,
    auditLogPath: "/tmp/audit.jsonl",
    idempotencyLogPath: "/tmp/idem.jsonl",
    maxMontos: { UYU: 100_000 },
    valorUi: 6.3,
    valorUiFecha: "2026-09-01",
  };

  it("dice 503 y QUÉ falta cuando el gate va a bloquear los POST", async () => {
    const { handle, base } = await arrancarCon({
      ...listaParaProduccion,
      maxMontos: {},
      valorUi: undefined,
      valorUiFecha: undefined,
    });
    try {
      const res = await fetch(`${base}/readyz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; faltan: string[] };
      expect(body.status).toBe("no_listo");
      expect(body.faltan.join(" ")).toContain("BILLER_MAX_MONTO");
      expect(body.faltan.join(" ")).toContain("BILLER_VALOR_UI");
    } finally {
      await handle.close();
    }
  });

  it("dice 200 cuando la preparación está completa", async () => {
    const { handle, base } = await arrancarCon(listaParaProduccion);
    try {
      const res = await fetch(`${base}/readyz`);
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toMatchObject({ status: "listo" });
    } finally {
      await handle.close();
    }
  });

  it("en test o sin escrituras es 200: el gate no bloquea nada ahí", async () => {
    const { handle, base } = await arrancarCon({ capabilityMode: "read_only" });
    try {
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("no pide auth y no filtra nada del negocio ni el token", async () => {
    const { handle, base } = await arrancarCon({
      ...listaParaProduccion,
      maxMontos: {},
      httpAuthToken: TOKEN_VALIDO,
    });
    try {
      const cuerpo = await (await fetch(`${base}/readyz`)).text();
      expect(cuerpo).not.toContain(TOKEN_VALIDO);
      expect(cuerpo).not.toContain(TEST_TOKEN);
      // Nombres de variable de entorno, nunca sus valores ni rutas del server.
      expect(cuerpo).not.toContain("/tmp/audit.jsonl");
    } finally {
      await handle.close();
    }
  });
});
