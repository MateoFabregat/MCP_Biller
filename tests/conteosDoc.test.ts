// =============================================================================
// Los números que los documentos afirman sobre el código.
//
// POR QUÉ ESTO ES UN TEST Y NO UNA REVISIÓN
//
// Una revisión de diseño encontró cuatro afirmaciones numéricas desactualizadas
// a la vez: el HANDBOOK decía "24 tools de lectura", el README "26", el
// docstring de `getRegisteredToolNames` decía "9 de lectura, 16 en total" (los
// números de hace meses), y el conteo de tests estaba viejo en los dos docs.
//
// Ninguna rompía nada. Ese es exactamente el problema: una cifra equivocada en
// la documentación no falla, solo hace que el que llega desconfíe del resto del
// documento —y con razón, porque no tiene forma de saber qué otra cosa está
// vieja—.
//
// La respuesta no es acordarse de actualizarlas. Es que la afirmación viva en
// un lugar donde equivocarse cueste rojo.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools/register.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (p: string): string => readFileSync(join(RAIZ, p), "utf8");

/** Cuántas tools de lectura y de escritura hay DE VERDAD. */
const LECTURA = READ_TOOL_NAMES.length;
const ESCRITURA = WRITE_TOOL_NAMES.length;

describe("los documentos no afirman conteos falsos", () => {
  it.each(["README.md", "docs/HANDBOOK.md", "src/tools/register.ts"])(
    "%s no menciona un conteo de tools de lectura distinto del real",
    (archivo) => {
      const texto = leer(archivo);
      // Busca "N tools de lectura" / "las N de lectura" en cualquier forma.
      const encontrados = [...texto.matchAll(/(\d+)\s+(?:tools?\s+de\s+lectura|de\s+lectura)/gi)].map(
        (m) => Number(m[1]),
      );
      for (const n of encontrados) expect(n).toBe(LECTURA);
    },
  );

  it.each(["README.md", "docs/HANDBOOK.md"])(
    "%s no menciona un conteo de tools de escritura distinto del real",
    (archivo) => {
      const encontrados = [...leer(archivo).matchAll(/(\d+)\s+tools?\s+de\s+escritura/gi)].map((m) =>
        Number(m[1]),
      );
      for (const n of encontrados) expect(n).toBe(ESCRITURA);
    },
  );

  it("READ_TOOL_NAMES y WRITE_TOOL_NAMES no se pisan", () => {
    // Una tool en las dos listas se registraría dos veces en write_enabled.
    const cruce = READ_TOOL_NAMES.filter((n) => (WRITE_TOOL_NAMES as readonly string[]).includes(n));
    expect(cruce).toEqual([]);
  });
});
