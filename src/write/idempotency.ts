// =============================================================================
// Idempotencia (in-process).
//
// Evita ejecutar dos veces la MISMA operación dentro de la vida del proceso
// (p.ej. un retry del modelo que duplicaría un comprobante). Se complementa con
// el header `Idempotency-Key` que envía el writeClient (soporte server-side: a
// validar contra Biller — ver README).
// =============================================================================

import { randomUUID } from "node:crypto";

export function generateIdempotencyKey(): string {
  return randomUUID();
}

/** Registro de keys ya ejecutadas con éxito en esta sesión. */
export class IdempotencyStore {
  private readonly used = new Set<string>();

  has(key: string): boolean {
    return this.used.has(key);
  }

  markUsed(key: string): void {
    this.used.add(key);
  }

  /** Solo para tests. */
  clear(): void {
    this.used.clear();
  }
}
