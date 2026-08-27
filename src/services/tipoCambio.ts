// =============================================================================
// Equivalente en pesos: cuánto vale, junto, lo que se facturó en varias monedas.
//
// EL PROBLEMA. "¿Cuánto facturé este mes?" con facturación en UYU y en USD hoy
// se contesta con dos números que no se pueden sumar. Es correcto —convertir con
// una cotización inventada sería peor— pero deja al dueño de la PyME haciendo la
// cuenta a mano, que es exactamente lo que vino a evitar.
//
// LA SOLUCIÓN, Y POR QUÉ ES LEGÍTIMA. Cada CFE en moneda extranjera trae su
// PROPIA cotización en el campo `tasa_cambio` (la UI de Biller la muestra como
// "Cotización: 38,397"). Es el tipo de cambio que quedó declarado ante DGI en
// ese comprobante: no es un dato de mercado que haya que ir a buscar, ni una
// estimación, ni algo que el modelo pueda inferir. Multiplicar el total por esa
// tasa da el equivalente en pesos QUE EL PROPIO COMPROBANTE DECLARA.
//
// Es aritmética sobre un campo de la respuesta: determinístico, auditable y
// reproducible. Dos corridas sobre los mismos comprobantes dan el mismo número.
//
// LO QUE ESTE NÚMERO NO ES:
//   - NO es el valor de hoy de esa facturación. Una factura en USD de enero
//     está convertida a la cotización de enero, no a la de hoy. Para el total
//     facturado eso es lo CORRECTO (es el criterio contable y el que usa DGI),
//     pero no sirve para responder "¿cuánto valen hoy mis dólares?".
//   - NO reemplaza a `totales_por_moneda`. El desglose por moneda sigue siendo
//     la verdad primaria; esto es una lectura derivada que se ofrece al lado.
//
// COBERTURA. Si algún comprobante en moneda extranjera viene sin tasa utilizable
// no se inventa ninguna: ese monto queda FUERA del equivalente y el resultado
// declara cuánto quedó afuera. Un total "casi completo" sin avisar es peor que
// no dar total.
// =============================================================================

import { round2 } from "../biller/coerce.js";

/** Moneda base del equivalente. Todo se expresa en pesos uruguayos. */
export const MONEDA_BASE = "UYU";

/**
 * Códigos que Biller/DGI usan para el peso uruguayo. "UYU" es el ISO; se acepta
 * también el numérico de DGI (858) y la forma corta por si aparece en un CFE
 * viejo. No se agrega "$": es ambiguo entre peso y dólar.
 */
const ALIAS_MONEDA_BASE = new Set(["UYU", "858", "UY", "PESOS", "PESO URUGUAYO"]);

export function esMonedaBase(moneda: string | null): boolean {
  return moneda !== null && ALIAS_MONEDA_BASE.has(moneda.trim().toUpperCase());
}

/** De dónde salió la tasa usada para convertir un comprobante. */
export type OrigenTasa =
  /** El comprobante ya está en pesos: la tasa es 1 por definición. */
  | "moneda_base"
  /** Se usó el campo `tasa_cambio` del propio comprobante. */
  | "tasa_del_comprobante"
  /** Moneda extranjera sin tasa utilizable: NO se convierte. */
  | "sin_tasa";

export interface ConversionUyu {
  /** Monto en pesos, o null si no se pudo convertir sin inventar nada. */
  monto_uyu: number | null;
  /** Tasa efectivamente aplicada. 1 para la moneda base. */
  tasa: number | null;
  origen: OrigenTasa;
}

/**
 * Convierte un monto a pesos usando la cotización del propio comprobante.
 *
 * Un `tasa_cambio` de 0, negativo o ausente en moneda extranjera se trata como
 * ausente: multiplicar por 0 daría un equivalente de $0 para una factura real,
 * que es el peor error posible acá (silencioso y a la baja).
 */
export function convertirAUyu(
  monto: number,
  moneda: string | null,
  tasaCambio: number | null,
): ConversionUyu {
  if (esMonedaBase(moneda)) {
    return { monto_uyu: round2(monto), tasa: 1, origen: "moneda_base" };
  }
  if (tasaCambio !== null && Number.isFinite(tasaCambio) && tasaCambio > 0) {
    return {
      monto_uyu: round2(monto * tasaCambio),
      tasa: tasaCambio,
      origen: "tasa_del_comprobante",
    };
  }
  return { monto_uyu: null, tasa: null, origen: "sin_tasa" };
}

export interface DetalleMonedaUyu {
  moneda: string;
  /** Suma en la moneda original (con signo: las notas de crédito restan). */
  total_original: number;
  /** Equivalente en pesos de la parte convertible. */
  total_uyu: number;
  comprobantes: number;
  /** Comprobantes que no se pudieron convertir por falta de tasa. */
  sin_tasa: number;
  /**
   * Cotización promedio PONDERADA POR MONTO (no por cantidad de comprobantes):
   * una factura de USD 10.000 pesa más en el promedio que una de USD 10.
   * Se pondera por el valor absoluto para que una nota de crédito no invierta
   * el peso de su factura.
   */
  tasa_promedio_ponderada: number | null;
  tasa_minima: number | null;
  tasa_maxima: number | null;
}

export interface EquivalenteUyuResultado {
  moneda_base: typeof MONEDA_BASE;
  /** Suma en pesos de todo lo que se pudo convertir. */
  total_uyu: number;
  /** true si TODOS los comprobantes con monto entraron en el total. */
  completo: boolean;
  comprobantes_convertidos: number;
  comprobantes_sin_tasa: number;
  /** Qué proporción de los comprobantes entró en el equivalente (0–100). */
  cobertura_pct: number;
  por_moneda: Record<string, DetalleMonedaUyu>;
  /** Cómo se calculó, en una línea. Viaja con el número para que no se lea mal. */
  metodo: string;
  warnings: string[];
}

export const METODO_EQUIVALENTE =
  "Suma de (total × tasa_cambio) tomando la cotización declarada en CADA comprobante. " +
  "Es aritmética sobre un campo de la API, no una estimación ni una cotización de mercado: " +
  "una factura en USD queda valuada a la cotización del día en que se emitió, que es el " +
  "criterio contable. NO es el valor de hoy de esa facturación.";

/**
 * Acumulador incremental. Existe como clase —y no como función sobre una lista—
 * para poder calcularse DENTRO del mismo recorrido que arma los totales por
 * moneda: si fueran dos recorridos con dos criterios de inclusión, tarde o
 * temprano divergen y el equivalente deja de corresponder al total que acompaña.
 */
export class AcumuladorUyu {
  private readonly porMoneda = new Map<
    string,
    { original: number; uyu: number; conteo: number; sinTasa: number; pesoTasa: number; peso: number; min: number | null; max: number | null }
  >();

  /**
   * @param monto Monto YA con signo aplicado (las notas de crédito llegan en negativo).
   */
  agregar(monto: number, moneda: string, tasaCambio: number | null): ConversionUyu {
    const conv = convertirAUyu(monto, moneda, tasaCambio);
    const bucket = this.porMoneda.get(moneda) ?? {
      original: 0,
      uyu: 0,
      conteo: 0,
      sinTasa: 0,
      pesoTasa: 0,
      peso: 0,
      min: null,
      max: null,
    };

    bucket.original = round2(bucket.original + monto);
    bucket.conteo += 1;

    if (conv.monto_uyu === null || conv.tasa === null) {
      bucket.sinTasa += 1;
    } else {
      bucket.uyu = round2(bucket.uyu + conv.monto_uyu);
      const peso = Math.abs(monto);
      bucket.pesoTasa += conv.tasa * peso;
      bucket.peso += peso;
      bucket.min = bucket.min === null ? conv.tasa : Math.min(bucket.min, conv.tasa);
      bucket.max = bucket.max === null ? conv.tasa : Math.max(bucket.max, conv.tasa);
    }

    this.porMoneda.set(moneda, bucket);
    return conv;
  }

  resultado(): EquivalenteUyuResultado {
    const por_moneda: Record<string, DetalleMonedaUyu> = {};
    let total_uyu = 0;
    let convertidos = 0;
    let sinTasa = 0;

    for (const [moneda, b] of this.porMoneda) {
      total_uyu = round2(total_uyu + b.uyu);
      convertidos += b.conteo - b.sinTasa;
      sinTasa += b.sinTasa;
      por_moneda[moneda] = {
        moneda,
        total_original: b.original,
        total_uyu: b.uyu,
        comprobantes: b.conteo,
        sin_tasa: b.sinTasa,
        tasa_promedio_ponderada: b.peso > 0 ? round2(b.pesoTasa / b.peso) : null,
        tasa_minima: b.min,
        tasa_maxima: b.max,
      };
    }

    const totalComprobantes = convertidos + sinTasa;
    const warnings: string[] = [];

    if (sinTasa > 0) {
      const monedas = Object.values(por_moneda)
        .filter((m) => m.sin_tasa > 0)
        .map((m) => `${m.moneda}: ${m.sin_tasa}`)
        .join(", ");
      warnings.push(
        `${sinTasa} comprobante(s) en moneda extranjera vinieron SIN cotización utilizable ` +
          `(${monedas}) y quedaron FUERA del equivalente en pesos. El total en ${MONEDA_BASE} está ` +
          "incompleto por ese monto: no se estimó ninguna tasa para rellenarlo.",
      );
    }

    // Una dispersión grande de cotizaciones dentro del mismo período no es un
    // error, pero cambia cómo se lee el número: sumar meses con el dólar a 38 y
    // a 44 da un total en pesos que ninguna cotización única reproduce.
    for (const m of Object.values(por_moneda)) {
      if (m.moneda === MONEDA_BASE || m.tasa_minima === null || m.tasa_maxima === null) continue;
      if (m.tasa_minima <= 0) continue;
      const dispersion = (m.tasa_maxima - m.tasa_minima) / m.tasa_minima;
      if (dispersion >= 0.05) {
        warnings.push(
          `Las cotizaciones de ${m.moneda} en el período van de ${m.tasa_minima} a ${m.tasa_maxima} ` +
            `(${Math.round(dispersion * 100)}% de diferencia). Cada comprobante se convirtió con la ` +
            "suya, que es lo correcto, pero el total en pesos no se reproduce con una cotización única.",
        );
      }
    }

    return {
      moneda_base: MONEDA_BASE,
      total_uyu,
      completo: sinTasa === 0,
      comprobantes_convertidos: convertidos,
      comprobantes_sin_tasa: sinTasa,
      cobertura_pct: totalComprobantes > 0 ? round2((convertidos / totalComprobantes) * 100) : 100,
      por_moneda,
      metodo: METODO_EQUIVALENTE,
      warnings,
    };
  }
}
