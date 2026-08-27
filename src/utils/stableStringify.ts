// =============================================================================
// Serialización estable (claves ordenadas) para hashes reproducibles.
//
// La usan el token de confirmación de escritura y la deduplicación de lecturas,
// así que vive en utils/ y no en ninguna de las dos capas.
// =============================================================================

/**
 * `undefined` y `NaN` producen "null" en JSON nativo, colisionando entre sí.
 * Se normalizan explícitamente para garantizar salidas distintas.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "number" && Number.isNaN(value)) return '"__NaN__"';
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
