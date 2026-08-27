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

/**
 * Los archivos barridos.
 *
 * `docs/ARQUITECTURA.md` y `docs/EQUIPO.md` entraron después: una segunda
 * revisión los encontró diciendo "19 tools de lectura" cuando ya eran 27 —el
 * mismo error que este test había venido a impedir, en documentos que nadie
 * había puesto bajo la red—. El criterio ahora es: si un documento afirma el
 * conteo, se vigila.
 *
 * OJO al agregar uno: el barrido es sobre el TEXTO CRUDO del archivo, así que
 * también entra a los bloques ```mermaid. Un nodo del diagrama que diga
 * "27 tools de lectura" queda vigilado igual que un párrafo.
 */
const DOCS_CON_CONTEOS = [
  "README.md",
  "docs/HANDBOOK.md",
  "docs/ARQUITECTURA.md",
  "docs/EQUIPO.md",
] as const;

describe("los documentos no afirman conteos falsos", () => {
  it.each([...DOCS_CON_CONTEOS, "src/tools/register.ts"])(
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

  it.each(DOCS_CON_CONTEOS)(
    "%s no menciona un conteo de tools de escritura distinto del real",
    (archivo) => {
      const encontrados = [...leer(archivo).matchAll(/(\d+)\s+tools?\s+de\s+escritura/gi)].map((m) =>
        Number(m[1]),
      );
      for (const n of encontrados) expect(n).toBe(ESCRITURA);
    },
  );

  // El conteo total (34, o 35 con la opt-in) es el que más se copia a mano.
  it.each(DOCS_CON_CONTEOS)("%s no afirma un total de tools registradas falso", (archivo) => {
    const total = LECTURA + ESCRITURA;
    const encontrados = [...leer(archivo).matchAll(/(\d+)\s+tools?\s+registradas/gi)].map((m) =>
      Number(m[1]),
    );
    for (const n of encontrados) expect([total, total + 1]).toContain(n);
  });

  it("READ_TOOL_NAMES y WRITE_TOOL_NAMES no se pisan", () => {
    // Una tool en las dos listas se registraría dos veces en write_enabled.
    const cruce = READ_TOOL_NAMES.filter((n) => (WRITE_TOOL_NAMES as readonly string[]).includes(n));
    expect(cruce).toEqual([]);
  });
});
