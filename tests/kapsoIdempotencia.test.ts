import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KapsoClient,
  KapsoIdempotencyError,
  type KapsoSendOptions,
} from "../src/kapso/client.js";
import { claveSalidaKapso } from "../src/kapso/idempotency.js";
import { FileIdempotencyStore } from "../src/write/idempotency.js";
import type { KapsoConfig } from "../src/config.js";

const destino = "59899123456";
const actor = "59895923567";

function config(overrides: Partial<KapsoConfig> = {}): KapsoConfig {
  return {
    apiKey: "kapso-secret",
    baseUrl: "https://api.kapso.ai",
    phoneNumberId: "110987654321",
    destinatariosPermitidos: [destino],
    tenantId: "panaderia",
    ...overrides,
  };
}

function ok(body = '{"messages":[{"id":"wamid.1"}]}'): Response {
  return new Response(body, { status: 200 });
}

describe("claves de salidas Kapso", () => {
  it("son determinísticas, cambian por tenant/actor/destinatario/operación/payload y no llevan PII", () => {
    const input = {
      tenantId: "panaderia",
      actorIdentity: actor,
      destinatario: destino,
      operation: "recordatorio",
      payload: { body: "Juan debe UYU 100" },
    } as const;
    const clave = claveSalidaKapso(input);
    expect(clave).toBe(claveSalidaKapso(input));
    expect(clave).toMatch(/^kapso:v1:[0-9a-f]{64}$/);
    expect(clave).not.toContain(actor);
    expect(clave).not.toContain(destino);
    expect(clave).not.toContain("Juan");
    expect(claveSalidaKapso({ ...input, tenantId: "ferreteria" })).not.toBe(clave);
    expect(claveSalidaKapso({ ...input, actorIdentity: "59890000000" })).not.toBe(clave);
    expect(claveSalidaKapso({ ...input, destinatario: "59890000000" })).not.toBe(clave);
    expect(claveSalidaKapso({ ...input, operation: "menu" })).not.toBe(clave);
    expect(claveSalidaKapso({ ...input, payload: { body: "otro" } })).not.toBe(clave);
  });
});

describe("KapsoClient: reserva antes de cada salida", () => {
  it("dos envíos concurrentes idénticos hacen como máximo una llamada", async () => {
    let liberar!: () => void;
    const espera = new Promise<void>((resolve) => (liberar = resolve));
    const fetchImpl = vi.fn(async () => {
      await espera;
      return ok();
    }) as unknown as typeof fetch;
    const client = new KapsoClient(config(), { fetchImpl });
    const opciones: KapsoSendOptions = { actorIdentity: actor, operation: "recordatorio" };
    const a = client.enviar(destino, "debe UYU 100", opciones);
    const b = client.enviar(destino, "debe UYU 100", opciones);
    liberar();
    const resultados = await Promise.allSettled([a, b]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(resultados.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(KapsoIdempotencyError);
  });

  it("una respuesta perdida deja ambiguous y un retry no vuelve a salir", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket closed after request");
    }) as unknown as typeof fetch;
    const client = new KapsoClient(config(), { fetchImpl });
    const opciones: KapsoSendOptions = { actorIdentity: actor, operation: "recordatorio" };
    await expect(client.enviar(destino, "debe UYU 100", opciones)).rejects.toThrow(/red|socket/i);
    await expect(client.enviar(destino, "debe UYU 100", opciones)).rejects.toBeInstanceOf(KapsoIdempotencyError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("documento trata subida + mensaje como una sola operación: al perder respuesta no duplica ninguna llamada", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (String(init?.body).includes("[object FormData]")) return ok('{"id":"media-1"}');
      throw new Error("socket closed after request");
    }) as unknown as typeof fetch;
    const client = new KapsoClient(config(), { fetchImpl });
    const opciones: KapsoSendOptions = { actorIdentity: actor, operation: "documento" };
    const archivo = { contenido: new Uint8Array([37, 80, 68, 70]), filename: "factura.pdf", mimeType: "application/pdf" };
    await expect(client.enviarDocumento(destino, archivo, opciones)).rejects.toThrow();
    await expect(client.enviarDocumento(destino, archivo, opciones)).rejects.toBeInstanceOf(KapsoIdempotencyError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Kapso persistente", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("sobrevive reinicio, conserva estados inciertos y no guarda payload", () => {
    dir = mkdtempSync(join(tmpdir(), "biller-kapso-"));
    const path = join(dir, "kapso.jsonl");
    const primero = new FileIdempotencyStore(path);
    const clave = claveSalidaKapso({
      tenantId: "panaderia",
      actorIdentity: actor,
      destinatario: destino,
      operation: "recordatorio",
      payload: { body: "Juan debe UYU 100" },
    });
    expect(primero.claim(clave)).toBe(true);
    primero.markAmbiguous(clave);
    const reiniciado = new FileIdempotencyStore(path);
    expect(reiniciado.claim(clave)).toBe(false);
    const contenido = readFileSync(path, "utf8");
    expect(contenido).not.toContain(actor);
    expect(contenido).not.toContain(destino);
    expect(contenido).not.toContain("Juan");
  });
});

// =============================================================================
// La reserva es una VENTANA, no una condena perpetua
// =============================================================================
//
// La primera versión hasheaba tenant+actor+destinatario+operación+payload sin
// ninguna noción de tiempo, sobre un journal que no expira. O sea: el segundo
// mensaje byte a byte idéntico quedaba bloqueado PARA SIEMPRE. El usuario que
// pide el menú dos veces —o que arranca una segunda factura, cuyo primer paso
// tiene exactamente el mismo texto que la primera— no recibía nada. Un flujo
// mudo es el peor modo de falla de este proyecto, y era el default.

describe("una salida idéntica no queda bloqueada para siempre", () => {
  const clienteCon = (fetchImpl: unknown, ahora: () => number) =>
    new KapsoClient(config(), { fetchImpl: fetchImpl as typeof fetch, ahora });

  it("el menú se puede pedir dos veces: lo conversacional no se reserva", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const t = 1_800_000_000_000;
    const c = clienteCon(fetchImpl, () => t);
    const opts: KapsoSendOptions = { actorIdentity: actor, operation: "menu" };
    await c.enviar(destino, "1. Facturar\n2. Cuánto facturé", opts);
    await c.enviar(destino, "1. Facturar\n2. Cuánto facturé", opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("el primer paso de dos facturas seguidas se pregunta las dos veces", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const t = 1_800_000_000_000;
    const c = clienteCon(fetchImpl, () => t);
    const opts: KapsoSendOptions = { actorIdentity: actor, operation: "paso_emision" };
    await c.enviarInteractivo(destino, { tipo: "botones", encabezado: "¿A quién?", cuerpo: "…", botones: [{ id: "emision:receptor:empresa", titulo: "🏢 Empresa" }] }, opts);
    await c.enviarInteractivo(destino, { tipo: "botones", encabezado: "¿A quién?", cuerpo: "…", botones: [{ id: "emision:receptor:empresa", titulo: "🏢 Empresa" }] }, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("un reintento inmediato de un documento NO se manda dos veces", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const t = 1_800_000_000_000;
    const c = clienteCon(fetchImpl, () => t);
    const opts: KapsoSendOptions = { actorIdentity: actor, operation: "reporte_diario" };
    await c.enviar(destino, "Hoy facturaste $12.500", opts);
    await expect(c.enviar(destino, "Hoy facturaste $12.500", opts)).rejects.toBeInstanceOf(
      KapsoIdempotencyError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("el mismo reporte, pasada la ventana, vuelve a salir", async () => {
    const fetchImpl = vi.fn(async () => ok());
    let t = 1_800_000_000_000;
    const c = clienteCon(fetchImpl, () => t);
    const opts: KapsoSendOptions = { actorIdentity: actor, operation: "reporte_diario" };
    await c.enviar(destino, "Hoy facturaste $12.500", opts);
    t += 2 * 60 * 60 * 1000; // dos horas después ya no es un reintento
    await c.enviar(destino, "Hoy facturaste $12.500", opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("un recordatorio de cobro sigue siendo UNO por día, como antes", async () => {
    // Esto lo garantizaba `claveRecordatorio` con el día uruguayo adentro. La
    // ventana de reintento sola dejaría mandar dos cobranzas el mismo día, que
    // es lo que aquel candado existía para evitar.
    const fetchImpl = vi.fn(async () => ok());
    let t = Date.parse("2026-09-03T14:00:00Z");
    const c = clienteCon(fetchImpl, () => t);
    const opts: KapsoSendOptions = { actorIdentity: actor, operation: "recordatorio" };
    await c.enviar(destino, "Tenés $3.000 vencidos", opts);
    t += 6 * 60 * 60 * 1000; // seis horas después, el MISMO día uruguayo
    await expect(c.enviar(destino, "Tenés $3.000 vencidos", opts)).rejects.toBeInstanceOf(
      KapsoIdempotencyError,
    );
    t += 24 * 60 * 60 * 1000; // al día siguiente sí
    await c.enviar(destino, "Tenés $3.000 vencidos", opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("una salida bloqueada deja rastro", () => {
  it("loguea el hecho y la operación, sin el contenido ni el número entero", async () => {
    const { logger } = await import("../src/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const c = new KapsoClient(config(), {
        fetchImpl: (async () => ok()) as unknown as typeof fetch,
        ahora: () => 1_800_000_000_000,
      });
      const opts: KapsoSendOptions = { actorIdentity: actor, operation: "reporte_diario" };
      await c.enviar(destino, "Hoy facturaste $12.500", opts);
      await expect(c.enviar(destino, "Hoy facturaste $12.500", opts)).rejects.toBeInstanceOf(
        KapsoIdempotencyError,
      );
      const [evento, meta] = warn.mock.calls.at(-1)!;
      expect(evento).toBe("kapso.salida.bloqueada_por_reserva");
      expect(meta).toMatchObject({ operacion: "reporte_diario", motivo: "reserva_vigente" });
      expect(JSON.stringify(meta)).not.toContain(destino);
      expect(JSON.stringify(meta)).not.toContain("12.500");
    } finally {
      warn.mockRestore();
    }
  });
});
