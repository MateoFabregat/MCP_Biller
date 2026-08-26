// =============================================================================
// El dialecto de los schemas que salen por el wire.
//
// EL PROBLEMA, ENCONTRADO USANDO EL SERVER DE VERDAD
//
// Un cliente MCP estricto (Claude Code, ajv en modo 2020-12) rechazó TODAS las
// tools con `outputSchema`: no se podía ni llamar a `biller_health_check`. El
// motivo no está en nuestro código: el SDK, cuando los schemas son Zod v3,
// los convierte con `zod-to-json-schema`, que estampa
// `"$schema": "http://json-schema.org/draft-07/schema#"` — y la spec de MCP
// pide draft 2020-12. Un cliente laxo lo ignora; uno estricto corta ahí, y el
// usuario ve "invalid outputSchema" antes de la primera respuesta.
//
// EL ARREGLO, Y POR QUÉ ES QUITAR Y NO TRADUCIR
//
// Se borra la clave `$schema` de los schemas de tools que salen en
// `tools/list`. Sin la clave, el cliente asume el dialecto por defecto
// (2020-12), y para las formas que emite Zod —objetos, enums, arrays, todo
// inline— draft-07 y 2020-12 son el mismo documento. Traducir de verdad
// (definitions→$defs, etc.) sería código para casos que estos schemas no
// producen.
//
// La salida de fondo es migrar los schemas a Zod v4, cuyo conversor nativo ya
// emite 2020-12; ese día este módulo se borra y nadie lo extraña.
//
// VIVE EN EL TRANSPORTE porque es el único lugar que ven los tres runtimes
// (stdio, HTTP largo, serverless): envolver 38 tools o parchear el SDK serían
// 38 lugares o uno ajeno.
// =============================================================================

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DIALECTO_VIEJO = "http://json-schema.org/draft-07/schema#";

export interface OpcionesDialecto {
  /**
   * Además del dialecto, quitar el `outputSchema` entero de cada tool.
   *
   * POR QUÉ EXISTE: el Agent Node de Kapso abría la sesión, pedía `tools/list`,
   * recibía 200… y configuraba el agente con CERO tools nuestras, sin error en
   * ningún lado. La lista pesaba 159 KB, y casi la mitad eran los
   * `outputSchema` — que para un agente conversacional no aportan nada: el
   * modelo lee `structuredContent` igual, con o sin schema declarado.
   *
   * `outputSchema` es OPCIONAL en la spec de MCP, así que quitarlo del wire es
   * legal y no cambia ninguna respuesta. Es opt-in (BILLER_WIRE_LIVIANO) porque
   * un cliente estricto como Claude Code sí lo aprovecha para validar.
   */
  quitarOutputSchema?: boolean;
}

/** Limpia los schemas de una lista de tools según las opciones. */
function limpiarListaDeTools(result: unknown, opciones: OpcionesDialecto): void {
  if (typeof result !== "object" || result === null) return;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const t = tool as Record<string, unknown>;
    if (opciones.quitarOutputSchema === true) delete t["outputSchema"];
    for (const clave of ["inputSchema", "outputSchema"] as const) {
      const schema = t[clave];
      if (typeof schema === "object" && schema !== null) {
        const s = schema as Record<string, unknown>;
        if (s["$schema"] === DIALECTO_VIEJO) delete s["$schema"];
      }
    }
  }
}

/**
 * Envuelve `transport.send` para limpiar todo `tools/list` que salga.
 * Devuelve el mismo transporte, para usarlo inline en el `connect`.
 */
export function conDialectoLimpio<T extends Transport>(
  transport: T,
  opciones: OpcionesDialecto = {},
): T {
  const enviarOriginal = transport.send.bind(transport);
  transport.send = (mensaje, opcionesEnvio) => {
    if (typeof mensaje === "object" && mensaje !== null && "result" in mensaje) {
      limpiarListaDeTools((mensaje as { result?: unknown }).result, opciones);
    }
    return enviarOriginal(mensaje, opcionesEnvio);
  };
  return transport;
}
