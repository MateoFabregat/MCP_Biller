// =============================================================================
// Protección contra reenvíos de webhooks entrantes de Kapso/Meta.
//
// El `message_id` es la única identidad que aceptamos para reconocer un
// reintento. El cuerpo NO se guarda, y es a propósito: un webhook trae nombres,
// teléfonos y texto libre, y nada de eso tiene por qué quedar escrito en un
// journal. Alcanza con un digest del id normalizado para reservarlo de forma
// durable sin llevarse esos datos puestos.
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
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "../logger.js";

/** One day is long enough for Meta retries while keeping memory/disk bounded. */
export const DEFAULT_WEBHOOK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
/** A webhook endpoint should not retain an unbounded number of message ids. */
export const DEFAULT_WEBHOOK_REPLAY_MAX_ENTRIES = 10_000;

export type WebhookReplayState = "in_flight" | "processed";

export interface WebhookReplayStore {
  /** Reserva un id en una sola transición. `false` = este evento no se corre otra vez. */
  claim(messageId: string): boolean;
  /** Deja asentado que un evento reservado terminó bien. */
  markProcessed(messageId: string): void;
  /** Libera la reserva SOLO si no se llegó a producir ningún efecto. */
  release(messageId: string): void;
  /** Consulta de presencia, sin reservar. Sirve para diagnóstico y tests. */
  has(messageId: string): boolean;
  /** Cuántos ids quedan retenidos, ya descontado lo vencido y lo desalojado. */
  readonly size: number;
  /** Limpia la memoria; el journal durable NO se toca, a propósito. */
  clear(): void;
}

export interface WebhookReplayStoreOptions {
  ahora?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  /** Entra al digest: si dos empresas compartieran journal, no se pisan. */
  tenantId?: string;
}

interface ReplayEntry {
  state: WebhookReplayState;
  /** Marca de la última transición, en milisegundos epoch. */
  touched: number;
}

interface JournalEntry {
  digest?: unknown;
  state?: unknown;
  ts?: unknown;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Intenta parsear una línea del journal. `undefined` si ni siquiera es JSON. */
function intentarParsear(linea: string): JournalEntry | undefined {
  try {
    return JSON.parse(linea) as JournalEntry;
  } catch {
    return undefined;
  }
}

/** Misma validación de forma que antes vivía inline en `cargar`/`leerActual`. */
function entradaValida(
  entrada: JournalEntry,
): entrada is JournalEntry & { digest: string; state: WebhookReplayState | "released"; ts: number } {
  return (
    isDigest(entrada.digest) &&
    (entrada.state === "in_flight" || entrada.state === "processed" || entrada.state === "released") &&
    typeof entrada.ts === "number" &&
    Number.isFinite(entrada.ts) &&
    entrada.ts >= 0
  );
}

/**
 * El comportamiento acotado que comparten las dos implementaciones.
 *
 * La de memoria es síncrona, así que entre chequear e insertar no hay await
 * posible: esa es toda la atomicidad que hace falta para dos requests
 * concurrentes dentro de un mismo proceso Node.
 */
class BoundedReplayStore implements WebhookReplayStore {
  protected readonly entries = new Map<string, ReplayEntry>();
  protected readonly ahora: () => number;
  protected readonly ttlMs: number;
  protected readonly maxEntries: number;
  private readonly tenantId: string;

  constructor(opciones: WebhookReplayStoreOptions = {}) {
    this.ahora = opciones.ahora ?? (() => Date.now());
    this.ttlMs = positiveOrDefault(opciones.ttlMs, DEFAULT_WEBHOOK_REPLAY_TTL_MS);
    this.maxEntries = positiveOrDefault(opciones.maxEntries, DEFAULT_WEBHOOK_REPLAY_MAX_ENTRIES);
    this.tenantId = opciones.tenantId ?? "";
  }

  protected digest(messageId: string): string {
    // El id llega tal cual lo dejó `normalizarEvento`. No se recorta ni se
    // reinterpret it here: changing identity after normalization can turn two
    // legitimate events into one, or vice versa.
    return createHash("sha256").update(this.tenantId).update("\0").update(messageId).digest("hex");
  }

  protected validarId(messageId: string): void {
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new Error("No se puede reservar un webhook sin message_id normalizado.");
    }
  }

  protected vencida(entry: ReplayEntry, now = this.ahora()): boolean {
    return entry.touched <= now - this.ttlMs;
  }

  protected purgar(now = this.ahora()): void {
    for (const [digest, entry] of this.entries) {
      if (!this.vencida(entry, now)) continue;
      this.entries.delete(digest); // check-readonly:allow Map.delete del store, no es HTTP
      this.onExpired(digest, entry);
    }
  }

  /** Enganche para que la implementación de archivo retire locks vencidos. */
  protected onExpired(_digest: string, _entry: ReplayEntry): void {
    // no-op
  }

  protected evictForClaim(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next();
      if (oldest.done === true) return;
      const [digest, entry] = oldest.value;
      // Never evict an active operation. If every slot is active, fail closed
      // en vez de dejar pasar un efecto perdiendo la reserva.
      if (entry.state === "in_flight") {
        throw new Error("Se alcanzó el techo de replay mientras había eventos en ejecución.");
      }
      this.entries.delete(digest); // check-readonly:allow Map.delete del store, no es HTTP
    }
  }

  /** Al cargar un journal grande, desaloja SOLO lo ya completado. */
  protected recortarExcedente(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next();
      if (oldest.done === true) return;
      const [digest, entry] = oldest.value;
      if (entry.state === "in_flight") {
        throw new Error("El journal de replay supera el techo con eventos en ejecución.");
      }
      this.entries.delete(digest); // check-readonly:allow Map.delete del store, no es HTTP
    }
  }

  claim(messageId: string): boolean {
    this.validarId(messageId);
    const digest = this.digest(messageId);
    const now = this.ahora();
    this.purgar(now);
    if (this.entries.has(digest)) return false;
    this.evictForClaim();
    this.entries.set(digest, { state: "in_flight", touched: now });
    return true;
  }

  markProcessed(messageId: string): void {
    this.validarId(messageId);
    const digest = this.digest(messageId);
    const entry = this.entries.get(digest);
    if (entry === undefined) return;
    entry.state = "processed";
    entry.touched = this.ahora();
  }

  release(messageId: string): void {
    this.validarId(messageId);
    this.entries.delete(this.digest(messageId)); // check-readonly:allow Map.delete del store, no es HTTP
  }

  has(messageId: string): boolean {
    this.validarId(messageId);
    this.purgar();
    return this.entries.has(this.digest(messageId));
  }

  get size(): number {
    this.purgar();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** El default volátil: desarrollo local y deploys sin directorio de datos. */
export class InMemoryWebhookReplayStore extends BoundedReplayStore {}

/**
 * Journal durable, append-only. Cada reserva toma un lock O_EXCL por digest y
 * RELEE el journal con el lock tomado, que es lo que cierra la carrera con una
 * memoria vieja
 * between independent Node processes.
 */
export class FileWebhookReplayStore extends BoundedReplayStore {
  private readonly path: string;
  private readonly claimsDir: string;
  private readonly journalLockPath: string;
  private cargaConfiable = true;
  private degradado = false;
  private journalTransitions = 0;

  constructor(path: string, opciones: WebhookReplayStoreOptions = {}) {
    super(opciones);
    if (path.trim() === "") throw new Error("La ruta del journal de replay no puede estar vacía.");
    this.path = path.trim();
    this.claimsDir = `${this.path}.claims`;
    this.journalLockPath = `${this.path}.journal.lock`;
    this.cargar();
  }

  private degradar(operacion: string, err: unknown): void {
    this.cargaConfiable = false;
    if (this.degradado) return;
    this.degradado = true;
    logger.warn("kapso.webhook.replay.degradado", {
      operacion,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  private cargar(): void {
    if (!existsSync(this.path)) return;
    try {
      // Tighten an existing journal before reading any retained state. New
      // los archivos se abren 0600 más abajo, así que nada se escribe primero con
      // broader permissions.
      chmodSync(this.path, 0o600);
      const contenido = readFileSync(this.path, "utf8");
      // Un archivo append-only que no termina en salto de línea tiene una cola
      // sin confirmar: es lo que deja un proceso al que mataron a mitad de un
      // `writeSync`. Eso NO es corrupción — es un append interrumpido — y no
      // puede tratarse igual que una línea rota en el medio del archivo, que sí
      // es corrupción real. Reproducido: journal con una línea válida y
      // `{"digest":"bb` al final volvía TODOS los webhooks de la empresa 503.
      const terminaConSalto = contenido === "" || contenido.endsWith("\n");
      const lineas = contenido.split("\n");
      const colaPartida = terminaConSalto ? undefined : lineas.pop();
      let huboColaPartida = false;
      for (const linea of lineas) {
        if (linea.trim() === "") continue;
        this.journalTransitions += 1;
        const entrada = intentarParsear(linea);
        if (entrada === undefined || !entradaValida(entrada)) {
          this.degradar("validar", new Error("journal de replay corrupto"));
          continue;
        }
        if (entrada.state === "released") this.entries.delete(entrada.digest); // check-readonly:allow Map.delete del store, no es HTTP
        else this.entries.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
      }
      if (colaPartida !== undefined && colaPartida.trim() !== "") {
        const entrada = intentarParsear(colaPartida);
        if (entrada !== undefined && entradaValida(entrada)) {
          // Parsea y valida igual que cualquier otra línea: la ausencia del
          // salto final no dice nada por sí sola, la posición sí, pero el
          // contenido resultó completo.
          this.journalTransitions += 1;
          if (entrada.state === "released") this.entries.delete(entrada.digest); // check-readonly:allow Map.delete del store, no es HTTP
          else this.entries.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
        } else {
          huboColaPartida = true;
          logger.warn("kapso.webhook.replay.linea_partida", { largo: colaPartida.length });
        }
      }
      if (this.cargaConfiable) {
        this.purgar();
        this.recortarExcedente();
        // Si hubo cola partida, se fuerza la compactación aunque no se haya
        // llegado al techo: es la única forma de que el archivo quede sano y
        // el próximo arranque no vuelva a encontrarse con la misma cola.
        this.compactIfNeeded(huboColaPartida);
      }
    } catch (err) {
      this.degradar("leer", err);
    }
  }

  private lockPath(digest: string): string {
    return `${this.claimsDir}/${digest}.lock`;
  }

  private asegurarDirectorios(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    mkdirSync(this.claimsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.claimsDir, 0o700);
  }

  private adquirirLock(path: string): boolean {
    this.asegurarDirectorios();
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      this.degradar("reservar", err);
      throw new Error("No se pudo crear la reserva de replay; por seguridad el webhook NO se procesó.");
    }
  }

  private liberarLock(path: string): void {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.degradar("liberar", err);
    }
  }

  /**
   * Relee el journal con el lock de la reserva tomado. `colaPartida` avisa si
   * la última porción no confirmó (mismo criterio que `cargar`), para que
   * `claim` pueda forzar la compactación después de escribir su propia línea.
   */
  private leerActual(): { entries: Map<string, ReplayEntry>; colaPartida: boolean } {
    const actual = new Map<string, ReplayEntry>();
    if (!existsSync(this.path)) return { entries: actual, colaPartida: false };
    const contenido = readFileSync(this.path, "utf8");
    const terminaConSalto = contenido === "" || contenido.endsWith("\n");
    const lineas = contenido.split("\n");
    const cola = terminaConSalto ? undefined : lineas.pop();
    for (const linea of lineas) {
      if (linea.trim() === "") continue;
      const entrada = intentarParsear(linea);
      if (entrada === undefined || !entradaValida(entrada)) {
        // Acá sí, en el medio del archivo: es corrupción real, se falla cerrado.
        throw new Error("el journal de replay está corrupto");
      }
      if (entrada.state === "released") actual.delete(entrada.digest); // check-readonly:allow Map.delete temporal, no es HTTP
      else actual.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
    }
    let colaPartida = false;
    if (cola !== undefined && cola.trim() !== "") {
      const entrada = intentarParsear(cola);
      if (entrada !== undefined && entradaValida(entrada)) {
        if (entrada.state === "released") actual.delete(entrada.digest); // check-readonly:allow Map.delete temporal, no es HTTP
        else actual.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
      } else {
        colaPartida = true;
        logger.warn("kapso.webhook.replay.linea_partida", { largo: cola.length });
      }
    }
    return { entries: actual, colaPartida };
  }

  private escribirLinea(digest: string, state: WebhookReplayState | "released", touched: number): boolean {
    let lockFd: number | null = null;
    let journalLockHeld = false;
    try {
      this.asegurarDirectorios();
      lockFd = openSync(this.journalLockPath, "wx", 0o600);
      fsyncSync(lockFd);
      closeSync(lockFd);
      lockFd = null;
      journalLockHeld = true;
      const fd = openSync(this.path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ digest, state, ts: touched })}\n`, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(this.path, 0o600);
      this.journalTransitions += 1;
      return true;
    } catch (err) {
      this.degradar("persistir", err);
      return false;
    } finally {
      if (lockFd !== null) closeSync(lockFd);
      if (journalLockHeld) this.liberarLock(this.journalLockPath);
    }
  }

  /**
   * `forzar` salta el chequeo de umbral. Se usa cuando `cargar`/`leerActual`
   * detectaron una cola partida: aunque el journal esté chico, hay que
   * reescribirlo igual para que el archivo en disco quede sano y el próximo
   * arranque no vuelva a toparse con la misma línea a medio escribir.
   */
  private compactIfNeeded(forzar = false): void {
    // La compactación es best effort: el techo duro de memoria lo pone el Map
    // acotado. Si falla, el store queda marcado como degradado y las reservas
    // siguientes fallan cerrado.
    if (!forzar && this.entries.size <= this.maxEntries && this.journalTransitions <= this.maxEntries * 2) return;
    let lockFd: number | null = null;
    let journalLockHeld = false;
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      this.asegurarDirectorios();
      lockFd = openSync(this.journalLockPath, "wx", 0o600);
      fsyncSync(lockFd);
      closeSync(lockFd);
      lockFd = null;
      journalLockHeld = true;
      const fd = openSync(tmpPath, "wx", 0o600);
      try {
        for (const [digest, entry] of this.entries) {
          writeSync(fd, `${JSON.stringify({ digest, state: entry.state, ts: entry.touched })}\n`, undefined, "utf8");
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmpPath, 0o600);
      renameSync(tmpPath, this.path);
      chmodSync(this.path, 0o600);
      this.journalTransitions = this.entries.size;
    } catch (err) {
      this.degradar("compactar", err);
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort cleanup; a leftover 0600 temp file has no payload
      }
    } finally {
      if (lockFd !== null) closeSync(lockFd);
      if (journalLockHeld) this.liberarLock(this.journalLockPath);
    }
  }

  protected override onExpired(digest: string): void {
    // Una reserva vencida vuelve a estar disponible. Solo se borra el lock cuyo
    // archivo supera el mismo TTL; una reserva viva sigue fallando cerrado.
    const lock = this.lockPath(digest);
    try {
      if (statSync(lock).mtimeMs <= this.ahora() - this.ttlMs) this.liberarLock(lock);
    } catch {
      // Que no haya lock es el caso normal de un evento ya procesado.
    }
  }

  override claim(messageId: string): boolean {
    this.validarId(messageId);
    if (!this.cargaConfiable) {
      throw new Error("No se pudo leer el registro de replay; por seguridad el webhook NO se procesó.");
    }
    const digest = this.digest(messageId);
    const now = this.ahora();
    this.purgar(now);
    if (this.entries.has(digest)) return false;
    this.evictForClaim();

    const lock = this.lockPath(digest);
    if (!this.adquirirLock(lock)) return false;
    try {
      // Otro proceso pudo haber agregado este id después de que esta instancia
      // cargó el journal.
      const { entries: actual, colaPartida } = this.leerActual();
      const previo = actual.get(digest);
      if (previo !== undefined && !this.vencida(previo, now)) {
        this.entries.clear();
        for (const [k, v] of actual) this.entries.set(k, v);
        this.liberarLock(lock);
        return false;
      }
      // A different process may have left many completed entries behind.
      // El techo se respeta ANTES de admitir la reserva nueva.
      for (const [k, v] of actual) {
        if (this.vencida(v, now)) actual.delete(k); // check-readonly:allow Map.delete temporal, no es HTTP
      }
      while (actual.size >= this.maxEntries) {
        const oldest = actual.entries().next();
        if (oldest.done === true) break;
        const [k, v] = oldest.value;
        if (v.state === "in_flight") {
          throw new Error("Se alcanzó el techo de replay con eventos en ejecución.");
        }
        actual.delete(k); // check-readonly:allow Map.delete temporal, no es HTTP
      }
      this.entries.clear();
      for (const [k, v] of actual) this.entries.set(k, v);
      if (!this.escribirLinea(digest, "in_flight", now)) {
        // Sin lock y sin reserva local: cada reintento posterior
        // fails closed because persistence is degraded.
        throw new Error("No se pudo persistir la reserva de replay; por seguridad el webhook NO se procesó.");
      }
      this.entries.set(digest, { state: "in_flight", touched: now });
      // Si `leerActual` encontró una cola partida, se fuerza la compactación
      // ya que estamos escribiendo de todos modos con el lock tomado: es la
      // oportunidad de dejar el journal sano sin esperar a un reinicio.
      this.compactIfNeeded(colaPartida);
      return true;
    } catch (err) {
      this.degradar("reservar", err);
      throw new Error("No se pudo reservar el webhook; por seguridad el webhook NO se procesó.");
    }
  }

  override markProcessed(messageId: string): void {
    this.validarId(messageId);
    const digest = this.digest(messageId);
    const entry = this.entries.get(digest);
    if (entry === undefined) return;
    const now = this.ahora();
    if (!this.escribirLinea(digest, "processed", now)) return;
    entry.state = "processed";
    entry.touched = now;
    this.liberarLock(this.lockPath(digest));
    this.compactIfNeeded();
  }

  override release(messageId: string): void {
    this.validarId(messageId);
    const digest = this.digest(messageId);
    const entry = this.entries.get(digest);
    if (entry?.state !== "in_flight") return;
    const now = this.ahora();
    if (!this.escribirLinea(digest, "released", now)) return;
    this.entries.delete(digest); // check-readonly:allow Map.delete del store, no es HTTP
    this.liberarLock(this.lockPath(digest));
  }
}

export function createWebhookReplayStore(
  path: string | undefined,
  opciones: WebhookReplayStoreOptions = {},
): WebhookReplayStore {
  return path === undefined || path.trim() === ""
    ? new InMemoryWebhookReplayStore(opciones)
    : new FileWebhookReplayStore(path.trim(), opciones);
}
