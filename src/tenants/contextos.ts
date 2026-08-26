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

import { createToolContext } from "../tools/register.js";
import type { ToolContext } from "../tools/shared.js";
import { entornoDe, type Tenant } from "./registry.js";

/** Cache de contextos por id de tenant. La clave es el id, nunca el token. */
export class ContextosPorTenant {
  private readonly cache = new Map<string, ToolContext>();

  constructor(private readonly base: Record<string, string | undefined> = process.env) {}

  /** El contexto de un tenant. Lo crea la primera vez y lo reusa después. */
  para(tenant: Tenant): ToolContext {
    const existente = this.cache.get(tenant.id);
    if (existente !== undefined) return existente;
    const ctx = createToolContext(entornoDe(tenant, this.base));
    this.cache.set(tenant.id, ctx);
    return ctx;
  }

  /** Cuántos contextos hay vivos. Para diagnóstico y tests. */
  get tamano(): number {
    return this.cache.size;
  }
}
