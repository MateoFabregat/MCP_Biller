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
// El archivo guarda SOLO la key, el estado y el timestamp. Nunca el payload:
// los datos de facturación no tienen por qué estar ahí.
// =============================================================================

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

export function generateIdempotencyKey(): string {
  return randomUUID();
}

export type IdempotencyState = "in_flight" | "executed" | "ambiguous";

export interface IdempotencyStore {
  /** Reserva la key en una sola transición atómica. `false` = ya no es reejecutable. */
  claim(key: string): boolean;
  markExecuted(key: string): void;
  markAmbiguous(key: string): void;
  /** Solo una operación que todavía no se despachó puede liberar su reserva. */
  release(key: string): void;
  /** Compatibilidad para callers antiguos: cualquier estado presente cuenta como usado. */
  has(key: string): boolean;
  /** Compatibilidad para callers antiguos: equivale a marcar `executed`. */
  markUsed(key: string): void;
  clear(): void;
}

/** Registro en memoria: se pierde al reiniciar el proceso. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  protected readonly states = new Map<string, IdempotencyState>();

  claim(key: string): boolean {
    if (this.states.has(key)) return false;
    this.states.set(key, "in_flight");
    return true;
  }

  markExecuted(key: string): void {
    this.states.set(key, "executed");
  }

  markAmbiguous(key: string): void {
    this.states.set(key, "ambiguous");
  }

  release(key: string): void {
    if (this.states.get(key) === "in_flight") this.states.delete(key);
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  markUsed(key: string): void {
    this.markExecuted(key);
  }

  clear(): void {
    this.states.clear();
  }
}

/**
 * Registro persistente en un archivo de líneas JSON.
 *
 * Se lee entero al arrancar y se mantiene en memoria; cada transición agrega
 * una línea. El volumen sigue siendo pequeño en el orden de magnitud de una
 * PyME (miles de escrituras al año).
 *
 * Un claim nuevo solo se concede si su `in_flight` quedó persistido. Las
 * transiciones posteriores al POST son best-effort: si fallan, el `in_flight`
 * ya grabado sigue bloqueando el reinicio y evita una reemisión insegura.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly states = new Map<string, IdempotencyState>();
  private readonly path: string;
  private degradado = false;
  private cargaConfiable = true;

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
          const entrada = JSON.parse(linea) as { key?: unknown; state?: unknown };
          if (typeof entrada.key !== "string") continue;

          // Formato histórico `{ key, ts }`: una key se escribía únicamente
          // después de un POST exitoso, así que es inequívocamente `executed`.
          if (entrada.state === undefined || entrada.state === "executed") {
            this.states.set(entrada.key, "executed");
          } else if (entrada.state === "in_flight" || entrada.state === "ambiguous") {
            this.states.set(entrada.key, entrada.state);
          } else if (entrada.state === "released") {
            this.states.delete(entrada.key);
          }
        } catch {
          // Línea corrupta (p.ej. escritura interrumpida): se ignora esa sola,
          // no se descarta el archivo entero.
        }
      }
      logger.info("idempotencia.cargada", { keys: this.states.size });
    } catch (err) {
      this.cargaConfiable = false;
      this.degradar("leer", err);
    }
  }

  private degradar(operacion: string, err: unknown): void {
    if (this.degradado) return;
    this.degradado = true;
    logger.warn(
      `No se pudo ${operacion} el archivo de idempotencia. No se permitirá asumir que una ` +
        "operación con estado incierto puede reintentarse.",
      { path: this.path, err: err instanceof Error ? err.message : String(err) },
    );
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  claim(key: string): boolean {
    if (this.states.has(key)) return false;
    if (!this.cargaConfiable) {
      throw new Error(
        "No se pudo leer el registro de idempotencia; por seguridad el POST NO se ejecutó.",
      );
    }
    if (!this.persistir(key, "in_flight")) {
      throw new Error(
        "No se pudo persistir la reserva de idempotencia; por seguridad el POST NO se ejecutó.",
      );
    }
    this.states.set(key, "in_flight");
    return true;
  }

  markExecuted(key: string): void {
    this.states.set(key, "executed");
    // Si falla esta línea, el `in_flight` ya persistido sigue bloqueando un
    // reinicio. No se propaga: el POST ya ocurrió y reportarlo como fallo
    // induciría al caller a reintentarlo.
    this.persistir(key, "executed");
  }

  markAmbiguous(key: string): void {
    this.states.set(key, "ambiguous");
    // La misma regla: si no se puede escribir, el `in_flight` previo sigue
    // siendo un estado seguro (no reejecutable) al reiniciar.
    this.persistir(key, "ambiguous");
  }

  release(key: string): void {
    if (this.states.get(key) !== "in_flight") return;
    if (this.persistir(key, "released")) this.states.delete(key);
  }

  markUsed(key: string): void {
    this.markExecuted(key);
  }

  private persistir(key: string, state: IdempotencyState | "released"): boolean {
    try {
      const directory = dirname(this.path);
      const directoryYaExistia = existsSync(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // No se cambia el modo de un directorio preexistente arbitrario (podría
      // ser /tmp o una carpeta compartida). El directorio privado que crea el
      // store sí queda explícitamente en 0700.
      if (!directoryYaExistia) chmodSync(directory, 0o700);
      appendFileSync(
        this.path,
        `${JSON.stringify({ key, state, ts: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(this.path, 0o600);
      return true;
    } catch (err) {
      this.degradar("escribir", err);
      return false;
    }
  }

  clear(): void {
    this.states.clear();
  }
}

/** Elige la implementación según haya o no ruta configurada. */
export function crearIdempotencyStore(path: string | undefined): IdempotencyStore {
  return path === undefined || path.trim() === ""
    ? new InMemoryIdempotencyStore()
    : new FileIdempotencyStore(path.trim());
}
