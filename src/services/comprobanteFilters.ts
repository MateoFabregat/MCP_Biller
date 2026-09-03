// =============================================================================
// Filtros LOCALES sobre comprobantes ya normalizados.
//
// Biller NO documenta filtros nativos por moneda ni por cliente para
// /v2/comprobantes/obtener, así que estos filtros se aplican en memoria sobre
// la respuesta recibida. Cuando un filtro no se puede aplicar de forma
// confiable (p.ej. cliente_rut, cuya estructura no está documentada), se
// reporta un warning y NO se descartan resultados silenciosamente.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido, ComprobanteRecibido } from "../biller/types.js";
import { classifyCfe, type CfeClassification } from "./cfeTypes.js";
import { clasificarEstado, estaAceptado } from "./estadoDgi.js";

// =============================================================================
// LA REGLA DE QUÉ SUMA EN UN TOTAL DE FACTURACIÓN
//
// Vive acá, una sola vez, porque es la regla que decide si el número que
// contesta el asistente coincide con el que muestra el panel de Biller. Dos
// implementaciones de esto es la única categoría de bug que el proyecto declara
// prohibida (ver docs/HANDBOOK.md, "dejar la lógica compartida adentro de una
// tool"): el día que una cambie y la otra no, dos tools contestan totales
// distintos PARA LOS MISMOS COMPROBANTES y nada falla — nadie se entera hasta
// que un cliente lo nota.
//
// Son dos condiciones, y ninguna es opcional:
//
//   1. `suma_en_resumen` (de `classifyCfe`): ventas +1, notas de crédito −1,
//      notas de débito +1; recibos, especiales (eRemito/eResguardo) y tipos no
//      clasificables NO aportan. El recibo es el caso traicionero: se emite
//      como e-Ticket/e-Factura, así que por tipo es indistinguible de una
//      venta, y sumarlo duplica lo ya facturado.
//
//   2. El estado DGI, cuando `solo_aceptados` (el default de todas las tools de
//      análisis): solo "Aceptado DGI". Es el criterio con el que Biller arma
//      sus propios totales (docs/CALCULOS.md §1); contar rechazados o
//      pendientes da un número que no cierra contra el panel.
//
//      Un estado que no reconocemos (null, vacío, o un texto nuevo) TAMPOCO
//      cuenta: no se puede afirmar que Biller lo esté sumando. El aviso al
//      usuario compensa lo que eso tiene de injusto — ver `estaAceptado` en
//      `estadoDgi.ts`.
//
// `clasificarEstado` HAY UNA SOLA, y vive en `estadoDgi.ts`. Hasta agosto de
// 2026 había dos con el mismo nombre y semánticas distintas —la otra estaba en
// `resumenFacturacion.ts` y contaba el estado desconocido—, así que cambiar un
// import por el otro movía totales sin que ningún chequeo de tipos chillara.
// Lo que sigue siendo distinto es `esVentaValida` (mismo archivo), que responde
// otra pregunta —si el CFE es respaldo fiscal válido— y ahí "Envío no
// corresponde" SÍ cuenta. Esa no decide totales: no la uses para sumar plata.
// =============================================================================

/**
 * Clasificación del CFE si el comprobante entra en un total de facturación;
 * `null` si no entra.
 *
 * Devuelve la clasificación y no un booleano a propósito: quien filtra necesita
 * después el `signo` para que la nota de crédito reste, y volver a llamar a
 * `classifyCfe` afuera es exactamente la costura por la que se cuela la segunda
 * copia de la regla.
 *
 * NO valida `total` ni `moneda`: eso depende de qué esté sumando cada llamador
 * (hay agregados que suman `total` del comprobante y otros que suman
 * `cantidad × precio` de los items), y meterlo acá haría que esta función
 * mienta sobre lo que decide.
 */
export function clasificarParaFacturacion(
  c: ComprobanteEmitido,
  soloAceptados: boolean,
): CfeClassification | null {
  const clasif = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
  if (!clasif.suma_en_resumen) return null;
  if (soloAceptados && !estaAceptado(c.estado)) return null;
  return clasif;
}

/**
 * Cuántos comprobantes que POR TIPO entrarían en un total de facturación traen
 * un estado DGI que no se puede leer (null, vacío, o un texto irreconocible).
 *
 * Existe porque el criterio estricto de `estaAceptado` los deja afuera, y este
 * proyecto se comprometió a que ninguna exclusión por estado sea silenciosa:
 * quien excluye tiene que poder decir cuántos excluyó. Filtra por
 * `suma_en_resumen` a propósito — contar acá un recibo o un eRemito sin estado
 * inflaría un aviso sobre un comprobante que igual no iba a sumar.
 */
export function contarSinEstadoConocido(comprobantes: ComprobanteEmitido[]): number {
  return comprobantes.reduce((n, c) => {
    if (!classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia).suma_en_resumen) return n;
    return clasificarEstado(c.estado) === "desconocido" ? n + 1 : n;
  }, 0);
}

/**
 * Importe NETO facturado en UNA moneda, sumando el `total` de cada comprobante
 * con su signo.
 *
 * Es la lectura a nivel COMPROBANTE, que es lo que permite calcular una
 * cobertura sin haber traído el detalle de items de todos (ver
 * `tools/rankingProductos.ts`: el detalle es un N+1 acotado).
 *
 * Un comprobante sin `total`, o en otra moneda, no suma: no se convierte
 * moneda en ningún lado del proyecto.
 */
export function importeFacturadoEnMoneda(
  comprobantes: ComprobanteEmitido[],
  moneda: string,
  soloAceptados: boolean,
): number {
  return round2(
    comprobantes.reduce((acc, c) => {
      const clasif = clasificarParaFacturacion(c, soloAceptados);
      if (clasif === null) return acc;
      if (c.total === null || c.moneda !== moneda) return acc;
      return acc + c.total * clasif.signo;
    }, 0),
  );
}

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
    // Comprobantes sin fecha_emision no se pueden ubicar en el período: se
    // excluyen, pero lo avisamos explícitamente para no confundir al usuario.
    const sinFechaEmision = list.filter((c) => !c.fecha_emision).length;
    list = list.filter((c) =>
      dentroDeFechaEmision(c.fecha_emision, filters.emitidas_desde, filters.emitidas_hasta),
    );
    warnings.push(
      `Filtro LOCAL por fecha de EMISIÓN aplicado (${filters.emitidas_desde ?? "…"} a ${filters.emitidas_hasta ?? "…"}): ` +
        `de ${antes} comprobantes quedaron ${list.length}. Nota: 'desde'/'hasta' de la API filtran por fecha de CREACIÓN; ` +
        "este filtro adicional usa la fecha fiscal (fecha_emision) sobre lo ya recibido.",
    );
    if (sinFechaEmision > 0) {
      warnings.push(
        `${sinFechaEmision} comprobante(s) se excluyeron del filtro por NO tener fecha_emision ` +
          "(no se pueden ubicar en el período). Quitá el filtro emitidas_desde/emitidas_hasta para verlos.",
      );
    }
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
