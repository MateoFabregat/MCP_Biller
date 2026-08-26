// =============================================================================
// Endurecimiento de la capa de escritura (PLAN_V2 §5.4):
//   S5 — TTL del confirmation_token
//   S6 — idempotencia persistente entre reinicios
//   S7 — tope de monto por operación
// =============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  checkConfirmationToken,
  computeConfirmationToken,
} from "../src/write/confirm.js";
import {
  BillerMontoExcedidoError,
  extraerMonto,
  parseLimitesMonto,
  verificarLimiteMonto,
} from "../src/write/limiteMonto.js";
import {
  FileIdempotencyStore,
  InMemoryIdempotencyStore,
  crearIdempotencyStore,
} from "../src/write/idempotency.js";

const ENDPOINT = "/v3/comprobantes/emitir";
const ENV = "test";
const PAYLOAD = { comprobante: { total: 1000, moneda: "UYU" } };

describe("S5 — TTL del confirmation_token", () => {
  it("un token recién emitido es válido", () => {
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0);
    expect(checkConfirmationToken(token, ENDPOINT, ENV, PAYLOAD, { ahora: t0 })).toEqual({ ok: true });
  });

  it("sigue siendo válido dentro de la ventana", () => {
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0);
    const check = checkConfirmationToken(token, ENDPOINT, ENV, PAYLOAD, {
      ahora: t0 + CONFIRMATION_TTL_MS - 1000,
    });
    expect(check.ok).toBe(true);
  });

  it("VENCE pasada la ventana", () => {
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0);
    const check = checkConfirmationToken(token, ENDPOINT, ENV, PAYLOAD, {
      ahora: t0 + CONFIRMATION_TTL_MS + 1,
    });
    expect(check).toMatchObject({ ok: false, motivo: "vencido" });
    if (!check.ok) expect(check.mensaje).toContain("dry-run");
  });

  it("distingue 'vencido' de 'no coincide'", () => {
    // Importa para el modelo: "vencido" se arregla repitiendo el dry-run;
    // "no coincide" significa que el payload cambió y NO hay que reintentar.
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0);
    const otro = { comprobante: { total: 999_999, moneda: "UYU" } };
    const check = checkConfirmationToken(token, ENDPOINT, ENV, otro, { ahora: t0 });
    expect(check).toMatchObject({ ok: false, motivo: "no_coincide" });
    if (!check.ok) expect(check.mensaje).toContain("payload cambió");
  });

  it("no se puede extender la vida moviendo el timestamp del token", () => {
    // El timestamp está DENTRO del hash: alterarlo invalida el token.
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0);
    const hash = token.split(".")[1]!;
    const falsificado = `${t0 + CONFIRMATION_TTL_MS * 10}.${hash}`;
    const check = checkConfirmationToken(falsificado, ENDPOINT, ENV, PAYLOAD, {
      ahora: t0 + CONFIRMATION_TTL_MS * 10,
    });
    expect(check).toMatchObject({ ok: false, motivo: "no_coincide" });
  });

  it("rechaza ausente, mal formado y fechado en el futuro", () => {
    const t0 = 1_000_000_000_000;
    expect(checkConfirmationToken(undefined, ENDPOINT, ENV, PAYLOAD)).toMatchObject({
      motivo: "ausente",
    });
    expect(checkConfirmationToken("deadbeef", ENDPOINT, ENV, PAYLOAD)).toMatchObject({
      motivo: "formato",
    });
    const futuro = computeConfirmationToken(ENDPOINT, ENV, PAYLOAD, t0 + 600_000);
    expect(checkConfirmationToken(futuro, ENDPOINT, ENV, PAYLOAD, { ahora: t0 })).toMatchObject({
      motivo: "formato",
    });
  });

  it("un token de otro ambiente no sirve", () => {
    const t0 = 1_000_000_000_000;
    const token = computeConfirmationToken(ENDPOINT, "test", PAYLOAD, t0);
    expect(
      checkConfirmationToken(token, ENDPOINT, "production", PAYLOAD, { ahora: t0 }),
    ).toMatchObject({ motivo: "no_coincide" });
  });
});

describe("S7 — tope de monto por operación", () => {
  it("parsea los topes por moneda desde el entorno", () => {
    expect(
      parseLimitesMonto({ BILLER_MAX_MONTO_UYU: "500000", BILLER_MAX_MONTO_USD: "10000" }),
    ).toEqual({ UYU: 500_000, USD: 10_000 });
  });

  it("ignora valores inválidos en vez de tomarlos como cero", () => {
    // Un tope de 0 por un typo bloquearía toda la facturación de la empresa.
    expect(parseLimitesMonto({ BILLER_MAX_MONTO_UYU: "abc" })).toEqual({});
    expect(parseLimitesMonto({ BILLER_MAX_MONTO_UYU: "0" })).toEqual({});
    expect(parseLimitesMonto({ BILLER_MAX_MONTO_UYU: "-5" })).toEqual({});
  });

  it("extrae monto y moneda del payload", () => {
    expect(extraerMonto({ total: 1500, moneda: "USD" })).toEqual({ monto: 1500, moneda: "USD" });
    expect(extraerMonto({ total: "2500.50" })).toEqual({ monto: 2500.5, moneda: "UYU" });
    expect(extraerMonto({ sin_total: 1 })).toBeNull();
  });

  it("deja pasar lo que está por debajo del tope", () => {
    expect(() => verificarLimiteMonto({ total: 1000, moneda: "UYU" }, { UYU: 500_000 })).not.toThrow();
  });

  it("BLOQUEA lo que lo supera", () => {
    // El caso real: "facturale 1.500" interpretado como 1500000.
    expect(() =>
      verificarLimiteMonto({ total: 1_500_000, moneda: "UYU" }, { UYU: 500_000 }),
    ).toThrow(BillerMontoExcedidoError);
  });

  it("el tope es POR MONEDA", () => {
    const limites = { UYU: 500_000 };
    // Sin tope para USD, no se bloquea: un límite pensado en pesos aplicado a
    // dólares frenaría casi todo.
    expect(() => verificarLimiteMonto({ total: 20_000, moneda: "USD" }, limites)).not.toThrow();
    expect(() => verificarLimiteMonto({ total: 600_000, moneda: "UYU" }, limites)).toThrow();
  });

  it("sin topes configurados no hace nada", () => {
    expect(() => verificarLimiteMonto({ total: 99_999_999, moneda: "UYU" }, {})).not.toThrow();
    expect(() => verificarLimiteMonto({ total: 99_999_999 }, undefined)).not.toThrow();
  });

  it("el mensaje dice el monto y el tope, para poder ver el error de tipeo", () => {
    try {
      verificarLimiteMonto({ total: 1_500_000, moneda: "UYU" }, { UYU: 500_000 });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("1.500.000");
      expect(msg).toContain("500.000");
      expect(msg).toContain("NO se ejecutó");
    }
  });
});

describe("S6 — idempotencia persistente", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "biller-idem-"));
    path = join(dir, "idempotency.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sin ruta configurada usa el store en memoria", () => {
    expect(crearIdempotencyStore(undefined)).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(crearIdempotencyStore("  ")).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(crearIdempotencyStore(path)).toBeInstanceOf(FileIdempotencyStore);
  });

  it("una key marcada SOBREVIVE al reinicio del proceso", () => {
    // Esta es la garantía central: sin ella, reiniciar Claude Desktop permite
    // re-ejecutar una emisión ya hecha y duplicar el comprobante ante DGI.
    const primero = new FileIdempotencyStore(path);
    primero.markUsed("key-abc");
    expect(primero.has("key-abc")).toBe(true);

    const segundo = new FileIdempotencyStore(path); // simula el reinicio
    expect(segundo.has("key-abc")).toBe(true);
    expect(segundo.has("key-nueva")).toBe(false);
  });

  it("acumula varias keys entre reinicios", () => {
    const a = new FileIdempotencyStore(path);
    a.markUsed("k1");
    const b = new FileIdempotencyStore(path);
    b.markUsed("k2");
    const c = new FileIdempotencyStore(path);
    expect(c.has("k1")).toBe(true);
    expect(c.has("k2")).toBe(true);
  });

  it("arrancar sin archivo previo no rompe", () => {
    const store = new FileIdempotencyStore(join(dir, "no-existe.log"));
    expect(store.has("x")).toBe(false);
  });

  it("una línea corrupta no descarta el resto del archivo", () => {
    const store = new FileIdempotencyStore(path);
    store.markUsed("buena-1");
    // Escritura interrumpida a mitad de línea.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(path, '{"key":"rota\n', "utf8");
    const recargado = new FileIdempotencyStore(path);
    expect(recargado.has("buena-1")).toBe(true);
  });

  it("no guarda el payload, solo la key y el timestamp", () => {
    // El archivo no es secreto: los datos de facturación no van ahí.
    const store = new FileIdempotencyStore(path);
    store.markUsed("key-xyz");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const contenido = readFileSync(path, "utf8");
    const entrada = JSON.parse(contenido.trim()) as Record<string, unknown>;
    expect(Object.keys(entrada).sort()).toEqual(["key", "ts"]);
  });

  it("degrada a memoria si el archivo no se puede escribir, sin lanzar", () => {
    // Bloquear la facturación entera porque falló un archivo auxiliar sería peor
    // que perder la protección contra duplicados.
    const store = new FileIdempotencyStore("/proc/imposible/idempotency.log");
    expect(() => store.markUsed("k")).not.toThrow();
    expect(store.has("k")).toBe(true);
  });
});
