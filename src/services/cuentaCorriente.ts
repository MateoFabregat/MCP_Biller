// =============================================================================
// Cuenta corriente: deuda NETA por cliente y por factura.
//
// Esto es lo que `vencimientos` no puede contestar. La diferencia:
//   vencimientos    -> lo FACTURADO con vencimiento en el rango (bruto)
//   cuenta corriente-> lo facturado MENOS lo cobrado (neto)
//
// Todo sale del mismo GET /v2/comprobantes/obtener, porque un recibo es un CFE:
// se emite como e-Ticket (101) o e-Factura (111) y vuelve en el listado con
// `indicador_cobranza_propia = 1`. Un recibo puede ser total, parcial, o un
// "Adelanto" sin referencias (doc de POST /v2/recibos/crear).
//
// DOS NIVELES, con precisión distinta — y la respuesta siempre dice cuál usó:
//
//  1. SALDO POR CLIENTE (exacto, 0 llamadas extra). Suma algebraica sobre el
//     listado: ventas a crédito + ND − NC − recibos. No necesita saber qué
//     recibo paga qué factura.
//
//  2. SALDO POR FACTURA (necesita imputar). El listado NO trae las referencias
//     del recibo, así que hay tres caminos, en este orden:
//       - "referencias": si al consultar el recibo por `id` vienen sus padres
//         en un campo `referencias`, la imputación es exacta.
//       - "items_concepto": VERIFICADO CONTRA LA API REAL (2026-07-28). El GET
//         por `id` de un recibo NO devuelve `referencias`; devuelve `items`, y
//         la imputación viaja en el TEXTO de `items[].concepto`, con la forma
//         "e-Factura D-1236497". Un ítem con concepto "Adelanto" es plata que
//         no se imputó a ninguna factura. Ver `referenciasDesdeItems`.
//       - "fifo": si no hay nada de lo anterior, se imputa lo más viejo primero
//         dentro de cliente+moneda. Es el criterio contable estándar, pero es
//         una ESTIMACIÓN y se declara como tal en `estrategia`.
//
// RECIBOS NEGATIVOS. Cancelar un recibo (POST /v2/recibos/cancelar) genera otro
// recibo con `total` NEGATIVO y razón "Cancela adelanto" (verificado: id 387222
// del ambiente de test). Eso no es un cobro: es la REVERSIÓN de uno anterior, y
// se procesa como tal (`revertirCredito`). Tratarlo como un cobro más habría
// dado un saldo a favor negativo, que no significa nada.
//
// El excedente que no se puede imputar (adelantos, o recibos de ventas contado
// que no entran al ledger) NO se descuenta a la fuerza: va a `saldo_a_favor`.
// Forzarlo contra facturas cualesquiera daría saldos bajos e inventados.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { envolverEnLinea } from "../security/untrusted.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { SIN_RECEPTOR } from "./rankingClientes.js";
import { hoyComoDateUy } from "./fechaUy.js";
import { aIso } from "./periodo.js";
import { estaAceptado } from "./resumenFacturacion.js";
import {
  clasificarBucket,
  diasEntre,
  esVencido,
  etiquetaBucket,
  type Bucket,
} from "./vencimientos.js";

/** Clave de agrupación: la deuda no se cruza entre clientes ni entre monedas. */
function claveLedger(rut: string | null, moneda: string): string {
  return `${rut ?? SIN_RECEPTOR}|${moneda}`;
}

// ---------------------------------------------------------------------------
// Referencias de un recibo (padre -> monto imputado)
// ---------------------------------------------------------------------------

export interface ReferenciaCobranza {
  /** ID del comprobante que se está pagando. null si se identifica por serie+número. */
  padre: number | null;
  /** Monto imputado a ese comprobante. null = no vino; se deduce al imputar. */
  total: number | null;
  /** Identificación alternativa cuando no hay id (viene del concepto del ítem). */
  serie?: string;
  numero?: number;
  /** Texto original del que salió la referencia. Para poder auditar el parseo. */
  origen_texto?: string;
}

function aNumero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extrae las referencias de un recibo, si la API las devolvió.
 *
 * La forma exacta NO está verificada contra datos reales: el OpenAPI solo
 * documenta `referencias` en el REQUEST de POST /v2/recibos/crear
 * (`[{ padre, total }]`), y el GET no declara devolverlas. Por eso se aceptan
 * varios alias y se busca tanto en el objeto tipado como en `campos_extra`,
 * que es donde `normalize.ts` deja lo que el OpenAPI no declara.
 *
 * Devuelve null cuando no hay referencias legibles -> el llamador cae a FIFO.
 */
export function referenciasDeCobranza(c: ComprobanteEmitido): ReferenciaCobranza[] | null {
  const candidatos = [
    (c as unknown as Record<string, unknown>).referencias,
    c.campos_extra?.referencias,
    c.campos_extra?.referencia,
    c.campos_extra?.padres,
  ];

  for (const bruto of candidatos) {
    if (!Array.isArray(bruto) || bruto.length === 0) continue;

    const refs: ReferenciaCobranza[] = [];
    for (const item of bruto) {
      // Forma corta: [79508] -> solo el id del padre.
      const directo = aNumero(item);
      if (directo !== null) {
        refs.push({ padre: directo, total: null });
        continue;
      }
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const padre = aNumero(o.padre ?? o.id ?? o.comprobante_id ?? o.comprobante);
      if (padre === null) continue;
      refs.push({ padre, total: aNumero(o.total ?? o.monto ?? o.importe) });
    }
    if (refs.length > 0) return refs;
  }
  return null;
}

/**
 * Concepto de ítem que significa "esta plata no se imputó a ninguna factura".
 * Documentado en POST /v2/recibos/crear: "Si el monto total de las referencias
 * es menor al monto del pago se agregará un ítem en el recibo por la diferencia
 * con el concepto de 'Adelanto'".
 */
const CONCEPTO_ADELANTO = /^\s*adelanto\s*$/i;

/**
 * Referencia embebida en el concepto de un ítem de recibo: "e-Factura D-1236497".
 *
 * Deliberadamente ANCLADA y estricta: el grupo del documento tiene que estar al
 * FINAL del texto y la serie no puede tener más de 10 caracteres. Un patrón
 * laxo sobre texto libre encuentra "referencias" en cualquier lado, y acá cada
 * falso positivo mueve plata de una factura a otra en el saldo del cliente.
 */
const CONCEPTO_REFERENCIA = /^(.*?)\s*([A-Za-z]{1,10})-(\d{1,12})\s*$/;

/**
 * Extrae la imputación de un recibo leyendo el CONCEPTO de sus ítems.
 *
 * Por qué esto existe: el GET del recibo por `id` no trae `referencias` (se
 * verificó contra el ambiente de test el 2026-07-28). Lo que trae es `items`,
 * y ahí Biller escribe a qué comprobante se aplicó cada parte del cobro. Sin
 * leer eso, TODA imputación caía a FIFO y `estrategia` reportaba una estimación
 * teniendo el dato exacto a mano.
 *
 * El monto imputado es `cantidad * precio` del ítem, no el total del recibo:
 * un mismo recibo puede pagar dos facturas y dejar un adelanto.
 *
 * Devuelve null si no hay NINGUNA referencia legible (p.ej. un recibo que es
 * solo "Adelanto"): el llamador cae a FIFO, que para un adelanto puro es
 * equivalente porque no hay nada que imputar.
 */
export function referenciasDesdeItems(c: ComprobanteEmitido): ReferenciaCobranza[] | null {
  const items = c.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const refs: ReferenciaCobranza[] = [];
  for (const item of items) {
    const concepto = item.concepto?.trim();
    if (concepto === undefined || concepto === "") continue;
    if (CONCEPTO_ADELANTO.test(concepto)) continue;

    const m = CONCEPTO_REFERENCIA.exec(concepto);
    if (m === null) continue;

    const numero = Number(m[3]);
    if (!Number.isFinite(numero)) continue;

    // El ítem de un recibo trae el importe imputado a ESE comprobante.
    const cantidad = item.cantidad ?? 1;
    const precio = item.precio;
    const total = precio === null ? null : round2(cantidad * precio);

    refs.push({
      padre: null,
      total,
      serie: m[2]!.toUpperCase(),
      numero,
      // El concepto de un recibo es texto libre que escribió la contraparte, y
      // acá sale bajo una clave que la barrera no cubre. Va marcado en el punto
      // de copia, que es donde la barrera pierde de vista al dato.
      origen_texto: envolverEnLinea(concepto),
    });
  }

  return refs.length > 0 ? refs : null;
}

/**
 * Resolver por defecto: primero el campo `referencias` (si algún día la API lo
 * devuelve), después el concepto de los ítems (lo que devuelve hoy).
 */
export function referenciasDeRecibo(c: ComprobanteEmitido): ReferenciaCobranza[] | null {
  return referenciasDeCobranza(c) ?? referenciasDesdeItems(c);
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export type EstadoCobro = "pendiente" | "parcial" | "cancelada";

export interface DocumentoDeuda {
  id: number | null;
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  cliente_rut: string | null;
  cliente_nombre: string | null;
  moneda: string;
  /** Monto original del comprobante. */
  total: number;
  /** Imputado por recibos y notas de crédito. */
  cobrado: number;
  /** total - cobrado. Nunca negativo: el excedente va a saldo_a_favor. */
  saldo: number;
  estado_cobro: EstadoCobro;
  /** Negativo = vencida hace N días. null si no tiene fecha de vencimiento. */
  dias_para_vencer: number | null;
  bucket: Bucket | null;
  estado: string | null;
  sucursal: number | null;
}

export interface MontoPorMoneda {
  total: number;
  comprobantes: number;
}

export interface SaldoCliente {
  cliente_rut: string | null;
  cliente_nombre: string | null;
  /** Deuda neta por moneda (solo documentos con saldo > 0). */
  saldo_por_moneda: Record<string, MontoPorMoneda>;
  /** Parte del saldo que ya venció. */
  vencido_por_moneda: Record<string, MontoPorMoneda>;
  /** Cobrado de más / adelantos: plata del cliente sin factura que la consuma. */
  saldo_a_favor_por_moneda: Record<string, number>;
  facturado_por_moneda: Record<string, number>;
  cobrado_por_moneda: Record<string, number>;
  documentos_pendientes: number;
  dias_atraso_maximo: number;
}

export interface CobranzaAplicada {
  recibo_id: number | null;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  moneda: string;
  monto: number;
  /** Cuánto de este recibo se pudo imputar a documentos concretos. */
  imputado: number;
  /** monto - imputado. > 0 = adelanto o cobro sin factura abierta que lo reciba. */
  sin_imputar: number;
  cliente_rut: string | null;
  origen: OrigenImputacion;
  /** true si este "cobro" es en realidad la cancelación de un recibo anterior. */
  es_reversion?: boolean;
}

/**
 * El vocabulario completo de estrategias de imputación. UNA sola definición.
 *
 * Es un array y no un `type` suelto porque el schema de salida de la tool
 * necesita los valores EN TIEMPO DE EJECUCIÓN para armar su `z.enum`. Cuando
 * eran dos listas escritas a mano, se desincronizaron: la del servicio decía
 * "exacta" y la de la tool no, pero sí decía "referencias", que el servicio
 * nunca devolvió. Resultado: la tool tiraba un error de validación de salida
 * justo en su mejor caso —todos los recibos declararon a qué factura van— y
 * funcionaba bien cuando había que estimar.
 *
 * Con una sola fuente, agregar una estrategia es imposible de dejar a medias:
 * el tipo y el schema salen de acá.
 */
export const ESTRATEGIAS = [
  /** Toda la imputación salió de datos declarados por el propio recibo. */
  "exacta",
  /** Toda la imputación se estimó FIFO. */
  "fifo",
  /** Una parte exacta y otra estimada. */
  "mixta",
  /** No hubo cobranzas que imputar. */
  "sin_cobranzas",
] as const;

export type Estrategia = (typeof ESTRATEGIAS)[number];

/**
 * De dónde salió la imputación de UN cobro concreto. UNA sola definición, por
 * la misma razón que `ESTRATEGIAS` — y por el mismo accidente.
 *
 * Esto era un `type` suelto de tres valores mientras la tool escribía a mano un
 * `z.enum(["referencias", "fifo"])` de dos. Faltaba `items_concepto`, que es
 * justamente el caso más común contra la API real: el GET de comprobantes no
 * trae las referencias del recibo, así que la imputación sale del concepto de
 * los ítems. O sea que `biller_cuenta_corriente` —"¿quién me debe?", la opción
 * más usada del menú— fallaba con un error de validación de SALIDA cada vez que
 * había cobranzas de verdad, y andaba perfecto con la cuenta vacía.
 *
 * Un `type` no se puede leer en tiempo de ejecución: mientras el vocabulario
 * viva en un `type`, el schema lo tiene que repetir a mano, y repetirlo a mano
 * es esto. Como array, el tipo y el `z.enum` salen del mismo lugar.
 */
export const ORIGENES_IMPUTACION = [
  /** El recibo declaró a qué comprobante va. Exacto. */
  "referencias",
  /** Salió del concepto de los ítems del recibo. Exacto, pero por otro camino. */
  "items_concepto",
  /** No había nada declarado: se estimó lo más viejo primero. */
  "fifo",
] as const;

export type OrigenImputacion = (typeof ORIGENES_IMPUTACION)[number];

export interface CuentaCorrienteResultado {
  /** Cómo se imputó. "fifo"/"mixta" => el saldo POR FACTURA es una estimación. */
  estrategia: Estrategia;
  /** true solo si TODA la imputación salió de referencias reales. */
  imputacion_exacta: boolean;
  documentos: DocumentoDeuda[];
  por_cliente: SaldoCliente[];
  saldo_por_moneda: Record<string, MontoPorMoneda>;
  vencido_por_moneda: Record<string, MontoPorMoneda>;
  por_vencer_por_moneda: Record<string, MontoPorMoneda>;
  saldo_a_favor_por_moneda: Record<string, number>;
  resumen_por_bucket: Array<{
    bucket: Bucket;
    etiqueta: string;
    vencida: boolean;
    totales_por_moneda: Record<string, MontoPorMoneda>;
    conteo: number;
  }>;
  cobranzas: CobranzaAplicada[];
  totales: {
    facturado_por_moneda: Record<string, number>;
    cobrado_por_moneda: Record<string, number>;
  };
  conteo: {
    analizados: number;
    documentos_deuda: number;
    documentos_pendientes: number;
    cobranzas: number;
    notas_credito: number;
  };
  excluidos: {
    contado: number;
    no_aceptados: number;
    no_cobrable: number;
    sin_datos_minimos: number;
  };
  warnings: string[];
  no_convertir_moneda: true;
}

export interface CuentaCorrienteOptions {
  /** Fecha de referencia para el aging. Se inyecta para testear sin reloj. */
  hoy?: Date;
  /** Contar solo comprobantes "Aceptado DGI" (default true). */
  solo_aceptados?: boolean;
  /**
   * Default true: las ventas contado no generan cuenta corriente. Heurística
   * disponible: sin fecha_vencimiento, o vencimiento <= emisión. La API no
   * devuelve `forma_pago` en el GET, así que la fecha es el único indicio.
   */
  solo_a_credito?: boolean;
  /** Mostrar también los documentos ya cancelados (default false). */
  incluir_canceladas?: boolean;
  /** Resolver de referencias. Default: `referenciasDeCobranza`. */
  resolverReferencias?: (c: ComprobanteEmitido) => ReferenciaCobranza[] | null;
}

function acumular(dest: Record<string, MontoPorMoneda>, moneda: string, monto: number): void {
  const b = (dest[moneda] ??= { total: 0, comprobantes: 0 });
  b.total = round2(b.total + monto);
  b.comprobantes += 1;
}

function sumar(dest: Record<string, number>, moneda: string, monto: number): void {
  dest[moneda] = round2((dest[moneda] ?? 0) + monto);
}

/** Fecha por la que se ordena la antigüedad: vencimiento, o emisión si no hay. */
function fechaAntiguedad(d: DocumentoDeuda): string {
  return d.fecha_vencimiento ?? d.fecha_emision ?? "9999-12-31";
}

/**
 * Aplica un crédito (recibo o nota de crédito) a documentos abiertos.
 * Devuelve cuánto quedó sin imputar.
 */
function imputar(monto: number, abiertos: DocumentoDeuda[]): number {
  let resto = round2(monto);
  for (const doc of abiertos) {
    if (resto <= 0) break;
    if (doc.saldo <= 0) continue;
    const aplicar = Math.min(doc.saldo, resto);
    doc.cobrado = round2(doc.cobrado + aplicar);
    doc.saldo = round2(doc.saldo - aplicar);
    resto = round2(resto - aplicar);
  }
  return resto;
}

/**
 * Calcula la deuda neta por cliente y por factura.
 *
 * `comprobantes` debe traer el período COMPLETO relevante: si las facturas
 * están en la ventana pero sus recibos no, la deuda sale inflada.
 */
export function calcularCuentaCorriente(
  comprobantes: ComprobanteEmitido[],
  options: CuentaCorrienteOptions = {},
): CuentaCorrienteResultado {
  const hoyIso = aIso(options.hoy ?? hoyComoDateUy());
  const soloAceptados = options.solo_aceptados ?? true;
  const soloACredito = options.solo_a_credito ?? true;
  const incluirCanceladas = options.incluir_canceladas ?? false;
  const resolver = options.resolverReferencias ?? referenciasDeRecibo;

  const warningsSet = new Set<string>();
  const excluidos = { contado: 0, no_aceptados: 0, no_cobrable: 0, sin_datos_minimos: 0 };
  const facturado_por_moneda: Record<string, number> = {};
  const cobrado_total_por_moneda: Record<string, number> = {};

  // --- 1. Clasificar --------------------------------------------------------
  const documentos: DocumentoDeuda[] = [];
  const recibos: ComprobanteEmitido[] = [];
  const notasCredito: ComprobanteEmitido[] = [];

  for (const c of comprobantes) {
    const clasif = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);

    if (soloAceptados && !estaAceptado(c.estado)) {
      excluidos.no_aceptados += 1;
      continue;
    }
    if (c.total === null || c.moneda === null) {
      excluidos.sin_datos_minimos += 1;
      warningsSet.add(
        "Se excluyeron comprobantes sin total o sin moneda: no se pueden imputar sin inventar datos.",
      );
      continue;
    }

    if (clasif.categoria === "cobranza") {
      recibos.push(c);
      continue;
    }
    if (clasif.categoria === "nota_credito") {
      notasCredito.push(c);
      continue;
    }
    if (clasif.categoria !== "venta" && clasif.categoria !== "nota_debito") {
      excluidos.no_cobrable += 1;
      continue;
    }

    // Contado: no genera cuenta corriente.
    const emision = c.fecha_emision?.slice(0, 10) ?? null;
    const vencimiento = c.fecha_vencimiento?.slice(0, 10) ?? null;
    const esContado =
      vencimiento === null || (emision !== null && vencimiento <= emision);
    if (soloACredito && esContado) {
      excluidos.contado += 1;
      continue;
    }

    const dias = vencimiento === null ? null : diasEntre(hoyIso, vencimiento);
    sumar(facturado_por_moneda, c.moneda, c.total);
    documentos.push({
      id: c.id,
      tipo_comprobante: c.tipo_comprobante,
      etiqueta_tipo: clasif.etiqueta,
      serie: c.serie,
      numero: c.numero,
      fecha_emision: emision,
      fecha_vencimiento: vencimiento,
      cliente_rut: extractClienteRut(c.cliente),
      cliente_nombre: extractClienteNombre(c.cliente),
      moneda: c.moneda,
      total: c.total,
      cobrado: 0,
      saldo: c.total,
      estado_cobro: "pendiente",
      dias_para_vencer: dias,
      bucket: dias === null ? null : clasificarBucket(dias),
      estado: c.estado,
      sucursal: c.sucursal,
    });
  }

  // --- 2. Índices para imputar ---------------------------------------------
  const porId = new Map<number, DocumentoDeuda>();
  for (const d of documentos) if (d.id !== null) porId.set(d.id, d);

  /**
   * Índice serie+número, para resolver las referencias que vienen del concepto
   * de un ítem ("e-Factura D-1236497"): ahí no hay `id`, hay serie y número.
   *
   * Si dos documentos comparten serie+número (no debería pasar dentro de una
   * empresa, pero la serie la asigna el CAE y nada nos garantiza unicidad en la
   * ventana consultada), se guarda el PRIMERO y se marca la colisión: imputar
   * contra un homónimo movería plata a la factura equivocada.
   */
  const porSerieNumero = new Map<string, DocumentoDeuda>();
  const seriesColisionadas = new Set<string>();
  for (const d of documentos) {
    if (d.serie === null || d.numero === null) continue;
    const clave = `${d.serie.toUpperCase()}-${d.numero}`;
    if (porSerieNumero.has(clave)) seriesColisionadas.add(clave);
    else porSerieNumero.set(clave, d);
  }

  /** Resuelve una referencia por id o por serie+número. null si no se ubica. */
  const ubicarDocumento = (ref: ReferenciaCobranza): DocumentoDeuda | null => {
    if (ref.padre !== null) return porId.get(ref.padre) ?? null;
    if (ref.serie === undefined || ref.numero === undefined) return null;
    const clave = `${ref.serie}-${ref.numero}`;
    if (seriesColisionadas.has(clave)) {
      warningsSet.add(
        `Hay más de un comprobante con serie+número ${clave} en la ventana consultada: el cobro que ` +
          "lo referencia NO se imputó, para no aplicarlo a la factura equivocada.",
      );
      return null;
    }
    return porSerieNumero.get(clave) ?? null;
  };

  /** Documentos abiertos de un cliente+moneda, del más viejo al más nuevo. */
  const abiertosPorLedger = new Map<string, DocumentoDeuda[]>();
  for (const d of documentos) {
    const clave = claveLedger(d.cliente_rut, d.moneda);
    const lista = abiertosPorLedger.get(clave) ?? [];
    lista.push(d);
    abiertosPorLedger.set(clave, lista);
  }
  for (const lista of abiertosPorLedger.values()) {
    lista.sort((a, b) => fechaAntiguedad(a).localeCompare(fechaAntiguedad(b)));
  }

  const saldo_a_favor_por_moneda: Record<string, number> = {};
  const saldoFavorPorCliente = new Map<string, Record<string, number>>();
  const cobranzas: CobranzaAplicada[] = [];
  let usoReferencias = 0;
  let usoFifo = 0;

  /** Imputa un crédito respetando referencias si las hay; si no, FIFO. */
  function aplicarCredito(
    c: ComprobanteEmitido,
    monto: number,
    moneda: string,
    registrar: boolean,
  ): void {
    const rut = extractClienteRut(c.cliente);
    const refs = resolver(c);
    let sinImputar = round2(monto);
    let origen: OrigenImputacion = "fifo";

    if (refs !== null) {
      // La referencia con `padre` viene de un campo declarado; la que trae
      // serie+numero salió de parsear el concepto de un ítem. La distinción
      // importa: una es un dato estructurado y la otra es texto interpretado.
      origen = refs.some((r) => r.padre !== null) ? "referencias" : "items_concepto";
      usoReferencias += 1;
      // Con monto explícito se respeta; sin monto, se aplica todo el saldo del
      // padre hasta agotar el crédito.
      for (const ref of refs) {
        if (sinImputar <= 0) break;
        const doc = ubicarDocumento(ref);
        if (doc === null) {
          const cual = ref.padre !== null ? `id ${ref.padre}` : `${ref.serie}-${ref.numero}`;
          warningsSet.add(
            `Un recibo referencia el comprobante ${cual}, que no está en la ventana consultada: ` +
              "ese cobro no se pudo imputar y quedó como saldo a favor. Ampliá el período (dias_atras) " +
              "para incluir la factura original.",
          );
          continue;
        }
        const tope = ref.total === null ? doc.saldo : Math.min(ref.total, doc.saldo);
        const aplicar = Math.min(tope, sinImputar);
        if (aplicar <= 0) continue;
        doc.cobrado = round2(doc.cobrado + aplicar);
        doc.saldo = round2(doc.saldo - aplicar);
        sinImputar = round2(sinImputar - aplicar);
      }
    } else {
      usoFifo += 1;
      const abiertos = abiertosPorLedger.get(claveLedger(rut, moneda)) ?? [];
      sinImputar = imputar(sinImputar, abiertos);
    }

    const imputado = round2(monto - sinImputar);
    sumar(cobrado_total_por_moneda, moneda, monto);

    if (sinImputar > 0) {
      sumar(saldo_a_favor_por_moneda, moneda, sinImputar);
      const clave = rut ?? SIN_RECEPTOR;
      const porCliente = saldoFavorPorCliente.get(clave) ?? {};
      sumar(porCliente, moneda, sinImputar);
      saldoFavorPorCliente.set(clave, porCliente);
    }

    if (registrar) {
      cobranzas.push({
        recibo_id: c.id,
        serie: c.serie,
        numero: c.numero,
        fecha_emision: c.fecha_emision?.slice(0, 10) ?? null,
        moneda,
        monto,
        imputado,
        sin_imputar: sinImputar,
        cliente_rut: rut,
        origen,
      });
    }
  }

  /**
   * Deshace un cobro anterior. Entra por acá el recibo con `total` negativo que
   * genera POST /v2/recibos/cancelar.
   *
   * Orden de reversión, y el porqué:
   *   1. PRIMERO el saldo a favor del cliente. Cancelar un adelanto tiene que
   *      borrar ese adelanto, no reabrir una factura que se pagó con otra plata.
   *      Es además el caso real observado (adelanto + "Cancela adelanto").
   *   2. DESPUÉS las facturas, de la MÁS NUEVA a la más vieja: es el inverso
   *      exacto del FIFO con el que se imputó, así que revertir deja el ledger
   *      como estaba antes del cobro.
   *
   * Si sobra algo por revertir después de eso, NO se inventa deuda nueva: se
   * avisa. Suele significar que el recibo original quedó fuera de la ventana.
   */
  function revertirCredito(c: ComprobanteEmitido, monto: number, moneda: string): void {
    // Cuenta como imputación ESTIMADA: el recibo de cancelación no declara qué
    // cobro deshace, así que se revierte por orden inverso al FIFO. Sin contarlo,
    // un período cuyos únicos movimientos son cancelaciones reportaría
    // `imputacion_exacta: true` y el caveat de estimación desaparecería.
    usoFifo += 1;
    const rut = extractClienteRut(c.cliente);
    const clave = rut ?? SIN_RECEPTOR;
    let porRevertir = round2(Math.abs(monto));

    // 1. Saldo a favor.
    const favorCliente = saldoFavorPorCliente.get(clave);
    const disponible = favorCliente?.[moneda] ?? 0;
    if (disponible > 0) {
      const quita = Math.min(disponible, porRevertir);
      sumar(favorCliente!, moneda, -quita);
      sumar(saldo_a_favor_por_moneda, moneda, -quita);
      porRevertir = round2(porRevertir - quita);
    }

    // 2. Facturas, del más nuevo al más viejo (inverso del FIFO).
    if (porRevertir > 0) {
      const abiertos = [...(abiertosPorLedger.get(claveLedger(rut, moneda)) ?? [])].reverse();
      for (const doc of abiertos) {
        if (porRevertir <= 0) break;
        if (doc.cobrado <= 0) continue;
        const devolver = Math.min(doc.cobrado, porRevertir);
        doc.cobrado = round2(doc.cobrado - devolver);
        doc.saldo = round2(doc.saldo + devolver);
        porRevertir = round2(porRevertir - devolver);
      }
    }

    sumar(cobrado_total_por_moneda, moneda, monto); // monto es negativo: resta

    if (porRevertir > 0) {
      warningsSet.add(
        `Un recibo de cancelación por ${Math.abs(monto)} ${moneda} no se pudo revertir por completo ` +
          `(quedaron ${porRevertir} sin aplicar): el cobro original probablemente está fuera de la ` +
          "ventana consultada. Ampliá 'dias_atras'.",
      );
    }

    cobranzas.push({
      recibo_id: c.id,
      serie: c.serie,
      numero: c.numero,
      fecha_emision: c.fecha_emision?.slice(0, 10) ?? null,
      moneda,
      monto,
      imputado: round2(monto + porRevertir),
      sin_imputar: porRevertir,
      cliente_rut: rut,
      origen: "fifo",
      es_reversion: true,
    });
  }

  // --- 3. Imputar: primero las NC, después los recibos ----------------------
  // Las NC van antes porque reducen la deuda en origen: si un recibo consumiera
  // una factura que después una NC anula, el saldo a favor quedaría inflado.
  // Se ordenan por fecha para que FIFO sea determinista.
  const porFecha = (a: ComprobanteEmitido, b: ComprobanteEmitido): number =>
    (a.fecha_emision ?? "").localeCompare(b.fecha_emision ?? "");

  for (const nc of [...notasCredito].sort(porFecha)) {
    aplicarCredito(nc, nc.total!, nc.moneda!, false);
  }
  for (const r of [...recibos].sort(porFecha)) {
    // Un recibo con total negativo es la CANCELACIÓN de un cobro anterior, no
    // un cobro. Meterlo por `aplicarCredito` habría dejado el monto entero como
    // "sin imputar" y sumado un saldo a favor negativo.
    if (r.total! < 0) revertirCredito(r, r.total!, r.moneda!);
    else aplicarCredito(r, r.total!, r.moneda!, true);
  }

  // --- 4. Estado de cada documento -----------------------------------------
  for (const d of documentos) {
    d.estado_cobro = d.saldo <= 0 ? "cancelada" : d.cobrado > 0 ? "parcial" : "pendiente";
  }

  const visibles = incluirCanceladas
    ? documentos
    : documentos.filter((d) => d.estado_cobro !== "cancelada");
  // Más urgente primero; las que no tienen vencimiento van al final.
  visibles.sort((a, b) => {
    if (a.dias_para_vencer === null) return b.dias_para_vencer === null ? 0 : 1;
    if (b.dias_para_vencer === null) return -1;
    return a.dias_para_vencer - b.dias_para_vencer;
  });

  // --- 5. Agregados ---------------------------------------------------------
  const saldo_por_moneda: Record<string, MontoPorMoneda> = {};
  const vencido_por_moneda: Record<string, MontoPorMoneda> = {};
  const por_vencer_por_moneda: Record<string, MontoPorMoneda> = {};
  const bucketsMap = new Map<Bucket, CuentaCorrienteResultado["resumen_por_bucket"][number]>();
  const clientesMap = new Map<string, SaldoCliente>();

  for (const d of documentos) {
    const clave = d.cliente_rut ?? SIN_RECEPTOR;
    const cliente = clientesMap.get(clave) ?? {
      cliente_rut: d.cliente_rut,
      cliente_nombre: d.cliente_nombre,
      saldo_por_moneda: {},
      vencido_por_moneda: {},
      saldo_a_favor_por_moneda: saldoFavorPorCliente.get(clave) ?? {},
      facturado_por_moneda: {},
      cobrado_por_moneda: {},
      documentos_pendientes: 0,
      dias_atraso_maximo: 0,
    };
    if (cliente.cliente_nombre === null && d.cliente_nombre !== null) {
      cliente.cliente_nombre = d.cliente_nombre;
    }
    sumar(cliente.facturado_por_moneda, d.moneda, d.total);
    sumar(cliente.cobrado_por_moneda, d.moneda, d.cobrado);

    if (d.saldo > 0) {
      const vencida = d.bucket !== null && esVencido(d.bucket);
      acumular(saldo_por_moneda, d.moneda, d.saldo);
      acumular(cliente.saldo_por_moneda, d.moneda, d.saldo);
      if (vencida) {
        acumular(vencido_por_moneda, d.moneda, d.saldo);
        acumular(cliente.vencido_por_moneda, d.moneda, d.saldo);
        cliente.dias_atraso_maximo = Math.max(
          cliente.dias_atraso_maximo,
          -(d.dias_para_vencer ?? 0),
        );
      } else {
        acumular(por_vencer_por_moneda, d.moneda, d.saldo);
      }
      cliente.documentos_pendientes += 1;

      if (d.bucket !== null) {
        const resumen = bucketsMap.get(d.bucket) ?? {
          bucket: d.bucket,
          etiqueta: etiquetaBucket(d.bucket),
          vencida,
          totales_por_moneda: {},
          conteo: 0,
        };
        acumular(resumen.totales_por_moneda, d.moneda, d.saldo);
        resumen.conteo += 1;
        bucketsMap.set(d.bucket, resumen);
      }
    }
    clientesMap.set(clave, cliente);
  }

  // Clientes que solo tienen saldo a favor (adelantos sin factura abierta).
  for (const [clave, saldos] of saldoFavorPorCliente) {
    if (clientesMap.has(clave)) continue;
    clientesMap.set(clave, {
      cliente_rut: clave === SIN_RECEPTOR ? null : clave,
      cliente_nombre: null,
      saldo_por_moneda: {},
      vencido_por_moneda: {},
      saldo_a_favor_por_moneda: saldos,
      facturado_por_moneda: {},
      cobrado_por_moneda: {},
      documentos_pendientes: 0,
      dias_atraso_maximo: 0,
    });
  }

  const maxMonto = (r: Record<string, MontoPorMoneda>): number =>
    Math.max(0, ...Object.values(r).map((m) => m.total));
  const por_cliente = [...clientesMap.values()].sort(
    (a, b) =>
      maxMonto(b.vencido_por_moneda) - maxMonto(a.vencido_por_moneda) ||
      maxMonto(b.saldo_por_moneda) - maxMonto(a.saldo_por_moneda),
  );

  const resumen_por_bucket = [...bucketsMap.values()].sort(
    (a, b) => Number(b.vencida) - Number(a.vencida),
  );

  // --- 6. Estrategia y warnings --------------------------------------------
  const estrategia: Estrategia =
    usoReferencias === 0 && usoFifo === 0
      ? "sin_cobranzas"
      : usoFifo === 0
        ? "exacta"
        : usoReferencias === 0
          ? "fifo"
          : "mixta";
  const imputacion_exacta = estrategia === "exacta" || estrategia === "sin_cobranzas";

  if (estrategia === "fifo" || estrategia === "mixta") {
    warningsSet.add(
      "IMPUTACIÓN ESTIMADA (FIFO): la API no devolvió a qué factura corresponde cada cobro, así que " +
        "se imputó lo más viejo primero dentro de cada cliente+moneda. El saldo TOTAL por cliente es " +
        "exacto; cuál factura puntual quedó impaga es una estimación.",
    );
  }
  // `> 0` sobre las CLAVES avisaría también cuando una reversión dejó todos los
  // saldos en cero: el aviso hablaría de plata que ya no está.
  if (Object.values(saldo_a_favor_por_moneda).some((v) => Math.abs(v) >= 0.01)) {
    warningsSet.add(
      "Hay cobros que no se pudieron imputar a ninguna factura abierta (ver 'saldo_a_favor_por_moneda'). " +
        "Suele ser un adelanto, un recibo de una venta contado, o una factura anterior a la ventana " +
        "consultada. NO se descontaron a la fuerza para no bajar el saldo con plata que no corresponde.",
    );
  }
  if (soloACredito && excluidos.contado > 0) {
    warningsSet.add(
      `Se excluyeron ${excluidos.contado} comprobante(s) tratados como CONTADO (sin fecha_vencimiento ` +
        "o con vencimiento <= emisión). Biller no expone forma_pago en el GET, así que la fecha es el " +
        "único indicio. Pasá solo_a_credito=false para incluirlos.",
    );
  }
  if (documentos.some((d) => d.cliente_rut === null)) {
    warningsSet.add(
      "Hay documentos agrupados en '(sin receptor)': no se pudo extraer el RUT del campo 'cliente'. " +
        "Su imputación FIFO se hace contra ese grupo, no contra un cliente real.",
    );
  }

  return {
    estrategia,
    imputacion_exacta,
    documentos: visibles,
    por_cliente,
    saldo_por_moneda,
    vencido_por_moneda,
    por_vencer_por_moneda,
    saldo_a_favor_por_moneda,
    resumen_por_bucket,
    cobranzas,
    totales: {
      facturado_por_moneda,
      cobrado_por_moneda: cobrado_total_por_moneda,
    },
    conteo: {
      analizados: comprobantes.length,
      documentos_deuda: documentos.length,
      documentos_pendientes: documentos.filter((d) => d.saldo > 0).length,
      cobranzas: recibos.length,
      notas_credito: notasCredito.length,
    },
    excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
