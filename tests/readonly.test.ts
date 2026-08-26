// =============================================================================
// La barrera de escritura, verificada desde el MISMO código que corre en CI.
//
// Este test NO reimplementa el walk ni los patrones: importa `analizarSrc()` de
// `scripts/check-readonly.mjs`, que es lo que ejecuta `npm run check:readonly`.
// Antes había dos copias de la barrera —una acá y otra allá— y dos copias de
// una barrera son dos barreras que pueden divergir sin que nadie lo note.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analizarSrc } from "../scripts/check-readonly.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIR = join(ROOT, "src");

/** Ruta relativa al repo, con "/" siempre, para que los mensajes sean legibles. */
const rel = (archivo: string): string => relative(ROOT, archivo).split(sep).join("/");

/**
 * Excepciones de MÉTODO HTTP autorizadas, PINEADAS.
 *
 * Son los dos POST del cliente de Kapso: salen hacia WhatsApp, no hacia la API
 * fiscal de Biller, y pasan por la allowlist de destinatarios. Cualquier tercera
 * excepción de este tipo es una decisión de arquitectura, no un detalle de
 * implementación, y tiene que discutirse en un diff — no aparecer sola.
 */
const EXCEPCIONES_METODO_HTTP_ESPERADAS = ["src/kapso/client.ts", "src/kapso/client.ts"];

describe("write-isolation guard estático sobre src/", () => {
  // Requisito #5 (re-scoped): la LECTURA sigue siendo GET-only; la escritura
  // solo puede vivir en directorios write/.
  it("no contiene escritura (POST/PUT/PATCH/DELETE) fuera de la capa write/", () => {
    const { violaciones } = analizarSrc();
    expect(
      violaciones.map((v) => `${rel(v.archivo)}:${v.linea} [${v.label}] ${v.texto}`),
    ).toEqual([]);
  });

  it("toda excepción declarada trae un motivo escrito", () => {
    // Una excepción sin motivo es una excepción que nadie va a poder revisar
    // dentro de seis meses. El guard las tolera; este test las obliga a
    // explicarse. Se miran TODOS los marcadores de src/, incluida la capa
    // write/: ahí el POST está permitido, pero un `allow` mudo tampoco sirve.
    const { marcadores } = analizarSrc();
    const sinMotivo = marcadores
      .filter((m) => (m.motivo ?? "").length < 10)
      .map((m) => `${rel(m.archivo)}:${m.linea}`);
    expect(sinMotivo).toEqual([]);
  });

  it("las excepciones de método HTTP son EXACTAMENTE las dos conocidas (POST a Kapso)", () => {
    // Este es el test que hace ruido. Las excepciones de `.delete(` son falsos
    // positivos de Map/Set y crecen con el código sin significar nada; una
    // excepción sobre un `method: "POST"` es otra cosa: es una salida de
    // escritura nueva. Pinear el conteo hace que la tercera ponga el CI en rojo.
    const { excepciones } = analizarSrc();
    const metodoHttp = excepciones.filter((e) => e.clase === "metodo_http");
    const ubicaciones = metodoHttp.map((e) => rel(e.archivo));

    expect(
      ubicaciones,
      "Cambió el conjunto de excepciones de MÉTODO HTTP fuera de la capa write/. " +
        "Cada una es una salida de escritura que esquiva el guard de solo-lectura, así que no puede " +
        "aparecer ni desaparecer sin una decisión EXPLÍCITA: revisá el diff, justificá por qué ese " +
        "POST/PUT/PATCH/DELETE no va en src/write/, y recién ahí actualizá " +
        "EXCEPCIONES_METODO_HTTP_ESPERADAS en este test. Encontradas: " +
        (metodoHttp.map((e) => `${rel(e.archivo)}:${e.linea} (${e.motivo ?? "sin motivo"})`).join("; ") ||
          "(ninguna)"),
    ).toEqual(EXCEPCIONES_METODO_HTTP_ESPERADAS);
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
