// =============================================================================
// Barrera única de salida.
//
// PLAN_V2 §5.1 pide que la no-filtración de secretos sea ESTRUCTURAL y no una
// convención ("ninguna tool devuelve el token"). Una convención se rompe con la
// tool número 18, escrita seis meses después por otra persona.
//
// Acá está la estructura: `hardenServer` intercepta `registerTool`, así que
// TODA tool —las que existen y las que se agreguen— devuelve su resultado a
// través de `sanitizeToolResult`. No hay forma de registrar una tool que
// esquive el filtro sin desarmar esta función a propósito.
//
// El filtro hace dos cosas, en este orden:
//   1. envuelve los campos de texto escritos por terceros (ver untrusted.ts),
//   2. redacta secretos de todo string que salga.
//
// El orden importa: si se redactara primero, la envoltura podría re-exponer un
// fragmento al recomponer el texto.
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactSecrets } from "../utils/errors.js";
import { pretty, type ToolContext, type ToolResult } from "../tools/shared.js";
import { CAMPOS_NO_CONFIABLES, envolverNoConfiable, yaEnvuelto } from "./untrusted.js";

/** Profundidad máxima al recorrer la salida (corta ciclos y estructuras patológicas). */
const MAX_DEPTH = 12;

/**
 * Recorre un valor arbitrario envolviendo los strings cuya CLAVE está en
 * `CAMPOS_NO_CONFIABLES`. `claveActual` es el nombre bajo el que vino el valor.
 */
function envolverCamposNoConfiables(valor: unknown, claveActual: string | null, depth: number): unknown {
  if (depth > MAX_DEPTH) return valor;

  if (typeof valor === "string") {
    if (claveActual !== null && CAMPOS_NO_CONFIABLES.has(claveActual) && !yaEnvuelto(valor)) {
      return envolverNoConfiable(valor);
    }
    return valor;
  }

  if (Array.isArray(valor)) {
    // Los elementos heredan la clave del array: `items: [...]` no marca, pero
    // `motivos: ["texto de tercero"]` sí debe marcar cada elemento.
    return valor.map((v) => envolverCamposNoConfiables(v, claveActual, depth + 1));
  }

  if (typeof valor === "object" && valor !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      out[k] = envolverCamposNoConfiables(v, k, depth + 1);
    }
    return out;
  }

  return valor;
}

/** Aplica `redactSecrets` a todo string del árbol. */
function redactarProfundo(valor: unknown, secrets: Array<string | undefined>, depth: number): unknown {
  if (depth > MAX_DEPTH) return valor;
  if (typeof valor === "string") return redactSecrets(valor, secrets);
  if (Array.isArray(valor)) return valor.map((v) => redactarProfundo(v, secrets, depth + 1));
  if (typeof valor === "object" && valor !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      out[k] = redactarProfundo(v, secrets, depth + 1);
    }
    return out;
  }
  return valor;
}

/**
 * Secretos a redactar. Tolera que la config no esté disponible (health_check
 * tiene que poder correr sin configuración).
 */
export function secretosDe(ctx: ToolContext): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  try {
    const config = ctx.getConfig();
    out.push(config.apiToken);
    if (config.kapso?.apiKey !== undefined) out.push(config.kapso.apiKey);
    if (config.httpAuthToken !== undefined) out.push(config.httpAuthToken);
  } catch {
    // Config incompleta: no hay secretos que redactar.
  }
  return out;
}

/**
 * Sanea un resultado de tool. Es idempotente y no rompe la validación del
 * `outputSchema`: solo transforma valores string, nunca la forma del objeto.
 */
export function sanitizeToolResult(result: ToolResult, ctx: ToolContext): ToolResult {
  const secrets = secretosDe(ctx);
  const textoOriginal = result.structuredContent !== undefined ? pretty(result.structuredContent) : null;

  let structured = result.structuredContent;
  if (structured !== undefined) {
    structured = envolverCamposNoConfiables(structured, null, 0) as Record<string, unknown>;
    structured = redactarProfundo(structured, secrets, 0) as Record<string, unknown>;
  }

  const content = result.content.map((bloque) => {
    // Caso `jsonResult`: el texto es el JSON del structured. Se regenera desde
    // el structured ya saneado para que ambos digan exactamente lo mismo.
    if (textoOriginal !== null && bloque.text === textoOriginal && structured !== undefined) {
      return { ...bloque, text: pretty(structured) };
    }
    // Caso markdown (`dualResult`): se redacta el texto tal cual. La envoltura
    // de no-confiables ya la aplicó quien armó el markdown, si correspondía.
    return { ...bloque, text: redactSecrets(bloque.text, secrets) };
  });

  return { ...result, content, ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

type RegisterToolFn = McpServer["registerTool"];

/**
 * Envuelve `server.registerTool` para que toda tool registrada DESPUÉS de esta
 * llamada pase su resultado por `sanitizeToolResult`.
 *
 * Llamar antes de `registerAllTools`. Es idempotente: envolver dos veces solo
 * agrega un pase extra del mismo filtro (que es idempotente).
 */
export function hardenServer(server: McpServer, ctx: ToolContext): void {
  const original = server.registerTool.bind(server) as RegisterToolFn;

  const wrapped = ((name: string, config: unknown, handler: unknown) => {
    const originalHandler = handler as (...args: unknown[]) => unknown;
    const safeHandler = async (...args: unknown[]): Promise<unknown> => {
      const out = await originalHandler(...args);
      return sanitizeToolResult(out as ToolResult, ctx);
    };
    return (original as unknown as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      config,
      safeHandler,
    );
  }) as unknown as RegisterToolFn;

  server.registerTool = wrapped;
}
