#!/usr/bin/env node
// =============================================================================
// Write-isolation guard (CI + local).
//
// La escritura (POST) está PERMITIDA solo dentro de directorios `write/`
// (src/write/ y src/tools/write/), que es la capa auditada con barreras.
// Este guard falla si aparece POST/PUT/PATCH/DELETE en CUALQUIER otro archivo
// de `src/`, garantizando que la superficie de LECTURA siga siendo GET-only.
//
// UNA SOLA FUENTE
//
// El análisis vive acá y `tests/readonly.test.ts` lo IMPORTA (`analizarSrc`).
// Antes el test tenía su propia copia del walk, de los patrones y del marcador
// de excepción: dos implementaciones de la misma barrera que podían divergir en
// silencio —una afloja un patrón, la otra no, y el CI sigue verde con un
// agujero abierto—. Este archivo sigue siendo el CLI que corre `npm run
// check:readonly`; lo único que cambió es que además exporta lo que analiza.
//
// Complementa al guard de runtime `src/biller/httpGuard.ts`.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

/** Los directorios `write/` son la única capa autorizada a hacer POST. */
const isWritePath = (file) => file.split(sep).includes("write");

// Patrones que NO deben aparecer en src/.
//
// `clase` separa dos cosas distintas que el mismo guard atrapa:
//
//  · "metodo_http": un verbo de escritura DECLARADO. Una excepción acá es
//    siempre una decisión de arquitectura (ver el test que las tiene pineadas).
//  · "invocacion": una llamada estilo cliente HTTP. Acá caen también los
//    Map.delete()/Set.delete(), que son falsos positivos y explican por qué
//    existe el marcador de excepción.
const FORBIDDEN = [
  // Object literal: { method: "POST" } y variantes.
  {
    re: /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i,
    label: 'method: "POST|PUT|PATCH|DELETE"',
    clase: "metodo_http",
  },
  // Llamadas estilo cliente HTTP: .post( .put( .patch( .delete(
  {
    re: /\.\s*(?:post|put|patch|delete)\s*\(/i,
    label: ".post(/.put(/.patch(/.delete(",
    clase: "invocacion",
  },
];

// El patrón `.delete(` también matchea Map.delete()/Set.delete(), que no tienen
// nada que ver con HTTP. En vez de aflojar el patrón —lo que abriría la puerta
// a que se cuele un .delete() real— se permite una excepción EXPLÍCITA por
// línea, que queda escrita en el código y se reporta al final para que no
// crezcan en silencio:
//
//     sesiones.delete(id); // check-readonly:allow Map.delete, no es HTTP
//
const ALLOW_MARKER = /\/\/\s*check-readonly:allow\b(.*)$/;

const EXTENSIONES = [".ts", ".mts", ".cts", ".js", ".mjs"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (EXTENSIONES.includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Recorre `src/` y devuelve, sin imprimir ni salir del proceso:
 *
 *  · `violaciones`: escritura fuera de `write/` SIN excepción declarada.
 *  · `excepciones`: escritura fuera de `write/` CON excepción declarada.
 *  · `marcadores`: todas las líneas con `check-readonly:allow` en src/,
 *    incluida la capa `write/` (para auditar que ninguna quede sin motivo).
 *
 * Cada entrada trae `archivo`, `linea` (1-based), `texto` y —cuando aplica—
 * `label`, `clase` y `motivo`.
 */
export function analizarSrc(dir = SRC_DIR) {
  const violaciones = [];
  const excepciones = [];
  const marcadores = [];

  for (const archivo of walk(dir)) {
    const enCapaWrite = isWritePath(archivo);
    const lines = readFileSync(archivo, "utf8").split("\n");

    lines.forEach((line, i) => {
      const linea = i + 1;
      const texto = line.trim();
      const allow = ALLOW_MARKER.exec(line);
      const motivo = allow !== null ? allow[1].trim() : null;

      if (allow !== null) marcadores.push({ archivo, linea, motivo, texto });

      // La capa de escritura auditada puede hacer POST: no se la analiza por
      // patrones (sus marcadores sí se recogen, arriba).
      if (enCapaWrite) return;

      for (const { re, label, clase } of FORBIDDEN) {
        if (!re.test(line)) continue;
        const entrada = { archivo, linea, texto, label, clase };
        if (allow !== null) excepciones.push({ ...entrada, motivo });
        else violaciones.push(entrada);
      }
    });
  }

  return { violaciones, excepciones, marcadores };
}

/** Formato de una excepción para el reporte del CLI (se mantiene tal cual estaba). */
const formatearExcepcion = (e) =>
  `${e.archivo}:${e.linea} —${e.motivo !== null && e.motivo.length > 0 ? ` ${e.motivo}` : " (sin motivo declarado)"}`;

function main() {
  const { violaciones, excepciones } = analizarSrc();

  for (const v of violaciones) {
    console.error(`WRITE-ISOLATION VIOLATION: ${v.archivo}:${v.linea}\n  ${v.texto}`);
  }

  if (violaciones.length > 0) {
    console.error(
      `\n✗ check:readonly falló: ${violaciones.length} llamada(s) de escritura fuera de la capa write/.`,
    );
    process.exit(1);
  }

  if (excepciones.length > 0) {
    console.log(`Excepciones declaradas (${excepciones.length}):`);
    for (const e of excepciones) console.log(`  · ${formatearExcepcion(e)}`);
  }

  console.log(
    "✓ check:readonly OK — la escritura está aislada en write/; el resto de src/ es GET-only.",
  );
}

// Solo corre el CLI cuando se lo invoca directamente (`npm run check:readonly`).
// Importado desde los tests, este archivo no imprime ni llama a process.exit().
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
