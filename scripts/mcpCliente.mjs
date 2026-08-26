// =============================================================================
// Un cliente MCP mínimo, en JS plano, para hablarle al server como le habla
// Kapso: HTTP + Streamable HTTP, con sesión y respuestas en SSE.
//
// POR QUÉ NO SE USA EL SDK. El SDK es el cliente CORRECTO, y por eso mismo no
// sirve acá: absorbe las diferencias de transporte que justamente queremos ver.
// Si Kapso falla porque el server contesta `text/event-stream` donde el cliente
// esperaba JSON, o porque el `mcp-session-id` no vuelve, el SDK lo resuelve solo
// y el simulador dice "anda" mientras el número real sigue mudo. Este cliente es
// deliberadamente literal: manda lo que manda Kapso y lee lo que vuelve.
// =============================================================================

/** Extrae el JSON de una respuesta que puede venir plana o como stream SSE. */
export function leerCuerpoMcp(texto) {
  if (texto.trimStart().startsWith("{")) return JSON.parse(texto);
  const datos = texto
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  if (datos === "") throw new Error(`Respuesta sin JSON ni SSE: ${texto.slice(0, 200)}`);
  return JSON.parse(datos);
}

export class ClienteMcp {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.sesion = null;
    this.siguienteId = 1;
  }

  async #enviar(method, params, conId) {
    const headers = {
      "content-type": "application/json",
      // Kapso manda los dos: el server puede elegir contestar en cualquiera.
      accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sesion !== null) headers["mcp-session-id"] = this.sesion;

    const cuerpo = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
      ...(conId ? { id: this.siguienteId++ } : {}),
    };

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
    });

    const sesion = res.headers.get("mcp-session-id");
    if (sesion !== null) this.sesion = sesion;

    const texto = await res.text();
    if (!conId) return { status: res.status, json: null };
    if (!res.ok) {
      return { status: res.status, json: null, crudo: texto.slice(0, 400) };
    }
    return { status: res.status, json: leerCuerpoMcp(texto) };
  }

  /** Handshake completo. Devuelve el serverInfo o tira con el motivo real. */
  async conectar() {
    const r = await this.#enviar(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "simulador-whatsapp", version: "1.0" },
      },
      true,
    );
    if (r.json === null) {
      throw new Error(`initialize → HTTP ${r.status}: ${r.crudo ?? "(sin cuerpo)"}`);
    }
    if (r.json.error !== undefined) {
      throw new Error(`initialize → ${JSON.stringify(r.json.error)}`);
    }
    // Sin esta notificación el server queda esperando y el primer tools/list
    // puede fallar. Kapso la manda; el simulador también.
    await this.#enviar("notifications/initialized", undefined, false);
    return r.json.result;
  }

  async listarTools() {
    const r = await this.#enviar("tools/list", {}, true);
    if (r.json === null) throw new Error(`tools/list → HTTP ${r.status}: ${r.crudo ?? ""}`);
    if (r.json.error !== undefined) throw new Error(`tools/list → ${JSON.stringify(r.json.error)}`);
    return r.json.result.tools ?? [];
  }

  /**
   * Llama una tool. NO tira ante un error de la tool: lo devuelve.
   *
   * La distinción importa para el simulador: que una tool conteste "no hay
   * comprobantes en ese período" es un ÉXITO del canal —viajó, se ejecutó,
   * contestó—, y que el transporte se caiga es otra cosa. Confundirlas hace que
   * el reporte marque en rojo cosas que andan.
   */
  async llamar(nombre, argumentos) {
    try {
      const r = await this.#enviar("tools/call", { name: nombre, arguments: argumentos ?? {} }, true);
      if (r.json === null) {
        return { ok: false, capa: "transporte", detalle: `HTTP ${r.status}: ${r.crudo ?? ""}` };
      }
      if (r.json.error !== undefined) {
        return { ok: false, capa: "protocolo", detalle: JSON.stringify(r.json.error).slice(0, 300) };
      }
      const res = r.json.result ?? {};
      const texto = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { ok: res.isError !== true, capa: "tool", texto, isError: res.isError === true };
    } catch (err) {
      return { ok: false, capa: "red", detalle: err instanceof Error ? err.message : String(err) };
    }
  }
}
