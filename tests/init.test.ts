// =============================================================================
// `npx biller-mcp-server init` — la parte con consecuencia de seguridad: el
// token del usuario termina escrito en disco. Que quede 0600 y que el merge no
// pise otros servers es lo que separa un instalador prolijo de una filtración.
// =============================================================================

import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bloqueServidor, escribirConfigDesktop } from "../src/cli/init.js";

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

  it("el bloque registrado queda en solo lectura", () => {
    const b = bloqueServidor("tok", "https://test.biller.uy") as any;
    expect(b.env.BILLER_CAPABILITY_MODE).toBe("read_only");
    expect(b.env.BILLER_WRITE_ENABLED).toBe("false");
    expect(b.env.BILLER_API_TOKEN).toBe("tok");
  });
});
