// =============================================================================
// C8 — Webhook de Kapso.
//
// Es la única puerta por la que entra un POST de afuera, así que casi todo lo
// que se prueba acá es qué NO pasa:
//   · sin secreto configurado, la ruta no existe (404, no 403);
//   · con firma inválida no se procesa nada;
//   · un `from` que no está en la allowlist se descarta SIN contestar;
//   · el webhook nunca decide ejecutar algo que toque plata.
// =============================================================================

import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { iniciarTransporteHttp, WEBHOOK_PATH } from "../src/transport/http.js";
import {
  decidirWebhook,
  firmar,
  firmaValida,
  normalizarEvento,
} from "../src/kapso/webhook.js";
import { crearServidorMcp } from "../src/server.js";
import { createToolContext } from "../src/tools/register.js";
import { makeConfig } from "./fixtures.js";
import type { BillerConfig, KapsoConfig } from "../src/config.js";

const SECRETO = "webhook-secreto-de-kapso";
const AUTORIZADO = "59895923567";
const DESCONOCIDO = "59899000111";

function kapsoConfig(over: Partial<KapsoConfig> = {}): KapsoConfig {
  return {
    apiKey: "kapso_key",
    baseUrl: "https://api.kapso.ai",
    phoneNumberId: "597907523413541",
    destinatariosPermitidos: [AUTORIZADO],
    webhookSecret: SECRETO,
    ...over,
  };
}

/** Payload con la forma real de la Cloud API para un mensaje de texto. */
function eventoTexto(body: string, from = AUTORIZADO): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "598...", phone_number_id: "5979075" },
              contacts: [{ profile: { name: "Mateo" }, wa_id: from }],
              messages: [
                { from, id: "wamid.HBg", timestamp: "1780000000", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function eventoBoton(id: string, from = AUTORIZADO): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: "Mateo" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: "wamid.BTN",
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { id, title: "✅ Emitir" } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

describe("firma HMAC", () => {
  const cuerpo = '{"hola":"mundo"}';

  it("acepta la firma correcta, con y sin prefijo sha256=", () => {
    const firma = firmar(cuerpo, SECRETO);
    expect(firmaValida(cuerpo, firma, SECRETO)).toBe(true);
    expect(firmaValida(cuerpo, firma.replace("sha256=", ""), SECRETO)).toBe(true);
  });

  it("rechaza otro secreto, otro cuerpo, o ninguna firma", () => {
    const firma = firmar(cuerpo, SECRETO);
    expect(firmaValida(cuerpo, firma, "otro-secreto")).toBe(false);
    expect(firmaValida('{"hola":"otro"}', firma, SECRETO)).toBe(false);
    expect(firmaValida(cuerpo, undefined, SECRETO)).toBe(false);
    expect(firmaValida(cuerpo, "", SECRETO)).toBe(false);
  });

  it("rechaza una firma con formato inválido sin explotar", () => {
    expect(firmaValida(cuerpo, "sha256=no-es-hex", SECRETO)).toBe(false);
    expect(firmaValida(cuerpo, "sha256=abc", SECRETO)).toBe(false);
  });

  it("un byte cambiado en el cuerpo invalida la firma", () => {
    const firma = firmar(cuerpo, SECRETO);
    expect(firmaValida(`${cuerpo} `, firma, SECRETO)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normalización del payload
// ---------------------------------------------------------------------------

describe("normalización del evento", () => {
  it("lee un mensaje de texto", () => {
    const e = normalizarEvento(eventoTexto("¿cuánto facturé este mes?"));
    expect(e.tipo).toBe("texto");
    expect(e.from).toBe(AUTORIZADO);
    expect(e.texto).toBe("¿cuánto facturé este mes?");
    expect(e.message_id).toBe("wamid.HBg");
    expect(e.perfil).toBe("Mateo");
  });

  it("de un botón lee el ID, no el título", () => {
    const e = normalizarEvento(eventoBoton("menu:cobranzas"));
    expect(e.tipo).toBe("boton");
    expect(e.texto).toBe("menu:cobranzas");
  });

  it("reconoce un acuse de entrega y no lo confunde con un mensaje", () => {
    const e = normalizarEvento({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    });
    expect(e.tipo).toBe("estado");
  });

  it("un tipo que no sabemos leer no rompe", () => {
    const e = normalizarEvento({
      entry: [
        {
          changes: [
            { value: { messages: [{ from: AUTORIZADO, id: "w", type: "audio", audio: {} }] } },
          ],
        },
      ],
    });
    expect(e.tipo).toBe("no_soportado");
    expect(e.from).toBe(AUTORIZADO);
  });

  it("basura no rompe", () => {
    for (const basura of [null, undefined, 42, "texto", {}, { entry: [] }, { entry: [{}] }]) {
      expect(() => normalizarEvento(basura)).not.toThrow();
      expect(normalizarEvento(basura).tipo).toBe("no_soportado");
    }
  });
});

// ---------------------------------------------------------------------------
// Decisión de ruteo
// ---------------------------------------------------------------------------

describe("decisión de ruteo", () => {
  const opciones = { remitentesAutorizados: [AUTORIZADO], capabilityMode: "read_only" as const };

  it("un remitente desconocido se descarta sin contestar", () => {
    const d = decidirWebhook(normalizarEvento(eventoTexto("hola", DESCONOCIDO)), opciones);
    expect(d.accion).toBe("rechazar");
    if (d.accion === "rechazar") expect(d.motivo).toBe("no_autorizado");
  });

  it("sin allowlist se descarta TODO, incluso un remitente que parezca válido", () => {
    const d = decidirWebhook(normalizarEvento(eventoTexto("hola")), {
      remitentesAutorizados: [],
    });
    expect(d.accion).toBe("rechazar");
    if (d.accion === "rechazar") expect(d.motivo).toBe("sin_allowlist");
  });

  it("un saludo se contesta con el menú, sin tocar Biller", () => {
    const d = decidirWebhook(normalizarEvento(eventoTexto("hola")), opciones);
    expect(d.accion).toBe("responder");
    if (d.accion === "responder") {
      expect(d.interpretacion.via).toBe("saludo");
      expect(d.mostrar_menu).toBe(true);
    }
  });

  it("una pregunta concreta se DELEGA: el webhook no consulta ni emite", () => {
    const d = decidirWebhook(normalizarEvento(eventoTexto("quién me debe plata")), opciones);
    expect(d.accion).toBe("delegar");
    if (d.accion === "delegar") {
      expect(d.tools).toContain("biller_cuenta_corriente");
    }
  });

  it("una confirmación de emisión NUNCA se autorresponde", () => {
    const d = decidirWebhook(
      normalizarEvento(eventoBoton("emitir:si:1780000000.abc")),
      { ...opciones, capabilityMode: "write_enabled" },
    );
    // Delegar = se lo pasa al agente, que tiene al humano adelante. Un webhook
    // no tiene con quién confirmar un CFE.
    expect(d.accion).toBe("delegar");
    if (d.accion === "delegar") expect(d.interpretacion.via).toBe("emision_confirmada");
  });

  it("un acuse de entrega se ignora", () => {
    const d = decidirWebhook(
      normalizarEvento({ entry: [{ changes: [{ value: { statuses: [{ status: "read" }] } }] }] }),
      opciones,
    );
    expect(d.accion).toBe("ignorar");
  });

  it("un audio se ignora con un motivo legible, no con un error", () => {
    const d = decidirWebhook(
      normalizarEvento({
        entry: [{ changes: [{ value: { messages: [{ from: AUTORIZADO, type: "audio" }] } }] }],
      }),
      opciones,
    );
    expect(d.accion).toBe("ignorar");
    if (d.accion === "ignorar") expect(d.motivo).toContain("audio");
  });
});

// ---------------------------------------------------------------------------
// El endpoint HTTP
// ---------------------------------------------------------------------------

describe("el endpoint", () => {
  async function levantar(config: Partial<BillerConfig>) {
    const cfg = makeConfig({ httpAuthToken: "bearer-de-prueba", httpPort: 0, ...config });
    const handle = await iniciarTransporteHttp(cfg, () =>
      crearServidorMcp(createToolContext({}), "read_only"),
    );
    return { handle, url: `http://127.0.0.1:${handle.port}${WEBHOOK_PATH}` };
  }

  async function postear(
    url: string,
    payload: unknown,
    firma: string | undefined,
  ): Promise<{ status: number; body: any }> {
    const cuerpo = JSON.stringify(payload);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(firma === undefined ? {} : { "x-hub-signature-256": firma }),
      },
      body: cuerpo,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("sin KAPSO_WEBHOOK_SECRET la ruta no existe (404, no 403)", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig({ webhookSecret: undefined }) });
    try {
      const cuerpo = JSON.stringify(eventoTexto("hola"));
      const res = await postear(url, eventoTexto("hola"), firmar(cuerpo, SECRETO));
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it("sin Kapso configurado tampoco existe", async () => {
    const { handle, url } = await levantar({});
    try {
      const res = await postear(url, eventoTexto("hola"), undefined);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it("con firma inválida devuelve 401 y no procesa", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const res = await postear(url, eventoTexto("hola"), "sha256=" + "0".repeat(64));
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_signature");
    } finally {
      await handle.close();
    }
  });

  it("sin firma devuelve 401", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const res = await postear(url, eventoTexto("hola"), undefined);
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("con firma válida procesa y devuelve el ruteo", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const payload = eventoTexto("hola");
      const res = await postear(url, payload, firmar(JSON.stringify(payload), SECRETO));
      expect(res.status).toBe(200);
      expect(res.body.accion).toBe("responder");
      expect(res.body.via).toBe("saludo");
      expect(res.body.mostrar_menu).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("un remitente no autorizado devuelve 200 (no 403) y no dice nada de la empresa", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const payload = eventoTexto("cuánto facturé", DESCONOCIDO);
      const res = await postear(url, payload, firmar(JSON.stringify(payload), SECRETO));
      // 200 a propósito: un 403 le confirma a quien sondea que el número existe,
      // y además Meta reintentaría el mismo mensaje cinco veces.
      expect(res.status).toBe(200);
      expect(res.body.accion).toBe("rechazar");
      expect(res.body.motivo).toBe("no_autorizado");
      expect(res.body.respuesta_sugerida).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it("un mensaje con ñ/emoji partido entre chunks TCP igual valida la firma", async () => {
    // La regresión: acumular `chunk.toString("utf8")` decodifica cada chunk por
    // separado, y un carácter multibyte partido en el borde se vuelve U+FFFD.
    // El síntoma era firma inválida INTERMITENTE sobre mensajes legítimos —y lo
    // que hace cualquiera frente a "la firma anda a veces" es apagar la firma.
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const payload = eventoTexto("facturale a la Peña Ñandú 🇺🇾 por 2 cajones");
      const crudo = Buffer.from(JSON.stringify(payload), "utf8");
      const firma = firmar(crudo.toString("utf8"), SECRETO);

      // Se parte a propósito en un byte que cae en el MEDIO de un multibyte.
      const corte = crudo.indexOf(Buffer.from("Ñ", "utf8")) + 1;
      expect(corte).toBeGreaterThan(0);

      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const u = new URL(url);
        const req = request(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": firma,
              "content-length": crudo.length,
            },
          },
          (r) => {
            r.resume();
            r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.write(crudo.subarray(0, corte));
        // Un tick entre mitades fuerza dos eventos 'data' distintos.
        setTimeout(() => req.end(crudo.subarray(corte)), 10);
      });

      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("un GET al webhook no se procesa", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const res = await fetch(url);
      expect(res.status).toBe(405);
    } finally {
      await handle.close();
    }
  });

  it("un cuerpo que no es JSON se consume con 200, no con 500", async () => {
    const { handle, url } = await levantar({ kapso: kapsoConfig() });
    try {
      const crudo = "esto no es json";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": firmar(crudo, SECRETO),
        },
        body: crudo,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { procesado: boolean }).procesado).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("el endpoint MCP sigue exigiendo su bearer: el webhook no abre una puerta", async () => {
    const { handle } = await levantar({ kapso: kapsoConfig() });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});
