import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWebhookReplayStore,
  InMemoryWebhookReplayStore,
  createWebhookReplayStore,
} from "../src/kapso/webhookReplay.js";

describe("deduplicación de replay de webhooks", () => {
  it("el claim atómico deja pasar una sola vez aunque haya concurrencia", async () => {
    const store = new InMemoryWebhookReplayStore();
    const claims = await Promise.all(Array.from({ length: 32 }, () => Promise.resolve(store.claim("wamid.1"))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(store.has("wamid.1")).toBe(true);
  });

  it("mantiene un estado acotado por TTL y desaloja el menos usado", () => {
    let now = 0;
    const store = new InMemoryWebhookReplayStore({ ahora: () => now, ttlMs: 100, maxEntries: 2 });
    expect(store.claim("a")).toBe(true);
    store.markProcessed("a");
    now = 10;
    expect(store.claim("b")).toBe(true);
    store.markProcessed("b");
    now = 20;
    expect(store.has("a")).toBe(true); // a es el más viejo, pero todavía vivo.
    expect(store.claim("c")).toBe(true);
    expect(store.has("a")).toBe(false); // techo LRU.
    expect(store.has("b")).toBe(true);
    now = 200;
    expect(store.has("b")).toBe(false); // TTL acotado.
    expect(store.size).toBe(0);
  });

  it("sobrevive reinicio y no comparte claves entre tenants", () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-"));
    const pathA = join(dir, "a", "webhook-replay.jsonl");
    const pathB = join(dir, "b", "webhook-replay.jsonl");
    const first = new FileWebhookReplayStore(pathA);
    expect(first.claim("wamid.same")).toBe(true);
    first.markProcessed("wamid.same");
    const afterRestart = new FileWebhookReplayStore(pathA);
    expect(afterRestart.claim("wamid.same")).toBe(false);
    expect(new FileWebhookReplayStore(pathB).claim("wamid.same")).toBe(true);

    const raw = readFileSync(pathA, "utf8");
    expect(raw).not.toContain("texto privado");
    expect(statSync(pathA).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
  });

  it("falla cerrado frente a journal corrupto", () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-corrupt-"));
    const path = join(dir, "replay.jsonl");
    writeFileSync(path, '{"digest":"ok","state":"processed","ts":1}\nno-json\n', { mode: 0o600 });
    const store = new FileWebhookReplayStore(path);
    expect(() => store.claim("nuevo")).toThrow(/registro de replay|journal/i);
  });

  it("tolera una cola partida al final: no es corrupción, es un append interrumpido", () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-partial-"));
    const path = join(dir, "replay.jsonl");
    const first = new FileWebhookReplayStore(path);
    expect(first.claim("wamid.ok")).toBe(true);
    first.markProcessed("wamid.ok");
    // Simula un proceso al que mataron a mitad de un `writeSync`: la línea
    // siguiente quedó a medio escribir, sin el salto de línea final.
    appendFileSync(path, '{"digest":"bb');
    const restarted = new FileWebhookReplayStore(path);
    // No lanza: la cola partida se descarta sola, no tira el store a 503.
    expect(restarted.claim("wamid.nuevo")).toBe(true);
    // El estado de la línea válida, anterior a la cola partida, se conservó.
    expect(restarted.claim("wamid.ok")).toBe(false);
    // Se forzó la compactación: la cola partida no sobrevive en disco.
    expect(readFileSync(path, "utf8")).not.toContain('"bb"');
  });

  it("basura en la PRIMERA línea sigue fallando cerrado", () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-corrupt-first-"));
    const path = join(dir, "replay.jsonl");
    writeFileSync(path, `no-json\n{"digest":"${"a".repeat(64)}","state":"processed","ts":1}\n`, { mode: 0o600 });
    const store = new FileWebhookReplayStore(path);
    // Esto NO es una cola al final: es basura en el medio/principio del
    // archivo, y eso sigue siendo corrupción real que falla cerrado.
    expect(() => store.claim("nuevo")).toThrow(/registro de replay|journal/i);
  });

  it("falla cerrado si no puede reservar", () => {
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-reserve-"));
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "no es un directorio");
    const store = new FileWebhookReplayStore(join(blocked, "replay.jsonl"));
    expect(() => store.claim("nuevo")).toThrow(/reserva|persistir|replay/i);
  });

  it("la fábrica usa memoria sin ruta y archivo con ruta", () => {
    expect(createWebhookReplayStore(undefined)).toBeInstanceOf(InMemoryWebhookReplayStore);
    const dir = mkdtempSync(join(tmpdir(), "biller-webhook-replay-factory-"));
    expect(createWebhookReplayStore(join(dir, "replay.jsonl"))).toBeInstanceOf(FileWebhookReplayStore);
  });
});
