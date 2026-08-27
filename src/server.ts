// =============================================================================
// Fábrica del server MCP.
//
// Vive aparte del entrypoint porque hay TRES consumidores: el binario stdio,
// el transporte HTTP local y el handler serverless de Vercel. Que los tres
// construyan el server por el mismo camino es lo que garantiza que ninguno se
// saltee la barrera de salida.
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { instrumentarTools } from "./observabilidad/instrumentar.js";
import { registerPrompts } from "./prompts/register.js";
import { guardarEntrada } from "./security/entrada.js";
import { hardenServer } from "./security/sanitize.js";
import { SERVER_INSTRUCTIONS } from "./security/untrusted.js";
import { registerAllTools, type BillerCapabilityMode } from "./tools/register.js";
import type { ToolContext } from "./tools/shared.js";

/**
 * Construye un McpServer listo para conectar a un transporte.
 *
 * ORDEN CRÍTICO: las TRES envolturas van ANTES de `registerAllTools`. Todas
 * interceptan `registerTool`, así que solo cubren lo que se registre DESPUÉS.
 * Moverlas abajo desactiva —sin que falle nada de forma visible— la redacción de
 * secretos, el marcado de datos no confiables, el chequeo de quién está
 * preguntando y las métricas.
 *
 * Entre `hardenServer` y `guardarEntrada` el orden es indistinto: una envuelve
 * la entrada y la otra la salida, y se componen igual en cualquier orden.
 *
 * `instrumentarTools` SÍ tiene orden: va PRIMERO, para quedar más afuera que
 * `guardarEntrada`. Así un rechazo de la barrera de entrada también se cuenta.
 * Un remitente no autorizado golpeando la puerta es de las cosas que más
 * interesa ver en una métrica, y adentro de la barrera sería invisible.
 */
export function crearServidorMcp(
  ctx: ToolContext,
  capabilityMode: BillerCapabilityMode,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  instrumentarTools(server, ctx.metricas);
  hardenServer(server, ctx);
  guardarEntrada(server, ctx);
  registerAllTools(server, ctx, capabilityMode);
  registerPrompts(server);
  return server;
}
