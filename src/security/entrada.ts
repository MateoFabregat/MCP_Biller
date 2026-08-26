// =============================================================================
// Barrera única de entrada.
//
// Simétrica a `hardenServer` (barrera de salida) y por los mismos motivos:
// intercepta `server.registerTool`, así que TODA tool —presente o futura— exige
// identificar a quien pregunta cuando hay un canal de WhatsApp abierto. No hay
// forma de registrar una tool que se saltee el chequeo sin desarmar esta función
// a propósito.
//
// Hace dos cosas:
//   1. agrega el parámetro `remitente` al input de cada tool, para que el modelo
//      SEPA que existe y lo mande (un parámetro que no está en el schema no lo
//      manda nadie);
//   2. lo verifica ANTES de ejecutar el handler.
//
// El chequeo va antes del handler y no adentro: así ninguna tool llega siquiera
// a llamar a la API de Biller por un remitente no autorizado. Un rechazo que
// ocurre después del GET ya gastó una request contra la cuenta de la empresa y,
// peor, ya trajo los datos a memoria.
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolResult } from "../tools/shared.js";
import { remitenteSchema, verificarRemitente } from "./remitentes.js";

type RegisterToolFn = McpServer["registerTool"];

/** Rechazo con la misma forma que usan las tools para sus errores. */
function rechazo(motivo: string, mensaje: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: { kind: "autorizacion", motivo, message: mensaje } }) },
    ],
    isError: true,
  };
}

/**
 * Envuelve `registerTool` para exigir `remitente` en toda tool registrada
 * DESPUÉS de esta llamada.
 *
 * Va junto a `hardenServer` en `crearServidorMcp`. El orden entre las dos no
 * cambia el resultado —una envuelve la entrada y la otra la salida— pero las dos
 * tienen que ir antes de `registerAllTools`.
 *
 * Si la configuración no se puede leer, se deja pasar: sin config no hay Kapso
 * configurado, y la tool va a fallar sola con un error de configuración claro.
 * Rechazar acá por "no pude leer la config" convertiría cualquier problema de
 * entorno en un "no estás autorizado", que manda a diagnosticar al lugar
 * equivocado.
 */
export function guardarEntrada(server: McpServer, ctx: ToolContext): void {
  const original = server.registerTool.bind(server) as RegisterToolFn;

  const wrapped = ((name: string, config: unknown, handler: unknown) => {
    const conf = config as { inputSchema?: Record<string, unknown> } | undefined;
    const configConRemitente = {
      ...(conf ?? {}),
      inputSchema: { ...(conf?.inputSchema ?? {}), remitente: remitenteSchema },
    };

    const originalHandler = handler as (...args: unknown[]) => unknown;
    const guardedHandler = async (...args: unknown[]): Promise<unknown> => {
      let permitido = true;
      let resultado: ToolResult | null = null;
      try {
        const cfg = ctx.getConfig();
        const entrada = args[0] as { remitente?: unknown } | undefined;
        const raw = typeof entrada?.remitente === "string" ? entrada.remitente : undefined;
        const v = verificarRemitente(raw, cfg, name);
        if (!v.ok) {
          permitido = false;
          resultado = rechazo(v.motivo, v.mensaje);
        }
      } catch {
        // Config ilegible: ver el comentario de la función.
        permitido = true;
      }
      if (!permitido && resultado !== null) return resultado;
      return originalHandler(...args);
    };

    return (original as unknown as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      configConRemitente,
      guardedHandler,
    );
  }) as unknown as RegisterToolFn;

  server.registerTool = wrapped;
}
