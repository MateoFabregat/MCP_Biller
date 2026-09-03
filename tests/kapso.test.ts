// =============================================================================
// Integración Kapso: allowlist de destinatarios y armado del digest.
//
// El riesgo de esta capa no es que falle un envío: es que un envío SALGA al
// número equivocado. Estos mensajes llevan montos, RUTs y nombres de clientes.
// La mitad de estos tests son sobre eso.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import {
  KapsoClient,
  KapsoDestinatarioBloqueadoError,
  MAX_MENSAJE_CHARS,
} from "../src/kapso/client.js";
import { normalizarTelefono, parseDestinatarios } from "../src/config.js";
import { construirDigest } from "../src/services/digest.js";
import type { KapsoConfig } from "../src/config.js";
import type { AlertasResultado } from "../src/services/alertas.js";
import type { VencimientosResultado } from "../src/services/vencimientos.js";

const API_KEY = "kapso_key_secretisima";

function kapsoConfig(over: Partial<KapsoConfig> = {}): KapsoConfig {
  return {
    apiKey: API_KEY,
    baseUrl: "https://api.kapso.ai",
    phoneNumberId: "110987654321",
    destinatariosPermitidos: ["59899123456"],
    ...over,
  };
}

/** fetch falso que registra la llamada y devuelve una respuesta OK de Kapso. */
function fakeFetch(status = 200, body = '{"messages":[{"id":"wamid.ABC"}]}') {
  return vi.fn(async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("normalización de teléfonos", () => {
  it("deja solo dígitos", () => {
    expect(normalizarTelefono("+598 99 123 456")).toBe("59899123456");
    expect(normalizarTelefono("(598) 99-123-456")).toBe("59899123456");
  });

  it("parsea la allowlist separada por comas y normaliza cada entrada", () => {
    expect(parseDestinatarios("+598 99 123 456, 59899999999")).toEqual([
      "59899123456",
      "59899999999",
    ]);
  });

  it("una allowlist vacía o ausente da lista vacía, no undefined", () => {
    expect(parseDestinatarios(undefined)).toEqual([]);
    expect(parseDestinatarios("")).toEqual([]);
    expect(parseDestinatarios("  ,  ")).toEqual([]);
  });
});

describe("allowlist de destinatarios", () => {
  it("envía a un número habilitado", async () => {
    const impl = fakeFetch();
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    const r = await client.enviar("59899123456", "hola");
    expect(r.message_id).toBe("wamid.ABC");
    expect(impl).toHaveBeenCalledOnce();
  });

  it("BLOQUEA un número que no está en la allowlist", async () => {
    const impl = fakeFetch();
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    await expect(client.enviar("59899000000", "hola")).rejects.toBeInstanceOf(
      KapsoDestinatarioBloqueadoError,
    );
  });

  it("un destinatario bloqueado NO genera ninguna llamada de red", async () => {
    // Importa: el chequeo va antes de armar la request, así que ni siquiera se
    // revela el intento hacia afuera.
    const impl = fakeFetch();
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    await expect(client.enviar("59899000000", "hola")).rejects.toThrow();
    expect(impl).not.toHaveBeenCalled();
  });

  it("con la allowlist vacía no se puede enviar a nadie", async () => {
    const client = new KapsoClient(kapsoConfig({ destinatariosPermitidos: [] }), {
      fetchImpl: fakeFetch(),
    });
    await expect(client.enviar("59899123456", "hola")).rejects.toBeInstanceOf(
      KapsoDestinatarioBloqueadoError,
    );
  });

  it("un dígito de más ya no coincide", async () => {
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: fakeFetch() });
    await expect(client.enviar("598991234567", "hola")).rejects.toThrow();
  });
});

describe("request a Kapso", () => {
  it("usa el endpoint, el header y el cuerpo documentados", async () => {
    const impl = fakeFetch();
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    await client.enviar("59899123456", "mensaje de prueba");

    const [url, init] = (impl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]! as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/110987654321/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "59899123456",
      type: "text",
      text: { body: "mensaje de prueba" },
    });
  });

  it("trunca mensajes que exceden el límite de WhatsApp", async () => {
    const impl = fakeFetch();
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    const r = await client.enviar("59899123456", "x".repeat(MAX_MENSAJE_CHARS * 2));
    expect(r.caracteres).toBe(MAX_MENSAJE_CHARS);
  });

  it("falla claro si no hay phone_number_id", async () => {
    const client = new KapsoClient(kapsoConfig({ phoneNumberId: undefined }), {
      fetchImpl: fakeFetch(),
    });
    await expect(client.enviar("59899123456", "hola")).rejects.toThrow(/KAPSO_PHONE_NUMBER_ID/);
  });

  it("un error de Kapso no filtra la API key en el mensaje", async () => {
    const impl = fakeFetch(401, `{"error":"invalid key ${API_KEY}"}`);
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: impl });
    await expect(client.enviar("59899123456", "hola")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(API_KEY) }) as Error,
    );
  });

  it("una respuesta 2xx sin JSON no rompe: el envío salió igual", async () => {
    const client = new KapsoClient(kapsoConfig(), { fetchImpl: fakeFetch(200, "OK") });
    const r = await client.enviar("59899123456", "hola");
    expect(r.message_id).toBeNull();
  });

  it("corta una respuesta de Kapso que supera el límite seguro", async () => {
    const client = new KapsoClient(kapsoConfig(), {
      fetchImpl: fakeFetch(200, "x".repeat(1024 * 1024 + 1)),
    });
    await expect(client.enviar("59899123456", "respuesta grande")).rejects.toThrow(
      /se cortó la respuesta/,
    );
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function alertas(over: Partial<AlertasResultado> = {}): AlertasResultado {
  return {
    alertas: [],
    rechazos: { conteo_total: 0, por_estado: [] },
    cae: [],
    conteo_por_severidad: { critica: 0, advertencia: 0, info: 0 },
    comprobantes_analizados: 0,
    warnings: [],
    ...over,
  } as AlertasResultado;
}

function vencimientos(over: Partial<VencimientosResultado> = {}): VencimientosResultado {
  return {
    facturas: [],
    resumen_por_bucket: [],
    por_cliente: [],
    totales_por_moneda: {},
    vencido_por_moneda: {},
    por_vencer_por_moneda: {},
    conteo_analizados: 0,
    conteo_incluidos: 0,
    excluidos: {
      sin_fecha_vencimiento: 0,
      contado: 0,
      no_aceptados: 0,
      no_cobrable: 0,
      fuera_de_rango: 0,
      sin_datos_minimos: 0,
    },
    warnings: [],
    no_convertir_moneda: true,
    ...over,
  } as VencimientosResultado;
}

describe("digest operativo", () => {
  it("cuando no hay nada que atender lo dice en una línea", () => {
    const d = construirDigest({ fecha: "2026-07-27", alertas: alertas(), vencimientos: vencimientos() });
    expect(d.requiere_atencion).toBe(false);
    expect(d.items_accionables).toBe(0);
    expect(d.texto).toContain("Sin alertas ni vencimientos");
  });

  it("lo crítico va ANTES que lo demás", () => {
    const d = construirDigest({
      fecha: "2026-07-27",
      alertas: alertas({
        alertas: [
          {
            tipo: "cae_por_agotarse",
            severidad: "advertencia",
            titulo: "CAE por agotarse",
            detalle: "quedan 50",
            cantidad: 1,
            datos: {},
          },
          {
            tipo: "cae_vencido",
            severidad: "critica",
            titulo: "CAE vencido",
            detalle: "serie A vencida",
            cantidad: 1,
            datos: {},
          },
        ],
      } as Partial<AlertasResultado>),
      vencimientos: vencimientos(),
    });
    expect(d.texto.indexOf("CAE vencido")).toBeLessThan(d.texto.indexOf("CAE por agotarse"));
    expect(d.secciones[0]).toBe("critico");
    expect(d.requiere_atencion).toBe(true);
  });

  it("informa el vencido y el por vencer sin convertir monedas", () => {
    const d = construirDigest({
      fecha: "2026-07-27",
      alertas: alertas(),
      vencimientos: vencimientos({
        vencido_por_moneda: { UYU: { total: 120_000, comprobantes: 3 } },
        por_vencer_por_moneda: { USD: { total: 500, comprobantes: 1 } },
      }),
    });
    expect(d.texto).toContain("$120.000");
    expect(d.texto).toContain("US$500");
    expect(d.requiere_atencion).toBe(true);
  });

  it("el 'por vencer' solo no cuenta como accionable", () => {
    // Una factura que vence en cinco días es información; una vencida es deuda.
    const d = construirDigest({
      fecha: "2026-07-27",
      alertas: alertas(),
      vencimientos: vencimientos({ por_vencer_por_moneda: { UYU: { total: 500, comprobantes: 1 } } }),
    });
    expect(d.items_accionables).toBe(0);
    expect(d.texto).toContain("Por vencer");
  });

  it("corta las secciones largas en vez de mandar una pared de texto", () => {
    const muchas = Array.from({ length: 12 }, (_, i) => ({
      tipo: "rechazo_dgi" as const,
      severidad: "critica" as const,
      titulo: `Alerta ${i}`,
      detalle: "detalle",
      cantidad: 1,
      datos: {},
    }));
    const d = construirDigest({
      fecha: "2026-07-27",
      alertas: alertas({ alertas: muchas } as Partial<AlertasResultado>),
      vencimientos: vencimientos(),
    });
    expect(d.texto).toContain("y 7 más");
    expect(d.items_accionables).toBe(12);
  });

  it("entra cómodo en un mensaje de WhatsApp", () => {
    const muchas = Array.from({ length: 40 }, (_, i) => ({
      tipo: "rechazo_dgi" as const,
      severidad: "critica" as const,
      titulo: `Alerta larguísima número ${i} con mucho texto de relleno`,
      detalle: "x".repeat(200),
      cantidad: 1,
      datos: {},
    }));
    const d = construirDigest({
      fecha: "2026-07-27",
      alertas: alertas({ alertas: muchas } as Partial<AlertasResultado>),
      vencimientos: vencimientos(),
    });
    expect(d.texto.length).toBeLessThan(MAX_MENSAJE_CHARS);
  });
});
