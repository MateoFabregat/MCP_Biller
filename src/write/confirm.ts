// =============================================================================
// Token de confirmación (human-in-the-loop).
//
// El token es un hash determinístico de { endpoint, environment, payload }.
// Flujo:
//   1. dry-run -> se devuelve el `confirmation_token` junto al preview.
//   2. ejecución -> el caller debe reenviar confirm=true + ese token.
// Si el payload cambia (cualquier campo), el token deja de coincidir y la
// ejecución se rechaza: así garantizamos que se ejecuta EXACTAMENTE lo previewado.
// =============================================================================

import { createHash } from "node:crypto";

/** Serialización estable (claves ordenadas) para un hash reproducible. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function computeConfirmationToken(
  endpoint: string,
  environment: string,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(stableStringify({ endpoint, environment, payload }))
    .digest("hex");
}

export function verifyConfirmationToken(
  provided: string | undefined,
  endpoint: string,
  environment: string,
  payload: unknown,
): boolean {
  if (!provided) return false;
  const expected = computeConfirmationToken(endpoint, environment, payload);
  // Comparación simple; el token no es un secreto, es un binding de intención.
  return provided.trim().toLowerCase() === expected;
}
