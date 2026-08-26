// =============================================================================
// Deduplicación de emisiones contra la API de Biller.
//
// Por qué existe: la idempotencia de `src/write/idempotency.ts` es in-process y
// se pierde al reiniciar el servidor MCP. Un reintento del cliente, un cold
// start o un segundo proceso pueden emitir el MISMO CFE dos veces ante DGI.
// Un duplicado se arregla —se anula con una nota de crédito— pero deja dos
// comprobantes emitidos, dos números consumidos y una conciliación que hacer.
// Es mucho más barato no emitirlo.
//
// `numero_interno` es, según la doc, el "identificador propio de la empresa" y
// "debe ser único"; además `/v2/comprobantes/obtener` lo acepta como filtro. Es
// la única clave de deduplicación que sobrevive a un reinicio, porque vive del
// lado de Biller.
//
// Vive en `services/` y no en `tools/write/` a propósito: solo hace GET, así que
// tiene que quedar DENTRO del alcance de `npm run check:readonly` (que excluye la
// capa de escritura). Si algún día alguien mete un POST acá, el guard lo detecta.
// =============================================================================

import { fetchEmitidos } from "../biller/queries.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import type { ToolContext } from "../tools/shared.js";
import { BillerApiError } from "../utils/errors.js";

/**
 * Biller devuelve 422 —no una lista vacía— cuando el `numero_interno` buscado
 * no existe:
 *
 *   GET /v2/comprobantes/obtener?numero_interno=MCP-TEST-A1
 *   -> 422 [{"field":"numero_interno","message":"No existe un comprobante con
 *            numero_interno MCP-TEST-A1"}]
 *
 * Verificado contra test.biller.uy el 2026-07-28. Es un 404 disfrazado de 422,
 * y confundirlo tiene una consecuencia concreta: el caso feliz —el número está
 * libre, se puede emitir— llegaba como excepción, se reportaba como "no se pudo
 * verificar si hay duplicados" y ensuciaba con un warning falso TODAS las
 * emisiones correctas. Con el tiempo, ese warning se ignora, y el día que la
 * verificación falla de verdad tampoco se lee.
 */
const RE_NO_EXISTE = /no existe un comprobante con numero_interno/i;

/**
 * Busca un comprobante ya emitido con ese `numero_interno`.
 *
 * Devuelve `null` si no existe —tanto si la API contesta con lista vacía como
 * si contesta con el 422 de "no existe"—. Cualquier otro error se propaga para
 * que el llamador decida si continuar sin la verificación: un 500 o un problema
 * de red NO son evidencia de que el número esté libre.
 */
export async function buscarPorNumeroInterno(
  ctx: ToolContext,
  numeroInterno: string,
): Promise<ComprobanteEmitido | null> {
  const client = ctx.getClient();
  let encontrados: ComprobanteEmitido[];
  try {
    encontrados = await fetchEmitidos(client, { numero_interno: numeroInterno });
  } catch (err) {
    if (
      err instanceof BillerApiError &&
      err.status === 422 &&
      RE_NO_EXISTE.test(err.bodySnippet ?? err.message)
    ) {
      return null;
    }
    throw err;
  }

  // Biller puede ignorar un filtro que no reconoce y devolver el listado por
  // defecto (los de hoy). Confirmamos el match en vez de confiar en el filtro.
  const match = encontrados.find((c) => c.numero_interno === numeroInterno);
  return match ?? null;
}
