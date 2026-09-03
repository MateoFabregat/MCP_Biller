import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_PATH } from "../src/transport/http.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const hijos = new Set<ChildProcess>();

function tenant(authToken: string, apiToken: string) {
  return [{ id: "panaderia", auth_token: authToken, env: {
    BILLER_API_TOKEN: apiToken,
    BILLER_CAPABILITY_MODE: "read_only",
  } }];
}

function entorno(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BILLER_TRANSPORT: "http",
    BILLER_HTTP_HOST: "127.0.0.1",
    BILLER_HTTP_PORT: "0",
    BILLER_HTTP_AUTH_TOKEN: "g".repeat(64),
    BILLER_API_BASE_URL: "https://test.biller.uy",
    BILLER_API_TOKEN: "token-global-test",
    BILLER_CAPABILITY_MODE: "read_only",
    BILLER_APPROVAL_SECRET: "approval-global-test-123456789012",
    BILLER_TENANTS_JSON: "",
    BILLER_TENANTS_PATH: "",
    KAPSO_API_KEY: "",
    KAPSO_WEBHOOK_SECRET: "",
    ...extra,
  };
  return env;
}

function esperarLog(
  child: ChildProcess,
  lineas: string[],
  predicado: (linea: string) => boolean,
  timeoutMs = 8_000,
): Promise<string> {
  const previa = lineas.find(predicado);
  if (previa !== undefined) return Promise.resolve(previa);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => terminar(new Error("timeout esperando log del proceso HTTP")), timeoutMs);
    const alDato = (): void => {
      const encontrada = lineas.find(predicado);
      if (encontrada !== undefined) terminar(undefined, encontrada);
    };
    const alSalir = (code: number | null): void => terminar(new Error(`el proceso HTTP terminó (${code})`));
    const terminar = (error?: Error, linea?: string): void => {
      clearTimeout(timeout);
      child.stderr?.off("data", alDato);
      child.off("exit", alSalir);
      if (error !== undefined) reject(error);
      else resolve(linea!);
    };
    child.stderr?.on("data", alDato);
    child.once("exit", alSalir);
  });
}

async function iniciar(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  hijos.add(child);
  const lineas: string[] = [];
  let pendiente = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    pendiente += chunk;
    const partes = pendiente.split("\n");
    pendiente = partes.pop() ?? "";
    lineas.push(...partes);
  });
  const lista = await esperarLog(child, lineas, (linea) => linea.includes("biller-mcp-server listo (http)"));
  const parsed = JSON.parse(lista) as { meta: { endpoint: string } };
  return { child, lineas, base: parsed.meta.endpoint.slice(0, -MCP_PATH.length) };
}

async function cerrar(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  hijos.delete(child);
}

afterEach(async () => {
  await Promise.all([...hijos].map(cerrar));
});

async function rpc(base: string, token: string, sessionId?: string, initialize = false) {
  return fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(initialize
      ? { jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reload-test", version: "1" },
        } }
      : { jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
}

describe("SIGHUP real del proceso HTTP", () => {
  it("un registro inválido conserva el snapshot que ya atendía", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-sighup-invalid-"));
    const path = join(dir, "tenants.json");
    writeFileSync(path, JSON.stringify(tenant(TOKEN_A, "api-panaderia-a")), { mode: 0o600 });
    const proceso = await iniciar(entorno({ BILLER_TENANTS_PATH: path }));
    try {
      expect((await rpc(proceso.base, TOKEN_A)).status).not.toBe(401);
      writeFileSync(path, "{invalido", { mode: 0o600 });
      proceso.child.kill("SIGHUP");
      await esperarLog(proceso.child, proceso.lineas, (linea) => linea.includes("tenants.recarga.rechazada"));
      expect((await rpc(proceso.base, TOKEN_A)).status).not.toBe(401);
    } finally {
      await cerrar(proceso.child);
    }
  });

  it("rotar la credencial cierra la sesión vieja y revoca el token anterior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-sighup-rotate-"));
    const path = join(dir, "tenants.json");
    writeFileSync(path, JSON.stringify(tenant(TOKEN_A, "api-panaderia-a")), { mode: 0o600 });
    const proceso = await iniciar(entorno({ BILLER_TENANTS_PATH: path }));
    try {
      const inicial = await rpc(proceso.base, TOKEN_A, undefined, true);
      expect(inicial.status).toBe(200);
      const sessionId = inicial.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      await inicial.text();

      writeFileSync(path, JSON.stringify(tenant(TOKEN_B, "api-panaderia-b")), { mode: 0o600 });
      proceso.child.kill("SIGHUP");
      await esperarLog(proceso.child, proceso.lineas, (linea) => linea.includes("tenants.recarga.completada"));

      expect((await rpc(proceso.base, TOKEN_A, sessionId!)).status).toBe(401);
      expect((await rpc(proceso.base, TOKEN_B, sessionId!)).status).toBe(404);
    } finally {
      await cerrar(proceso.child);
    }
  });

  it("mono-tenant sobrevive SIGHUP y sigue atendiendo sin emitir logs de recarga", async () => {
    const proceso = await iniciar(entorno());
    try {
      proceso.child.kill("SIGHUP");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(proceso.child.exitCode).toBeNull();
      expect((await rpc(proceso.base, "g".repeat(64))).status).not.toBe(401);
      expect(proceso.lineas.some((linea) => linea.includes("tenants.recarga."))).toBe(false);
    } finally {
      await cerrar(proceso.child);
    }
  });
});
