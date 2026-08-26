// =============================================================================
// Helpers de coerción y validación compartidos por los schemas de Biller.
//
// Por qué existen: los ejemplos oficiales mezclan números y strings numéricos
// para el MISMO campo (p.ej. "tipo_comprobante": 101 y "tipo_comprobante":
// "131"), y booleanos como true/false, 0/1 o "0"/"1". Aceptamos todas las
// formas documentadas y normalizamos a lo que declara la tabla de valores.
// =============================================================================

import { z } from "zod";

/** Convierte un string numérico a número; deja pasar el resto tal cual. */
export function aNumero(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  }
  return v;
}

/** Booleano flexible: true/false, 0/1, "0"/"1". La doc usa las tres formas. */
export function aBooleano(v: unknown): unknown {
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return v;
}

export function listarCodigos(tabla: Record<number, string>): string {
  return Object.entries(tabla)
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
}

/** Entero restringido a una tabla de valores documentada. */
export function codigo(tabla: Record<number, string>, campo: string) {
  return z.preprocess(
    aNumero,
    z
      .number({ invalid_type_error: `${campo} debe ser un número entero.` })
      .int()
      .refine((v) => v in tabla, {
        message: `Valor no documentado para ${campo}. Valores válidos: ${listarCodigos(tabla)}.`,
      }),
  );
}

/** Número (entero o decimal) tolerante a strings numéricos. */
export function numero(campo: string) {
  return z.preprocess(
    aNumero,
    z.number({ invalid_type_error: `${campo} debe ser numérico.` }),
  );
}

/** Entero tolerante a strings numéricos. */
export function entero(campo: string) {
  return z.preprocess(
    aNumero,
    z.number({ invalid_type_error: `${campo} debe ser un número entero.` }).int(),
  );
}

/** Booleano tolerante a 0/1 y "0"/"1". */
export function booleano() {
  return z.preprocess(aBooleano, z.boolean());
}

/** String con el largo máximo que documenta DGI. */
export function texto(max: number, campo: string) {
  return z.string().max(max, `${campo} supera el máximo documentado de ${max} caracteres.`);
}

/**
 * Fecha ISO aaaa-mm-dd. El mensaje aclara la diferencia con dd/mm/aaaa porque
 * la API usa AMBOS formatos según el campo, y confundirlos es el error más
 * fácil de cometer.
 */
export function fechaIso(campo: string) {
  return z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      `${campo} usa formato ISO aaaa-mm-dd (ej: "2026-05-28"). ` +
        "Ojo: las fechas de EMISIÓN de un CFE usan dd/mm/aaaa; ésta no.",
    )
    .refine((v) => !Number.isNaN(Date.parse(v)), `${campo} debe ser una fecha real.`);
}

/** Redondeo monetario a 2 decimales, estable ante el error de coma flotante. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
