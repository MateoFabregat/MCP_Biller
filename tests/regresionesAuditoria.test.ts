// =============================================================================
// Los bugs que encontró la caza de septiembre de 2026, cada uno con su prueba.
//
// Todos estaban reproducidos antes de arreglarse. Este archivo es lo que impide
// que vuelvan: si alguno de estos tests falla, el bug volvió tal cual estaba.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsearCantidad } from "../src/services/importe.js";
import { calcularTotales, formatearTotales } from "../src/services/calcularTotales.js";
import { construirConfirmacionEmision, overheadConfirmacionEmision } from "../src/kapso/render.js";
import { construirPayloadInteractivo, LIMITES_INTERACTIVO, KapsoClient, KapsoIdempotencyError } from "../src/kapso/client.js";
import { BorradorStoreMemoria, MAX_SESIONES } from "../src/kapso/borradorStore.js";
import { FileIdempotencyStore } from "../src/write/idempotency.js";
import { logger } from "../src/logger.js";
import { interpretarRespuestaLibre } from "../src/kapso/emision.js";
import { recortarSeguro } from "../src/utils/texto.js";

// --- 1. Cantidades ----------------------------------------------------------

describe("cantidad: la fracción del mostrador y el falso punto de miles", () => {
  it("lee las fracciones con barra en vez de quedarse con el numerador", () => {
    expect(parsearCantidad("1/2 kg").valor).toBe(0.5);
    expect(parsearCantidad("1/2").valor).toBe(0.5);
    expect(parsearCantidad("3/4 de bolsa").valor).toBe(0.75);
    // Mixta: dos y medio, no dos.
    expect(parsearCantidad("2 1/2").valor).toBe(2.5);
  });

  it("no toma un cero solo como grupo de miles", () => {
    // "0.500" es medio kilo. Leerlo como 500 multiplicaba la línea por mil.
    expect(parsearCantidad("0.500").valor).toBe(0.5);
  });

  it("no toma un cero solo como grupo de miles, tampoco con coma", () => {
    // Mismo bug que "0.500", con el separador decimal uruguayo: "0,500" es
    // medio kilo, no quinientos. Antes de este arreglo la regla de miles solo
    // excluía el cero solo en la rama del punto, y acá seguía dando 500
    // marcado como ambiguo. Ahora no hay nada que confirmar: se leyó bien.
    const leida = parsearCantidad("0,500");
    expect(leida.valor).toBe(0.5);
    expect(leida.ambiguo).toBeFalsy();
    expect(parsearCantidad("0,750").valor).toBe(0.75);
    expect(parsearCantidad("0,250").valor).toBe(0.25);
  });

  it("pero '6,500' sigue siendo la coma de miles real, y sigue ambiguo", () => {
    // Esta es la regla que NO cambia: un precio de mostrador con tres
    // decimales no existe, así que "6,500" sigue leyéndose 6.500 — con la
    // advertencia, porque también podría ser seis coma cinco.
    const leida = parsearCantidad("6,500");
    expect(leida.valor).toBe(6500);
    expect(leida.ambiguo).toBe(true);
  });

  it("no rompe lo que ya funcionaba", () => {
    expect(parsearCantidad("12 cajas de una unidad").valor).toBe(12);
    expect(parsearCantidad("media docena").valor).toBe(6);
    expect(parsearCantidad("0/2").valor).toBeNull();
  });

  it("la unidad pegada no cambia el precio: '1/2kg' es lo mismo que '1/2 kg'", () => {
    // El mismo usuario no puede facturar distinto según si apretó la barra
    // espaciadora. Ver issue #16.
    expect(parsearCantidad("1/2kg").valor).toBe(0.5);
  });

  it("un código con barra no es una división: se rechaza y se pregunta", () => {
    // "12/03", "3/12" y "art 12/24" tienen forma de fracción pero son un
    // talle, un lote o una fecha corta. Ninguno se convierte en cantidad.
    expect(parsearCantidad("12/03").valor).toBeNull();
    expect(parsearCantidad("3/12").valor).toBeNull();
    expect(parsearCantidad("art 12/24").valor).toBeNull();
  });
});

// --- 2. El preview no se corta por la cola ----------------------------------

describe("preview de confirmación: la razón social más larga que admite DGI", () => {
  const NOMBRE = "A".repeat(150);

  const totales = () =>
    calcularTotales({
      tipo_comprobante: 111,
      moneda: "UYU",
      montos_brutos: 1,
      items: Array.from({ length: 12 }, (_, i) => ({
        concepto: `Producto numero ${i} con nombre largo`,
        cantidad: 3,
        precio: 640,
        indicador_facturacion: 3,
      })),
    } as never);

  it("el cuerpo entra en los 1024 de WhatsApp y conserva TOTAL, avisos y la pregunta", () => {
    const overhead = overheadConfirmacionEmision({
      cliente: NOMBRE,
      documento: "218765430011",
      tipoComprobante: "e-Factura",
    });
    const resumen = formatearTotales(totales(), {
      max_chars: LIMITES_INTERACTIVO.cuerpo - overhead,
      fecha_emision: "03/09/2026",
      hoy: "03/09/2026",
      forma_pago: 1,
      montos_brutos: true,
      precios_ambiguos: [{ concepto: "Producto numero 0", precio: 640 }],
      advertencias_criticas: ["⛔ RECEPTOR OBLIGATORIO: la e-Factura exige receptor identificado."],
    });

    const mensaje = construirConfirmacionEmision({
      resumen,
      cliente: NOMBRE,
      documento: "218765430011",
      tipoComprobante: "e-Factura",
      ambiente: "production",
      token: "tok",
    });
    const enviado = (construirPayloadInteractivo(mensaje) as { body: { text: string } }).body.text;

    // Lo que se rompía: WhatsApp cortaba por el final y se perdían las dos
    // últimas cosas, que son las que hacen que el "sí" signifique algo.
    expect(enviado.length).toBeLessThanOrEqual(LIMITES_INTERACTIVO.cuerpo);
    expect(enviado).toBe(mensaje.cuerpo);
    expect(enviado).toContain("¿Lo emito?");
    expect(enviado).toContain("TOTAL");
    expect(enviado).toContain("Confirmalo ANTES de emitir");
    expect(enviado).toContain("RECEPTOR OBLIGATORIO");
  });

  it("aunque el resumen llegue sobredimensionado, el recorte de emergencia no toca el TOTAL", () => {
    const resumen = formatearTotales(totales(), { max_chars: 4000 });
    const mensaje = construirConfirmacionEmision({
      resumen,
      cliente: NOMBRE,
      documento: "218765430011",
      tipoComprobante: "e-Factura",
      ambiente: "production",
      token: "tok",
    });
    expect(mensaje.cuerpo.length).toBeLessThanOrEqual(LIMITES_INTERACTIVO.cuerpo);
    expect(mensaje.cuerpo).toContain("TOTAL");
    expect(mensaje.cuerpo).toContain("¿Lo emito?");
  });

  it("declara los ítems que no muestra, en vez de insinuarlo", () => {
    const texto = formatearTotales(totales(), {});
    expect(texto).toContain("que no entran en el mensaje");
  });

  // --- Issue 15: la última red mide lo que realmente va a escribir ---------
  //
  // El bucle de emergencia medía contra el placeholder "… (N renglones del
  // detalle no entraron)" (39 caracteres) pero escribía "… (1 renglón/es del
  // detalle no entraron)" (40): el cuerpo se pasaba por un carácter, WhatsApp
  // lo recortaba a su vez y "¿Lo emito?" quedaba afuera. Y el primer renglón
  // que el bucle elegía para caer era justo la declaración de los ítems
  // ocultos, la única frase que avisa que el TOTAL incluye ítems que la
  // persona nunca vio.
  it("sin pasar max_chars, el cuerpo entra en 1024 y conserva la pregunta y la declaración de ocultos", () => {
    // El único llamador de producción SÍ pasa max_chars (con el presupuesto de
    // `overheadConfirmacionEmision`); esta prueba cubre a quien no lo hace,
    // que es exactamente donde la issue reprodujo el bug.
    const resumen = formatearTotales(totales(), {
      fecha_emision: "03/09/2026",
      hoy: "03/09/2026",
      forma_pago: 1,
      montos_brutos: true,
      precios_ambiguos: [{ concepto: "Producto numero 0", precio: 640 }],
      advertencias_criticas: ["⛔ RECEPTOR OBLIGATORIO: la e-Factura exige receptor identificado."],
    });

    const mensaje = construirConfirmacionEmision({
      resumen,
      cliente: NOMBRE,
      documento: "218765430011",
      tipoComprobante: "e-Factura",
      ambiente: "production",
      token: "tok",
    });

    expect(mensaje.cuerpo.length).toBeLessThanOrEqual(LIMITES_INTERACTIVO.cuerpo);
    expect(mensaje.cuerpo).toContain("¿Lo emito?");
    // La declaración de los ítems ocultos tiene que sobrevivir al recorte de
    // emergencia: es información, no un renglón de relleno más.
    expect(mensaje.cuerpo).toContain("ítems más que no entran");
  });
});

// --- 3. Recorte que no parte un emoji ---------------------------------------

describe("recorte por code units", () => {
  it("no deja un surrogate suelto al final", () => {
    const largo = `${"a".repeat(4095)}😀`;
    const corto = recortarSeguro(largo, 4096);
    expect(corto.length).toBeLessThanOrEqual(4096);
    // Sin `isWellFormed` (no está en el lib de este tsconfig): un surrogate
    // alto suelto al final es exactamente lo que se quiere descartar.
    const ultimo = corto.charCodeAt(corto.length - 1);
    expect(ultimo >= 0xd800 && ultimo <= 0xdbff).toBe(false);
    expect(corto.endsWith("a")).toBe(true);
  });

  it("respeta el tope contando el sufijo", () => {
    expect(recortarSeguro("abcdef", 4, "…")).toBe("abc…");
  });
});

// --- 4. Borrador: carrera y desalojo ----------------------------------------

describe("borrador de emisión", () => {
  it("fusiona en vez de pisar cuando otra llamada escribió en el medio", () => {
    const store = new BorradorStoreMemoria();
    const clave = store.clave("59891234567");

    // Las dos llamadas leen "no existe" (revisión 0).
    const leidaA = 0;
    const leidaB = 0;
    // B guarda primero: el usuario contestó que el precio ya incluye IVA.
    store.guardar(clave, { montos_brutos: true }, { desdeRevision: leidaB });
    // A guarda después, con la base vieja: trae los ítems.
    store.guardar(clave, { items: [{ concepto: "harina", precio: 6500 }] } as never, {
      desdeRevision: leidaA,
    });

    const final = store.leer(clave)!.estado as Record<string, unknown>;
    expect(final.montos_brutos).toBe(true);
    expect((final.items as unknown[]).length).toBe(1);
  });

  it("anota el borrado aunque la sesión ya se haya caído por LRU", () => {
    const escritas: Array<Record<string, unknown>> = [];
    class StoreConLapida extends BorradorStoreMemoria {
      protected override persistirBorrado(sesion: string): void {
        escritas.push({ sesion, borrado: true });
      }
    }
    const store = new StoreConLapida();
    const clave = store.clave("59891234567");
    store.guardar(clave, { montos_brutos: true });
    // Se desborda la LRU: la sesión original se cae de memoria.
    for (let i = 0; i < MAX_SESIONES; i += 1) store.guardar(store.clave(`5989000${i}`), {});
    expect(store.leer(clave)).toBeNull();

    store.borrar(clave);
    // Sin la lápida, otra instancia (o un reinicio) resucitaba el borrador de un
    // comprobante ya emitido y la factura siguiente arrancaba con sus datos.
    expect(escritas.some((e) => e.sesion === clave)).toBe(true);
  });
});

// --- 5. Idempotencia: los locks se sueltan ----------------------------------

describe("registro fiscal de idempotencia", () => {
  it("no deja un .lock por CFE emitido", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const store = new FileIdempotencyStore(join(dir, "idem.jsonl"));
    for (let i = 0; i < 5; i += 1) {
      expect(store.claim(`k${i}`)).toBe(true);
      store.markExecuted(`k${i}`);
    }
    expect(readdirSync(join(dir, "idem.jsonl.claims"))).toHaveLength(0);
  });

  it("sigue negando la reejecución de una key ya usada", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const path = join(dir, "idem.jsonl");
    const store = new FileIdempotencyStore(path);
    store.claim("k");
    store.markExecuted("k");
    expect(store.claim("k")).toBe(false);

    // Y una instancia NUEVA, que no vio nada en memoria, tampoco la concede:
    // el estado vive en el journal, que es lo que permitió soltar el lock.
    expect(new FileIdempotencyStore(path).claim("k")).toBe(false);
  });

  it("un proceso que arrancó antes ve la ejecución ajena al releer el journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const path = join(dir, "idem.jsonl");
    const viejo = new FileIdempotencyStore(path); // arranca con el journal vacío
    const nuevo = new FileIdempotencyStore(path);
    nuevo.claim("k");
    nuevo.markExecuted("k");
    // El viejo no tiene la key en memoria: sin la relectura, la reejecutaba.
    expect(viejo.claim("k")).toBe(false);
  });

  // --- R1: el umbral de compactación tiene que ser relativo, no fijo -------
  it("R1: pasadas las 1000 líneas de sobra, la compactación deja de dispararse en cada escritura", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const store = new FileIdempotencyStore(join(dir, "idem.jsonl"));
    const compactaciones = vi.spyOn(logger, "info").mockImplementation(() => {});
    const contar = () =>
      compactaciones.mock.calls.filter(([mensaje]) => mensaje === "idempotencia.compactada").length;

    // 1100 ciclos de claim+release sobre un puñado de keys: cada ciclo dos
    // líneas de journal (in_flight + released) que NO dejan estado vivo (la
    // key se borra de `this.states` al liberarse). Es el patrón real que
    // infla el journal sin que el umbral fijo de antes lo detectara nunca
    // como "sobrante": simula, sin usar tiempo real, un journal viejo con
    // mucho historial ya resuelto.
    for (let i = 0; i < 1100; i += 1) {
      const key = `k${i % 20}`;
      if (store.claim(key)) store.release(key);
    }
    // `release` no dispara la compactación (no marca estado terminal); recién
    // acá, con las líneas de sobra ya acumuladas, un `markExecuted` la evalúa
    // por primera vez y la dispara.
    store.claim("final");
    store.markExecuted("final");
    const contadorTrasElPrimerLote = contar();
    expect(contadorTrasElPrimerLote).toBeGreaterThan(0);

    // Con el umbral fijo, una vez que `this.states.size` solo (sin journal
    // de sobra) superaba 1000, CADA escritura siguiente volvía a compactar
    // — el bug reproducido por la auditoría: 1100 operaciones, 109
    // compactaciones, y 10 más después de esas seguían compactando una por
    // una. Con el umbral relativo, 10 keys nuevas (journal ~2 líneas por
    // key) no duplican al estado real: cero compactaciones nuevas.
    for (let i = 0; i < 10; i += 1) {
      const key = `k${1000 + i}`;
      store.claim(key);
      store.markExecuted(key);
    }
    expect(contar()).toBe(contadorTrasElPrimerLote);

    compactaciones.mockRestore();
  });

  // --- R2: el lock de compactación protege también los appends -------------
  it("R2: con el lock de compactación tomado, persistir falla cerrado y no suelta el .lock de la key", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const path = join(dir, "idem.jsonl");
    const store = new FileIdempotencyStore(path);
    expect(store.claim("k")).toBe(true);

    const huella = createHash("sha256").update("k").digest("hex");
    const lockDeLaKey = join(dir, "idem.jsonl.claims", `${huella}.lock`);
    expect(existsSync(lockDeLaKey)).toBe(true);

    // Simulamos OTRO PROCESO compactando: tiene el lock global tomado.
    const lockDeCompactacion = `${path}.compact.lock`;
    const fdAjeno = openSync(lockDeCompactacion, "wx", 0o600);
    try {
      store.markExecuted("k");
      // persistir no consiguió el lock tras los reintentos: el estado
      // "executed" no llegó al journal, así que el lock de la key —lo único
      // que sigue impidiendo una reejecución— tiene que seguir ahí.
      expect(existsSync(lockDeLaKey)).toBe(true);
    } finally {
      closeSync(fdAjeno);
      unlinkSync(lockDeCompactacion);
    }
  });

  // --- R3: el centinela detecta un journal que desapareció ------------------
  it("R3: si el journal desaparece con el centinela puesto, una instancia nueva NIEGA (lanza) en vez de conceder", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const path = join(dir, "idem.jsonl");
    const store = new FileIdempotencyStore(path);
    store.claim("k");
    store.markExecuted("k");
    expect(existsSync(`${path}.creado`)).toBe(true);

    // Un logrotate, un restore de un backup viejo o un `rm` accidental.
    unlinkSync(path);

    expect(() => new FileIdempotencyStore(path).claim("k")).toThrow();
  });
});

// --- 6. "Uno por cliente por día" ------------------------------------------

describe("recordatorio de cobro: la ventana de un día", () => {
  const kapso = (dir: string, ahora: () => number) =>
    new KapsoClient(
      {
        apiKey: "k",
        baseUrl: "https://api.kapso.ai",
        phoneNumberId: "1",
        destinatariosPermitidos: ["59891234567"],
        idempotencyLogPath: join(dir, "kapso.jsonl"),
      } as never,
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ messages: [{ id: "m" }] }), {
            status: 200,
          })) as unknown as typeof fetch,
        ahora,
      },
    );

  it("bloquea el segundo reclamo del día aunque cambie el texto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kapso-"));
    const cliente = kapso(dir, () => Date.parse("2026-09-03T14:00:00Z"));
    const base = "Hola Pérez SRL,\n\nTotal: UYU 12.000,00";
    await cliente.enviar("59891234567", base, { operation: "recordatorio", sujeto: "rut:21" });

    await expect(
      cliente.enviar("59891234567", `Nota nueva\n\n${base}`, {
        operation: "recordatorio",
        sujeto: "rut:21",
      }),
    ).rejects.toBeInstanceOf(KapsoIdempotencyError);
  });

  it("deja pasar el reclamo a OTRO deudor el mismo día", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kapso-"));
    const cliente = kapso(dir, () => Date.parse("2026-09-03T14:00:00Z"));
    await cliente.enviar("59891234567", "uno", { operation: "recordatorio", sujeto: "rut:21" });
    await expect(
      cliente.enviar("59891234567", "otro", { operation: "recordatorio", sujeto: "rut:22" }),
    ).resolves.toBeTruthy();
  });

  it("no deja locks colgados en el directorio de reservas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kapso-"));
    let t = Date.parse("2026-09-03T14:00:00Z");
    const cliente = kapso(dir, () => (t += 31 * 60 * 1000));
    for (let i = 0; i < 5; i += 1) {
      await cliente.enviar("59891234567", `hola ${i}`, { operation: "reporte_diario" });
    }
    expect(readdirSync(join(dir, "kapso.jsonl.claims"))).toHaveLength(0);
    expect(readFileSync(join(dir, "kapso.jsonl"), "utf8").trim().split("\n").length).toBe(10);
  });
});

// --- 7. La pregunta de IVA acepta su propia respuesta ------------------------

describe("IVA: la respuesta compuesta que la gente escribe", () => {
  it("entiende 'sí, con iva' y 'no, se suma aparte'", () => {
    expect(interpretarRespuestaLibre("sí, con iva", "iva")).toEqual({
      paso: "montos_brutos",
      incluye_iva: true,
    });
    expect(interpretarRespuestaLibre("no, se suma aparte", "iva")).toEqual({
      paso: "montos_brutos",
      incluye_iva: false,
    });
  });

  it("sigue entendiendo la respuesta corta y sigue sin adivinar", () => {
    expect(interpretarRespuestaLibre("si", "iva")).toEqual({
      paso: "montos_brutos",
      incluye_iva: true,
    });
    expect(interpretarRespuestaLibre("qué sé yo", "iva")).toEqual({ paso: "ninguna" });
  });
});
