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
        } else if (v.remitente !== null && entrada !== undefined) {
          // EL DATO VERIFICADO PISA AL QUE MANDÓ EL MODELO.
          //
          // Hasta acá la barrera verificaba `remitente` y después lo tiraba: el
          // handler parsea con su propio `z.object`, que descarta lo que no
          // declara. Cada tool que quisiera atar algo a la identidad de quien
          // escribe tenía que volver a leer el crudo y repetir
          // `normalizarTelefono` + `requiereRemitente` — o sea, una convención,
          // que es exactamente lo que la tool número 25 se olvida. Y "se olvida"
          // acá significa que vuelve el agujero de leer datos ajenos.
          //
          // SE PISA EL MISMO CAMPO, y no se agrega un `__remitente_verificado`
          // aparte, por dos motivos. Uno: un campo que no está en el inputSchema
          // es invisible para el `z.object` de cada tool, así que la tool tendría
          // que meter la mano en los args crudos para leerlo —la misma convención
          // que se está eliminando—; y uno que SÍ esté en el schema es un campo
          // más que el modelo va a intentar completar. Así, el schema que ve el
          // modelo queda igual que antes: un solo `remitente`, una sola
          // descripción. Dos: con dos campos conviven "lo que dijo el modelo" y
          // "lo que verificó la barrera" bajo nombres parecidos, y la tool que
          // lea el equivocado falla en silencio y a favor del atacante.
          // Pisándolo, el valor no verificado deja de existir: no hay forma de
          // confundirlos porque hay uno solo, y es el bueno. Las tools que ya
          // declaran `remitente` (writeControlShape, la emisión guiada) no
          // cambian una línea, y de yapa lo reciben normalizado, que es la forma
          // que el audit log quiere escribir.
          //
          // Solo cuando la verificación produjo un número: para las tools exentas
          // y sin Kapso `v.remitente` es null y el crudo se deja intacto
          // —`biller_health_check` lo necesita para decidir si degrada su salida,
          // y en stdio no hay nada que verificar—.
          try {
            (entrada as { remitente?: unknown }).remitente = v.remitente;
          } catch {
            // Args congelados: no es un caso real (el objeto lo arma el SDK), pero
            // fallar la tool entera por no poder anotar sería peor. El handler
            // recibe el crudo, que ya pasó la allowlist.
          }
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
