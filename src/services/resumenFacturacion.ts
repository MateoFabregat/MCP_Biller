// =============================================================================
// Servicio de agregación: resumen de facturación por período.
//
// Reglas (ver PLAN §9):
//  - Separar totales por moneda. NO convertir monedas.
//  - Ventas suman; Notas de Crédito restan; Notas de Débito suman.
//  - Especiales (eRemito/eResguardo/eRemito exportación) NO se suman.
//  - Si falta total, moneda o tipo_comprobante -> excluir del cálculo + warning.
//  - Anulados: solo se pueden excluir si hay un campo de estado/anulación
//    documentado. Como en emitidos NO existe, se emite warning.
// =============================================================================

import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe, type CfeCategoria } from "./cfeTypes.js";

export interface MonedaTotal {
  total: number;
  comprobantes: number;
}

export interface TipoTotal {
  tipo: number;
  categoria: CfeCategoria;
  etiqueta: string;
  signo: 1 | -1 | 0;
  /** Total (con signo aplicado) separado por moneda. */
  total_por_moneda: Record<string, number>;
  conteo: number;
}

export interface ResumenResultado {
  totales_por_moneda: Record<string, MonedaTotal>;
  totales_por_tipo_comprobante: Record<string, TipoTotal>;
  conteo_por_tipo_comprobante: Record<string, number>;
  conteo_total: number;
  conteo_incluidos: number;
  conteo_excluidos: number;
  warnings: string[];
  no_convertir_moneda: true;
}

export interface ResumenOptions {
  incluir_anulados: boolean;
}

const ANULACION_FIELDS = ["estado", "anulado", "anulada", "anulacion", "cancelado", "activo"];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function resumirFacturacion(
  comprobantes: ComprobanteEmitido[],
  options: ResumenOptions,
): ResumenResultado {
  const totales_por_moneda: Record<string, MonedaTotal> = {};
  const totales_por_tipo_comprobante: Record<string, TipoTotal> = {};
  const conteo_por_tipo_comprobante: Record<string, number> = {};
  const warningsSet = new Set<string>();

  let conteo_incluidos = 0;
  let conteo_excluidos = 0;

  for (const c of comprobantes) {
    // Validación de campos mínimos: si falta alguno, no inventar -> excluir.
    if (c.total === null || c.moneda === null || c.tipo_comprobante === null) {
      conteo_excluidos += 1;
      warningsSet.add(
        "Se excluyeron del cálculo uno o más comprobantes por faltar total, moneda o tipo_comprobante.",
      );
      continue;
    }

    const clasif = classifyCfe(c.tipo_comprobante);

    if (clasif.categoria === "desconocido") {
      conteo_excluidos += 1;
      warningsSet.add(
        `Tipo de comprobante ${c.tipo_comprobante} no clasificable: se excluyó del total (no se inventa categoría).`,
      );
      continue;
    }

    if (clasif.categoria === "especial") {
      conteo_excluidos += 1;
      warningsSet.add(
        `Comprobante tipo ${c.tipo_comprobante} (${clasif.etiqueta}) es especial: no se suma automáticamente sin validación.`,
      );
      continue;
    }

    // Aporte al total (con signo).
    const moneda = c.moneda;
    const aporte = clasif.signo * c.total;

    const bucket = (totales_por_moneda[moneda] ??= { total: 0, comprobantes: 0 });
    bucket.total = round2(bucket.total + aporte);
    bucket.comprobantes += 1;

    const tipoKey = String(c.tipo_comprobante);
    const tipoBucket = (totales_por_tipo_comprobante[tipoKey] ??= {
      tipo: c.tipo_comprobante,
      categoria: clasif.categoria,
      etiqueta: clasif.etiqueta,
      signo: clasif.signo,
      total_por_moneda: {},
      conteo: 0,
    });
    tipoBucket.total_por_moneda[moneda] = round2(
      (tipoBucket.total_por_moneda[moneda] ?? 0) + aporte,
    );
    tipoBucket.conteo += 1;

    conteo_por_tipo_comprobante[tipoKey] = (conteo_por_tipo_comprobante[tipoKey] ?? 0) + 1;
    conteo_incluidos += 1;
  }

  // Anulación: ¿hay algún campo de estado/anulación en los datos crudos?
  const hayCampoAnulacion = comprobantes.some((c) =>
    c.campos_presentes.some((k) => ANULACION_FIELDS.includes(k.toLowerCase())),
  );
  if (!hayCampoAnulacion && !options.incluir_anulados) {
    warningsSet.add(
      "No hay un campo documentado de estado/anulación en los comprobantes emitidos: " +
        "no fue posible excluir anulados. El total podría incluir comprobantes anulados.",
    );
  }

  return {
    totales_por_moneda,
    totales_por_tipo_comprobante,
    conteo_por_tipo_comprobante,
    conteo_total: comprobantes.length,
    conteo_incluidos,
    conteo_excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
