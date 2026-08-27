// =============================================================================
// El contexto de cada empresa, y por qué no se comparte.
//
// `createToolContext` memoiza adentro tres cosas con estado: el cliente de
// Biller, el auditor y —la que importa— el store de idempotencia. Reusar un
// contexto entre dos empresas haría que compartieran las claves de idempotencia:
// una clave marcada como usada por una empresa bloquearía la emisión de la otra,
// y el mensaje de error hablaría de una operación que el usuario nunca hizo.
//
// Por eso hay un contexto POR TENANT, y se cachea: en un proceso que vive (el
// transporte HTTP), tirar el store de idempotencia en cada request equivale a no
// tener idempotencia. En serverless el proceso no vive, y por eso allá la
// escritura ya está degradada a `read_only` — ver `transport/serverless.ts`.
// =============================================================================

import { registrarHabilitacionCache } from "../services/periodo.js";
import { createToolContext } from "../tools/register.js";
import type { ToolContext } from "../tools/shared.js";
import { entornoDe, type Tenant } from "./registry.js";

/** Cache de contextos por id de tenant. La clave es el id, nunca el token. */
export class ContextosPorTenant {
  private readonly cache = new Map<string, ToolContext>();

  /**
   * `cacheId` -> qué opina ESA empresa sobre el cache de ventanas.
   *
   * POR QUÉ VIVE ACÁ Y NO EN `registry.ts` NI EN `periodo.ts`. El cache de
   * ventanas es un singleton del proceso y su única identidad de empresa es el
   * `cacheId` del cliente (sha256 de baseUrl+token, `biller/client.ts`), que no
   * es un dato de configuración: no existe hasta que alguien CONSTRUYE el
   * cliente de ese tenant. El registro conoce el overlay pero no el cliente;
   * `periodo.ts` conoce el `cacheId` pero no el overlay. Este es el único lugar
   * donde las dos mitades están a la vez, porque es el que construye el contexto
   * de cada empresa — y ya es el dueño del ciclo de vida por tenant.
   *
   * `undefined` como valor no es "no está": es "este tenant no opina",
   * exactamente lo que `registrarHabilitacionCache` espera para caer al default
   * del proceso. Por eso se guarda la clave igual.
   */
  private readonly habilitacionCache = new Map<string, boolean | undefined>();

  constructor(private readonly base: Record<string, string | undefined> = process.env) {
    // Se enchufa al construir el registro de contextos y no al primer `para()`:
    // así el cache queda preguntando por empresa desde el arranque, y un
    // `cacheId` que todavía no está en el índice contesta `undefined` (default
    // del proceso), que es el comportamiento de siempre.
    //
    // COSTURA: `registrarHabilitacionCache` es un singleton del módulo, o sea
    // que la ÚLTIMA instancia de esta clase que se construya es la que manda.
    // En el proceso real hay una sola (`index.ts`); en los tests, construir dos
    // deja a la primera desconectada.
    registrarHabilitacionCache((cacheId) => this.habilitacionCache.get(cacheId));
  }

  /** El contexto de un tenant. Lo crea la primera vez y lo reusa después. */
  para(tenant: Tenant): ToolContext {
    const existente = this.cache.get(tenant.id);
    if (existente !== undefined) return existente;
    // El id viaja para que la LÍNEA DE LOG de métricas diga de qué empresa es.
    // Es `[a-z0-9_-]`, no es secreto y no tiene corrida de dígitos: pasa el
    // filtro de valores de etiqueta sin volverse "invalido".
    const entorno = entornoDe(tenant, this.base);
    const ctx = createToolContext(entorno, { tenantId: tenant.id });
    this.cache.set(tenant.id, ctx);
    this.indexarHabilitacionCache(tenant, ctx);
    return ctx;
  }

  /**
   * Ata el `cacheId` de esta empresa a lo que su overlay dice de
   * `BILLER_CACHE_ENABLED`.
   *
   * SOLO SI EL TENANT OPINA. Si su overlay no declara la variable, se guarda
   * `undefined` y el cache cae al default del proceso — que es el comportamiento
   * de hoy, y el que tiene que quedar intacto para los diecinueve tenants que no
   * están diagnosticando nada.
   *
   * Si el cliente no se puede construir (config incompleta), no se indexa nada:
   * sin cliente no hay `cacheId`, y sin `cacheId` tampoco hay nada que cachear.
   * El diagnóstico de esa config lo da `biller_health_check`, no esto.
   */
  private indexarHabilitacionCache(tenant: Tenant, ctx: ToolContext): void {
    // Se mira el OVERLAY del tenant, no el entorno efectivo: si se mirara el
    // efectivo, un `BILLER_CACHE_ENABLED` puesto en el proceso haría que las
    // veinte empresas "opinaran" lo mismo que el proceso, y la resolución por
    // empresa sería una capa que existe y no distingue nada.
    const opina = (tenant.env.BILLER_CACHE_ENABLED ?? "").trim() !== "";
    if (!opina) return;
    try {
      const cacheId = ctx.getClient().cacheId;
      if (typeof cacheId === "string" && cacheId !== "") {
        this.habilitacionCache.set(cacheId, ctx.getConfig().cacheEnabled);
      }
    } catch {
      // Sin config no hay cliente ni cacheId. Ver el comentario de arriba.
    }
  }

  /** Cuántos contextos hay vivos. Para diagnóstico y tests. */
  get tamano(): number {
    return this.cache.size;
  }
}
