// =============================================================================
// C6 / E5 — Recordatorio de cobro al cliente deudor.
//
// Esta es la única salida del server cuyo destinatario NO es el usuario, y por
// eso los tests están escritos al revés que los demás: la mayoría verifica que
// algo NO salga. Un mensaje entregado a un tercero no se puede retirar.
//
// Los cuatro invariantes que se fijan acá:
//   1. sin allowlist no hay ni tráfico de red ni consulta de la deuda;
//   2. sin token válido no sale nada, y si el saldo cambió el token deja de valer;
//   3. si la imputación es estimada, el mensaje NO detalla facturas;
//   4. nunca aparece un dato de otro cliente en el mensaje.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KapsoConfig } from "../src/config.js";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { calcularCuentaCorriente } from "../src/services/cuentaCorriente.js";
import { hoyComoDateUy } from "../src/services/fechaUy.js";
import { construirRecordatorio } from "../src/services/recordatorioCobro.js";
import { handleRecordatorioCobro } from "../src/tools/recordatorioCobro.js";
import type { ToolResult } from "../src/tools/shared.js";
import { errorOf, makeCtx } from "./helpers.js";

const PERMITIDO = "59895923567";
const BLOQUEADO = "59899000111";
const RUT_A = "210000000011";
const RUT_B = "219999999992";

function kapsoConfig(over: Partial<KapsoConfig> = {}): KapsoConfig {
  return {
    apiKey: "kapso_key_secretisima",
    baseUrl: "https://api.kapso.ai",
    phoneNumberId: "597907523413541",
    destinatariosPermitidos: [PERMITIDO],
    ...over,
  };
}

function fakeFetch(): { fn: typeof fetch; llamadas: Array<{ url: string; init: RequestInit }> } {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return new Response('{"messages":[{"id":"wamid.ABC"}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, llamadas };
}

function sc(res: ToolResult): Record<string, any> {
  return (res.structuredContent ?? {}) as Record<string, any>;
}

/** Factura a crédito, vencida hace `atraso` días respecto de hoy. */
function factura(over: Record<string, unknown> = {}): Record<string, unknown> {
  // Ancla en el "día uruguayo" (mediodía UTC), igual que el código bajo prueba
  // resuelve "hoy" con hoyComoDateUy(). Con `new Date()` crudo, entre las 21:00
  // y la medianoche UY el test corría en el día UTC siguiente y el atraso daba 29.
  const hoy = hoyComoDateUy();
  const emision = new Date(hoy.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  const vencimiento = new Date(hoy.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: 1,
    tipo_comprobante: 111,
    serie: "A",
    numero: 1001,
    moneda: "UYU",
    total: 10_000,
    estado: "Aceptado DGI",
    fecha_emision: emision,
    fecha_vencimiento: vencimiento,
    cliente: { documento: RUT_A, razon_social: "ACME SA" },
    ...over,
  };
}

function cuenta(crudos: Array<Record<string, unknown>>) {
  return calcularCuentaCorriente(normalizeComprobantesEmitidos(crudos));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Armado del mensaje (servicio puro)
// ---------------------------------------------------------------------------

describe("armado del mensaje", () => {
  it("lista las facturas vencidas con importe y atraso", () => {
    const r = construirRecordatorio(cuenta([factura()]), RUT_A, { empresa: "Almacén La Esquina" });
    expect(r.mensaje).toContain("ACME SA");
    expect(r.mensaje).toContain("e-Factura A-1001");
    expect(r.mensaje).toContain("UYU 10.000,00");
    expect(r.mensaje).toContain("vencida hace 30 días");
    expect(r.mensaje).toContain("Almacén La Esquina");
    expect(r.total_reclamado_por_moneda["UYU"]).toBe(10_000);
    expect(r.documentos).toBe(1);
  });

  it("descuenta el cobro parcial y lo dice", () => {
    const recibo = factura({
      id: 2,
      serie: "R",
      numero: 5,
      total: 4000,
      indicador_cobranza_propia: 1,
      fecha_vencimiento: null,
      items: [{ concepto: "e-Factura A-1001", cantidad: 1, precio: 4000 }],
    });
    const r = construirRecordatorio(cuenta([factura(), recibo]), RUT_A);
    expect(r.total_reclamado_por_moneda["UYU"]).toBe(6000);
    expect(r.mensaje).toContain("UYU 6.000,00");
    expect(r.mensaje).toContain("ya con el pago parcial descontado");
  });

  it("la nota del usuario va ARRIBA de los números", () => {
    const r = construirRecordatorio(cuenta([factura()]), RUT_A, { nota: "Hola Juan, ¿cómo va?" });
    const texto = r.mensaje!;
    expect(texto.indexOf("Hola Juan")).toBeLessThan(texto.indexOf("e-Factura"));
  });

  it("no reclama lo que todavía no venció", () => {
    const futuro = new Date(hoyComoDateUy().getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    const r = construirRecordatorio(cuenta([factura({ fecha_vencimiento: futuro })]), RUT_A);
    expect(r.mensaje).toBeNull();
    expect(r.motivo).toBe("sin_documentos_vencidos");
    expect(r.explicacion).toContain("spam");
  });

  it("con incluir_por_vencer sí lo reclama", () => {
    const futuro = new Date(hoyComoDateUy().getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    const r = construirRecordatorio(cuenta([factura({ fecha_vencimiento: futuro })]), RUT_A, {
      incluir_por_vencer: true,
    });
    expect(r.mensaje).toContain("vence el");
  });

  it("un cliente sin deuda no genera mensaje", () => {
    const recibo = factura({
      id: 2,
      total: 10_000,
      indicador_cobranza_propia: 1,
      fecha_vencimiento: null,
      items: [{ concepto: "e-Factura A-1001", cantidad: 1, precio: 10_000 }],
    });
    const r = construirRecordatorio(cuenta([factura(), recibo]), RUT_A);
    expect(r.mensaje).toBeNull();
    expect(r.motivo).toBe("sin_deuda");
  });

  it("no se le puede reclamar al grupo sin receptor", () => {
    const r = construirRecordatorio(cuenta([factura({ cliente: [] })]), "(sin receptor)");
    expect(r.motivo).toBe("cliente_sin_identificar");
  });

  it("un cliente que no está en el período devuelve motivo propio", () => {
    const r = construirRecordatorio(cuenta([factura()]), "999999999999");
    expect(r.motivo).toBe("cliente_no_encontrado");
    expect(r.explicacion).toContain("ampliá el período");
  });
});

// ---------------------------------------------------------------------------
// Invariante 3: la imputación estimada no detalla facturas
// ---------------------------------------------------------------------------

describe("imputación estimada", () => {
  it("con FIFO reclama el total y NO nombra comprobantes", () => {
    // Recibo sin items: no hay forma de saber qué factura pagó -> FIFO.
    const reciboFifo = factura({
      id: 3,
      serie: "R",
      numero: 9,
      total: 3000,
      indicador_cobranza_propia: 1,
      fecha_vencimiento: null,
    });
    const cc = cuenta([factura(), factura({ id: 4, numero: 1002, total: 5000 }), reciboFifo]);
    expect(cc.imputacion_exacta).toBe(false);

    const r = construirRecordatorio(cc, RUT_A);
    expect(r.detalle_omitido_por_imputacion).toBe(true);
    expect(r.lineas).toEqual([]);
    expect(r.mensaje).not.toContain("A-1001");
    expect(r.mensaje).not.toContain("A-1002");
    // Pero el total sí, porque el saldo por cliente SÍ es exacto.
    expect(r.mensaje).toContain("UYU 12.000,00");
    expect(r.warnings.some((w) => w.includes("ESTIMACIÓN"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariante 4: nunca un dato de otro cliente
// ---------------------------------------------------------------------------

describe("aislamiento entre clientes", () => {
  it("el mensaje de un cliente no menciona la deuda de otro", () => {
    const cc = cuenta([
      factura({ id: 1, numero: 1001, total: 10_000 }),
      factura({
        id: 2,
        numero: 2002,
        total: 77_777,
        cliente: { documento: RUT_B, razon_social: "OTRA SRL" },
      }),
    ]);
    const r = construirRecordatorio(cc, RUT_A);
    expect(r.mensaje).toContain("A-1001");
    expect(r.mensaje).not.toContain("2002");
    expect(r.mensaje).not.toContain("OTRA SRL");
    expect(r.mensaje).not.toContain("77.777");
    expect(r.total_reclamado_por_moneda["UYU"]).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Invariantes 1 y 2: allowlist y ciclo de confirmación
// ---------------------------------------------------------------------------

describe("la tool: allowlist", () => {
  it("un destinatario bloqueado no genera NI UNA llamada de red", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    const res = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: BLOQUEADO },
      fx.ctx,
    );

    expect(res.isError).toBe(true);
    expect(errorOf(res).message).toContain("KAPSO_DESTINATARIOS_PERMITIDOS");
    expect(llamadas).toHaveLength(0);
    // Y tampoco se consultó la deuda: no se trae a memoria lo que no se va a usar.
    expect(fx.getMock).not.toHaveBeenCalled();
  });

  it("sin Kapso configurado devuelve error de configuración, no de red", async () => {
    const fx = makeCtx({ response: [factura()] });
    const res = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(errorOf(res).kind).toBe("config");
  });
});

describe("la tool: dry-run y confirmación", () => {
  it("el dry-run devuelve el texto y un token, y NO manda nada", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    const res = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO },
      fx.ctx,
    );

    expect(sc(res).enviado).toBe(false);
    expect(sc(res).dry_run).toBe(true);
    expect(String(sc(res).mensaje)).toContain("e-Factura A-1001");
    expect(String(sc(res).confirmation_token)).toMatch(/^\d+\./);
    expect(llamadas).toHaveLength(0);
  });

  it("confirm sin token no manda nada", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    const res = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO, confirm: true },
      fx.ctx,
    );

    expect(res.isError).toBe(true);
    expect(errorOf(res).message).toContain("confirmation_token");
    expect(llamadas).toHaveLength(0);
  });

  it("con el token del dry-run sí manda, y el cuerpo lleva el texto exacto", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    const previo = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO },
      fx.ctx,
    );
    const token = String(sc(previo).confirmation_token);

    const res = await handleRecordatorioCobro(
      {
        cliente_rut: RUT_A,
        destinatario: PERMITIDO,
        confirm: true,
        confirmation_token: token,
      },
      fx.ctx,
    );

    expect(sc(res).enviado).toBe(true);
    expect(sc(res).message_id).toBe("wamid.ABC");
    expect(llamadas).toHaveLength(1);
    const body = JSON.parse(String(llamadas[0]!.init.body)) as Record<string, any>;
    expect(body.to).toBe(PERMITIDO);
    expect(body.text.body).toBe(sc(previo).mensaje);
  });

  it("si el saldo cambió entre el preview y la confirmación, el token deja de valer", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);

    let comprobantes: Array<Record<string, unknown>> = [factura()];
    const fx = makeCtx({
      config: { kapso: kapsoConfig() },
      impl: () => comprobantes,
    });

    const previo = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO },
      fx.ctx,
    );
    const token = String(sc(previo).confirmation_token);

    // Entró un cobro parcial después del preview.
    comprobantes = [
      factura(),
      factura({
        id: 2,
        serie: "R",
        numero: 5,
        total: 4000,
        indicador_cobranza_propia: 1,
        fecha_vencimiento: null,
        items: [{ concepto: "e-Factura A-1001", cantidad: 1, precio: 4000 }],
      }),
    ];

    const res = await handleRecordatorioCobro(
      {
        cliente_rut: RUT_A,
        destinatario: PERMITIDO,
        confirm: true,
        confirmation_token: token,
      },
      fx.ctx,
    );

    expect(res.isError).toBe(true);
    expect(errorOf(res).message).toContain("el saldo cambió");
    expect(llamadas).toHaveLength(0);
  });
});

describe("la tool: no dos veces el mismo día", () => {
  async function mandar(fx: ReturnType<typeof makeCtx>, extra: Record<string, unknown> = {}) {
    const previo = await handleRecordatorioCobro(
      { cliente_rut: RUT_A, destinatario: PERMITIDO },
      fx.ctx,
    );
    return handleRecordatorioCobro(
      {
        cliente_rut: RUT_A,
        destinatario: PERMITIDO,
        confirm: true,
        confirmation_token: String(sc(previo).confirmation_token),
        ...extra,
      },
      fx.ctx,
    );
  }

  it("el segundo recordatorio del día se rechaza", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    expect(sc(await mandar(fx)).enviado).toBe(true);
    const segundo = await mandar(fx);

    expect(segundo.isError).toBe(true);
    expect(errorOf(segundo).message).toContain("permitir_reenvio");
    expect(llamadas).toHaveLength(1);
  });

  it("con permitir_reenvio se puede insistir", async () => {
    const { fn, llamadas } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const fx = makeCtx({ config: { kapso: kapsoConfig() }, response: [factura()] });

    await mandar(fx);
    const segundo = await mandar(fx, { permitir_reenvio: true });

    expect(sc(segundo).enviado).toBe(true);
    expect(llamadas).toHaveLength(2);
  });
});
