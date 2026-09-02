// =============================================================================
// Endurecimiento de la capa de escritura (PLAN_V2 §5.4):
//   S5 — TTL del confirmation_token
//   S6 — idempotencia persistente entre reinicios
//   S7 — tope de monto por operación
// =============================================================================

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  BillerMontoInvalidoError,
  extraerMonto,
  parseLimitesMonto,
  verificarLimiteMonto,
} from "../src/write/limiteMonto.js";
import {
  FileIdempotencyStore,
  InMemoryIdempotencyStore,
  crearIdempotencyStore,
} from "../src/write/idempotency.js";
import { handleCrearRecibo } from "../src/tools/write/crearRecibo.js";
import { errorOf, makeCtx } from "./helpers.js";
import { BillerNetworkError } from "../src/utils/errors.js";

const ENDPOINT = "/v3/comprobantes/emitir";
const ENV = "test";
const PAYLOAD = { comprobante: { total: 1000, moneda: "UYU" } };
const RECIBO = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
  cliente: {
    tipo_documento: 3,
    documento: "52165030",
    nombre_fantasia: "Juan Pérez",
    sucursal: { pais: "UY", ciudad: "Montevideo", direccion: "Sarandí 420" },
  },
  referencias: [{ padre: 150448, total: 1830 }],
  pago: { fecha: "2021-05-27", monto: 1830, referencia: "Transferencia Itaú 2185" },
};

function structured(res: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return res.structuredContent!;
}

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
    const [, huella, hash] = token.split(".");
    const falsificado = `${t0 + CONFIRMATION_TTL_MS * 10}.${huella}.${hash}`;
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

  // -------------------------------------------------------------------------
  // SEC-A3: el tope NO se aplicaba a la emisión, que es para lo que se escribió.
  //
  // `extraerMonto` husmea `total`/`monto`/`importe` en la RAÍZ del payload. Un
  // ComprobanteBody no tiene ninguno de los tres: el total de un CFE es la suma
  // de sus líneas con su IVA. O sea que BILLER_MAX_MONTO_UYU nunca frenó una
  // emisión — justo la operación que motiva el tope (una coma mal puesta).
  // -------------------------------------------------------------------------
  it("un ComprobanteBody NO tiene total en la raíz: por eso el tope no aplicaba", () => {
    const cfe = {
      tipo_comprobante: 101,
      moneda: "UYU",
      items: [{ cantidad: 1, concepto: "Pelota", precio: 999_999_999 }],
    };
    expect(extraerMonto(cfe)).toBeNull();
    // Sin monto explícito, el tope se evapora aunque esté configurado.
    expect(() => verificarLimiteMonto(cfe, { UYU: 100_000 })).not.toThrow();
  });

  it("con el total calculado pasado explícitamente, SÍ bloquea", () => {
    const cfe = {
      tipo_comprobante: 101,
      moneda: "UYU",
      items: [{ cantidad: 1, concepto: "Pelota", precio: 999_999_999 }],
    };
    expect(() =>
      verificarLimiteMonto(cfe, { UYU: 100_000 }, { monto: 999_999_999, moneda: "UYU" }),
    ).toThrow(BillerMontoExcedidoError);
  });

  it("el monto explícito GANA sobre lo husmeado del payload", () => {
    // Es un número calculado, no adivinado. Si un payload trajera un `total`
    // decorativo distinto del real, el que manda es el que se va a facturar.
    expect(() =>
      verificarLimiteMonto({ total: 10, moneda: "UYU" }, { UYU: 100_000 }, { monto: 500_000, moneda: "UYU" }),
    ).toThrow(BillerMontoExcedidoError);
  });

  it("un monto explícito en cero o no finito cae al husmeo de siempre", () => {
    // Un CFE de total 0 (todo entrega gratuita) no tiene por qué chocar contra
    // un tope, y un NaN no puede bloquear una emisión legítima.
    expect(() =>
      verificarLimiteMonto({ total: 10 }, { UYU: 100_000 }, { monto: 0, moneda: "UYU" }),
    ).not.toThrow();
    expect(() =>
      verificarLimiteMonto({ total: 10 }, { UYU: 100_000 }, { monto: NaN, moneda: "UYU" }),
    ).not.toThrow();
    expect(() =>
      verificarLimiteMonto({ total: 200_000 }, { UYU: 100_000 }, { monto: 0, moneda: "UYU" }),
    ).toThrow(BillerMontoExcedidoError);
  });

  it("con tope configurado falla cerrado si una operación monetaria no tiene monto legible", () => {
    expect(() =>
      verificarLimiteMonto({ moneda: "UYU", pago: { monto: "mucho" } }, { UYU: 1000 }),
    ).toThrow(BillerMontoInvalidoError);

    // Crear/cancelar entidades sin valor monetario conserva el comportamiento
    // anterior aunque exista un tope para otras operaciones.
    expect(() =>
      verificarLimiteMonto({ nombre: "Cliente sin importe" }, { UYU: 1000 }),
    ).not.toThrow();
    expect(() =>
      verificarLimiteMonto(
        { tipo_comprobante: 101, items: [] },
        { UYU: 1000 },
        { monto: Number.NaN, moneda: "UYU" },
      ),
    ).toThrow(BillerMontoInvalidoError);
  });

  it("monto autoritativo no puede ser tapado por un total decorativo", () => {
    expect(() =>
      verificarLimiteMonto({ moneda: "UYU", monto: 2000, total: 1 }, { UYU: 1000 }),
    ).toThrow(BillerMontoExcedidoError);
  });

  it("no presume UYU para un pago cuya moneda no viene en el payload", () => {
    expect(() =>
      verificarLimiteMonto({ monto: 100, comprobantes: [{ id: 1, monto: 100 }] }, { USD: 50 }),
    ).toThrow(BillerMontoInvalidoError);
    expect(() =>
      verificarLimiteMonto({ monto: 100, comprobantes: [{ id: 1, monto: 100 }] }, { UYU: 1000 }),
    ).toThrow(/moneda/i);
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

  it("un claim in_flight se persiste y bloquea después de reiniciar", () => {
    const primero = new FileIdempotencyStore(path);
    expect(primero.claim("key-en-vuelo")).toBe(true);

    const reiniciado = new FileIdempotencyStore(path);
    expect(reiniciado.claim("key-en-vuelo")).toBe(false);
  });

  it("dos stores vivos sobre el mismo archivo no reclaman la misma key", () => {
    const procesoA = new FileIdempotencyStore(path);
    const procesoB = new FileIdempotencyStore(path);

    expect(procesoA.claim("key-dos-procesos")).toBe(true);
    expect(procesoB.claim("key-dos-procesos")).toBe(false);
  });

  it("los estados ambiguous y executed nunca se reemiten al reiniciar", () => {
    const primero = new FileIdempotencyStore(path);
    expect(primero.claim("key-ambigua")).toBe(true);
    primero.markAmbiguous("key-ambigua");
    expect(primero.claim("key-ejecutada")).toBe(true);
    primero.markExecuted("key-ejecutada");

    const reiniciado = new FileIdempotencyStore(path);
    expect(reiniciado.claim("key-ambigua")).toBe(false);
    expect(reiniciado.claim("key-ejecutada")).toBe(false);
  });

  it("solo un claim aún no despachado puede liberarse y volver a intentarse", () => {
    const primero = new FileIdempotencyStore(path);
    expect(primero.claim("key-pre-dispatch")).toBe(true);
    primero.release("key-pre-dispatch");

    const reiniciado = new FileIdempotencyStore(path);
    expect(reiniciado.claim("key-pre-dispatch")).toBe(true);
    reiniciado.markAmbiguous("key-pre-dispatch");
    reiniciado.release("key-pre-dispatch");
    expect(reiniciado.claim("key-pre-dispatch")).toBe(false);
  });

  it("interpreta las líneas históricas {key,ts} como executed", () => {
    writeFileSync(path, `${JSON.stringify({ key: "key-vieja", ts: "2026-01-01T00:00:00.000Z" })}\n`);

    const reiniciado = new FileIdempotencyStore(path);
    expect(reiniciado.has("key-vieja")).toBe(true);
    expect(reiniciado.claim("key-vieja")).toBe(false);
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

  it("una línea corrupta conserva las keys válidas pero bloquea claims nuevos", () => {
    const store = new FileIdempotencyStore(path);
    store.markUsed("buena-1");
    // Escritura interrumpida a mitad de línea.
    appendFileSync(path, '{"key":"rota\n', "utf8");
    const recargado = new FileIdempotencyStore(path);
    expect(recargado.has("buena-1")).toBe(true);
    expect(() => recargado.claim("nueva-despues-de-corrupcion")).toThrow(/leer el registro/i);
  });

  it("no guarda el payload, solo la key, el estado y el timestamp", () => {
    // El archivo no es secreto: los datos de facturación no van ahí.
    const store = new FileIdempotencyStore(path);
    store.markUsed("key-xyz");
    const contenido = readFileSync(path, "utf8");
    const entrada = JSON.parse(contenido.trim()) as Record<string, unknown>;
    expect(Object.keys(entrada).sort()).toEqual(["key", "state", "ts"]);
    expect(entrada).toMatchObject({ key: "key-xyz", state: "executed" });
  });

  it("crea el directorio 0700 y el archivo 0600", () => {
    const rutaPrivada = join(dir, "privado", "idempotency.log");
    const store = new FileIdempotencyStore(rutaPrivada);
    expect(store.claim("key-permisos")).toBe(true);

    expect(statSync(join(dir, "privado")).mode & 0o777).toBe(0o700);
    expect(statSync(rutaPrivada).mode & 0o777).toBe(0o600);
  });

  it("degrada a memoria si el archivo no se puede escribir, sin lanzar", () => {
    // Bloquear la facturación entera porque falló un archivo auxiliar sería peor
    // que perder la protección contra duplicados.
    const store = new FileIdempotencyStore("/proc/imposible/idempotency.log");
    expect(() => store.markUsed("k")).not.toThrow();
    expect(store.has("k")).toBe(true);
  });

  it("no concede un claim si no puede persistir in_flight", () => {
    const store = new FileIdempotencyStore("/proc/imposible/idempotency.log");
    expect(() => store.claim("key-sin-disco")).toThrow(/POST NO se ejecutó/);
    expect(store.has("key-sin-disco")).toBe(false);
  });
});

describe("P0 — claim atómico antes del POST", () => {
  it("dos confirmaciones concurrentes del mismo preview hacen como máximo un POST", async () => {
    let liberarPost!: () => void;
    const postPendiente = new Promise<void>((resolve) => {
      liberarPost = resolve;
    });
    const fx = makeCtx({
      config: { writeEnabled: true },
      postImpl: async () => {
        await postPendiente;
        return { status: 201, data: { id: 99 } };
      },
    });
    const dry = await handleCrearRecibo({ recibo: RECIBO }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const confirmacion = {
      recibo: RECIBO,
      confirm: true,
      confirmation_token: token,
    };

    const primera = handleCrearRecibo(confirmacion, fx.ctx);
    const segunda = handleCrearRecibo(confirmacion, fx.ctx);
    liberarPost();
    const resultados = await Promise.all([primera, segunda]);

    expect(fx.postMock).toHaveBeenCalledOnce();
    expect(
      resultados.filter((r) => r.isError !== true && structured(r).mode === "executed"),
    ).toHaveLength(1);
    const bloqueada = resultados.find((r) => r.isError === true);
    expect(bloqueada).toBeDefined();
    expect(errorOf(bloqueada!)).toMatchObject({ kind: "idempotency" });
    expect(errorOf(bloqueada!).message).toMatch(/verific[aá].*Biller/i);
    expect(errorOf(bloqueada!).message).not.toMatch(/key nueva/i);
  });

  it("un corte de red después de invocar POST queda ambiguous y no se reintenta", async () => {
    const fx = makeCtx({
      config: { writeEnabled: true },
      postImpl: async () => {
        throw new BillerNetworkError("conexión interrumpida");
      },
    });
    const dry = await handleCrearRecibo({ recibo: RECIBO }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const confirmacion = {
      recibo: RECIBO,
      confirm: true,
      confirmation_token: token,
    };

    const incierta = await handleCrearRecibo(confirmacion, fx.ctx);
    const reintento = await handleCrearRecibo(confirmacion, fx.ctx);

    expect(errorOf(incierta)).toMatchObject({ kind: "network" });
    expect(errorOf(reintento)).toMatchObject({ kind: "idempotency" });
    expect(errorOf(reintento).message).toMatch(/incierto|en curso|ejecutad/i);
    expect(fx.postMock).toHaveBeenCalledOnce();
  });
});

describe("P0 — BILLER_MAX_MONTO_* cubre crear_recibo", () => {
  it("rechaza pago.monto malformado en la interfaz pública", async () => {
    const fx = makeCtx({ config: { writeEnabled: true, maxMontos: { UYU: 1000 } } });
    const res = await handleCrearRecibo(
      { recibo: { ...RECIBO, pago: { ...RECIBO.pago, monto: "mucho" } } },
      fx.ctx,
    );

    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatchObject({ kind: "validation" });
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("rechaza pago.monto no finito en la interfaz pública", async () => {
    const fx = makeCtx({ config: { writeEnabled: true, maxMontos: { UYU: 1000 } } });
    const res = await handleCrearRecibo(
      { recibo: { ...RECIBO, pago: { ...RECIBO.pago, monto: Number.POSITIVE_INFINITY } } },
      fx.ctx,
    );

    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatchObject({ kind: "validation" });
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("permite pago.monto exactamente igual al tope", async () => {
    const recibo = {
      ...RECIBO,
      referencias: [{ padre: 150448, total: 1000 }],
      pago: { ...RECIBO.pago, monto: 1000 },
    };
    const fx = makeCtx({
      config: { writeEnabled: true, maxMontos: { UYU: 1000 } },
      postResponse: { id: 99 },
    });
    const dry = await handleCrearRecibo({ recibo }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const ejecutada = await handleCrearRecibo(
      { recibo, confirm: true, confirmation_token: token },
      fx.ctx,
    );

    expect(structured(ejecutada)).toMatchObject({ mode: "executed", http_status: 201 });
    expect(fx.postMock).toHaveBeenCalledOnce();
  });

  it("bloquea pago.monto por encima del tope antes de llegar a Biller", async () => {
    const recibo = {
      ...RECIBO,
      referencias: [{ padre: 150448, total: 1000.01 }],
      pago: { ...RECIBO.pago, monto: 1000.01 },
    };
    const fx = makeCtx({
      config: { writeEnabled: true, maxMontos: { UYU: 1000 } },
      postResponse: { id: 99 },
    });
    const dry = await handleCrearRecibo({ recibo }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const ejecutada = await handleCrearRecibo(
      { recibo, confirm: true, confirmation_token: token },
      fx.ctx,
    );

    expect(ejecutada.isError).toBe(true);
    expect(errorOf(ejecutada)).toMatchObject({ kind: "validation" });
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("pago.monto es autoritativo aunque el payload traiga un total decorativo", async () => {
    const recibo = {
      ...RECIBO,
      total: 1,
      referencias: [{ padre: 150448, total: 1000.01 }],
      pago: { ...RECIBO.pago, monto: 1000.01 },
    };
    const fx = makeCtx({
      config: { writeEnabled: true, maxMontos: { UYU: 1000 } },
      postResponse: { id: 99 },
    });
    const dry = await handleCrearRecibo({ recibo }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const ejecutada = await handleCrearRecibo(
      { recibo, confirm: true, confirmation_token: token },
      fx.ctx,
    );

    expect(ejecutada.isError).toBe(true);
    expect(errorOf(ejecutada)).toMatchObject({ kind: "validation" });
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("rechaza un monto negativo en el recibo en vez de convertirlo a valor absoluto", async () => {
    const recibo = {
      ...RECIBO,
      referencias: [{ padre: 150448, total: -1 }],
      pago: { ...RECIBO.pago, monto: -1 },
    };
    const fx = makeCtx({
      config: { writeEnabled: true, maxMontos: { UYU: 1000 } },
      postResponse: { id: 99 },
    });
    const dry = await handleCrearRecibo({ recibo }, fx.ctx);
    const token = structured(dry).confirmation_token as string;
    const ejecutada = await handleCrearRecibo(
      { recibo, confirm: true, confirmation_token: token },
      fx.ctx,
    );

    expect(ejecutada.isError).toBe(true);
    expect(errorOf(ejecutada)).toMatchObject({ kind: "validation" });
    expect(fx.postMock).not.toHaveBeenCalled();
  });
});
