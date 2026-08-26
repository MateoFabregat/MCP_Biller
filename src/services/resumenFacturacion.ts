// =============================================================================
// Servicio de agregación: resumen de facturación por período.
//
// Reglas:
//  - Separar totales por moneda. NO convertir monedas.
//  - Ventas suman; Notas de Crédito restan; Notas de Débito suman.
//  - Especiales (eRemito/eResguardo/eRemito exportación) NO se suman.
//  - Si falta total, moneda o tipo_comprobante -> excluir del cálculo + warning.
//
// ESTADO DGI (`solo_aceptados`, default true): por defecto el total cuenta
// únicamente los comprobantes en estado "Aceptado DGI", que es el criterio con
// el que Biller muestra sus propios números. Contar los rechazados/pendientes
// da un total que no coincide con el panel de Biller. El total con todos los
// estados se devuelve igual, aparte, para poder comparar.
//
// AGRUPACIÓN (`agrupar_por`): permite cortar el período por sucursal, día, mes,
// tipo de comprobante, moneda o cliente — p.ej. "cuánto vendí en cada local".
//
// EQUIVALENTE EN PESOS (`equivalente_uyu`): además del desglose por moneda —que
// sigue siendo la verdad primaria— se ofrece la suma en UYU calculada con la
// cotización que trae CADA comprobante. Ver `tipoCambio.ts`: es aritmética
// sobre `tasa_cambio`, no una estimación.
//
// DETALLE (`incluir_detalle`): la lista de los comprobantes que forman el
// total, con el aporte de cada uno. Se arma DENTRO del mismo recorrido que
// suma, para que "las facturas de este total" sean exactamente las que se
// sumaron y no una segunda consulta con otro criterio.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe, type CfeCategoria } from "./cfeTypes.js";
import { SIN_RECEPTOR } from "./rankingClientes.js";
import { AcumuladorUyu, type EquivalenteUyuResultado } from "./tipoCambio.js";

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

/** Dimensiones por las que se puede cortar el resumen. */
export type Dimension = "sucursal" | "dia" | "mes" | "tipo_comprobante" | "moneda" | "cliente" | "estado";

export const DIMENSIONES: Dimension[] = [
  "sucursal",
  "dia",
  "mes",
  "tipo_comprobante",
  "moneda",
  "cliente",
  "estado",
];

export interface GrupoResumen {
  /** Valor de cada dimensión de agrupación, ej: { sucursal: "6" }. */
  clave: Record<string, string>;
  /** Texto legible del grupo, ej: "Sucursal 6 (Pocitos)". */
  etiqueta: string;
  totales_por_moneda: Record<string, MonedaTotal>;
  conteo: number;
}

/**
 * Un comprobante tal como entró (o no) al total. Es la respuesta a "mostrame
 * las facturas de ese número": trae el `id` con el que se puede pedir el
 * detalle completo a `biller_obtener_comprobante`.
 */
export interface ComprobanteDelTotal {
  id: number | null;
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  categoria: CfeCategoria;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  estado: string | null;
  moneda: string;
  total: number;
  /** Aporte al total con el signo aplicado (negativo en notas de crédito). */
  aporte: number;
  /** Cotización declarada en el comprobante. null en moneda base. */
  tasa_cambio: number | null;
  /** Aporte convertido a pesos con esa cotización. null si no había tasa. */
  aporte_uyu: number | null;
  cliente_rut: string | null;
  cliente_nombre: string | null;
  sucursal: number | null;
}

export interface ResumenResultado {
  /** Totales según el criterio de estado activo (por defecto, solo aceptados). */
  totales_por_moneda: Record<string, MonedaTotal>;
  /**
   * Suma en pesos de `totales_por_moneda`, usando la cotización de cada
   * comprobante. Convive con el desglose, no lo reemplaza.
   */
  equivalente_uyu: EquivalenteUyuResultado;
  /** Ídem para `cobrado_por_moneda`. */
  equivalente_uyu_cobrado: EquivalenteUyuResultado;
  /** Comprobantes que forman el total. Vacío salvo que se pida `incluir_detalle`. */
  detalle: ComprobanteDelTotal[];
  /** true si el detalle se recortó por `limite_detalle` (los totales NO se recortan). */
  detalle_truncado: boolean;
  /**
   * Recibos emitidos en el período (`indicador_cobranza_propia = 1`). NO forman
   * parte de `totales_por_moneda`: son cobro de facturación previa, que puede
   * ser de otro período.
   */
  cobrado_por_moneda: Record<string, MonedaTotal>;
  /** Totales contando TODOS los estados DGI, para comparar. */
  totales_por_moneda_todos_los_estados: Record<string, MonedaTotal>;
  totales_por_tipo_comprobante: Record<string, TipoTotal>;
  conteo_por_tipo_comprobante: Record<string, number>;
  /** Conteo de comprobantes por estado DGI (ej. "Aceptado DGI", "Rechazado DGI"). */
  conteo_por_estado: Record<string, number>;
  /** Cortes del período por las dimensiones pedidas. Vacío si no se agrupó. */
  grupos: GrupoResumen[];
  agrupado_por: Dimension[];
  solo_aceptados: boolean;
  conteo_total: number;
  conteo_incluidos: number;
  conteo_excluidos: number;
  warnings: string[];
  no_convertir_moneda: true;
}

/** Estado que indica que el CFE fue aceptado por DGI (cuenta "en firme"). */
const ESTADO_ACEPTADO = /aceptado/i;
/** "Sobre Rechazado DGI" contiene "echazado" pero también hay que descartarlo. */
const ESTADO_RECHAZADO = /rechazado/i;
const ESTADO_SIN_DATO = "(sin estado)";

export interface ResumenOptions {
  incluir_anulados: boolean;
  /** Default true: contar solo "Aceptado DGI" (criterio que usa Biller). */
  solo_aceptados?: boolean;
  agrupar_por?: Dimension[];
  /** Mapa id de sucursal -> nombre legible, desde configuración. */
  nombres_sucursal?: Record<string, string>;
  /** Devolver la lista de comprobantes que forman el total. Default false. */
  incluir_detalle?: boolean;
  /** Tope de filas del detalle. Default 200. No afecta a los totales. */
  limite_detalle?: number;
}

/**
 * Clasifica el estado DGI de un comprobante.
 *
 * `desconocido` (estado null o con un texto que no reconocemos) NO es lo mismo
 * que rechazado: la ausencia del dato no es evidencia de rechazo. Excluir esos
 * comprobantes del total daría un número bajo sin motivo. Se cuentan, y se
 * avisa cuántos fueron.
 */
export type EstadoDgi = "aceptado" | "no_aceptado" | "desconocido";

export function clasificarEstado(estado: string | null): EstadoDgi {
  if (estado === null || estado.trim() === "") return "desconocido";
  if (ESTADO_RECHAZADO.test(estado)) return "no_aceptado";
  if (ESTADO_ACEPTADO.test(estado)) return "aceptado";
  // "Pendiente DGI", "Envío no corresponde", etc.
  return "no_aceptado";
}

/** true si el estado indica aceptación efectiva por DGI. */
export function estaAceptado(estado: string | null): boolean {
  return clasificarEstado(estado) === "aceptado";
}

function valorDimension(
  c: ComprobanteEmitido,
  dim: Dimension,
  nombresSucursal: Record<string, string>,
): { valor: string; etiqueta: string } {
  switch (dim) {
    case "sucursal": {
      const id = c.sucursal === null ? "(sin sucursal)" : String(c.sucursal);
      const nombre = nombresSucursal[id];
      return { valor: id, etiqueta: nombre ? `Sucursal ${id} (${nombre})` : `Sucursal ${id}` };
    }
    case "dia": {
      const dia = c.fecha_emision?.slice(0, 10) ?? "(sin fecha)";
      return { valor: dia, etiqueta: dia };
    }
    case "mes": {
      const mes = c.fecha_emision?.slice(0, 7) ?? "(sin fecha)";
      return { valor: mes, etiqueta: mes };
    }
    case "tipo_comprobante": {
      const tipo = c.tipo_comprobante;
      const clasif = classifyCfe(tipo, c.indicador_cobranza_propia);
      const valor = tipo === null ? "(sin tipo)" : String(tipo);
      return { valor, etiqueta: tipo === null ? "(sin tipo)" : `${tipo} — ${clasif.etiqueta}` };
    }
    case "moneda": {
      const moneda = c.moneda ?? "(sin moneda)";
      return { valor: moneda, etiqueta: moneda };
    }
    case "cliente": {
      const rut = extractClienteRut(c.cliente);
      const valor = rut ?? SIN_RECEPTOR;
      return { valor, etiqueta: valor };
    }
    case "estado": {
      const estado = c.estado ?? ESTADO_SIN_DATO;
      return { valor: estado, etiqueta: estado };
    }
  }
}

export function resumirFacturacion(
  comprobantes: ComprobanteEmitido[],
  options: ResumenOptions,
): ResumenResultado {
  const soloAceptados = options.solo_aceptados ?? true;
  const agruparPor = options.agrupar_por ?? [];
  const nombresSucursal = options.nombres_sucursal ?? {};

  const incluirDetalle = options.incluir_detalle ?? false;
  const limiteDetalle = options.limite_detalle ?? 200;

  const totales_por_moneda: Record<string, MonedaTotal> = {};
  const totales_todos: Record<string, MonedaTotal> = {};
  const cobrado_por_moneda: Record<string, MonedaTotal> = {};
  // Los acumuladores en pesos corren dentro de este mismo bucle a propósito:
  // ver la nota de cabecera de `AcumuladorUyu`.
  const acumuladorUyu = new AcumuladorUyu();
  const acumuladorUyuCobrado = new AcumuladorUyu();
  const detalle: ComprobanteDelTotal[] = [];
  let detalleOmitidos = 0;
  const totales_por_tipo_comprobante: Record<string, TipoTotal> = {};
  const conteo_por_tipo_comprobante: Record<string, number> = {};
  const conteo_por_estado: Record<string, number> = {};
  const gruposMap = new Map<string, GrupoResumen>();
  const warningsSet = new Set<string>();

  let conteo_incluidos = 0;
  let conteo_excluidos = 0;
  let excluidosPorEstado = 0;
  let sinEstadoConocido = 0;

  for (const c of comprobantes) {
    // Validación de campos mínimos: si falta alguno, no inventar -> excluir.
    if (c.total === null || c.moneda === null || c.tipo_comprobante === null) {
      conteo_excluidos += 1;
      warningsSet.add(
        "Se excluyeron del cálculo uno o más comprobantes por faltar total, moneda o tipo_comprobante.",
      );
      continue;
    }

    const clasif = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);

    // Un recibo NO es facturación: es el cobro de un CFE ya facturado. Se emite
    // como e-Ticket/e-Factura, así que sumarlo duplicaría la venta. Se
    // contabiliza aparte, en `cobrado_por_moneda`.
    if (clasif.categoria === "cobranza") {
      conteo_excluidos += 1;
      if (!soloAceptados || clasificarEstado(c.estado) !== "no_aceptado") {
        const bucketCobrado = (cobrado_por_moneda[c.moneda] ??= { total: 0, comprobantes: 0 });
        bucketCobrado.total = round2(bucketCobrado.total + c.total);
        bucketCobrado.comprobantes += 1;
        acumuladorUyuCobrado.agregar(c.total, c.moneda, c.tasa_cambio);
      }
      continue;
    }

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

    const moneda = c.moneda;
    const aporte = clasif.signo * c.total;

    // Desglose por estado DGI de todos los comprobantes clasificables.
    const estadoKey = c.estado ?? ESTADO_SIN_DATO;
    conteo_por_estado[estadoKey] = (conteo_por_estado[estadoKey] ?? 0) + 1;

    // Total con TODOS los estados (referencia de comparación).
    const bucketTodos = (totales_todos[moneda] ??= { total: 0, comprobantes: 0 });
    bucketTodos.total = round2(bucketTodos.total + aporte);
    bucketTodos.comprobantes += 1;

    // Criterio de estado para el total principal. Solo se excluye lo que
    // sabemos que NO fue aceptado; el estado desconocido se cuenta y se avisa.
    const estadoClasificado = clasificarEstado(c.estado);
    if (estadoClasificado === "desconocido") {
      sinEstadoConocido += 1;
    }
    if (soloAceptados && estadoClasificado === "no_aceptado") {
      excluidosPorEstado += 1;
      conteo_excluidos += 1;
      continue;
    }

    const bucket = (totales_por_moneda[moneda] ??= { total: 0, comprobantes: 0 });
    bucket.total = round2(bucket.total + aporte);
    bucket.comprobantes += 1;

    const conversion = acumuladorUyu.agregar(aporte, moneda, c.tasa_cambio);

    if (incluirDetalle) {
      if (detalle.length < limiteDetalle) {
        detalle.push({
          id: c.id,
          tipo_comprobante: c.tipo_comprobante,
          etiqueta_tipo: clasif.etiqueta,
          categoria: clasif.categoria,
          serie: c.serie,
          numero: c.numero,
          fecha_emision: c.fecha_emision?.slice(0, 10) ?? null,
          estado: c.estado,
          moneda,
          total: c.total,
          aporte: round2(aporte),
          tasa_cambio: c.tasa_cambio,
          aporte_uyu: conversion.monto_uyu,
          cliente_rut: extractClienteRut(c.cliente),
          cliente_nombre: extractClienteNombre(c.cliente),
          sucursal: c.sucursal,
        });
      } else {
        detalleOmitidos += 1;
      }
    }

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

    // --- Agrupación ------------------------------------------------------
    if (agruparPor.length > 0) {
      const clave: Record<string, string> = {};
      const etiquetas: string[] = [];
      for (const dim of agruparPor) {
        const { valor, etiqueta } = valorDimension(c, dim, nombresSucursal);
        clave[dim] = valor;
        etiquetas.push(etiqueta);
      }
      const claveGrupo = agruparPor.map((d) => `${d}=${clave[d]}`).join("|");
      const grupo = gruposMap.get(claveGrupo) ?? {
        clave,
        etiqueta: etiquetas.join(" · "),
        totales_por_moneda: {},
        conteo: 0,
      };
      const gb = (grupo.totales_por_moneda[moneda] ??= { total: 0, comprobantes: 0 });
      gb.total = round2(gb.total + aporte);
      gb.comprobantes += 1;
      grupo.conteo += 1;
      gruposMap.set(claveGrupo, grupo);
    }

    conteo_incluidos += 1;
  }

  // --- Warnings sobre el criterio de estado -------------------------------
  const noAceptados = Object.entries(conteo_por_estado)
    .filter(([e]) => e !== ESTADO_SIN_DATO && !estaAceptado(e))
    .map(([e, n]) => `${e}: ${n}`);

  if (sinEstadoConocido > 0) {
    warningsSet.add(
      `${sinEstadoConocido} comprobante(s) vinieron SIN estado DGI. Se contaron en el total: la ` +
        "ausencia del dato no significa que hayan sido rechazados. Verificá esos comprobantes si el " +
        "total no coincide con Biller.",
    );
  }

  if (soloAceptados) {
    if (excluidosPorEstado > 0) {
      warningsSet.add(
        `El total cuenta SOLO comprobantes "Aceptado DGI" (criterio de Biller). Se excluyeron ` +
          `${excluidosPorEstado} comprobante(s) por estado (${noAceptados.join(", ")}). ` +
          "Mirá 'totales_por_moneda_todos_los_estados' para el total sin ese filtro.",
      );
    }
  } else if (noAceptados.length > 0) {
    const total = noAceptados.length;
    warningsSet.add(
      `solo_aceptados=false: el total INCLUYE comprobantes que NO están aceptados por DGI ` +
        `(${noAceptados.join(", ")}). Ese monto NO va a coincidir con lo que muestra Biller. ` +
        `Hay ${total} estado(s) no aceptados en el período.`,
    );
  }

  // Anulación: NO existe un estado "Anulado". Anular un CFE genera una Nota de
  // Crédito separada, que ya resta en el total.
  if (!options.incluir_anulados) {
    warningsSet.add(
      "Nota sobre anulados: anular un CFE genera una Nota de Crédito separada (no hay estado " +
        '"Anulado"). Este resumen no detecta anulaciones por estado; si una venta fue anulada, ' +
        "su Nota de Crédito ya resta en el total.",
    );
  }

  // Ordena los grupos por total descendente de la moneda más frecuente.
  const grupos = [...gruposMap.values()].sort((a, b) => {
    const totalA = Math.max(...Object.values(a.totales_por_moneda).map((m) => m.total), 0);
    const totalB = Math.max(...Object.values(b.totales_por_moneda).map((m) => m.total), 0);
    return totalB - totalA;
  });

  const conteoCobranzas = Object.values(cobrado_por_moneda).reduce(
    (n, m) => n + m.comprobantes,
    0,
  );
  if (conteoCobranzas > 0) {
    warningsSet.add(
      `${conteoCobranzas} recibo(s) de cobranza (indicador_cobranza_propia=1) NO se sumaron a la ` +
        "facturación: son el cobro de comprobantes ya facturados y contarlos duplicaría la venta. " +
        "Su monto está en 'cobrado_por_moneda'. Ojo: ese cobro puede corresponder a facturas de " +
        "períodos anteriores, así que no es 'lo cobrado de lo facturado en este período'.",
    );
  }

  // --- Equivalente en pesos -------------------------------------------------
  const equivalente_uyu = acumuladorUyu.resultado();
  const equivalente_uyu_cobrado = acumuladorUyuCobrado.resultado();
  for (const w of equivalente_uyu.warnings) warningsSet.add(w);

  const monedasDelTotal = Object.keys(totales_por_moneda);
  if (monedasDelTotal.length > 1) {
    warningsSet.add(
      `Se facturó en ${monedasDelTotal.length} monedas (${monedasDelTotal.join(", ")}). ` +
        "'totales_por_moneda' es el dato primario y NO convierte nada. 'equivalente_uyu' suma todo " +
        "en pesos usando la cotización que declara cada comprobante (campo tasa_cambio): sirve para " +
        "tener un único número, no para revaluar la facturación a la cotización de hoy.",
    );
  }

  if (detalleOmitidos > 0) {
    warningsSet.add(
      `El detalle se recortó a ${limiteDetalle} comprobante(s) y quedaron ${detalleOmitidos} afuera. ` +
        "Los TOTALES se calcularon sobre todos: subí 'limite_comprobantes' o acotá el período si " +
        "necesitás la lista completa.",
    );
  }

  return {
    totales_por_moneda,
    equivalente_uyu,
    equivalente_uyu_cobrado,
    detalle,
    detalle_truncado: detalleOmitidos > 0,
    cobrado_por_moneda,
    totales_por_moneda_todos_los_estados: totales_todos,
    totales_por_tipo_comprobante,
    conteo_por_tipo_comprobante,
    conteo_por_estado,
    grupos,
    agrupado_por: agruparPor,
    solo_aceptados: soloAceptados,
    conteo_total: comprobantes.length,
    conteo_incluidos,
    conteo_excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
