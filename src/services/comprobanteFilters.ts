// =============================================================================
// Filtros LOCALES sobre comprobantes ya normalizados.
//
// Biller NO documenta filtros nativos por moneda ni por cliente para
// /v2/comprobantes/obtener, así que estos filtros se aplican en memoria sobre
// la respuesta recibida. Cuando un filtro no se puede aplicar de forma
// confiable (p.ej. cliente_rut, cuya estructura no está documentada), se
// reporta un warning y NO se descartan resultados silenciosamente.
// =============================================================================

import type { ComprobanteEmitido, ComprobanteRecibido } from "../biller/types.js";
import { extractClienteRut } from "../biller/normalize.js";

export interface EmitidoFilterInput {
  moneda?: string;
  cliente_rut?: string;
  /** Filtro LOCAL por fecha de EMISIÓN fiscal (aaaa-mm-dd), inclusive. */
  emitidas_desde?: string;
  emitidas_hasta?: string;
}

/** Compara la parte fecha (aaaa-mm-dd) de fecha_emision contra un rango. */
function dentroDeFechaEmision(
  fechaEmision: string | null,
  desde?: string,
  hasta?: string,
): boolean {
  if (!fechaEmision) return false; // sin fecha de emisión no se puede ubicar en el período
  const dia = fechaEmision.slice(0, 10); // "2026-06-30 ..." -> "2026-06-30"
  if (desde && dia < desde) return false;
  if (hasta && dia > hasta) return false;
  return true;
}

export interface FilterOutput<T> {
  list: T[];
  warnings: string[];
}

function sameRut(a: string | null, b: string): boolean {
  if (!a) return false;
  const norm = (s: string) => s.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  return norm(a) === norm(b);
}

export function filterEmitidos(
  comprobantes: ComprobanteEmitido[],
  filters: EmitidoFilterInput,
): FilterOutput<ComprobanteEmitido> {
  const warnings: string[] = [];
  let list = comprobantes;

  if (filters.moneda) {
    const target = filters.moneda.trim().toUpperCase();
    list = list.filter((c) => (c.moneda ?? "").toUpperCase() === target);
  }

  if (filters.emitidas_desde || filters.emitidas_hasta) {
    const antes = list.length;
    list = list.filter((c) =>
      dentroDeFechaEmision(c.fecha_emision, filters.emitidas_desde, filters.emitidas_hasta),
    );
    warnings.push(
      `Filtro LOCAL por fecha de EMISIÓN aplicado (${filters.emitidas_desde ?? "…"} a ${filters.emitidas_hasta ?? "…"}): ` +
        `de ${antes} comprobantes quedaron ${list.length}. Nota: 'desde'/'hasta' de la API filtran por fecha de CREACIÓN; ` +
        "este filtro adicional usa la fecha fiscal (fecha_emision) sobre lo ya recibido.",
    );
  }

  if (filters.cliente_rut) {
    // Solo aplicable si el RUT es extraíble del campo `cliente` (no documentado).
    const extractable = comprobantes.some((c) => extractClienteRut(c.cliente) !== null);
    if (!extractable) {
      warnings.push(
        "No se pudo filtrar por cliente_rut: la estructura del campo 'cliente' de los comprobantes " +
          "emitidos no está documentada (en los ejemplos viene vacío). El filtro por cliente_rut se ignoró.",
      );
    } else {
      list = list.filter((c) => sameRut(extractClienteRut(c.cliente), filters.cliente_rut!));
    }
  }

  return { list, warnings };
}

export interface RecibidoFilterInput {
  proveedor_rut?: string;
  moneda?: string;
  tipo?: number;
  estado?: string;
}

export function filterRecibidos(
  comprobantes: ComprobanteRecibido[],
  filters: RecibidoFilterInput,
): FilterOutput<ComprobanteRecibido> {
  const warnings: string[] = [];
  let list = comprobantes;

  if (filters.proveedor_rut) {
    list = list.filter((c) => sameRut(c.rut_emisor, filters.proveedor_rut!));
  }
  if (filters.moneda) {
    const target = filters.moneda.trim().toUpperCase();
    list = list.filter((c) => (c.moneda ?? "").toUpperCase() === target);
  }
  if (filters.tipo !== undefined) {
    list = list.filter((c) => c.tipo === filters.tipo);
  }
  if (filters.estado) {
    const target = filters.estado.trim().toUpperCase();
    list = list.filter((c) => (c.estado ?? "").toUpperCase() === target);
  }

  return { list, warnings };
}
