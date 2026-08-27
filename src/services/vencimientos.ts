// =============================================================================
// Servicio de vencimientos: "¿qué facturas vencen esta semana?" y aging.
//
// LÍMITE IMPORTANTE (leer antes de usar esto como cuentas por cobrar):
// la API de Biller NO expone lectura de pagos ni de recibos. Se puede saber qué
// se facturó y con qué vencimiento, pero NO si ya se cobró. Todo lo que devuelve
// este servicio es "facturado con vencimiento en el rango", no "deuda vigente".
// El warning correspondiente viaja SIEMPRE en la respuesta: un número de
// cobranzas sin ese caveat se lee como saldo real y es falso.
//
// Criterios:
//  - Solo cuentan las categorías que generan un cobro: ventas y notas de débito.
//    Las notas de crédito no se listan como cobrables (restan, no se cobran).
//  - `solo_a_credito` (default true) descarta el contado con la heurística
//    fecha_vencimiento == fecha_emision. Biller no expone forma de pago en el
//    GET, así que la fecha es el único indicio disponible.
//  - Sin conversión de monedas: los totales van separados por moneda.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { SIN_RECEPTOR } from "./rankingClientes.js";
import { hoyComoDateUy } from "./fechaUy.js";
import { aIso } from "./periodo.js";
import { estaAceptado } from "./resumenFacturacion.js";

/** Tramos de aging. El orden es el de presentación: de lo más viejo a lo más lejano. */
export const BUCKETS = [
  "vencida_mas_90",
  "vencida_61_90",
  "vencida_31_60",
  "vencida_1_30",
  "vence_hoy",
  "vence_en_7",
  "vence_en_30",
  "vence_despues",
] as const;

export type Bucket = (typeof BUCKETS)[number];

const ETIQUETA_BUCKET: Record<Bucket, string> = {
  vencida_mas_90: "Vencida hace más de 90 días",
  vencida_61_90: "Vencida hace 61-90 días",
  vencida_31_60: "Vencida hace 31-60 días",
  vencida_1_30: "Vencida hace 1-30 días",
  vence_hoy: "Vence hoy",
  vence_en_7: "Vence en los próximos 7 días",
  vence_en_30: "Vence en 8-30 días",
  vence_despues: "Vence en más de 30 días",
};

export function etiquetaBucket(bucket: Bucket): string {
  return ETIQUETA_BUCKET[bucket];
}

/** true si el tramo corresponde a algo ya vencido. */
export function esVencido(bucket: Bucket): boolean {
  return bucket.startsWith("vencida_");
}

/**
 * Días calendario entre dos fechas aaaa-mm-dd (b - a). Positivo si `b` es
 * posterior. Ambas se interpretan en UTC para que no las corra el huso horario.
 */
export function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function clasificarBucket(diasParaVencer: number): Bucket {
  if (diasParaVencer < -90) return "vencida_mas_90";
  if (diasParaVencer < -60) return "vencida_61_90";
  if (diasParaVencer < -30) return "vencida_31_60";
  if (diasParaVencer < 0) return "vencida_1_30";
  if (diasParaVencer === 0) return "vence_hoy";
  if (diasParaVencer <= 7) return "vence_en_7";
  if (diasParaVencer <= 30) return "vence_en_30";
  return "vence_despues";
}

export interface FacturaConVencimiento {
  id: number | null;
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  fecha_vencimiento: string;
  /** Negativo = vencida hace N días. 0 = vence hoy. */
  dias_para_vencer: number;
  bucket: Bucket;
  cliente_rut: string | null;
  cliente_nombre: string | null;
  moneda: string;
  total: number;
  estado: string | null;
  sucursal: number | null;
}

export interface MontoPorMoneda {
  total: number;
  comprobantes: number;
}

export interface ResumenBucket {
  bucket: Bucket;
  etiqueta: string;
  vencida: boolean;
  totales_por_moneda: Record<string, MontoPorMoneda>;
  conteo: number;
}

export interface ResumenCliente {
  cliente_rut: string | null;
  cliente_nombre: string | null;
  totales_por_moneda: Record<string, MontoPorMoneda>;
  vencido_por_moneda: Record<string, MontoPorMoneda>;
  conteo: number;
  /** Días de atraso de la factura más vieja sin vencer aún (0 si ninguna venció). */
  dias_atraso_maximo: number;
}

export interface VencimientosExcluidos {
  sin_fecha_vencimiento: number;
  contado: number;
  no_aceptados: number;
  no_cobrable: number;
  fuera_de_rango: number;
  sin_datos_minimos: number;
}

export interface VencimientosResultado {
  facturas: FacturaConVencimiento[];
  resumen_por_bucket: ResumenBucket[];
  por_cliente: ResumenCliente[];
  totales_por_moneda: Record<string, MontoPorMoneda>;
  vencido_por_moneda: Record<string, MontoPorMoneda>;
  por_vencer_por_moneda: Record<string, MontoPorMoneda>;
  conteo_analizados: number;
  conteo_incluidos: number;
  excluidos: VencimientosExcluidos;
  warnings: string[];
  no_convertir_moneda: true;
}

export interface VencimientosOptions {
  /** Fecha de referencia. Se inyecta para poder testear sin depender del reloj. */
  hoy?: Date;
  /** Horizonte hacia adelante, en días (7 = "esta semana"). */
  horizonte_dias: number;
  /** Incluir las que ya vencieron (default true). */
  incluir_vencidas?: boolean;
  /** Contar solo comprobantes "Aceptado DGI" (default true). */
  solo_aceptados?: boolean;
  /** Descartar el contado con la heurística vencimiento == emisión (default true). */
  solo_a_credito?: boolean;
}

function acumular(
  destino: Record<string, MontoPorMoneda>,
  moneda: string,
  monto: number,
): void {
  const bucket = (destino[moneda] ??= { total: 0, comprobantes: 0 });
  bucket.total = round2(bucket.total + monto);
  bucket.comprobantes += 1;
}

/**
 * Clasifica los comprobantes por vencimiento respecto de `hoy`.
 *
 * Devuelve solo lo que cae dentro de la ventana pedida: desde lo más vencido
 * (si `incluir_vencidas`) hasta `horizonte_dias` hacia adelante.
 */
export function analizarVencimientos(
  comprobantes: ComprobanteEmitido[],
  options: VencimientosOptions,
): VencimientosResultado {
  const hoyIso = aIso(options.hoy ?? hoyComoDateUy());
  const incluirVencidas = options.incluir_vencidas ?? true;
  const soloAceptados = options.solo_aceptados ?? true;
  const soloACredito = options.solo_a_credito ?? true;

  const facturas: FacturaConVencimiento[] = [];
  const warningsSet = new Set<string>();
  const excluidos: VencimientosExcluidos = {
    sin_fecha_vencimiento: 0,
    contado: 0,
    no_aceptados: 0,
    no_cobrable: 0,
    fuera_de_rango: 0,
    sin_datos_minimos: 0,
  };

  let cobranzas = 0;

  for (const c of comprobantes) {
    const clasif = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    // Solo lo que genera un cobro. Las notas de crédito restan deuda, no se
    // cobran; listarlas como "a cobrar" sería un error de signo. Los recibos
    // (categoria "cobranza") son el cobro en sí: listarlos como pendientes de
    // cobro es exactamente al revés.
    if (clasif.categoria === "cobranza") {
      cobranzas += 1;
      excluidos.no_cobrable += 1;
      continue;
    }
    if (clasif.categoria !== "venta" && clasif.categoria !== "nota_debito") {
      excluidos.no_cobrable += 1;
      continue;
    }

    if (soloAceptados && !estaAceptado(c.estado)) {
      excluidos.no_aceptados += 1;
      continue;
    }

    if (c.total === null || c.moneda === null) {
      excluidos.sin_datos_minimos += 1;
      warningsSet.add(
        "Se excluyeron comprobantes sin total o sin moneda: no se pueden sumar sin inventar datos.",
      );
      continue;
    }

    const vencimiento = c.fecha_vencimiento?.slice(0, 10) ?? null;
    if (vencimiento === null || !/^\d{4}-\d{2}-\d{2}$/.test(vencimiento)) {
      excluidos.sin_fecha_vencimiento += 1;
      continue;
    }

    const emision = c.fecha_emision?.slice(0, 10) ?? null;
    if (soloACredito && emision !== null && vencimiento <= emision) {
      excluidos.contado += 1;
      continue;
    }

    const dias = diasEntre(hoyIso, vencimiento);
    if (dias > options.horizonte_dias) {
      excluidos.fuera_de_rango += 1;
      continue;
    }
    if (dias < 0 && !incluirVencidas) {
      excluidos.fuera_de_rango += 1;
      continue;
    }

    facturas.push({
      id: c.id,
      tipo_comprobante: c.tipo_comprobante,
      etiqueta_tipo: clasif.etiqueta,
      serie: c.serie,
      numero: c.numero,
      fecha_emision: emision,
      fecha_vencimiento: vencimiento,
      dias_para_vencer: dias,
      bucket: clasificarBucket(dias),
      cliente_rut: extractClienteRut(c.cliente),
      cliente_nombre: extractClienteNombre(c.cliente),
      moneda: c.moneda,
      total: c.total,
      estado: c.estado,
      sucursal: c.sucursal,
    });
  }

  // Más urgente primero: lo más vencido arriba.
  facturas.sort((a, b) => a.dias_para_vencer - b.dias_para_vencer);

  // --- Agregados ------------------------------------------------------------
  const totales_por_moneda: Record<string, MontoPorMoneda> = {};
  const vencido_por_moneda: Record<string, MontoPorMoneda> = {};
  const por_vencer_por_moneda: Record<string, MontoPorMoneda> = {};
  const bucketsMap = new Map<Bucket, ResumenBucket>();
  const clientesMap = new Map<string, ResumenCliente>();

  for (const f of facturas) {
    acumular(totales_por_moneda, f.moneda, f.total);
    const vencida = esVencido(f.bucket);
    acumular(vencida ? vencido_por_moneda : por_vencer_por_moneda, f.moneda, f.total);

    const resumen = bucketsMap.get(f.bucket) ?? {
      bucket: f.bucket,
      etiqueta: etiquetaBucket(f.bucket),
      vencida,
      totales_por_moneda: {},
      conteo: 0,
    };
    acumular(resumen.totales_por_moneda, f.moneda, f.total);
    resumen.conteo += 1;
    bucketsMap.set(f.bucket, resumen);

    const claveCliente = f.cliente_rut ?? SIN_RECEPTOR;
    const cliente = clientesMap.get(claveCliente) ?? {
      cliente_rut: f.cliente_rut,
      cliente_nombre: f.cliente_nombre,
      totales_por_moneda: {},
      vencido_por_moneda: {},
      conteo: 0,
      dias_atraso_maximo: 0,
    };
    acumular(cliente.totales_por_moneda, f.moneda, f.total);
    if (vencida) {
      acumular(cliente.vencido_por_moneda, f.moneda, f.total);
      cliente.dias_atraso_maximo = Math.max(cliente.dias_atraso_maximo, -f.dias_para_vencer);
    }
    // Si el primer comprobante del cliente vino sin nombre y otro sí lo trae,
    // preferimos el que tiene nombre para que el reporte sea legible.
    if (cliente.cliente_nombre === null && f.cliente_nombre !== null) {
      cliente.cliente_nombre = f.cliente_nombre;
    }
    cliente.conteo += 1;
    clientesMap.set(claveCliente, cliente);
  }

  const resumen_por_bucket = BUCKETS.filter((b) => bucketsMap.has(b)).map(
    (b) => bucketsMap.get(b)!,
  );

  // El que más debe primero, mirando el monto vencido y cayendo al total.
  const por_cliente = [...clientesMap.values()].sort((a, b) => {
    const max = (r: Record<string, MontoPorMoneda>) =>
      Math.max(0, ...Object.values(r).map((m) => m.total));
    return (
      max(b.vencido_por_moneda) - max(a.vencido_por_moneda) ||
      max(b.totales_por_moneda) - max(a.totales_por_moneda)
    );
  });

  // --- Warnings -------------------------------------------------------------
  warningsSet.add(
    "SIN IMPUTAR COBRANZAS: esto es lo FACTURADO con vencimiento en el rango, no la deuda neta. " +
      "Una factura ya cobrada aparece igual. Los recibos SÍ son legibles " +
      "(indicador_cobranza_propia=1 en el mismo GET), pero esta vista todavía no los descuenta " +
      "factura por factura.",
  );
  if (cobranzas > 0) {
    warningsSet.add(
      `Se detectaron ${cobranzas} recibo(s) de cobranza en la ventana consultada: hay cobros que ` +
        "este listado no está descontando. El monto a cobrar real es MENOR al que se muestra acá.",
    );
  }
  if (soloACredito && excluidos.contado > 0) {
    warningsSet.add(
      `Se excluyeron ${excluidos.contado} comprobante(s) tratados como CONTADO (fecha_vencimiento <= ` +
        "fecha_emision). Biller no expone la forma de pago en el GET, así que la fecha es el único " +
        "indicio. Pasá solo_a_credito=false para incluirlos.",
    );
  }
  if (excluidos.sin_fecha_vencimiento > 0) {
    warningsSet.add(
      `${excluidos.sin_fecha_vencimiento} comprobante(s) no tienen fecha_vencimiento y no se pueden ` +
        "ubicar en el aging. Quedaron fuera del análisis.",
    );
  }
  if (facturas.some((f) => f.cliente_rut === null)) {
    warningsSet.add(
      "Algunas facturas quedaron agrupadas en '(sin receptor)': el RUT no se pudo extraer del campo " +
        "'cliente', cuya estructura Biller no documenta (típico en e-Tickets a consumidor final).",
    );
  }

  return {
    facturas,
    resumen_por_bucket,
    por_cliente,
    totales_por_moneda,
    vencido_por_moneda,
    por_vencer_por_moneda,
    conteo_analizados: comprobantes.length,
    conteo_incluidos: facturas.length,
    excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
