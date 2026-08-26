// =============================================================================
// Ranking de clientes: quién factura más, quién es nuevo, quién se fue.
//
// Todo sale del campo `cliente` de los comprobantes emitidos. Biller NO expone
// un endpoint de listado de clientes, así que la cartera se DERIVA de la
// facturación — que además es la definición correcta para esta pregunta: un
// cliente que existe en la base pero nunca compró no es un cliente.
//
// Tres decisiones que definen si los números sirven o no:
//
// 1. NO SE CONVIERTE MONEDA. Sumar UYU y USD da un número sin significado. Todo
//    se acumula por moneda y el ranking se ordena por UNA moneda elegida
//    (default: la de mayor facturación en el período).
//
// 2. LAS NOTAS DE CRÉDITO RESTAN. Un cliente al que le facturaste 100 y le
//    hiciste 90 de nota de crédito facturó 10, no 100. `classifyCfe` ya tiene
//    el signo; acá solo hay que respetarlo. Sin esto, el "mejor cliente" puede
//    ser el que más devuelve.
//
// 3. LOS RECIBOS NO SON FACTURACIÓN. `indicador_cobranza_propia = 1` es cobro
//    de algo ya facturado, posiblemente en otro período. Contarlo duplica.
//    `classifyCfe` también resuelve esto (`suma_en_resumen = false`).
//
// El estado "dormido" se calcula contra el FIN del período consultado, no
// contra hoy: preguntar por un período histórico y recibir "todos dormidos"
// porque pasó un año sería inútil.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { clasificarEstado } from "./resumenFacturacion.js";
import { monedaDeOrden } from "./monedaOrden.js";

/** Días sin comprar a partir de los cuales un cliente se considera dormido. */
export const DIAS_DORMIDO = 90;

/**
 * Ratio de notas de crédito a partir del cual el cliente se marca para revisar.
 * 15% es alto para cualquier rubro: por encima de eso, o hay un problema de
 * calidad, o de facturación, o algo que conviene mirar de cerca.
 */
export const UMBRAL_NC_ANOMALAS_PCT = 15;

/**
 * Etiqueta del grupo que junta las ventas sin receptor identificado.
 *
 * Es una CLAVE, no solo un texto: `riesgoPlata` cruza la cuenta corriente contra
 * este ranking por el RUT del cliente, y este valor es el que representa "sin
 * RUT" en los dos lados. Si cada módulo escribiera su propio literal y uno
 * cambiara, el cruce dejaría de encontrar coincidencias sin ningún error.
 */
export const SIN_RECEPTOR = "(sin receptor)";

/**
 * Días distintos de compra mínimos para estimar cada cuánto compra un cliente.
 *
 * Con dos fechas hay un solo intervalo, y un solo intervalo no es un ritmo: el
 * cliente que compró el lunes y el martes daría "compra cada 1 día" y quedaría
 * atrasado el jueves. Tres fechas dan dos intervalos, que ya es un promedio.
 */
export const MINIMO_DIAS_PARA_FRECUENCIA = 3;

/**
 * Cuántas veces su propio intervalo tiene que pasar para marcarlo atrasado.
 *
 * 2 es deliberadamente tolerante: quien compra cada 30 días y va por el 45 no
 * es noticia (se fue de licencia, movió una entrega). El que va por el 61, sí.
 */
export const FACTOR_ATRASO_FRECUENCIA = 2;

export interface ClienteRanking {
  /** RUT/documento del receptor. null en ventas sin receptor (e-Ticket al mostrador). */
  rut: string | null;
  nombre: string | null;
  /** Facturación neta (ventas − notas de crédito + notas de débito) por moneda. */
  facturado_por_moneda: Record<string, number>;
  /** Cantidad de comprobantes que suman (excluye recibos y especiales). */
  comprobantes: number;
  /** Notas de crédito emitidas a este cliente, por moneda (valor positivo). */
  notas_credito_por_moneda: Record<string, number>;
  cantidad_notas_credito: number;
  /**
   * Qué proporción de lo facturado bruto a este cliente terminó en nota de
   * crédito, en la moneda de ordenamiento. null si no hay base para calcularlo.
   *
   * Es un indicador de fricción que nadie mira: un cliente con 30% de notas de
   * crédito no es un buen cliente aunque encabece el ranking por volumen — está
   * devolviendo, reclamando o recibiendo facturas mal hechas.
   */
  ratio_notas_credito_pct: number | null;
  /** true si el ratio supera el umbral configurado: merece una mirada. */
  nc_anomalas: boolean;
  primera_compra: string | null;
  ultima_compra: string | null;
  /** Días entre la última compra y el fin del período. */
  dias_desde_ultima_compra: number | null;
  /** Ticket promedio en la moneda de ordenamiento. */
  ticket_promedio: number | null;
  /** Días distintos en los que este cliente compró dentro del período. */
  dias_con_compra: number;
  /**
   * Cada cuántos días compra este cliente, en promedio.
   *
   * Se calcula sobre DÍAS DISTINTOS de compra, no sobre comprobantes: tres
   * facturas del mismo día son una visita, no tres. null si compró un solo día
   * (con un punto no hay intervalo que promediar).
   */
  dias_entre_compras_promedio: number | null;
  /**
   * true si hace más del doble de su propio intervalo que no compra.
   *
   * Es el umbral relativo que `esta_dormido` no puede dar: un cliente que compra
   * todas las semanas y hace 30 días que no aparece es una señal fuerte, y sin
   * embargo está lejísimos de los 90 días del corte absoluto. Al revés, uno que
   * compra cada seis meses no está dormido a los 100 días: está a tiempo.
   */
  atrasado_vs_su_frecuencia: boolean;
  /** % de la facturación total del período, en la moneda de ordenamiento. */
  participacion_pct: number | null;
  /**
   * true si este cliente no le había comprado nunca antes de este período.
   *
   * `null` cuando no se puede saber, que es el caso por defecto: para afirmar
   * "nunca antes" hay que MIRAR antes, y esta función solo ve los comprobantes
   * del período. Antes decía `primera_compra >= desde`, que sobre una lista ya
   * filtrada al período es verdadero SIEMPRE — o sea que todos los clientes
   * salían como nuevos y "ganaste N clientes nuevos" era el conteo de clientes.
   *
   * Se completa pasando `ruts_previos`. Ver `RankingClientesOptions`.
   */
  es_nuevo: boolean | null;
  /** true si hace más de `dias_dormido` que no compra. */
  esta_dormido: boolean;
}

export interface ConcentracionIngresos {
  moneda: string;
  /** Participación del cliente más grande, en %. */
  top_1_pct: number;
  top_3_pct: number;
  top_5_pct: number;
  /**
   * Índice de Herfindahl-Hirschman (0–10000): suma de los cuadrados de las
   * participaciones porcentuales. Es la medida estándar de concentración.
   * >2500 = muy concentrado; <1500 = diversificado.
   */
  hhi: number;
  /** Lectura en castellano del HHI, para que el número signifique algo. */
  interpretacion: string;
  /** Cuántos clientes hacen falta para llegar al 50% de la facturación. */
  clientes_hasta_50_pct: number;
  clientes_totales: number;
}

export interface RankingClientesResultado {
  clientes: ClienteRanking[];
  /** Moneda usada para ordenar y para los porcentajes. */
  moneda_orden: string;
  monedas_presentes: string[];
  concentracion: ConcentracionIngresos | null;
  nuevos: number;
  dormidos: number;
  /** Clientes atrasados contra su propio ritmo que todavía no figuran dormidos. */
  atrasados_vs_su_frecuencia: number;
  total_facturado_por_moneda: Record<string, number>;
  clientes_totales: number;
  comprobantes_analizados: number;
  warnings: string[];
}

export interface RankingClientesOptions {
  /** Fin del período: referencia para "días desde la última compra". aaaa-mm-dd. */
  hasta: string;
  /** Inicio del período. aaaa-mm-dd. */
  desde: string;
  /**
   * RUTs que YA habían comprado antes de `desde`, mirando hacia atrás.
   *
   * Es la única forma de contestar "¿es nuevo?": sin esto, `es_nuevo` queda en
   * `null` en vez de mentir. El llamador decide cuánto hacia atrás mira y lo
   * declara en la respuesta — "nuevo" es siempre relativo a un horizonte, y uno
   * que no se dice es uno que el lector va a suponer infinito.
   */
  ruts_previos?: ReadonlySet<string>;
  /** Moneda para ordenar. Si se omite, la de mayor facturación. */
  moneda?: string;
  /** Default true: contar solo comprobantes "Aceptado DGI". */
  solo_aceptados?: boolean;
  /** Umbral de "dormido" en días. Default 90. */
  dias_dormido?: number;
  /** Umbral del ratio de notas de crédito, en %. Default 15. */
  umbral_nc_pct?: number;
  /** Cuántos clientes devolver. Default 20. */
  limite?: number;
}

function sumar(mapa: Record<string, number>, moneda: string, monto: number): void {
  mapa[moneda] = round2((mapa[moneda] ?? 0) + monto);
}

function diasEntreFechas(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Toma los primeros 10 caracteres: las fechas llegan como "aaaa-mm-dd hh:mm:ss". */
function soloFecha(valor: string | null): string | null {
  if (valor === null) return null;
  const t = valor.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

function interpretarHhi(hhi: number, top1: number): string {
  if (hhi >= 2500) {
    return (
      `Cartera MUY concentrada (HHI ${hhi}). El cliente más grande explica el ${top1}% de la ` +
      "facturación: perderlo sería un golpe difícil de absorber."
    );
  }
  if (hhi >= 1500) {
    return (
      `Concentración moderada (HHI ${hhi}). El cliente más grande explica el ${top1}%. ` +
      "Vale la pena vigilar la dependencia."
    );
  }
  return `Cartera diversificada (HHI ${hhi}). Ningún cliente domina la facturación (el mayor: ${top1}%).`;
}

/**
 * Construye el ranking de clientes de un conjunto de comprobantes emitidos.
 * `comprobantes` ya viene filtrado por período de emisión.
 */
export function rankingClientes(
  comprobantes: ComprobanteEmitido[],
  opciones: RankingClientesOptions,
): RankingClientesResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const diasDormido = opciones.dias_dormido ?? DIAS_DORMIDO;
  const umbralNc = opciones.umbral_nc_pct ?? UMBRAL_NC_ANOMALAS_PCT;
  const limite = opciones.limite ?? 20;
  const warnings: string[] = [];

  const porCliente = new Map<string, ClienteRanking>();
  // Días DISTINTOS en que cada cliente compró. Va aparte del objeto público
  // porque un Set no serializa a JSON: lo que sale es su tamaño y el promedio
  // de los intervalos, no las fechas.
  const diasPorCliente = new Map<string, Set<string>>();
  const totalPorMoneda: Record<string, number> = {};
  let analizados = 0;
  let sinEstado = 0;
  let sinFecha = 0;

  // Conteo de comprobantes POR MONEDA, aparte del total.
  //
  // Existe por el ticket promedio: se calcula sobre la moneda de orden, así que
  // el divisor tienen que ser los comprobantes DE ESA MONEDA. Antes dividía el
  // monto en UYU por el conteo total: un cliente con una factura de $1.000 y
  // otra en dólares mostraba ticket $500 — la mitad del real, sin que nada
  // falle ni avise.
  const conteoPorMoneda = new Map<string, Record<string, number>>();

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    // Recibos y especiales (eRemito/eResguardo) no son facturación.
    if (!clasificacion.suma_en_resumen) continue;

    const estado = clasificarEstado(c.estado);
    if (estado === "desconocido") sinEstado += 1;
    if (soloAceptados && estado !== "aceptado") continue;

    if (c.total === null || c.moneda === null) continue;
    analizados += 1;

    const rut = extractClienteRut(c.cliente);
    const clave = rut ?? SIN_RECEPTOR;
    const fecha = soloFecha(c.fecha_emision);
    if (fecha === null) sinFecha += 1;

    const actual: ClienteRanking = porCliente.get(clave) ?? {
      rut,
      nombre: null,
      facturado_por_moneda: {},
      comprobantes: 0,
      notas_credito_por_moneda: {},
      cantidad_notas_credito: 0,
      ratio_notas_credito_pct: null,
      nc_anomalas: false,
      primera_compra: null,
      ultima_compra: null,
      dias_desde_ultima_compra: null,
      ticket_promedio: null,
      dias_con_compra: 0,
      dias_entre_compras_promedio: null,
      atrasado_vs_su_frecuencia: false,
      participacion_pct: null,
      es_nuevo: null,
      esta_dormido: false,
    };

    if (actual.nombre === null) actual.nombre = extractClienteNombre(c.cliente);

    const montoConSigno = c.total * clasificacion.signo;
    sumar(actual.facturado_por_moneda, c.moneda, montoConSigno);
    sumar(totalPorMoneda, c.moneda, montoConSigno);
    actual.comprobantes += 1;
    const conteos = conteoPorMoneda.get(clave) ?? {};
    conteos[c.moneda] = (conteos[c.moneda] ?? 0) + 1;
    conteoPorMoneda.set(clave, conteos);

    if (clasificacion.categoria === "nota_credito") {
      sumar(actual.notas_credito_por_moneda, c.moneda, c.total);
      actual.cantidad_notas_credito += 1;
    }

    if (fecha !== null) {
      if (actual.primera_compra === null || fecha < actual.primera_compra) actual.primera_compra = fecha;
      if (actual.ultima_compra === null || fecha > actual.ultima_compra) actual.ultima_compra = fecha;
      // Solo las VENTAS marcan una visita. Una nota de crédito no es una compra
      // —es la marcha atrás de una— y contarla acortaría el intervalo promedio
      // justo del cliente que más devuelve.
      if (clasificacion.categoria === "venta") {
        const dias = diasPorCliente.get(clave) ?? new Set<string>();
        dias.add(fecha);
        diasPorCliente.set(clave, dias);
      }
    }

    porCliente.set(clave, actual);
  }

  // --- Moneda de ordenamiento ----------------------------------------------
  const monedasPresentes = Object.keys(totalPorMoneda).sort();
  const monedaOrden = monedaDeOrden(totalPorMoneda, opciones.moneda);

  if (monedasPresentes.length > 1) {
    warnings.push(
      `Hay facturación en ${monedasPresentes.length} monedas (${monedasPresentes.join(", ")}). ` +
        `El ranking se ordena por ${monedaOrden} y los porcentajes son sobre esa moneda. ` +
        "Los montos de las demás monedas están en 'facturado_por_moneda' SIN convertir.",
    );
  }

  // --- Derivados por cliente -----------------------------------------------
  const totalOrden = totalPorMoneda[monedaOrden] ?? 0;
  const clientes = [...porCliente.values()];

  for (const cl of clientes) {
    const montoOrden = cl.facturado_por_moneda[monedaOrden] ?? 0;
    cl.participacion_pct = totalOrden > 0 ? round2((montoOrden / totalOrden) * 100) : null;
    // El divisor son los comprobantes DE LA MONEDA DE ORDEN. Un cliente que
    // solo compró en otra moneda no tiene ticket en esta: null, no cero.
    const comprobantesOrden = conteoPorMoneda.get(cl.rut ?? SIN_RECEPTOR)?.[monedaOrden] ?? 0;
    cl.ticket_promedio = comprobantesOrden > 0 ? round2(montoOrden / comprobantesOrden) : null;
    cl.dias_desde_ultima_compra =
      cl.ultima_compra !== null ? diasEntreFechas(cl.ultima_compra, opciones.hasta) : null;
    // Sin RUT no se puede preguntar si ya había comprado: el grupo
    // "(sin receptor)" junta ventas de mostrador de personas distintas, así que
    // "¿es nuevo?" no tiene respuesta para él, ni true ni false.
    cl.es_nuevo =
      opciones.ruts_previos === undefined || cl.rut === null
        ? null
        : !opciones.ruts_previos.has(cl.rut);
    cl.esta_dormido =
      cl.dias_desde_ultima_compra !== null && cl.dias_desde_ultima_compra > diasDormido;

    // --- Frecuencia de compra (A9) -----------------------------------------
    // El grupo "(sin receptor)" queda afuera a propósito: junta ventas de
    // personas distintas, así que su "ritmo de compra" sería el ritmo del
    // mostrador, no el de nadie.
    const dias = [...(diasPorCliente.get(cl.rut ?? SIN_RECEPTOR) ?? [])].sort();
    cl.dias_con_compra = cl.rut === null ? 0 : dias.length;
    if (cl.rut !== null && dias.length >= MINIMO_DIAS_PARA_FRECUENCIA) {
      const abarca = diasEntreFechas(dias[0]!, dias[dias.length - 1]!);
      const promedio = round2(abarca / (dias.length - 1));
      cl.dias_entre_compras_promedio = promedio;
      cl.atrasado_vs_su_frecuencia =
        promedio > 0 &&
        cl.dias_desde_ultima_compra !== null &&
        cl.dias_desde_ultima_compra > promedio * FACTOR_ATRASO_FRECUENCIA;
    }

    // El ratio se calcula sobre el BRUTO (neto + notas de crédito), no sobre el
    // neto: con el neto, un cliente al que se le anuló casi todo daría un ratio
    // gigante o negativo, que no significa nada.
    const nc = cl.notas_credito_por_moneda[monedaOrden] ?? 0;
    const bruto = montoOrden + nc;
    cl.ratio_notas_credito_pct = bruto > 0 ? round2((nc / bruto) * 100) : null;
    cl.nc_anomalas = cl.ratio_notas_credito_pct !== null && cl.ratio_notas_credito_pct >= umbralNc;
  }

  clientes.sort(
    (a, b) => (b.facturado_por_moneda[monedaOrden] ?? 0) - (a.facturado_por_moneda[monedaOrden] ?? 0),
  );

  // --- Concentración --------------------------------------------------------
  // Se calcula sobre clientes IDENTIFICADOS: el grupo "(sin receptor)" junta
  // ventas de personas distintas, así que tratarlo como un cliente inflaría la
  // concentración con un cliente que no existe.
  const identificados = clientes.filter((c) => c.rut !== null && (c.facturado_por_moneda[monedaOrden] ?? 0) > 0);
  const totalIdentificado = identificados.reduce(
    (acc, c) => acc + (c.facturado_por_moneda[monedaOrden] ?? 0),
    0,
  );

  let concentracion: ConcentracionIngresos | null = null;
  if (identificados.length > 0 && totalIdentificado > 0) {
    const participaciones = identificados.map(
      (c) => ((c.facturado_por_moneda[monedaOrden] ?? 0) / totalIdentificado) * 100,
    );
    const acumular = (n: number): number =>
      round2(participaciones.slice(0, n).reduce((a, b) => a + b, 0));

    let acumulado = 0;
    let hasta50 = 0;
    for (const p of participaciones) {
      if (acumulado >= 50) break;
      acumulado += p;
      hasta50 += 1;
    }

    const hhi = Math.round(participaciones.reduce((acc, p) => acc + p * p, 0));
    const top1 = acumular(1);
    concentracion = {
      moneda: monedaOrden,
      top_1_pct: top1,
      top_3_pct: acumular(3),
      top_5_pct: acumular(5),
      hhi,
      interpretacion: interpretarHhi(hhi, top1),
      clientes_hasta_50_pct: hasta50,
      clientes_totales: identificados.length,
    };
  }

  // --- Warnings de calidad de dato -----------------------------------------
  if (porCliente.has(SIN_RECEPTOR)) {
    const sr = porCliente.get(SIN_RECEPTOR)!;
    warnings.push(
      `${sr.comprobantes} comprobante(s) no tienen receptor identificable y se agruparon como ` +
        `"${SIN_RECEPTOR}". Es lo normal en e-Tickets al mostrador. Ese grupo NO cuenta para la ` +
        "concentración, porque junta ventas de clientes distintos.",
    );
  }
  if (sinFecha > 0) {
    warnings.push(
      `${sinFecha} comprobante(s) sin fecha de emisión utilizable: no cuentan para "nuevo" ni "dormido".`,
    );
  }
  if (sinEstado > 0) {
    warnings.push(
      `${sinEstado} comprobante(s) llegaron sin estado DGI reconocible. Se contaron igual ` +
        "(la ausencia del dato no es evidencia de rechazo).",
    );
  }

  // El atraso relativo llega ANTES que el corte absoluto de "dormido": un
  // cliente semanal que hace 30 días que no compra todavía no está dormido, y
  // ya es el mejor momento para llamarlo.
  const atrasados = clientes.filter((c) => c.atrasado_vs_su_frecuencia && !c.esta_dormido);
  if (atrasados.length > 0) {
    warnings.push(
      `${atrasados.length} cliente(s) llevan más del doble de SU PROPIO intervalo sin comprar y ` +
        `todavía no llegan a los ${diasDormido} días de "dormido" (campo atrasado_vs_su_frecuencia). ` +
        "Es la señal temprana: cuando además figuren como dormidos, ya se fueron.",
    );
  }

  const conNcAnomalas = clientes.filter((c) => c.nc_anomalas).length;
  if (conNcAnomalas > 0) {
    warnings.push(
      `${conNcAnomalas} cliente(s) tienen un ratio de notas de crédito >= ${umbralNc}% ` +
        "(campo nc_anomalas). Volumen alto con muchas notas de crédito no es un buen cliente: " +
        "revisá si hay un problema de calidad, de facturación o de acuerdo comercial.",
    );
  }

  return {
    clientes: clientes.slice(0, limite),
    moneda_orden: monedaOrden,
    monedas_presentes: monedasPresentes,
    concentracion,
    nuevos: clientes.filter((c) => c.es_nuevo === true).length,
    dormidos: clientes.filter((c) => c.esta_dormido).length,
    atrasados_vs_su_frecuencia: atrasados.length,
    total_facturado_por_moneda: totalPorMoneda,
    clientes_totales: porCliente.size,
    comprobantes_analizados: analizados,
    warnings,
  };
}
