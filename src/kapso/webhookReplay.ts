// =============================================================================
// Replay protection for inbound Kapso/Meta webhooks.
//
// A webhook message_id is the only identity we trust for retries.  The body is
// deliberately not retained: webhook payloads can contain names, phone
// numbers, and free text.  A digest of the normalized message_id is enough to
// reserve it durably without putting that data in the journal.
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
  /** Atomically reserves an id. false means this event must not run again. */
  claim(messageId: string): boolean;
  /** Persists the successful completion of a claimed event. */
  markProcessed(messageId: string): void;
  /** Releases a claim only when no side effect was performed. */
  release(messageId: string): void;
  /** Read-only presence check, useful for diagnostics and tests. */
  has(messageId: string): boolean;
  /** Number of retained ids after lazy expiry/eviction. */
  readonly size: number;
  /** Clears in-memory state; durable journals remain intentionally untouched. */
  clear(): void;
}

export interface WebhookReplayStoreOptions {
  ahora?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  /** Namespace included in the digest if a journal is ever shared. */
  tenantId?: string;
}

interface ReplayEntry {
  state: WebhookReplayState;
  /** Last transition timestamp, in epoch milliseconds. */
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

/**
 * Shared bounded behavior.  The in-memory implementation is synchronous, so a
 * claim cannot yield between checking and inserting; that is the atomicity
 * required for concurrent requests in one Node process.
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
    // The caller receives message_id from normalizarEvento. Do not trim or
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

  /** Hook for the file implementation to retire stale lock files. */
  protected onExpired(_digest: string, _entry: ReplayEntry): void {
    // no-op
  }

  protected evictForClaim(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next();
      if (oldest.done === true) return;
      const [digest, entry] = oldest.value;
      // Never evict an active operation. If every slot is active, fail closed
      // instead of allowing an effect while losing the reservation.
      if (entry.state === "in_flight") {
        throw new Error("Se alcanzó el techo de replay mientras había eventos en ejecución.");
      }
      this.entries.delete(digest); // check-readonly:allow Map.delete del store, no es HTTP
    }
  }

  /** Evicts only completed entries when loading/reloading a large journal. */
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

/** Volatile default for local development and deployments without a data dir. */
export class InMemoryWebhookReplayStore extends BoundedReplayStore {}

/**
 * Durable append-only replay journal. Claims use an O_EXCL lock per digest,
 * then re-read the journal under that lock to close the stale-memory race
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
      // files are opened 0600 below, so no content is ever first written with
      // broader permissions.
      chmodSync(this.path, 0o600);
      const contenido = readFileSync(this.path, "utf8");
      for (const linea of contenido.split("\n")) {
        if (linea.trim() === "") continue;
        this.journalTransitions += 1;
        let entrada: JournalEntry;
        try {
          entrada = JSON.parse(linea) as JournalEntry;
        } catch (err) {
          this.degradar("leer", err);
          continue;
        }
        if (!isDigest(entrada.digest) ||
          (entrada.state !== "in_flight" && entrada.state !== "processed" && entrada.state !== "released") ||
          typeof entrada.ts !== "number" || !Number.isFinite(entrada.ts) || entrada.ts < 0) {
          this.degradar("validar", new Error("journal de replay corrupto"));
          continue;
        }
        if (entrada.state === "released") this.entries.delete(entrada.digest); // check-readonly:allow Map.delete del store, no es HTTP
        else this.entries.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
      }
      if (this.cargaConfiable) {
        this.purgar();
        this.recortarExcedente();
        this.compactIfNeeded();
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

  private leerActual(): Map<string, ReplayEntry> {
    const actual = new Map<string, ReplayEntry>();
    if (!existsSync(this.path)) return actual;
    for (const linea of readFileSync(this.path, "utf8").split("\n")) {
      if (linea.trim() === "") continue;
      let entrada: JournalEntry;
      try {
        entrada = JSON.parse(linea) as JournalEntry;
      } catch {
        throw new Error("el journal de replay está corrupto");
      }
      if (!isDigest(entrada.digest) ||
        (entrada.state !== "in_flight" && entrada.state !== "processed" && entrada.state !== "released") ||
        typeof entrada.ts !== "number" || !Number.isFinite(entrada.ts) || entrada.ts < 0) {
        throw new Error("el journal de replay está corrupto");
      }
      if (entrada.state === "released") actual.delete(entrada.digest); // check-readonly:allow Map.delete temporal, no es HTTP
      else actual.set(entrada.digest, { state: entrada.state, touched: entrada.ts });
    }
    return actual;
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

  private compactIfNeeded(): void {
    // Compaction is best effort. The bounded Map remains the hard memory cap;
    // failure marks the store degraded so future claims fail closed.
    if (this.entries.size <= this.maxEntries && this.journalTransitions <= this.maxEntries * 2) return;
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
    // Expired reservations are eligible again. Remove only a lock whose file
    // is older than the same TTL; an active claim remains fail-closed.
    const lock = this.lockPath(digest);
    try {
      if (statSync(lock).mtimeMs <= this.ahora() - this.ttlMs) this.liberarLock(lock);
    } catch {
      // Missing lock is the normal processed-event case.
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
      // Another process may have appended this id after this instance loaded.
      const actual = this.leerActual();
      const previo = actual.get(digest);
      if (previo !== undefined && !this.vencida(previo, now)) {
        this.entries.clear();
        for (const [k, v] of actual) this.entries.set(k, v);
        this.liberarLock(lock);
        return false;
      }
      // A different process may have left many completed entries behind.
      // Keep the bound before admitting this new reservation.
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
        // Keep the lock and local reservation absent: every subsequent retry
        // fails closed because persistence is degraded.
        throw new Error("No se pudo persistir la reserva de replay; por seguridad el webhook NO se procesó.");
      }
      this.entries.set(digest, { state: "in_flight", touched: now });
      this.compactIfNeeded();
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
