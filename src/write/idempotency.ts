// =============================================================================
// Idempotencia.
//
// Evita ejecutar dos veces la MISMA operación (p.ej. un retry del modelo que
// duplicaría un comprobante ante DGI). Se complementa con el header
// `Idempotency-Key` que envía el writeClient.
//
// PERSISTENCIA (PLAN_V2 §5.4). Hasta acá el registro era un Set en memoria: al
// reiniciar el server, una key ya ejecutada volvía a considerarse nueva. En el
// uso real eso no es raro — se reinicia Claude Desktop, se recarga la config —
// y el resultado es una factura duplicada que hay que anular con una nota de
// crédito.
//
// Ahora hay dos implementaciones:
//   · InMemoryIdempotencyStore — la de siempre; default cuando no se configura ruta.
//   · FileIdempotencyStore     — append-only en disco, sobrevive reinicios.
//
// El archivo guarda SOLO la key y el timestamp. Nunca el payload: ese archivo
// no está pensado para ser secreto, y los datos de facturación no tienen por
// qué estar ahí.
// =============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

export function generateIdempotencyKey(): string {
  return randomUUID();
}

export interface IdempotencyStore {
  has(key: string): boolean;
  markUsed(key: string): void;
  clear(): void;
}

/** Registro en memoria: se pierde al reiniciar el proceso. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly used = new Set<string>();

  has(key: string): boolean {
    return this.used.has(key);
  }

  markUsed(key: string): void {
    this.used.add(key);
  }

  clear(): void {
    this.used.clear();
  }
}

/**
 * Registro persistente en un archivo de líneas JSON.
 *
 * Se lee entero al arrancar y se mantiene en memoria; cada `markUsed` agrega
 * una línea. El volumen es de una línea por escritura ejecutada, así que ni el
 * tamaño ni la lectura inicial son un problema en el orden de magnitud de una
 * PyME (miles de comprobantes al año).
 *
 * Los errores de E/S NO se propagan: si el disco falla, el store degrada a
 * comportamiento en memoria y avisa. Perder la protección contra duplicados es
 * malo, pero bloquear toda la facturación de la empresa porque no se pudo
 * escribir un archivo auxiliar es peor.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly used = new Set<string>();
  private readonly path: string;
  private degradado = false;

  constructor(path: string) {
    this.path = path;
    this.cargar();
  }

  private cargar(): void {
    try {
      if (!existsSync(this.path)) return;
      for (const linea of readFileSync(this.path, "utf8").split("\n")) {
        if (linea.trim() === "") continue;
        try {
          const entrada = JSON.parse(linea) as { key?: unknown };
          if (typeof entrada.key === "string") this.used.add(entrada.key);
        } catch {
          // Línea corrupta (p.ej. escritura interrumpida): se ignora esa sola,
          // no se descarta el archivo entero.
        }
      }
      logger.info("idempotencia.cargada", { keys: this.used.size });
    } catch (err) {
      this.degradar("leer", err);
    }
  }

  private degradar(operacion: string, err: unknown): void {
    if (this.degradado) return;
    this.degradado = true;
    logger.warn(
      `No se pudo ${operacion} el archivo de idempotencia: la protección contra duplicados ` +
        "pasa a ser solo en memoria y NO sobrevive a un reinicio.",
      { path: this.path, err: err instanceof Error ? err.message : String(err) },
    );
  }

  has(key: string): boolean {
    return this.used.has(key);
  }

  markUsed(key: string): void {
    this.used.add(key);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify({ key, ts: new Date().toISOString() })}\n`, "utf8");
    } catch (err) {
      this.degradar("escribir", err);
    }
  }

  clear(): void {
    this.used.clear();
  }
}

/** Elige la implementación según haya o no ruta configurada. */
export function crearIdempotencyStore(path: string | undefined): IdempotencyStore {
  return path === undefined || path.trim() === ""
    ? new InMemoryIdempotencyStore()
    : new FileIdempotencyStore(path.trim());
}
