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
//   · FileIdempotencyStore     — journal append-only más lock O_EXCL por key;
//                                sobrevive reinicios y coordina procesos.
//
// El archivo guarda SOLO la key, el estado y el timestamp. Nunca el payload:
// los datos de facturación no tienen por qué estar ahí.
// =============================================================================

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "../logger.js";

export function generateIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Espera sincrónica corta entre reintentos de un lock entre procesos.
 *
 * `Atomics.wait` es la única forma sincrónica de esperar en Node sin ceder al
 * event loop: acá conviene porque `persistir` no puede volverse async (lo
 * llaman `claim`/`markExecuted`, que son sincrónicos por contrato) y una
 * espera activa (`while` sin pausa) quemaría CPU compitiendo por el mismo
 * lock que se está esperando.
 */
function dormirSincrono(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
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
 * Piso de líneas del journal a partir del cual se compacta.
 *
 * Alto a propósito: compactar cuesta una reescritura del archivo, y el journal
 * es la memoria fiscal del proceso. Mil transiciones son ~500 operaciones, que
 * en una PyME es más de un mes.
 *
 * Es un PISO, no el umbral final: el umbral real es
 * `Math.max(UMBRAL_COMPACTACION, 2 * cantidad de keys vivas)`. Sin el término
 * relativo, pasadas las 1000 keys vivas el journal queda POR ENCIMA del
 * umbral para siempre (cada key ejecutada deja como mínimo una línea que
 * nunca se borra) y cada `markExecuted` posterior reescribe el journal
 * entero — la auditoría lo midió: 1100 operaciones, 109 compactaciones. El
 * término relativo dispara la compactación cuando el journal duplica al
 * estado real, que es cuando de verdad conviene pagar la reescritura.
 */
const UMBRAL_COMPACTACION = 1000;

/**
 * Registro persistente en un archivo de líneas JSON.
 *
 * Se lee entero al arrancar y se mantiene en memoria; cada transición agrega
 * una línea, y el journal se compacta a una línea por key cuando pasa el
 * umbral. El volumen sigue siendo pequeño en el orden de magnitud de una PyME
 * (miles de escrituras al año).
 *
 * Un claim nuevo solo se concede si obtuvo el lock exclusivo entre procesos, si
 * la RELECTURA del journal confirma que la key no está usada, y si su
 * `in_flight` quedó persistido. Las transiciones posteriores al POST son
 * best-effort: si fallan, el `in_flight` ya grabado sigue bloqueando el
 * reinicio y evita una reemisión insegura.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly states = new Map<string, IdempotencyState>();
  private readonly path: string;
  private degradado = false;
  private cargaConfiable = true;
  /** Líneas escritas en el journal. Dispara la compactación. */
  private lineasJournal = 0;

  private lockPath(key: string): string {
    const huella = createHash("sha256").update(key).digest("hex");
    return `${this.path}.claims/${huella}.lock`;
  }

  /**
   * Centinela: existe si ALGUNA VEZ hubo journal.
   *
   * Antes, si el journal desaparecía (logrotate, `rm` accidental, restore de
   * un backup viejo) una instancia nueva lo leía como "todavía no se emitió
   * nada" y volvía a conceder claims ya usados: reemisión fiscal (R3 de la
   * auditoría). El centinela no se borra nunca ni se toca en la compactación
   * (que reescribe el journal, no lo hace desaparecer), así que su sola
   * presencia sin journal es la firma inequívoca de "esto se perdió".
   */
  private centinelaPath(): string {
    return `${this.path}.creado`;
  }

  private lockCompactacionPath(): string {
    return `${this.path}.compact.lock`;
  }

  constructor(path: string) {
    this.path = path;
    this.cargar();
  }

  /**
   * Relee el journal del disco y devuelve el estado por key.
   *
   * Existe para que `claim` pueda mirar lo que escribió OTRO PROCESO después de
   * que esta instancia arrancó. Antes eso lo cubría el archivo de lock, que por
   * eso no se borraba nunca: un `.lock` por CFE emitido, para siempre. Con la
   * relectura, el lock vuelve a ser lo que su nombre dice —la exclusión mutua
   * de la ventana in_flight— y se puede borrar al cerrar la operación.
   */
  private leerJournal(): { estados: Map<string, IdempotencyState>; confiable: boolean; lineas: number } {
    const estados = new Map<string, IdempotencyState>();
    let confiable = true;
    let lineas = 0;
    if (!existsSync(this.path)) return { estados, confiable, lineas };
    for (const linea of readFileSync(this.path, "utf8").split("\n")) {
      if (linea.trim() === "") continue;
      lineas += 1;
      try {
        const entrada = JSON.parse(linea) as { key?: unknown; state?: unknown };
        if (typeof entrada.key !== "string") {
          confiable = false;
          continue;
        }
        if (entrada.state === undefined || entrada.state === "executed") {
          estados.set(entrada.key, "executed");
        } else if (entrada.state === "in_flight" || entrada.state === "ambiguous") {
          estados.set(entrada.key, entrada.state);
        } else if (entrada.state === "released") {
          estados.delete(entrada.key);
        } else {
          confiable = false;
        }
      } catch {
        confiable = false;
      }
    }
    return { estados, confiable, lineas };
  }

  private cargar(): void {
    try {
      if (!existsSync(this.path)) {
        if (existsSync(this.centinelaPath())) {
          // El centinela sobrevive; el journal no. Alguien se llevó la única
          // memoria de qué CFE ya se emitieron. No hay forma de distinguir
          // acá "se rotó sin querer" de "un ataque borró la evidencia": en
          // los dos casos negar todo hasta que un humano lo mire es el lado
          // seguro (R3 de la auditoría).
          this.cargaConfiable = false;
          this.degradar(
            "cargar",
            new Error(
              "el journal desapareció y el centinela sigue ahí: alguien lo borró o lo rotó",
            ),
          );
        }
        return;
      }
      for (const linea of readFileSync(this.path, "utf8").split("\n")) {
        if (linea.trim() === "") continue;
        try {
          const entrada = JSON.parse(linea) as { key?: unknown; state?: unknown };
          if (typeof entrada.key !== "string") {
            this.cargaConfiable = false;
            continue;
          }

          // Formato histórico `{ key, ts }`: una key se escribía únicamente
          // después de un POST exitoso, así que es inequívocamente `executed`.
          if (entrada.state === undefined || entrada.state === "executed") {
            this.states.set(entrada.key, "executed");
          } else if (entrada.state === "in_flight" || entrada.state === "ambiguous") {
            this.states.set(entrada.key, entrada.state);
          } else if (entrada.state === "released") {
            this.states.delete(entrada.key);
          } else {
            this.cargaConfiable = false;
          }
        } catch {
          // Conservamos las entradas anteriores para diagnóstico, pero una
          // línea truncada puede ser justamente el último `in_flight`. Por eso
          // el store deja de conceder claims nuevos: ignorarla sería reemitir.
          this.cargaConfiable = false;
        }
      }
      if (!this.cargaConfiable) {
        this.degradar("validar", new Error("el journal contiene una entrada corrupta"));
      }
      this.lineasJournal = this.leerJournal().lineas;
      logger.info("idempotencia.cargada", { keys: this.states.size, lineas: this.lineasJournal });
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
    const lock = this.adquirirLock(key);
    if (!lock) return false;

    // RELECTURA CON EL LOCK TOMADO.
    //
    // Otro proceso pudo haber ejecutado esta key después de que esta instancia
    // cargó el journal. Antes eso lo cubría el `.lock`, que sobrevivía a la
    // operación para siempre; ahora lo cubre el journal, que es donde el estado
    // vive de verdad. Mismo patrón que `FileWebhookReplayStore.claim`.
    const actual = this.leerJournal();
    if (!actual.confiable) {
      this.soltarLock(key);
      this.degradar("releer", new Error("el journal contiene una entrada corrupta"));
      throw new Error(
        "No se pudo releer el registro de idempotencia; por seguridad el POST NO se ejecutó.",
      );
    }
    const yaConocida = actual.estados.get(key);
    if (yaConocida !== undefined) {
      // No se borra el lock ajeno si el estado sigue en vuelo: es de otro.
      if (yaConocida !== "in_flight") this.soltarLock(key);
      this.states.set(key, yaConocida);
      return false;
    }

    if (!this.persistir(key, "in_flight")) {
      this.soltarLock(key);
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
    const persistido = this.persistir(key, "executed");
    // El lock se suelta SOLO si el estado terminal quedó en el journal. Si no
    // se pudo escribir, el `.lock` es lo único que impide una reejecución desde
    // otro proceso y tiene que quedarse.
    if (persistido) this.soltarLock(key);
    this.compactarSiHaceFalta();
  }

  markAmbiguous(key: string): void {
    this.states.set(key, "ambiguous");
    // La misma regla: si no se puede escribir, el `in_flight` previo sigue
    // siendo un estado seguro (no reejecutable) al reiniciar.
    const persistido = this.persistir(key, "ambiguous");
    if (persistido) this.soltarLock(key);
    this.compactarSiHaceFalta();
  }

  release(key: string): void {
    if (this.states.get(key) !== "in_flight") return;
    if (this.persistir(key, "released")) {
      this.states.delete(key);
      this.soltarLock(key);
    }
  }

  markUsed(key: string): void {
    this.markExecuted(key);
  }

  /**
   * Escribe una línea del journal bajo el lock de compactación.
   *
   * Antes, un `openSync(path, "a")` podía arrancar justo cuando otro proceso
   * ya había leído el journal para compactar; ese `append` cae en el inode
   * viejo, desvinculado en cuanto el otro proceso hace `renameSync`, y
   * desaparece sin ningún error (R2 de la auditoría). Tomar el MISMO lock que
   * usa la compactación alrededor de open+write+close serializa las dos
   * operaciones y cierra esa ventana.
   *
   * Reintenta unos milisegundos porque una compactación ajena es breve y
   * poco frecuente; si el lock sigue tomado después, se falla cerrado (`false`)
   * en vez de arriesgar la pérdida de este append.
   */
  private persistir(key: string, state: IdempotencyState | "released"): boolean {
    const lockFd = this.adquirirLockCompactacion(8);
    if (lockFd === null) {
      this.degradar(
        "tomar el lock de compactación para persistir",
        new Error(
          "el lock de compactación siguió tomado por otro proceso tras los reintentos",
        ),
      );
      return false;
    }
    try {
      const directory = dirname(this.path);
      const directoryYaExistia = existsSync(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // No se cambia el modo de un directorio preexistente arbitrario (podría
      // ser /tmp o una carpeta compartida). El directorio privado que crea el
      // store sí queda explícitamente en 0700.
      if (!directoryYaExistia) chmodSync(directory, 0o700);
      const journalYaExistia = existsSync(this.path);
      const fd = openSync(this.path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ key, state, ts: new Date().toISOString() })}\n`, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(this.path, 0o600);
      if (!journalYaExistia) {
        // El journal se acaba de crear: dejamos el centinela para poder
        // distinguir, al arrancar, "nunca hubo emisiones" (ni journal ni
        // centinela) de "hubo emisiones y el journal se perdió" (centinela
        // sin journal). Ver R3 de la auditoría y `centinelaPath`.
        try {
          writeFileSync(this.centinelaPath(), "", { mode: 0o600 });
        } catch (err) {
          this.degradar("crear el centinela de idempotencia", err);
        }
      }
      this.lineasJournal += 1;
      return true;
    } catch (err) {
      this.degradar("escribir", err);
      return false;
    } finally {
      this.soltarLockCompactacion(lockFd);
    }
  }

  /**
   * Toma el lock global de compactación (`O_EXCL`), con reintentos cortos.
   *
   * Es el mismo lock para compactar y para persistir: lo que hay que evitar
   * es que una de las dos operaciones abra el journal mientras la otra lo
   * está reescribiendo (R2 de la auditoría), no coordinar compactaciones
   * entre sí en particular.
   */
  private adquirirLockCompactacion(intentos: number): number | null {
    for (let intento = 0; intento < intentos; intento += 1) {
      try {
        return openSync(this.lockCompactacionPath(), "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          this.degradar("tomar el lock de compactación", err);
          return null;
        }
        if (intento < intentos - 1) dormirSincrono(15);
      }
    }
    return null;
  }

  /**
   * Suelta el lock de compactación. Se llama SIEMPRE desde un `finally`: un
   * lock que queda tomado por una excepción a mitad de camino bloquearía
   * cualquier escritura futura del journal, incluidas las de otros procesos.
   */
  private soltarLockCompactacion(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      // best effort: lo que importa es liberar el nombre del archivo.
    }
    try {
      unlinkSync(this.lockCompactacionPath());
    } catch {
      // Si no se puede borrar, el próximo `wx` falla con EEXIST y quien lo
      // pida falla cerrado (persistir) o saltea (compactar): ninguno de los
      // dos lados arriesga perder un append ajeno.
    }
  }

  /** O_EXCL es la parte atómica entre procesos; el Map solo acelera el caso local. */
  private adquirirLock(key: string): boolean {
    const directory = `${this.path}.claims`;
    let fd: number | null = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      fd = openSync(this.lockPath(key), "wx", 0o600);
      fsyncSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      this.degradar("crear la reserva atómica", err);
      throw new Error(
        "No se pudo crear la reserva atómica de idempotencia; por seguridad el POST NO se ejecutó.",
      );
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /**
   * Borra el lock de una key cuyo estado ya vive en el journal.
   *
   * Best effort: si no se puede borrar, el lock huérfano solo hace que un claim
   * futuro de la MISMA key se niegue, que es el lado seguro.
   */
  private soltarLock(key: string): void {
    try {
      unlinkSync(this.lockPath(key));
    } catch {
      // Un lock huérfano falla cerrado. Es preferible diagnosticarlo a
      // conceder la misma operación desde otro proceso.
    }
  }

  /**
   * Reescribe el journal con una línea por key.
   *
   * SIN ESTO EL ARCHIVO NO PARABA DE CRECER. Cada operación deja dos líneas
   * (`in_flight` y su estado final) y ninguna se borraba nunca, así que el
   * arranque leía el historial entero de la empresa para reconstruir un estado
   * que ocupa una línea por CFE. Con la relectura de `claim` esto pasó de ser
   * higiene a ser necesario: ahora el journal se lee también en caliente.
   *
   * Es best effort y atómica (temporal + rename): si falla, el journal viejo
   * sigue siendo válido y el store queda degradado, que falla cerrado.
   */
  private compactarSiHaceFalta(): void {
    // Umbral RELATIVO al estado real (ver el comentario de UMBRAL_COMPACTACION):
    // sin el término `2 * this.states.size`, pasadas las 1000 keys vivas el
    // journal queda por encima del piso para siempre y cada escritura
    // reescribe el archivo entero (R1 de la auditoría).
    if (this.lineasJournal <= Math.max(UMBRAL_COMPACTACION, 2 * this.states.size)) return;

    // Un solo intento, sin reintentos: si el lock ya está tomado —por otro
    // proceso compactando, o por un `persistir` en curso— esta pasada se
    // saltea sin más. No hace falta insistir: la próxima escritura vuelve a
    // evaluar el umbral y lo va a volver a intentar (R2 de la auditoría).
    const lockFd = this.adquirirLockCompactacion(1);
    if (lockFd === null) return;
    try {
      const actual = this.leerJournal();
      if (!actual.confiable) return;

      const tmp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const fd = openSync(tmp, "wx", 0o600);
        try {
          for (const [key, state] of actual.estados) {
            writeSync(fd, `${JSON.stringify({ key, state, ts: new Date().toISOString() })}\n`, undefined, "utf8");
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.path);
        chmodSync(this.path, 0o600);
        // fsync del DIRECTORIO, no solo del archivo: sin esto, un corte de luz
        // justo después del rename puede dejar en disco el inode VIEJO (sin
        // los appends que se hicieron después de leerlo para compactar),
        // porque el cambio de metadata del directorio nunca llegó a disco
        // (R2 de la auditoría).
        const dirFd = openSync(dirname(this.path), "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
        this.lineasJournal = actual.estados.size;
        logger.info("idempotencia.compactada", { keys: actual.estados.size });
      } catch (err) {
        this.degradar("compactar", err);
        try {
          unlinkSync(tmp);
        } catch {
          // El temporal huérfano es 0600 y no tiene payload.
        }
      }
    } finally {
      this.soltarLockCompactacion(lockFd);
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
