// =============================================================================
// Handler del MCP para entornos SERVERLESS (Vercel).
//
// LA DIFERENCIA QUE IMPORTA: en Vercel cada request puede caer en una instancia
// distinta, y el proceso se congela o se destruye entre invocaciones. Nada de
// lo que viva en memoria sobrevive de forma confiable.
//
// Consecuencia directa: el modo con sesión del Streamable HTTP NO FUNCIONA acá.
// El `mcp-session-id` que devuelve una instancia no lo conoce la siguiente, y
// el cliente recibe 404 en la segunda llamada. Por eso este handler usa
// **modo stateless** (`sessionIdGenerator: undefined`): server y transporte
// nuevos por request, sin estado compartido.
//
// Eso es correcto para el uso de Kapso —preguntas independientes tipo
// "¿cuánto facturé este mes?"— y es la razón por la que la integración funciona
// igual sin sesión.
//
// LO QUE SE PIERDE, dicho explícitamente porque afecta a la seguridad:
//
//   · IDEMPOTENCIA. `IdempotencyStore` es en memoria: en serverless no protege
//     contra una doble ejecución. Por eso `resolverCapabilityModeServerless`
//     fuerza `read_only` salvo que alguien lo desactive a mano sabiendo esto.
//   · AUDIT LOG A ARCHIVO. El filesystem de Vercel es de solo lectura (excepto
//     /tmp, que es efímero). El audit sigue yendo a stderr, que Vercel captura
//     en sus logs, pero `BILLER_AUDIT_LOG_PATH` no sirve.
//   · RATE LIMITING. Los limitadores son por proceso: con N instancias en
//     paralelo, el límite efectivo es N veces mayor que el configurado.
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type BillerCapabilityMode } from "../config.js";
import { logger } from "../logger.js";
import { crearServidorMcp } from "../server.js";
import { autenticarConTenants } from "../tenants/acceso.js";
import { cargarTenants, entornoDe } from "../tenants/registry.js";
import { createToolContext } from "../tools/register.js";
import { conDialectoLimpio } from "./dialecto.js";

/**
 * Decide el modo de capacidades en serverless.
 *
 * La escritura emite comprobantes IRREVERSIBLES ante DGI, y su protección
 * contra duplicados (idempotencia) es un Map en memoria que en serverless no
 * sobrevive entre invocaciones. Un reintento de red —que en serverless es
 * normal, no excepcional— podría emitir dos veces la misma factura.
 *
 * Por eso acá el default NO es el de la config: es `read_only`, y habilitar
 * escritura requiere una variable extra cuyo nombre dice lo que estás
 * aceptando.
 */
export function resolverCapabilityModeServerless(
  configurado: BillerCapabilityMode,
  env: Record<string, string | undefined>,
): { modo: BillerCapabilityMode; degradado: boolean } {
  const forzado =
    (env.BILLER_SERVERLESS_ALLOW_WRITES ?? "").trim().toLowerCase() === "true";

  if (configurado === "write_enabled" && !forzado) {
    return { modo: "read_only", degradado: true };
  }
  return { modo: configurado, degradado: false };
}

function responderErrorRpc(res: ServerResponse, status: number, message: string): void {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: status === 401 || status === 403 ? -32001 : -32000, message },
    id: null,
  });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Atiende una request MCP en serverless.
 *
 * `parsedBody` viene ya parseado por la plataforma (Vercel lo hace); si no
 * viene, el transporte lee el stream.
 */
export async function manejarRequestServerless(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  // El registro se lee en cada invocación a propósito: en serverless no hay un
  // arranque donde cachearlo, y un registro mal formado tiene que fallar con su
  // propio mensaje y no como "token inválido".
  let registro;
  try {
    registro = cargarTenants(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    responderErrorRpc(res, 500, `Registro de empresas inválido: ${message}`);
    return;
  }

  const auth = autenticarConTenants(req, process.env.BILLER_HTTP_AUTH_TOKEN, registro);
  if (!auth.ok) {
    logger.warn("serverless.auth.rechazado", { status: auth.status });
    res.setHeader("www-authenticate", 'Bearer realm="biller-mcp"');
    responderErrorRpc(res, auth.status, auth.message);
    return;
  }

  // El entorno efectivo: el del proceso, con el overlay del tenant encima. En
  // modo de un solo tenant es literalmente `process.env`.
  const entorno = auth.tenant === null ? process.env : entornoDe(auth.tenant, process.env);

  let config;
  try {
    config = loadConfig(entorno);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const de = auth.tenant === null ? "" : ` (empresa "${auth.tenant.id}")`;
    responderErrorRpc(res, 500, `Configuración inválida${de}: ${message}`);
    return;
  }
  if (auth.tenant !== null) {
    logger.info("serverless.tenant", { tenant: auth.tenant.id });
  }

  const { modo, degradado } = resolverCapabilityModeServerless(config.capabilityMode, process.env);
  if (degradado) {
    logger.warn(
      "En serverless la escritura queda deshabilitada: la idempotencia es en memoria y no " +
        "sobrevive entre invocaciones, así que un reintento podría emitir dos veces. " +
        "Para asumirlo igual: BILLER_SERVERLESS_ALLOW_WRITES=true.",
    );
  }

  // Un server y un transporte NUEVOS por request. Es lo correcto en serverless
  // y además aísla por completo una request de otra.
  const ctx = createToolContext(entorno, {
    tenantId: auth.tenant?.id,
    serverless: true,
  });
  const server = crearServidorMcp(ctx, modo);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: ver el comentario de cabecera
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(conDialectoLimpio(transport, { quitarOutputSchema: config.wireLiviano }));
  await transport.handleRequest(req, res, parsedBody);
}
