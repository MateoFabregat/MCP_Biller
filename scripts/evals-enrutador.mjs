#!/usr/bin/env node
// =============================================================================
// El benchmark del enrutador (V5.3): un NÚMERO, no un pass/fail.
//
// POR QUÉ EXISTE APARTE DE LOS TESTS
//
// Los tests de regresión protegen frases individuales: una que se rompe pone
// la suite en rojo. Esto contesta otra pregunta: ¿QUÉ PORCENTAJE del corpus se
// entiende? — el número que se compara entre commits antes de tocar sinónimos,
// prompts o (algún día) pesos. Un cambio puede arreglar 3 frases y romper 5;
// la suite lo dejaría pasar si esas 5 no tenían test, el score no.
//
// El corpus (evals/corpus-enrutador.jsonl) nació de la auditoría de 155
// mensajes reales de agosto 2026 y CRECE con producción: cada `desconocido`
// que las métricas muestren y que un humano etiquete es una línea más.
//
// USO
//   npm run build && node scripts/evals-enrutador.mjs [--min 90]
//
// Con --min, sale con código 1 si el score queda por debajo: eso lo hace
// usable como gate de CI sin convertir cada frase en un test frágil.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const { interpretarMensaje } = await import(join(raiz, "dist/kapso/menu.js"));

const min = (() => {
  const i = process.argv.indexOf("--min");
  return i === -1 ? null : Number(process.argv[i + 1]);
})();

const lineas = readFileSync(join(raiz, "evals/corpus-enrutador.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

let ok = 0;
const fallas = [];
for (const caso of lineas) {
  const r = interpretarMensaje(caso.mensaje, {
    capabilityMode: caso.modo ?? "write_enabled",
    en_flujo: caso.en_flujo === true,
  });
  let paso = true;
  if (caso.esperado_via !== undefined && r.via !== caso.esperado_via) paso = false;
  if (caso.esperado_opcion !== undefined && r.opcion?.id !== caso.esperado_opcion) paso = false;
  if (caso.prohibido_opcion !== undefined && r.opcion?.id === caso.prohibido_opcion) paso = false;
  if (paso) ok += 1;
  else fallas.push({ caso, obtenido: { via: r.via, opcion: r.opcion?.id ?? null } });
}

const score = Math.round((ok / lineas.length) * 1000) / 10;
console.log(`\nEnrutador: ${ok}/${lineas.length} casos (${score}%)\n`);
for (const f of fallas) {
  console.log(
    `  ✗ "${f.caso.mensaje}" → via=${f.obtenido.via} opcion=${f.obtenido.opcion}` +
      ` (esperaba ${f.caso.esperado_via ?? f.caso.esperado_opcion ?? "NO " + f.caso.prohibido_opcion})` +
      `  [${f.caso.origen}]`,
  );
}
if (min !== null && score < min) {
  console.error(`\n✗ Score ${score}% por debajo del mínimo ${min}%.`);
  process.exit(1);
}
