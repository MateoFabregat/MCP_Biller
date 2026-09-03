// =============================================================================
// Catálogo CFE estático para MCP Resources.
//
// No duplica la tabla fiscal: compone el documento desde los mismos exports y
// evaluador que usan las tools de emisión y requisitos.
// =============================================================================

import {
  FORMAS_PAGO,
  INDICADORES_FACTURACION,
  TIPOS_COMPROBANTE,
  TIPOS_DOCUMENTO,
} from "../biller/cfeSchema.js";
import { evaluarRequisitos } from "../biller/requisitos.js";

export const CFE_CATALOG_RESOURCE_URI = "biller://catalogos/cfe";

export interface CatalogoCfe {
  tipos_comprobante: Record<number, string>;
  formas_pago: Record<number, string>;
  tipos_documento: Record<number, string>;
  indicadores_facturacion: Record<number, string>;
  requisitos_por_tipo: Record<number, ReturnType<typeof evaluarRequisitos>>;
}

/**
 * Materializa un snapshot puro y estable del conocimiento local de CFE.
 * No recibe contexto ni consulta Biller: una Resource no representa datos de
 * tenant ni una operación del operador.
 */
export function crearCatalogoCfe(): CatalogoCfe {
  const requisitos_por_tipo: Record<number, ReturnType<typeof evaluarRequisitos>> = {};
  for (const tipo of Object.keys(TIPOS_COMPROBANTE).map(Number).sort((a, b) => a - b)) {
    requisitos_por_tipo[tipo] = evaluarRequisitos(tipo);
  }
  return {
    tipos_comprobante: TIPOS_COMPROBANTE,
    formas_pago: FORMAS_PAGO,
    tipos_documento: TIPOS_DOCUMENTO,
    indicadores_facturacion: INDICADORES_FACTURACION,
    requisitos_por_tipo,
  };
}

export function catalogoCfeComoTexto(): string {
  return `${JSON.stringify(crearCatalogoCfe(), null, 2)}\n`;
}
