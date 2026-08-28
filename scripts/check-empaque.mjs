// =============================================================================
// Guard de empaque: el tarball no puede llevar archivos duplicados.
//
// POR QUÉ EXISTE. macOS con iCloud sincronizando ~/Documents crea copias en
// conflicto ("archivo 2.js", "archivo 3.js") DENTRO del repo, sin avisar y en
// cualquier momento. La v0.1.0 se publicó con 61 de esas copias adentro porque
// nada lo impedía: tsc compila lo que encuentra y npm empaqueta lo que hay.
// Un paquete con dos copias de cada módulo no rompe nada hoy, pero es el tipo
// de basura que un día ES una versión vieja de un módulo de seguridad.
//
// Corre en prepack (antes de todo publish). Si encuentra una copia, corta.
// =============================================================================
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function buscar(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) buscar(full, out);
    else if (/ \d+(\.|$)/.test(entry)) out.push(full);
  }
  return out;
}

const sospechosos = [];
for (const dir of ["dist", "src"]) {
  try { buscar(dir, sospechosos); } catch { /* dist puede no existir aún */ }
}

if (sospechosos.length > 0) {
  console.error("✗ check:empaque — hay archivos duplicados (copias de iCloud/Finder) que NO pueden publicarse:");
  for (const f of sospechosos) console.error(`  · ${f}`);
  console.error("Borralos (rm) y corré `npm run build` de nuevo. Causa probable: iCloud sincronizando ~/Documents.");
  process.exit(1);
}
console.log("✓ check:empaque OK — sin archivos duplicados en src/ ni dist/.");
