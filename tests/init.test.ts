// =============================================================================
// `npx biller-mcp-server init` — la parte con consecuencia de seguridad: el
// token del usuario termina escrito en disco. Que quede 0600 y que el merge no
// pise otros servers es lo que separa un instalador prolijo de una filtración.
// =============================================================================

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bloqueServidor, escribirConfigDesktop, rutaConfigClaudeDesktop } from "../src/cli/init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "biller-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modo = (p: string): string => (statSync(p).mode & 0o777).toString(8);

describe("escribirConfigDesktop", () => {
  it("crea el archivo con permisos 0600 (el token no lo lee otro usuario)", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    escribirConfigDesktop(ruta, "tok-secreto", "https://test.biller.uy");
    expect(modo(ruta)).toBe("600");
  });

  it("baja a 0600 un archivo que YA existía con permisos abiertos", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    writeFileSync(ruta, "{}\n", { mode: 0o644 });
    escribirConfigDesktop(ruta, "tok-secreto", "https://test.biller.uy");
    expect(modo(ruta)).toBe("600");
    expect(modo(`${ruta}.bak`)).toBe("600"); // el backup también lleva el token
  });

  it("no pisa otros servers ni otras claves del config", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    writeFileSync(ruta, JSON.stringify({ mcpServers: { otro: { command: "foo" } }, tema: "dark" }));
    escribirConfigDesktop(ruta, "tok", "https://test.biller.uy");
    const out = JSON.parse(readFileSync(ruta, "utf8")) as Record<string, any>;
    expect(Object.keys(out.mcpServers)).toEqual(["otro", "biller"]);
    expect(out.tema).toBe("dark");
  });

  it("es idempotente: repetir exactamente el mismo alta no reescribe ni crea backup", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    const primera = escribirConfigDesktop(ruta, "tok", "https://test.biller.uy");
    const antes = readFileSync(ruta, "utf8");

    const segunda = escribirConfigDesktop(ruta, "tok", "https://test.biller.uy");

    expect(primera.backup).toBe(false);
    expect(segunda.backup).toBe(false);
    expect(readFileSync(ruta, "utf8")).toBe(antes);
    expect(existsSync(`${ruta}.bak`)).toBe(false);
  });

  it("si el JSON existente está roto, falla sin tocarlo ni crear backup", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    const roto = "{ no-es-json\n";
    writeFileSync(ruta, roto, { mode: 0o600 });

    expect(() => escribirConfigDesktop(ruta, "tok", "https://test.biller.uy")).toThrow();
    expect(readFileSync(ruta, "utf8")).toBe(roto);
    expect(existsSync(`${ruta}.bak`)).toBe(false);
  });

  it("publica el config con reemplazo atómico y no deja temporales", () => {
    const ruta = join(dir, "claude_desktop_config.json");
    writeFileSync(ruta, JSON.stringify({ tema: "dark" }), { mode: 0o600 });

    escribirConfigDesktop(ruta, "tok", "https://test.biller.uy");

    expect(JSON.parse(readFileSync(ruta, "utf8"))).toMatchObject({
      tema: "dark",
      mcpServers: { biller: { command: "npx" } },
    });
    expect(readdirSync(dir).filter((nombre) => nombre.includes(".tmp-"))).toEqual([]);
  });

  it("el bloque registrado queda en solo lectura", () => {
    const b = bloqueServidor("tok", "https://test.biller.uy") as any;
    expect(b.env.BILLER_CAPABILITY_MODE).toBe("read_only");
    expect(b.env.BILLER_WRITE_ENABLED).toBe("false");
    expect(b.env.BILLER_API_TOKEN).toBe("tok");
  });
});

describe("rutaConfigClaudeDesktop", () => {
  it("resuelve las rutas soportadas sin depender de la máquina que corre el test", () => {
    expect(rutaConfigClaudeDesktop({ plataforma: "darwin", home: "/casa", env: {} })).toBe(
      "/casa/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(
      rutaConfigClaudeDesktop({ plataforma: "win32", home: "C:\\Users\\Mateo", env: { APPDATA: "C:\\Datos" } }),
    ).toBe("C:\\Datos/Claude/claude_desktop_config.json");
    expect(
      rutaConfigClaudeDesktop({ plataforma: "linux", home: "/home/mateo", env: { XDG_CONFIG_HOME: "/cfg" } }),
    ).toBe("/cfg/Claude/claude_desktop_config.json");
  });
});
