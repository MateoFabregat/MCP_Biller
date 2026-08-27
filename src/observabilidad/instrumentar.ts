// =============================================================================
// Instrumentación de las tools.
//
// POR QUÉ INTERCEPTA `registerTool` Y NO SE MIDE TOOL POR TOOL
//
// Mismo criterio que `hardenServer` (salida) y `guardarEntrada` (entrada), y por
// la misma razón: medir adentro de cada tool es una convención, y una convención
// se rompe con la tool número 40 escrita dentro de seis meses. Justo la que
// nadie mide es la que después nadie sabe si se usa.
//
// Envolviendo el registro, toda tool —presente o futura— queda contada sin que
// su autor tenga que acordarse de nada.
//
// QUÉ SE MIDE Y QUÉ NO
//
// Se mide el NOMBRE de la tool, el DESENLACE y un BUCKET de duración. No se
// miran los argumentos ni el resultado: ahí adentro viven los RUT, los importes
// y los teléfonos. La regla del módulo de métricas —ningún dato fiscal— se
// sostiene sola si esta capa nunca abre el payload, así que no lo abre.
//
// El desenlace distingue tres cosas que hay que poder separar en producción:
//   · `ok`        — la tool contestó;
//   · `error`     — contestó con isError (validación, API caída, 422 de Biller);
//   · `excepcion` — se rompió de verdad y la excepción sube.
//
// Un pico de `error` en una tool concreta es un problema de datos o de API; un
// pico de `excepcion` es un bug nuestro. Mezclarlos hace que ninguno se vea.
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Metricas } from "./metricas.js";

type RegisterToolFn = McpServer["registerTool"];

/** ¿El resultado de la tool venía marcado como error? */
function esError(resultado: unknown): boolean {
  return (
    typeof resultado === "object" &&
    resultado !== null &&
    (resultado as { isError?: unknown }).isError === true
  );
}

/**
 * Envuelve `registerTool` para contar invocaciones, desenlaces y duraciones de
 * toda tool registrada DESPUÉS de esta llamada.
 *
 * Va junto a `hardenServer` y `guardarEntrada` en `crearServidorMcp`, y como
 * ellas, tiene que ir ANTES de `registerAllTools`.
 *
 * ORDEN RESPECTO DE `guardarEntrada`: esta capa se aplica primero para quedar
 * MÁS AFUERA, de modo que un rechazo de la barrera de entrada también se
 * cuente. Un remitente no autorizado que golpea la puerta es exactamente el
 * tipo de cosa que uno quiere ver en una métrica; si la instrumentación
 * quedara adentro, esos intentos serían invisibles.
 */
export function instrumentarTools(server: McpServer, metricas: Metricas): void {
  const original = server.registerTool.bind(server) as RegisterToolFn;

  const wrapped = ((name: string, config: unknown, handler: unknown) => {
    const originalHandler = handler as (...args: unknown[]) => unknown;

    const medido = async (...args: unknown[]): Promise<unknown> => {
      const inicio = Date.now();
      let resultado: "ok" | "error" | "excepcion" = "ok";
      try {
        const salida = await originalHandler(...args);
        resultado = esError(salida) ? "error" : "ok";
        return salida;
      } catch (err) {
        resultado = "excepcion";
        throw err;
      } finally {
        // En `finally` a propósito: una tool que explota es la que MÁS interesa
        // contar, y es justo la que un contador puesto después del `return` no
        // llega a registrar nunca.
        metricas.contar("tool.invocacion", { tool: name, resultado });
        metricas.observarDuracion("tool.duracion", Date.now() - inicio, { tool: name });
      }
    };

    return (original as unknown as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      config,
      medido,
    );
  }) as unknown as RegisterToolFn;

  server.registerTool = wrapped;
}
