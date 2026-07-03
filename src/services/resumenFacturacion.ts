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
  /** Conteo de comprobantes por estado DGI (ej. "Aceptado DGI", "Rechazado DGI"). */
  conteo_por_estado: Record<string, number>;
  conteo_total: number;
  conteo_incluidos: number;
  conteo_excluidos: number;
  warnings: string[];
  no_convertir_moneda: true;
}

/** Estado que indica que el CFE fue aceptado por DGI (cuenta "en firme"). */
const ESTADO_ACEPTADO = /aceptado/i;
const ESTADO_SIN_DATO = "(sin estado)";

export interface ResumenOptions {
  incluir_anulados: boolean;
}

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
  const conteo_por_estado: Record<string, number> = {};
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

    // Desglose por estado DGI de los comprobantes que SÍ entran al total.
    const estadoKey = c.estado ?? ESTADO_SIN_DATO;
    conteo_por_estado[estadoKey] = (conteo_por_estado[estadoKey] ?? 0) + 1;

    conteo_incluidos += 1;
  }

  // Estado DGI: el total incluye TODOS los estados (configurado: "contar todos").
  // Avisamos explícitamente cuántos NO están aceptados para que el usuario sepa
  // que el total puede no coincidir con lo realmente válido ante DGI.
  let noAceptados = 0;
  for (const [estado, n] of Object.entries(conteo_por_estado)) {
    if (estado === ESTADO_SIN_DATO || ESTADO_ACEPTADO.test(estado)) continue;
    noAceptados += n;
  }
  if (noAceptados > 0) {
    const detalle = Object.entries(conteo_por_estado)
      .filter(([e]) => e !== ESTADO_SIN_DATO && !ESTADO_ACEPTADO.test(e))
      .map(([e, n]) => `${e}: ${n}`)
      .join(", ");
    warningsSet.add(
      `El total INCLUYE ${noAceptados} comprobante(s) que NO están en estado "Aceptado DGI" ` +
        `(${detalle}). El monto declarado puede no coincidir con lo aceptado por DGI. ` +
        "Revisá 'conteo_por_estado' para el desglose.",
    );
  }

  // Anulación: NO existe un estado "Anulado". Anular un CFE genera una Nota de
  // Crédito separada (documentado). Por eso este resumen no puede "excluir
  // anulados" por un flag; lo aclaramos para no dar falsa sensación de filtrado.
  if (!options.incluir_anulados) {
    warningsSet.add(
      "Nota sobre anulados: anular un CFE genera una Nota de Crédito separada (no hay estado " +
        '"Anulado"). Este resumen no detecta anulaciones por estado; si una venta fue anulada, ' +
        "su Nota de Crédito ya resta en el total.",
    );
  }

  return {
    totales_por_moneda,
    totales_por_tipo_comprobante,
    conteo_por_tipo_comprobante,
    conteo_por_estado,
    conteo_total: comprobantes.length,
    conteo_incluidos,
    conteo_excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
