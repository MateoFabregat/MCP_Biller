// =============================================================================
// Guard de read-only en runtime.
//
// Único punto que decide si un método HTTP está permitido. SOLO GET.
// Cualquier otro método lanza BillerReadOnlyViolationError.
//
// Esta función es exportada e independiente para poder testearla directamente
// y para que el cliente HTTP la invoque antes de cada request.
// =============================================================================

import { BillerReadOnlyViolationError } from "../utils/errors.js";

export const ALLOWED_METHOD = "GET" as const;
export type AllowedMethod = typeof ALLOWED_METHOD;

/**
 * Afirma que `method` es GET. Lanza BillerReadOnlyViolationError si no lo es.
 * Usar como gate antes de construir cualquier request a Biller.
 */
export function assertReadOnlyMethod(method: string): asserts method is AllowedMethod {
  if (typeof method !== "string" || method.toUpperCase() !== ALLOWED_METHOD) {
    throw new BillerReadOnlyViolationError(method);
  }
}
