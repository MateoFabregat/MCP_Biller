// =============================================================================
// A10 — Cohortes de clientes por mes de alta.
//
// Agrupa a los clientes por el mes de su PRIMERA compra y sigue a cada grupo mes
// a mes: cuántos volvieron y cuánto facturaron. Contesta la pregunta que ningún
// total mensual contesta: "los clientes que gané en marzo, ¿siguen comprando?".
//
// EL CAVEAT QUE HAY QUE LEER ANTES QUE LOS NÚMEROS
//
// "Primera compra" acá significa "primera compra DENTRO DE LA VENTANA
// CONSULTADA". Biller no tiene endpoint de clientes ni fecha de alta, así que la
// cohorte se deriva de la facturación y no hay forma de distinguir a un cliente
// nuevo de uno de hace diez años que volvió justo en el primer mes del rango.
//
// La consecuencia es concreta y siempre en la misma dirección: **el primer mes
// del período está inflado**. Todos los clientes preexistentes que compraron ahí
// aparecen como altas de ese mes. Por eso el resultado marca esa cohorte con
// `posible_contaminada` y lo dice en un warning, en vez de dejar que alguien
// concluya que marzo fue un mes histórico de captación.
//
// La mitigación real no es de código: es pedir una ventana que arranque antes de
// lo que se quiere analizar y descartar las primeras cohortes. Por eso el
// resultado también expone `meses_de_gracia`, para que se vea cuánto colchón se
// pidió.
//
// DECISIONES HEREDADAS de rankingClientes, por los mismos motivos:
//   · no se convierte moneda (todo por moneda, se ordena por una);
//   · las notas de crédito restan;
//   · los recibos no son facturación;
//   · "(sin receptor)" NO forma cohorte: junta personas distintas, y una cohorte
//     de gente distinta no retiene ni deja de retener nada.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { clasificarEstado } from "./estadoDgi.js";
import { monedaDeOrden } from "./monedaOrden.js";

/** Actividad de una cohorte en un mes concreto. */
export interface CeldaCohorte {
  /** Mes calendario, "aaaa-mm". */
  mes: string;
  /** Meses transcurridos desde el alta. 0 = el mes en que entraron. */
  offset: number;
  /** Cuántos clientes de la cohorte facturaron ese mes. */
  clientes_activos: number;
  /** % sobre el tamaño original de la cohorte. */
  retencion_pct: number;
  /** Facturado por esos clientes, en la moneda de ordenamiento. */
  facturado: number;
}

export interface Cohorte {
  /** Mes de alta, "aaaa-mm". */
  mes_alta: string;
  /** Clientes cuya primera compra del rango cae en ese mes. */
  clientes: number;
  /** Facturación acumulada de la cohorte en todo el rango (moneda de orden). */
  facturado_total: number;
  /** Facturado promedio por cliente de la cohorte, en todo el rango. */
  valor_por_cliente: number | null;
  /** Un renglón por mes desde el alta hasta el fin del rango. */
  meses: CeldaCohorte[];
  /**
   * true si esta cohorte cae dentro del colchón inicial y por lo tanto mezcla
   * altas reales con clientes preexistentes. Ver el encabezado del módulo.
   */
  posible_contaminada: boolean;
}

export interface CohortesResultado {
  cohortes: Cohorte[];
  moneda_orden: string;
  monedas_presentes: string[];
  /** Meses del rango, en orden. */
  meses: string[];
  /** Cuántos meses iniciales se marcaron como contaminados. */
  meses_de_gracia: number;
  clientes_totales: number;
  comprobantes_analizados: number;
  /**
   * Retención promedio por offset, sobre las cohortes NO contaminadas y que
   * tuvieron tiempo de llegar a ese offset. Es la curva del negocio.
   */
  retencion_promedio: Array<{ offset: number; retencion_pct: number; cohortes: number }>;
  lectura: string;
  warnings: string[];
}

export interface CohortesOptions {
  /** Default true: contar solo comprobantes "Aceptado DGI". */
  solo_aceptados?: boolean;
  /** Moneda para los importes. Default: la de mayor facturación. */
  moneda?: string;
  /**
   * Cuántos meses iniciales marcar como contaminados. Default 1: el primero
   * SIEMPRE lo está (ver encabezado). Subilo si sabés que el negocio tiene
   * clientes que compran cada varios meses.
   */
  meses_de_gracia?: number;
}

/** "aaaa-mm" de una fecha "aaaa-mm-dd hh:mm:ss". null si no es legible. */
function mesDe(valor: string | null): string | null {
  if (valor === null) return null;
  const t = valor.trim();
  return /^\d{4}-\d{2}/.test(t) ? t.slice(0, 7) : null;
}

/** Distancia en meses entre dos "aaaa-mm". */
export function offsetMeses(desde: string, hasta: string): number {
  const [a1, m1] = desde.split("-").map(Number);
  const [a2, m2] = hasta.split("-").map(Number);
  if ([a1, m1, a2, m2].some((n) => n === undefined || Number.isNaN(n))) return 0;
  return (a2! - a1!) * 12 + (m2! - m1!);
}

/** Lista de meses "aaaa-mm" entre dos fechas, inclusive. */
export function mesesEntre(desde: string, hasta: string): string[] {
  const inicio = mesDe(desde);
  const fin = mesDe(hasta);
  if (inicio === null || fin === null) return [];
  const out: string[] = [];
  let [anio, mes] = inicio.split("-").map(Number) as [number, number];
  for (let i = 0; i <= offsetMeses(inicio, fin); i += 1) {
    out.push(`${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}`);
    mes += 1;
    if (mes > 12) {
      mes = 1;
      anio += 1;
    }
  }
  return out;
}

interface ActividadCliente {
  /** Mes -> facturado en la moneda de orden. */
  porMes: Map<string, number>;
  primerMes: string;
  nombre: string | null;
}

/**
 * Construye las cohortes de un conjunto de comprobantes emitidos.
 * `comprobantes` ya viene filtrado por período de emisión.
 */
export function calcularCohortes(
  comprobantes: ComprobanteEmitido[],
  rango: { desde: string; hasta: string },
  opciones: CohortesOptions = {},
): CohortesResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const gracia = Math.max(0, opciones.meses_de_gracia ?? 1);
  const warnings: string[] = [];

  // --- 1. Primera pasada: totales por moneda para elegir la de orden --------
  const totalPorMoneda: Record<string, number> = {};
  const utiles: Array<{ rut: string; mes: string; moneda: string; monto: number; nombre: string | null }> = [];
  let analizados = 0;
  let sinReceptor = 0;
  let sinFecha = 0;
  let sinEstado = 0;

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (!clasificacion.suma_en_resumen) continue;
    const claseEstado = clasificarEstado(c.estado);
    if (claseEstado === "desconocido") sinEstado += 1;
    if (soloAceptados && claseEstado !== "aceptado") continue;
    if (c.total === null || c.moneda === null) continue;
    analizados += 1;

    const rut = extractClienteRut(c.cliente);
    if (rut === null) {
      sinReceptor += 1;
      continue;
    }
    const mes = mesDe(c.fecha_emision);
    if (mes === null) {
      sinFecha += 1;
      continue;
    }

    const monto = c.total * clasificacion.signo;
    totalPorMoneda[c.moneda] = round2((totalPorMoneda[c.moneda] ?? 0) + monto);
    utiles.push({ rut, mes, moneda: c.moneda, monto, nombre: extractClienteNombre(c.cliente) });
  }

  const monedasPresentes = Object.keys(totalPorMoneda).sort();
  const monedaOrden = monedaDeOrden(totalPorMoneda, opciones.moneda);

  if (monedasPresentes.length > 1) {
    warnings.push(
      `Hay facturación en ${monedasPresentes.length} monedas (${monedasPresentes.join(", ")}). ` +
        `Los importes de las cohortes son SOLO de ${monedaOrden}; la retención (que cuenta clientes, ` +
        "no plata) sí incluye a todos.",
    );
  }

  // --- 2. Actividad por cliente --------------------------------------------
  const porCliente = new Map<string, ActividadCliente>();
  for (const u of utiles) {
    const actual = porCliente.get(u.rut) ?? {
      porMes: new Map<string, number>(),
      primerMes: u.mes,
      nombre: u.nombre,
    };
    // La RETENCIÓN cuenta al cliente en el mes aunque haya facturado en otra
    // moneda: seguir comprando es seguir comprando. El importe solo suma si es
    // la moneda de orden.
    const previo = actual.porMes.get(u.mes) ?? 0;
    actual.porMes.set(u.mes, round2(previo + (u.moneda === monedaOrden ? u.monto : 0)));
    if (u.mes < actual.primerMes) actual.primerMes = u.mes;
    if (actual.nombre === null) actual.nombre = u.nombre;
    porCliente.set(u.rut, actual);
  }

  // --- 3. Cohortes ----------------------------------------------------------
  const meses = mesesEntre(rango.desde, rango.hasta);
  const mesesDeGracia = meses.slice(0, gracia);

  const porCohorte = new Map<string, ActividadCliente[]>();
  for (const actividad of porCliente.values()) {
    const lista = porCohorte.get(actividad.primerMes) ?? [];
    lista.push(actividad);
    porCohorte.set(actividad.primerMes, lista);
  }

  const cohortes: Cohorte[] = [];
  for (const mesAlta of [...porCohorte.keys()].sort()) {
    const miembros = porCohorte.get(mesAlta)!;
    const posteriores = meses.filter((m) => m >= mesAlta);

    let facturadoTotal = 0;
    const celdas: CeldaCohorte[] = posteriores.map((mes) => {
      let activos = 0;
      let facturado = 0;
      for (const m of miembros) {
        const monto = m.porMes.get(mes);
        if (monto === undefined) continue;
        activos += 1;
        facturado = round2(facturado + monto);
      }
      facturadoTotal = round2(facturadoTotal + facturado);
      return {
        mes,
        offset: offsetMeses(mesAlta, mes),
        clientes_activos: activos,
        retencion_pct: miembros.length > 0 ? round2((activos / miembros.length) * 100) : 0,
        facturado,
      };
    });

    cohortes.push({
      mes_alta: mesAlta,
      clientes: miembros.length,
      facturado_total: facturadoTotal,
      valor_por_cliente: miembros.length > 0 ? round2(facturadoTotal / miembros.length) : null,
      meses: celdas,
      posible_contaminada: mesesDeGracia.includes(mesAlta),
    });
  }

  // --- 4. Curva promedio ----------------------------------------------------
  // Solo sobre cohortes limpias. Una cohorte contaminada mezcla clientes viejos
  // —que por definición retienen mucho— y levantaría la curva de todo el negocio.
  const acumPorOffset = new Map<number, { suma: number; cohortes: number }>();
  for (const co of cohortes) {
    if (co.posible_contaminada) continue;
    for (const celda of co.meses) {
      const acc = acumPorOffset.get(celda.offset) ?? { suma: 0, cohortes: 0 };
      acc.suma += celda.retencion_pct;
      acc.cohortes += 1;
      acumPorOffset.set(celda.offset, acc);
    }
  }
  const retencionPromedio = [...acumPorOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, acc]) => ({
      offset,
      retencion_pct: round2(acc.suma / acc.cohortes),
      cohortes: acc.cohortes,
    }));

  // --- 5. Lectura y warnings ------------------------------------------------
  const limpias = cohortes.filter((c) => !c.posible_contaminada);
  const mes1 = retencionPromedio.find((r) => r.offset === 1);
  const lectura =
    limpias.length === 0
      ? "No hay cohortes limpias todavía: todo lo que se ve cae en el colchón inicial del período. " +
        "Pedí un rango que arranque antes para que las altas sean altas de verdad."
      : mes1 === undefined
        ? `Hay ${limpias.length} cohorte(s) utilizable(s), pero ninguna llegó al segundo mes: ` +
          "todavía no hay curva de retención que leer."
        : `De los clientes que entran, en promedio vuelve a comprar el ${mes1.retencion_pct}% al mes ` +
          `siguiente (${mes1.cohortes} cohorte(s) medidas). Todo lo anterior al mes ` +
          `${mesesDeGracia[mesesDeGracia.length - 1] ?? "-"} no se usa para la curva.`;

  if (mesesDeGracia.length > 0) {
    warnings.push(
      `La(s) cohorte(s) de ${mesesDeGracia.join(", ")} están marcadas como 'posible_contaminada' y ` +
        "NO entran en la curva promedio: no hay forma de distinguir un cliente nuevo de uno viejo " +
        "que compró en el primer mes del rango. Biller no expone fecha de alta de clientes, así que " +
        "esto no se arregla con código: se arregla pidiendo un rango que empiece antes.",
    );
  }
  if (sinReceptor > 0) {
    warnings.push(
      `${sinReceptor} comprobante(s) sin receptor identificable quedaron FUERA de las cohortes ` +
        "(es lo normal en e-Tickets al mostrador). Una cohorte de ventas anónimas juntaría personas " +
        "distintas y su retención no significaría nada.",
    );
  }
  if (sinFecha > 0) {
    warnings.push(`${sinFecha} comprobante(s) sin fecha de emisión utilizable: no se pudieron cohortizar.`);
  }
  // Acá la exclusión por estado pega más fuerte que en un total: si la ÚNICA
  // compra de un cliente en su primer mes vino con el estado en null, ese
  // cliente entra a la cohorte equivocada —o no entra— y la curva de retención
  // sale mal para todos los meses siguientes, no solo por el importe.
  if (soloAceptados && sinEstado > 0) {
    warnings.push(
      `${sinEstado} comprobante(s) llegaron sin estado DGI reconocible y NO se cohortizaron ` +
        '(el criterio es contar solo "Aceptado DGI"). Si alguno era la primera compra de un ' +
        "cliente, ese cliente quedó asignado a un mes de alta posterior al real.",
    );
  }
  if (meses.length < 3) {
    warnings.push(
      `El rango cubre ${meses.length} mes(es). Las cohortes necesitan varios meses para decir algo: ` +
        "con menos de tres, lo único que se ve es el mes de alta.",
    );
  }

  return {
    cohortes,
    moneda_orden: monedaOrden,
    monedas_presentes: monedasPresentes,
    meses,
    meses_de_gracia: mesesDeGracia.length,
    clientes_totales: porCliente.size,
    comprobantes_analizados: analizados,
    retencion_promedio: retencionPromedio,
    lectura,
    warnings,
  };
}
