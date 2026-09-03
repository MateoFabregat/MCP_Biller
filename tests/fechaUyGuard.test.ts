// =============================================================================
// Guard estático: "hoy" se pregunta en Uruguay, no en UTC.
//
// EL BUG QUE ESTE TEST EXISTE PARA QUE NO VUELVA
//
// `src/services/fechaUy.ts` se escribió justamente para cerrar el desfasaje de
// UTC−3 (ver su encabezado). Pero escribirlo no alcanzó: meses después, seis
// tools y cinco defaults de services seguían llamando a `new Date()` crudo. En
// un proceso que corre en UTC —Vercel, un Docker, cualquier server sin `TZ`—
// eso significa que a las 21:00 de Montevideo "hoy" pasa a ser mañana:
//
//   · el aging de vencimientos y de la cuenta corriente daba un día de más;
//   · el digest diario mezclaba dos días en un mismo mensaje, porque
//     `resolverPeriodo` ya resolvía en hora uruguaya y el resto no.
//
// Nada de eso falla: devuelve un número equivocado con total naturalidad. Por
// eso la regla vive acá, donde equivocarse cuesta rojo, y no en un documento.
//
// LA REGLA
//
// Fuera de `src/services/fechaUy.ts`, un `new Date()` crudo NO puede usarse como
// "qué día es hoy". La regla cubre producción y los fixtures representativos
// de `tests/`, y persigue estas formas, que son las que aparecieron de verdad
// en el repo:
//
//   1. `?? new Date()`            — un `hoy` inyectable cuyo default es UTC-now.
//   2. `const hoy = new Date();`  — el instante crudo atado a una variable.
//   3. `hoy: Date = new Date()`   — lo mismo, como parámetro con default.
//   4. `helper(new Date())`       — el instante crudo entra directo a una
//                                  función que espera un día civil.
//
// LAS DOS SALIDAS
//
// (a) CONVERSIÓN. (2) y (3) se aceptan si ese mismo identificador se le pasa a
//     un conversor de `fechaUy` cerca (`hoyIsoUy(hoy)`, `hoyDgiUy(ahora)`, …).
//     Un instante crudo que se convierte a día uruguayo antes de usarse ya es
//     correcto: `new Date()` ahí es solo "ahora", que es lo que el conversor
//     espera recibir.
//
// (b) MARCADOR EXPLÍCITO, misma convención que `check-readonly:allow`:
//
//         hoy: Date = new Date(), // fecha-uy:allow es un TTL, no un día
//
//     Existe porque hay usos legítimos del instante crudo: un TTL de cache o un
//     techo de validación miden DURACIONES, y ahí anclar al mediodía uruguayo
//     sería introducir un error de doce horas, no sacarlo. La excepción queda
//     escrita en el código y se revisa en el diff; aflojar el patrón, no.
//
// LO QUE EL GUARD NO PERSIGUE, A PROPÓSITO
//
// `new Date().toISOString()` para sellar un log, una auditoría o una entrada de
// idempotencia. Eso es un INSTANTE (y en UTC, que es lo correcto para un sello),
// no una respuesta a "qué día es". Perseguirlo sería puro ruido.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(RAIZ, "src");
const TESTS_DIR = join(RAIZ, "tests");

/** El único archivo que puede preguntarle la hora al sistema. */
const MODULO_FECHA = join("src", "services", "fechaUy.ts");
/** Este guard contiene ejemplos de los patrones y no puede denunciarse solo. */
const ARCHIVO_GUARD = join("tests", "fechaUyGuard.test.ts");

/** Excepción por línea, con motivo escrito. */
const ALLOW_MARKER = /\/\/\s*fecha-uy:allow\b(.*)$/;

/** Línea que es solo comentario: prosa, no código. */
const ES_COMENTARIO = /^\s*(?:\/\/|\/\*|\*)/;

/** Los conversores que convierten un instante en el día uruguayo. */
const CONVERSORES = ["hoyIsoUy", "hoyDgiUy", "hoyComoDateUy"];

/** Cuántas líneas hacia adelante se busca la conversión del identificador. */
const VENTANA_CONVERSION = 8;

const IDENT = "[A-Za-z_$][\\w$]*";

interface Patron {
  re: RegExp;
  label: string;
  /** Si matchea, el grupo 1 es el identificador que puede redimirse convirtiéndose. */
  redimible: boolean;
}

const PATRONES: Patron[] = [
  // 1. Default nullish. Irredimible: el valor sale de la función como `hoy` y
  //    quien lo recibe no tiene forma de saber que venía en UTC.
  { re: /\?\?\s*new Date\(\)/, label: "?? new Date()", redimible: false },
  // 2. Binding crudo: `const hoy = new Date();`, `this.hoy = new Date();`.
  {
    re: new RegExp(`(?:const|let|var|this\\.)\\s*(${IDENT})\\s*=\\s*new Date\\(\\)\\s*;?`),
    label: "= new Date();",
    redimible: true,
  },
  // 3. Parámetro con default: `hoy: Date = new Date()`.
  {
    re: new RegExp(`(${IDENT})\\s*:\\s*Date\\s*=\\s*new Date\\(\\)`),
    label: ": Date = new Date()",
    redimible: true,
  },
  // 4. El instante crudo entrando directo a un helper de fechas —
  //    `aIso(new Date())`, `diasEntre(aIso(new Date()), …)`. Los conversores de
  //    fechaUy quedan afuera: recibir "ahora" es exactamente su contrato.
  {
    re: new RegExp(`\\b(?!(?:${CONVERSORES.join("|")})\\b)${IDENT}\\(\\s*new Date\\(\\)\\s*[,)]`),
    label: "f(new Date())",
    redimible: false,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if ([".ts", ".js", ".mjs"].includes(extname(full))) out.push(full);
  }
  return out;
}

/** ¿Se convierte `ident` a día uruguayo en las líneas que siguen? */
function seConvierte(lineas: string[], desde: number, ident: string): boolean {
  const ventana = lineas.slice(desde + 1, desde + 1 + VENTANA_CONVERSION).join("\n");
  return CONVERSORES.some((c) => new RegExp(`\\b${c}\\s*\\(\\s*${ident}\\s*[,)]`).test(ventana));
}

function rutasGuardadas(): string[] {
  return [...walk(SRC_DIR), ...walk(TESTS_DIR)];
}

function rutaRelativa(file: string): string {
  return relative(RAIZ, file).split(sep).join("/");
}

function esArchivoExceptuado(file: string): boolean {
  const ruta = rutaRelativa(file);
  return ruta === MODULO_FECHA.split(sep).join("/") || ruta === ARCHIVO_GUARD.split(sep).join("/");
}

function violacionesDeFuente(fuente: string, archivo = "fixture.ts"): string[] {
  const lineas = fuente.split("\n");
  const out: string[] = [];
  lineas.forEach((linea, i) => {
    // Las líneas de comentario quedan afuera: este archivo se explica a sí
    // mismo citando los patrones que persigue, y un guard que se marca la
    // propia prosa enseña a la gente a escribir los comentarios raro.
    if (ES_COMENTARIO.test(linea)) return;
    if (ALLOW_MARKER.test(linea)) return;
    for (const { re, label, redimible } of PATRONES) {
      const m = re.exec(linea);
      if (m === null) continue;
      if (redimible && m[1] !== undefined && seConvierte(lineas, i, m[1])) continue;
      out.push(`${archivo}:${i + 1} [${label}] ${linea.trim()}`);
      return;
    }
  });
  return out;
}

function violaciones(): string[] {
  const out: string[] = [];
  for (const file of rutasGuardadas()) {
    if (esArchivoExceptuado(file)) continue;
    out.push(...violacionesDeFuente(readFileSync(file, "utf8"), rutaRelativa(file)));
  }
  return out;
}

function motivosFaltantes(fuente: string, archivo = "fixture.ts"): string[] {
  return fuente
    .split("\n")
    .flatMap((linea, i) => {
      const m = ALLOW_MARKER.exec(linea);
      return m !== null && m[1]!.trim().length === 0 ? [`${archivo}:${i + 1}`] : [];
    });
}

describe('guard estático: "hoy" en hora uruguaya', () => {
  it("ningún archivo de src/ ni fixture representativo usa new Date() como día civil", () => {
    expect(violaciones()).toEqual([]);
  });

  it("toda excepción fecha-uy:allow trae un motivo escrito", () => {
    // Una excepción sin motivo no se puede revisar dentro de seis meses. El
    // guard las tolera; este test las obliga a explicarse. Mismo criterio que
    // `check-readonly:allow` en readonly.test.ts.
    const sinMotivo: string[] = [];
    for (const file of rutasGuardadas()) {
      if (esArchivoExceptuado(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((linea, i) => {
          const m = ALLOW_MARKER.exec(linea);
          if (m !== null && m[1]!.trim().length === 0) {
            sinMotivo.push(`${relative(RAIZ, file)}:${i + 1}`);
          }
        });
    }
    expect(sinMotivo).toEqual([]);
  });

  it("el guard detecta fixtures civiles y redime instantes técnicos", () => {
    // Un guard estático que dejó de matchear es un guard verde y vacío: el
    // caso más caro de todos, porque nadie lo mira. Las muestras son las
    // líneas REALES que este guard vino a sacar del repo.
    const casos = [
      "  const hoyIso = aIso(opciones.hoy ?? new Date());",
      "  const hoy = new Date();",
      "export function ttlPara(hasta: string, hoy: Date = new Date()): number {",
      "  const dias = diasEntre(aIso(new Date()), vencimiento.fecha);",
    ];
    for (const caso of casos) {
      expect(
        PATRONES.some((p) => p.re.test(caso)),
        caso,
      ).toBe(true);
    }

    // Y no matchea lo que no debe: sellos de tiempo, relojes inyectables y los
    // conversores de fechaUy recibiendo "ahora", que es su contrato.
    const inocentes = [
      "    ts: new Date().toISOString(),",
      "    this.ahora = opciones.ahora ?? (() => new Date());",
      "  return hoyIsoUy(new Date());",
    ];
    for (const caso of inocentes) {
      expect(
        PATRONES.some((p) => p.re.test(caso)),
        caso,
      ).toBe(false);
    }

    expect(violacionesDeFuente("const hoy = new Date();")).toEqual([
      "fixture.ts:1 [= new Date();] const hoy = new Date();",
    ]);
    expect(violacionesDeFuente("const ahora = new Date();\nhoyIsoUy(ahora);")).toEqual([]);
    expect(
      violacionesDeFuente("const ahora = new Date(); // fecha-uy:allow TTL de fixture técnico"),
    ).toEqual([]);
    expect(motivosFaltantes("const ahora = new Date(); // fecha-uy:allow")).toEqual(["fixture.ts:1"]);
  });

  it("fechaUy.ts sigue siendo el único que le pregunta la hora al sistema", () => {
    // Si el módulo se renombra o se parte, el guard quedaría exceptuando un
    // archivo que ya no existe — verde y sin cubrir nada.
    const fuente = readFileSync(join(RAIZ, MODULO_FECHA), "utf8");
    expect(fuente).toContain("new Date()");
    for (const c of CONVERSORES) expect(fuente).toContain(`export function ${c}`);
  });
});
