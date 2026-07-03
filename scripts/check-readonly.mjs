#!/usr/bin/env node
// =============================================================================
// Write-isolation guard (CI + local).
//
// La escritura (POST) está PERMITIDA solo dentro de directorios `write/`
// (src/write/ y src/tools/write/), que es la capa auditada con barreras.
// Este guard falla si aparece POST/PUT/PATCH/DELETE en CUALQUIER otro archivo
// de `src/`, garantizando que la superficie de LECTURA siga siendo GET-only.
//
// Complementa al test `tests/readonly.test.ts` y al guard de runtime
// `src/biller/httpGuard.ts`.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

/** Los directorios `write/` son la única capa autorizada a hacer POST. */
const isWritePath = (file) => file.split(sep).includes("write");

// Patrones que NO deben aparecer en src/.
const FORBIDDEN = [
  // Object literal: { method: "POST" } y variantes.
  /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i,
  // Llamadas estilo cliente HTTP: .post( .put( .patch( .delete(
  /\.\s*(?:post|put|patch|delete)\s*\(/i,
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if ([".ts", ".mts", ".cts", ".js", ".mjs"].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

let violations = 0;
for (const file of walk(SRC_DIR)) {
  if (isWritePath(file)) continue; // capa de escritura auditada: POST permitido acá
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) {
        console.error(`WRITE-ISOLATION VIOLATION: ${file}:${i + 1}\n  ${line.trim()}`);
        violations += 1;
      }
    }
  });
}

if (violations > 0) {
  console.error(
    `\n✗ check:readonly falló: ${violations} llamada(s) de escritura fuera de la capa write/.`,
  );
  process.exit(1);
}

console.log(
  "✓ check:readonly OK — la escritura está aislada en write/; el resto de src/ es GET-only.",
);
