// =============================================================================
// Transporte HTTP (Streamable HTTP) del server MCP.
//
// PARA QUÉ EXISTE: los Agent Nodes de Kapso aceptan MCP servers externos
// (`flow_agent_mcp_servers`), pero por protección contra SSRF rechazan URLs que
// resuelven a localhost. Con stdio no hay forma de conectarlos. Este transporte
// es lo único que faltaba para que el dueño de una PyME pregunte "¿cuánto
// facturé este mes?" por WhatsApp y conteste el mismo código que ya contesta en
// Claude Desktop.
//
// POSTURA DE SEGURIDAD (el stdio no la necesitaba; esto sí):
//   - Bind a 127.0.0.1 por DEFECTO. Exponerlo a 0.0.0.0 es una decisión
//     explícita del operador, no algo que pase por descuido.
//   - Token propio obligatorio, distinto del de Biller (ver httpAuth.ts). Sin
//     token configurado, el server NO ARRANCA en modo http.
//   - Protección contra DNS rebinding activada.
//   - Sesión por conexión: cada cliente MCP tiene su propio transporte.
//   - El modo de capacidades sigue mandando: si el server está en `read_only`,
//     por HTTP tampoco hay tools de escritura.
//
// Nota sobre el despliegue: 127.0.0.1 + un túnel (o un reverse proxy con TLS)
// es la forma correcta de darle una URL pública a Kapso. Poner el proceso
// directamente en 0.0.0.0 sin TLS manda el bearer en texto plano.
// =============================================================================

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BillerConfig } from "../config.js";
import {
  HEADER_FIRMA,
  MAX_BODY_BYTES,
  decidirWebhook,
  firmaValida,
  normalizarEvento,
} from "../kapso/webhook.js";
import { logger } from "../logger.js";
import { enmascararTelefono, remitentesAutorizados } from "../security/remitentes.js";
import { autenticarConTenants } from "../tenants/acceso.js";
import type { RegistroTenants, Tenant } from "../tenants/registry.js";
import { conDialectoLimpio } from "./dialecto.js";

/** Ruta del endpoint MCP. Kapso apunta acá. */
export const MCP_PATH = "/mcp";
/** Ruta de liveness, SIN autenticación y sin datos. Para el orquestador. */
export const HEALTH_PATH = "/healthz";
/**
 * Ruta del webhook de Kapso (C8). SOLO EXISTE si hay `KAPSO_WEBHOOK_SECRET`.
 *
 * No usa el bearer del transporte: quien la llama es Kapso, no un cliente MCP, y
 * su credencial es la firma HMAC del cuerpo. Ver `kapso/webhook.ts`.
 */
export const WEBHOOK_PATH = "/kapso/webhook";

export interface HttpTransportHandle {
  /** Puerto realmente escuchado (útil cuando se pide 0 en los tests). */
  port: number;
  close: () => Promise<void>;
}

function responderJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // El contenido es contabilidad: que ningún intermediario lo cachee.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Error JSON-RPC, que es lo que un cliente MCP sabe interpretar. Devolver un
 * error HTTP "pelado" hace que el cliente reporte "conexión rota" en vez del
 * motivo real.
 */
function responderErrorRpc(res: ServerResponse, status: number, message: string): void {
  responderJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 || status === 403 ? -32001 : -32000, message },
    id: null,
  });
}

/** Registro vacío: modo de un solo tenant, que es el default. */
const SIN_TENANTS: RegistroTenants = { tenants: [], porToken: new Map() };

/**
 * Lee el cuerpo CRUDO con tope. La firma se calcula sobre estos bytes exactos.
 *
 * SE ACUMULAN BUFFERS Y SE DECODIFICA UNA SOLA VEZ AL FINAL, y eso no es estilo.
 * La versión anterior hacía `datos += chunk.toString("utf8")` por chunk, que
 * decodifica cada uno por separado — y un carácter multibyte partido en el
 * borde de un chunk TCP se convierte en U+FFFD de los dos lados. En castellano
 * eso no es un caso raro: alcanza una "ñ" o un emoji en el mensaje.
 *
 * El síntoma habría sido el peor posible para una barrera de seguridad: mensajes
 * legítimos fallando la verificación de firma DE FORMA INTERMITENTE, sin patrón
 * visible. Y el paso siguiente que da cualquiera frente a "la firma anda a
 * veces" es desactivar la firma.
 */
async function leerCuerpo(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const partes: Buffer[] = [];
    let bytes = 0;
    let cortado = false;
    req.on("data", (chunk: Buffer) => {
      if (cortado) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cortado = true;
        resolve(null);
        return;
      }
      partes.push(chunk);
    });
    req.on("end", () => {
      if (!cortado) resolve(Buffer.concat(partes).toString("utf8"));
    });
    req.on("error", () => {
      if (!cortado) resolve(null);
    });
  });
}

/**
 * Atiende el webhook de Kapso.
 *
 * SIEMPRE responde 200 salvo que la firma falle. No es descuido: Meta reintenta
 * ante cualquier no-2xx y termina desactivando la suscripción, así que un evento
 * que no sabemos leer tiene que consumirse con un 200 y un motivo, no con un
 * error. La firma es la única excepción porque ahí NO hay evento válido que
 * consumir: lo que llegó no viene de Kapso.
 *
 * Lo que la decisión diga que hay que "delegar" no se ejecuta acá. Este endpoint
 * no llama a Biller ni emite nada: devuelve el ruteo para que lo tome el agente,
 * que es el que tiene al humano adelante.
 */
async function atenderWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: BillerConfig,
): Promise<void> {
  const secreto = config.kapso?.webhookSecret;
  if (secreto === undefined) {
    // 404, no 403: sin secreto la ruta directamente no existe, y decir "existe
    // pero no autorizado" es contarle a quien sondea que este server tiene un
    // webhook para atacar.
    responderJson(res, 404, { error: "not_found" });
    return;
  }

  if (req.method !== "POST") {
    responderJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const crudo = await leerCuerpo(req, MAX_BODY_BYTES);
  if (crudo === null) {
    responderJson(res, 413, { error: "payload_too_large" });
    return;
  }

  const firma = req.headers[HEADER_FIRMA];
  if (!firmaValida(crudo, Array.isArray(firma) ? firma[0] : firma, secreto)) {
    logger.warn("kapso.webhook.firma_invalida", { bytes: crudo.length });
    responderJson(res, 401, { error: "invalid_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(crudo);
  } catch {
    responderJson(res, 200, { procesado: false, motivo: "cuerpo no es JSON" });
    return;
  }

  const evento = normalizarEvento(payload);
  const decision = decidirWebhook(evento, {
    capabilityMode: config.capabilityMode,
    remitentesAutorizados: remitentesAutorizados(config),
  });

  // El log lleva el HECHO, nunca el texto: un mensaje entrante puede tener
  // montos, nombres y —si el que escribe quiere— un intento de inyección.
  logger.info("kapso.webhook.evento", {
    tipo: evento.tipo,
    accion: decision.accion,
    remitente: evento.from === null ? null : enmascararTelefono(evento.from),
    via: "interpretacion" in decision ? decision.interpretacion.via : undefined,
  });

  responderJson(res, 200, {
    procesado: decision.accion !== "ignorar",
    accion: decision.accion,
    ...(decision.accion === "rechazar" ? { motivo: decision.motivo } : {}),
    ...(decision.accion === "ignorar" ? { motivo: decision.motivo } : {}),
    ...("interpretacion" in decision
      ? {
          via: decision.interpretacion.via,
          opcion: decision.interpretacion.opcion?.id ?? null,
          tools: "tools" in decision ? decision.tools : [],
          mostrar_menu: decision.interpretacion.mostrar_menu,
          respuesta_sugerida: decision.interpretacion.respuesta_sugerida ?? null,
        }
      : {}),
  });
}

/**
 * Arranca el server MCP sobre HTTP.
 *
 * `crearServidorMcp` se invoca UNA VEZ POR SESIÓN: cada cliente necesita su
 * propia instancia de McpServer + transporte. Compartir una sola instancia
 * entre conexiones mezcla el estado de sesión de clientes distintos.
 *
 * Recibe el TENANT de la request (null en modo de una sola empresa) porque la
 * empresa se decide en la autenticación, no antes: el token es a la vez la
 * credencial y el selector. Ver `src/tenants/acceso.ts`.
 *
 * OJO CON LA SESIÓN: el `mcp-session-id` queda ligado al server que se creó con
 * el token de la primera request. Una sesión no cambia de empresa a mitad de
 * camino, que es lo correcto — pero significa que el token que importa es el de
 * la request que ABRE la sesión.
 */
export async function iniciarTransporteHttp(
  config: BillerConfig,
  crearServidorMcp: (tenant: Tenant | null) => McpServer,
  registro: RegistroTenants = SIN_TENANTS,
): Promise<HttpTransportHandle> {
  const sesiones = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Liveness: sin auth y sin ningún dato del negocio.
      if (url.pathname === HEALTH_PATH) {
        responderJson(res, 200, { status: "ok", transport: "http" });
        return;
      }

      // El webhook va ANTES de la autenticación bearer: su credencial es otra
      // (la firma HMAC del cuerpo) porque quien llama es Kapso, no un cliente
      // MCP. Meterlo detrás del bearer significaría ponerle nuestro token a un
      // tercero, que es exactamente lo que la firma evita.
      if (url.pathname === WEBHOOK_PATH) {
        await atenderWebhook(req, res, config);
        return;
      }

      if (url.pathname !== MCP_PATH) {
        responderErrorRpc(res, 404, `Ruta no encontrada. El endpoint MCP es ${MCP_PATH}.`);
        return;
      }

      const auth = autenticarConTenants(req, config.httpAuthToken, registro);
      if (!auth.ok) {
        // No se loguea el token presentado, ni siquiera un prefijo.
        logger.warn("http.auth.rechazado", { status: auth.status, path: url.pathname });
        res.setHeader("www-authenticate", 'Bearer realm="biller-mcp"');
        responderErrorRpc(res, auth.status, auth.message);
        return;
      }

      try {
        const sessionId = req.headers["mcp-session-id"];
        const sessionIdRaw = Array.isArray(sessionId) ? sessionId[0] : sessionId;

        // LA CLAVE DE SESIÓN LLEVA EL TENANT ADELANTE.
        //
        // Sin eso, el mapa se indexa solo por el `mcp-session-id` que manda el
        // cliente, y un tenant autenticado que presente el id de sesión de OTRO
        // recibe el server de ese otro — o sea, la contabilidad de otra empresa,
        // con su propio token válido en la mano.
        //
        // El id es un UUID aleatorio, así que adivinarlo no es viable; pero
        // aparece en headers, en trazas y en cualquier log de proxy, y "es
        // difícil de adivinar" no es el mismo argumento que "no sirve aunque lo
        // tengas". Esto último cuesta una interpolación.
        const sessionKey =
          sessionIdRaw === undefined ? undefined : `${auth.tenant?.id ?? "-"}:${sessionIdRaw}`;

        let transport = sessionKey !== undefined ? sesiones.get(sessionKey) : undefined;

        if (transport === undefined) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sesiones.set(`${auth.tenant?.id ?? "-"}:${id}`, transport!);
              logger.info("http.sesion.abierta", { sesiones_activas: sesiones.size });
            },
            onsessionclosed: (id) => {
              sesiones.delete(`${auth.tenant?.id ?? "-"}:${id}`); // check-readonly:allow Map.delete sobre sesiones en memoria, no es HTTP
              logger.info("http.sesion.cerrada", { sesiones_activas: sesiones.size });
            },
            // Sin esto, un sitio malicioso en el navegador del operador puede
            // hablarle a 127.0.0.1 vía DNS rebinding.
            enableDnsRebindingProtection: true,
            // Detrás de un túnel o un dominio propio, el `Host` que llega es el
            // PÚBLICO, no el de escucha: sin declararlo, Kapso recibe
            // "Invalid Host header" antes de que se ejecute ninguna tool. Se
            // declara el nombre en vez de apagar la protección — apagarla vale
            // para cualquier atacante; declarar un nombre vale para ese nombre.
            // El host público puede venir con o sin puerto según el proxy.
            allowedHosts: [
              `${config.httpHost}:${config.httpPort}`,
              `localhost:${config.httpPort}`,
              `127.0.0.1:${config.httpPort}`,
              ...config.httpAllowedHosts.flatMap((h) => [h, `${h}:443`, `${h}:${config.httpPort}`]),
            ],
          });

          const server = crearServidorMcp(auth.tenant);
          await server.connect(
            conDialectoLimpio(transport, { quitarOutputSchema: config.wireLiviano }),
          );
        }

        await transport.handleRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("http.request.error", { message });
        if (!res.headersSent) {
          responderErrorRpc(res, 500, "Error interno del transporte HTTP.");
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const direccion = httpServer.address();
  const puerto = typeof direccion === "object" && direccion !== null ? direccion.port : config.httpPort;

  return {
    port: puerto,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of sesiones.values()) void t.close();
        sesiones.clear();
        httpServer.close(() => resolve());
      }),
  };
}
