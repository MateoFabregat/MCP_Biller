// =============================================================================
// Helpers de coerción y validación compartidos por los schemas de Biller.
//
// Por qué existen: los ejemplos oficiales mezclan números y strings numéricos
// para el MISMO campo (p.ej. "tipo_comprobante": 101 y "tipo_comprobante":
// "131"), y booleanos como true/false, 0/1 o "0"/"1". Aceptamos todas las
// formas documentadas y normalizamos a lo que declara la tabla de valores.
// =============================================================================

import { z } from "zod";
import { parsearImporte } from "../services/importe.js";

/** Convierte un string numérico a número; deja pasar el resto tal cual. */
export function aNumero(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  }
  return v;
}

/** Un string que es SOLO un número: signo, dígitos y separadores. Sin moneda ni letras. */
const SOLO_NUMERO = /^[+-]?[\d.,]+$/;

/**
 * Campo de PLATA de un documento fiscal (un importe o una cantidad que suma o
 * multiplica al total del CFE).
 *
 * Por qué NO alcanza `numero()`/`aNumero` acá: usan `Number()`, y `Number("6.500")`
 * es 6.5 — en JavaScript el punto es decimal, en Uruguay es de miles. Un CFE
 * emitido con 6.5 donde iba 6.500 está mal por CIEN VECES, sale bien formado, y
 * nadie lo ve hasta el reclamo semanas después. Es el mismo caso que
 * `biller_emision_guiada` ya trata con `parsearImporte`; esta es la misma regla
 * en la tool que REALMENTE emite.
 *
 * - Un `number` ya resuelto pasa intacto. Es el caso normal: el borrador de la
 *   emisión guiada llega con `precio: number` porque ya lo parseó antes.
 * - Un string se lee con `parsearImporte` (los mismos criterios escritos y
 *   testeados): "6.500" → 6500, "1.234,56" → 1234.56.
 * - Un string genuinamente ambiguo (un punto con dos decimales, una coma de
 *   miles: la diferencia es de cien veces) se RECHAZA pidiendo el número sin
 *   separador. La emisión es irreversible y acá no hay a quién preguntarle;
 *   ante la duda no se elige.
 */
export function plata(campo: string) {
  return z.union([z.number(), z.string()]).transform((v, ctx): number => {
    if (typeof v === "number") {
      if (Number.isFinite(v)) return v;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${campo} debe ser numérico.` });
      return z.NEVER;
    }
    const t = v.trim();
    if (t === "" || !SOLO_NUMERO.test(t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${campo} debe ser numérico.` });
      return z.NEVER;
    }
    const leido = parsearImporte(t);
    if (leido.valor === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${campo} debe ser numérico.` });
      return z.NEVER;
    }
    if (leido.ambiguo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${campo}: "${t}" admite dos lecturas y la diferencia puede ser de cien veces. ` +
          "Mandá el número sin separador de miles (por ejemplo 6500, no \"6.500\"), " +
          "usando el punto solo para decimales (6.5 = seis con cincuenta).",
      });
      return z.NEVER;
    }
    return leido.valor;
  });
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
export function esFechaIsoReal(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const fecha = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === v;
}

export function fechaIso(campo: string) {
  return z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      `${campo} usa formato ISO aaaa-mm-dd (ej: "2026-05-28"). ` +
        "Ojo: las fechas de EMISIÓN de un CFE usan dd/mm/aaaa; ésta no.",
    )
    .refine(esFechaIsoReal, `${campo} debe ser una fecha real.`);
}

/** Redondeo monetario a 2 decimales, estable ante el error de coma flotante. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
