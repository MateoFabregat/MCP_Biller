import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i, label: 'method: "POST|PUT|PATCH|DELETE"' },
  { re: /\.\s*(?:post|put|patch|delete)\s*\(/i, label: ".post(/.put(/.patch(/.delete(" },
];

/** La escritura está aislada en directorios `write/`. */
const isWritePath = (file: string): boolean => file.split(sep).includes("write");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if ([".ts", ".js", ".mjs"].includes(extname(full))) out.push(full);
  }
  return out;
}

describe("write-isolation guard estático sobre src/", () => {
  // Requisito #5 (re-scoped): la LECTURA sigue siendo GET-only; la escritura
  // solo puede vivir en directorios write/.
  it("no contiene escritura (POST/PUT/PATCH/DELETE) fuera de la capa write/", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (isWritePath(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const { re, label } of FORBIDDEN) {
          if (re.test(line)) violations.push(`${file}:${i + 1} [${label}] ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("la escritura está efectivamente aislada en write/ (writeClient hace POST)", () => {
    const writeClient = readFileSync(join(SRC_DIR, "write", "writeClient.ts"), "utf8");
    expect(writeClient).toMatch(/method:\s*WRITE_METHOD/);
    expect(writeClient).toMatch(/WRITE_METHOD\s*=\s*["'`]POST["'`]/);
  });

  it("el cliente HTTP fija el método a GET vía ALLOWED_METHOD", () => {
    const client = readFileSync(join(SRC_DIR, "biller", "client.ts"), "utf8");
    // El fetch usa exclusivamente ALLOWED_METHOD como valor de `method`.
    expect(client).toMatch(/method:\s*ALLOWED_METHOD/);
    // No hay ningún `method:` con un literal de verbo HTTP de escritura.
    expect(client).not.toMatch(/method\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i);

    const guard = readFileSync(join(SRC_DIR, "biller", "httpGuard.ts"), "utf8");
    expect(guard).toMatch(/ALLOWED_METHOD\s*=\s*["'`]GET["'`]/);
  });
});
