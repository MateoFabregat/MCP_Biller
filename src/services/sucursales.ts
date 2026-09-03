// =============================================================================
// A8 — Ranking por sucursal: participación y evolución.
//
// Biller NO expone un endpoint de sucursales. Lo único que hay es el campo
// `sucursal` de cada comprobante emitido (un id numérico) y, opcionalmente, el
// mapa `BILLER_SUCURSALES_JSON` que le pone nombre. Así que la cartera de
// sucursales se DERIVA de la facturación, igual que la de clientes.
//
// POR QUÉ ESTO NO ES `biller_resumen_facturacion_periodo` CON agrupar_por=sucursal
//
// El resumen agrupado contesta "cuánto facturó cada sucursal". Eso es la mitad
// de la pregunta, y es la mitad que no decide nada: el dueño de tres locales ya
// intuye cuál factura más. Lo que no sabe —y es lo que hace mover una decisión—
// es si la participación de una sucursal SUBIÓ o BAJÓ, y cuánto. Un local que
// facturó lo mismo que el mes pasado mientras los otros dos crecieron 20% está
// perdiendo terreno, y el total absoluto no lo muestra.
//
// De ahí las dos columnas que este módulo agrega sobre el resumen: participación
// (sobre el total del período, por moneda) y variación contra el período
// anterior, en importe y en PUNTOS PORCENTUALES de participación.
//
// TRES DECISIONES QUE VIENEN DE `rankingClientes` Y SE MANTIENEN ACÁ:
//
// 1. NO SE CONVIERTE MONEDA. Todo se acumula por moneda y el ranking se ordena
//    por UNA (default: la de mayor facturación).
// 2. LAS NOTAS DE CRÉDITO RESTAN — `classifyCfe` ya trae el signo.
// 3. LOS RECIBOS NO SON FACTURACIÓN (`suma_en_resumen = false`).
//
// Y una propia: LA SUCURSAL AUSENTE NO ES LA SUCURSAL 0. Un comprobante con
// `sucursal: null` va a un grupo aparte, "(sin sucursal)". Meterlo en la casa
// central por comodidad le inventa facturación a un local real.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { clasificarEstado, estaAceptado } from "./estadoDgi.js";
import { monedaDeOrden } from "./monedaOrden.js";

/** Clave del grupo que junta los comprobantes sin sucursal declarada. */
export const SIN_SUCURSAL = "(sin sucursal)";

/**
 * Puntos porcentuales de participación a partir de los cuales el movimiento se
 * considera relevante. Por debajo de esto es ruido de mix, no una tendencia:
 * dos comprobantes grandes emitidos el 31 en vez del 1 mueven un punto solos.
 */
export const SALTO_PARTICIPACION_PP = 5;

export interface SucursalRanking {
  /** Id tal como lo devuelve Biller. null en el grupo sin sucursal. */
  id: string | null;
  /** Nombre de BILLER_SUCURSALES_JSON, si está configurado. */
  nombre: string | null;
  /** Texto para mostrar: "Sucursal 6 (Pocitos)" o "(sin sucursal)". */
  etiqueta: string;
  /** Facturación neta por moneda (ventas − NC + ND). */
  facturado_por_moneda: Record<string, number>;
  /** Comprobantes que suman (excluye recibos y especiales). */
  comprobantes: number;
  /** Clientes distintos con RUT identificable. Los sin receptor no se cuentan. */
  clientes_distintos: number;
  /** Ticket promedio en la moneda de ordenamiento. */
  ticket_promedio: number | null;
  /** % del total del período en la moneda de ordenamiento. */
  participacion_pct: number | null;
  /** Facturado en el período anterior, en la moneda de ordenamiento. */
  facturado_anterior: number | null;
  /** Variación de importe contra el período anterior, en %. */
  variacion_pct: number | null;
  /** Participación que tenía en el período anterior. */
  participacion_anterior_pct: number | null;
  /**
   * Cuánto se movió la PARTICIPACIÓN, en puntos porcentuales.
   *
   * Es la columna que no se puede leer del total absoluto: una sucursal puede
   * facturar más que el mes pasado y aun así estar perdiendo peso.
   */
  salto_participacion_pp: number | null;
  /** Lectura en castellano de las dos variaciones. */
  lectura: string | null;
}

export interface RankingSucursalesResultado {
  sucursales: SucursalRanking[];
  moneda_orden: string;
  monedas_presentes: string[];
  total_facturado_por_moneda: Record<string, number>;
  /** true si se comparó contra un período anterior. */
  con_comparacion: boolean;
  sucursales_totales: number;
  comprobantes_analizados: number;
  /** Sucursales cuyo peso se movió más de `salto_pp` puntos. Es lo que hay que mirar. */
  movimientos_relevantes: string[];
  warnings: string[];
}

export interface RankingSucursalesOptions {
  /** Mapa id -> nombre, desde BILLER_SUCURSALES_JSON. */
  nombres?: Record<string, string>;
  /** Moneda para ordenar. Si se omite, la de mayor facturación. */
  moneda?: string;
  /** Default true: contar solo comprobantes "Aceptado DGI". */
  solo_aceptados?: boolean;
  /** Umbral en puntos porcentuales para marcar un movimiento. Default 5. */
  salto_pp?: number;
}

interface Acumulado {
  facturado: Record<string, number>;
  comprobantes: number;
  /** Conteo por moneda, para que el ticket promedio no mezcle divisores. */
  comprobantesPorMoneda: Record<string, number>;
  clientes: Set<string>;
}

/** Suma por moneda respetando el signo del tipo de CFE. */
function acumular(
  comprobantes: ComprobanteEmitido[],
  soloAceptados: boolean,
): {
  porSucursal: Map<string, Acumulado>;
  totalPorMoneda: Record<string, number>;
  analizados: number;
  sinEstado: number;
} {
  const porSucursal = new Map<string, Acumulado>();
  const totalPorMoneda: Record<string, number> = {};
  let analizados = 0;
  let sinEstado = 0;

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (!clasificacion.suma_en_resumen) continue;

    const estado = clasificarEstado(c.estado);
    if (estado === "desconocido") sinEstado += 1;
    if (soloAceptados && !estaAceptado(c.estado)) continue;

    if (c.total === null || c.moneda === null) continue;
    analizados += 1;

    const clave = c.sucursal === null ? SIN_SUCURSAL : String(c.sucursal);
    const actual = porSucursal.get(clave) ?? {
      facturado: {},
      comprobantes: 0,
      // Conteo por moneda, para el ticket promedio: el divisor tienen que ser
      // los comprobantes de la moneda que se muestra, no todos. Mismo bug y
      // mismo arreglo que en rankingClientes.
      comprobantesPorMoneda: {},
      clientes: new Set<string>(),
    };

    const monto = c.total * clasificacion.signo;
    actual.facturado[c.moneda] = round2((actual.facturado[c.moneda] ?? 0) + monto);
    totalPorMoneda[c.moneda] = round2((totalPorMoneda[c.moneda] ?? 0) + monto);
    actual.comprobantes += 1;
    actual.comprobantesPorMoneda[c.moneda] = (actual.comprobantesPorMoneda[c.moneda] ?? 0) + 1;

    const rut = extractClienteRut(c.cliente);
    if (rut !== null) actual.clientes.add(rut);

    porSucursal.set(clave, actual);
  }

  return { porSucursal, totalPorMoneda, analizados, sinEstado };
}

function etiquetarSucursal(clave: string, nombres: Record<string, string>): string {
  if (clave === SIN_SUCURSAL) return SIN_SUCURSAL;
  const nombre = nombres[clave];
  return nombre === undefined ? `Sucursal ${clave}` : `Sucursal ${clave} (${nombre})`;
}

/**
 * Lectura de las dos variaciones juntas.
 *
 * Se redacta acá y no en el modelo por el mismo motivo que el caption del PDF:
 * los dos números tienen que contarse en la misma frase para que la
 * contradicción aparente ("facturó más pero pesa menos") se lea como lo que es.
 */
function lecturaMovimiento(
  etiqueta: string,
  variacionPct: number | null,
  saltoPp: number | null,
  moneda: string,
): string | null {
  if (variacionPct === null && saltoPp === null) return null;

  const partes: string[] = [];
  if (variacionPct !== null) {
    const verbo = variacionPct > 0 ? "subió" : variacionPct < 0 ? "bajó" : "quedó igual";
    partes.push(
      variacionPct === 0
        ? `${etiqueta} facturó lo mismo que el período anterior en ${moneda}`
        : `${etiqueta} ${verbo} ${Math.abs(variacionPct)}% en ${moneda}`,
    );
  }
  if (saltoPp !== null && Math.abs(saltoPp) >= 0.01) {
    const verbo = saltoPp > 0 ? "ganó" : "perdió";
    partes.push(`${verbo} ${Math.abs(saltoPp)} puntos de participación`);
  }
  return `${partes.join(" y ")}.`;
}

/**
 * Ranking de sucursales con participación y evolución.
 *
 * `anteriores` es opcional: sin él se calcula solo la participación del período,
 * y `con_comparacion` queda en false. La alternativa —comparar contra un período
 * anterior vacío— haría que toda sucursal apareciera como "creció infinito".
 */
export function rankingSucursales(
  comprobantes: ComprobanteEmitido[],
  anteriores: ComprobanteEmitido[] | null = null,
  opciones: RankingSucursalesOptions = {},
): RankingSucursalesResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const nombres = opciones.nombres ?? {};
  const saltoPp = opciones.salto_pp ?? SALTO_PARTICIPACION_PP;
  const warnings: string[] = [];

  const actual = acumular(comprobantes, soloAceptados);
  const previo = anteriores === null ? null : acumular(anteriores, soloAceptados);

  // --- Moneda de ordenamiento -----------------------------------------------
  const monedasPresentes = Object.keys(actual.totalPorMoneda).sort();
  const monedaOrden = monedaDeOrden(actual.totalPorMoneda, opciones.moneda);

  if (monedasPresentes.length > 1) {
    warnings.push(
      `Hay facturación en ${monedasPresentes.length} monedas (${monedasPresentes.join(", ")}). ` +
        `El ranking se ordena por ${monedaOrden} y las participaciones son sobre esa moneda. ` +
        "Los montos de las demás están en 'facturado_por_moneda' SIN convertir.",
    );
  }

  const totalOrden = actual.totalPorMoneda[monedaOrden] ?? 0;
  const totalOrdenPrevio = previo?.totalPorMoneda[monedaOrden] ?? 0;

  // --- Filas -----------------------------------------------------------------
  const sucursales: SucursalRanking[] = [];
  const movimientos: string[] = [];

  for (const [clave, datos] of actual.porSucursal) {
    const montoOrden = datos.facturado[monedaOrden] ?? 0;
    const participacion = totalOrden > 0 ? round2((montoOrden / totalOrden) * 100) : null;

    let facturadoAnterior: number | null = null;
    let variacionPct: number | null = null;
    let participacionAnterior: number | null = null;
    let salto: number | null = null;

    if (previo !== null) {
      facturadoAnterior = round2(previo.porSucursal.get(clave)?.facturado[monedaOrden] ?? 0);
      // Dividir por cero no es "creció infinito": una sucursal que abrió este
      // período no tiene variación porcentual, tiene una primera facturación.
      variacionPct =
        facturadoAnterior !== 0
          ? round2(((montoOrden - facturadoAnterior) / Math.abs(facturadoAnterior)) * 100)
          : null;
      participacionAnterior =
        totalOrdenPrevio > 0 ? round2((facturadoAnterior / totalOrdenPrevio) * 100) : null;
      salto =
        participacion !== null && participacionAnterior !== null
          ? round2(participacion - participacionAnterior)
          : null;
    }

    const etiqueta = etiquetarSucursal(clave, nombres);
    const lectura = lecturaMovimiento(etiqueta, variacionPct, salto, monedaOrden);

    if (salto !== null && Math.abs(salto) >= saltoPp && lectura !== null) {
      movimientos.push(lectura);
    }

    sucursales.push({
      id: clave === SIN_SUCURSAL ? null : clave,
      nombre: clave === SIN_SUCURSAL ? null : (nombres[clave] ?? null),
      etiqueta,
      facturado_por_moneda: datos.facturado,
      comprobantes: datos.comprobantes,
      clientes_distintos: datos.clientes.size,
      ticket_promedio:
        (datos.comprobantesPorMoneda[monedaOrden] ?? 0) > 0
          ? round2(montoOrden / datos.comprobantesPorMoneda[monedaOrden]!)
          : null,
      participacion_pct: participacion,
      facturado_anterior: facturadoAnterior,
      variacion_pct: variacionPct,
      participacion_anterior_pct: participacionAnterior,
      salto_participacion_pp: salto,
      lectura,
    });
  }

  sucursales.sort(
    (a, b) => (b.facturado_por_moneda[monedaOrden] ?? 0) - (a.facturado_por_moneda[monedaOrden] ?? 0),
  );

  // --- Sucursales que DESAPARECIERON ----------------------------------------
  // Una sucursal que facturaba y este período no facturó nada no aparece en el
  // Map actual, así que sin esto se caería del ranking en silencio — y es
  // exactamente el caso más grave que este módulo puede detectar.
  if (previo !== null) {
    for (const [clave, datos] of previo.porSucursal) {
      if (actual.porSucursal.has(clave)) continue;
      const montoPrevio = round2(datos.facturado[monedaOrden] ?? 0);
      if (montoPrevio === 0) continue;
      const etiqueta = etiquetarSucursal(clave, nombres);
      warnings.push(
        `${etiqueta} facturó ${montoPrevio} ${monedaOrden} en el período anterior y NADA en este. ` +
          "O dejó de operar, o dejó de emitir por Biller: las dos cosas hay que mirarlas.",
      );
      sucursales.push({
        id: clave === SIN_SUCURSAL ? null : clave,
        nombre: clave === SIN_SUCURSAL ? null : (nombres[clave] ?? null),
        etiqueta,
        facturado_por_moneda: {},
        comprobantes: 0,
        clientes_distintos: 0,
        ticket_promedio: null,
        participacion_pct: totalOrden > 0 ? 0 : null,
        facturado_anterior: montoPrevio,
        variacion_pct: -100,
        participacion_anterior_pct:
          totalOrdenPrevio > 0 ? round2((montoPrevio / totalOrdenPrevio) * 100) : null,
        salto_participacion_pp:
          totalOrden > 0 && totalOrdenPrevio > 0
            ? round2(0 - (montoPrevio / totalOrdenPrevio) * 100)
            : null,
        lectura: `${etiqueta} no facturó nada en este período (venía de ${montoPrevio} ${monedaOrden}).`,
      });
    }
  }

  // --- Warnings de calidad de dato ------------------------------------------
  if (actual.porSucursal.has(SIN_SUCURSAL)) {
    const sinSuc = actual.porSucursal.get(SIN_SUCURSAL)!;
    warnings.push(
      `${sinSuc.comprobantes} comprobante(s) no traen sucursal y se agruparon como "${SIN_SUCURSAL}". ` +
        "NO se sumaron a ninguna sucursal real: hacerlo le inventaría facturación a un local.",
    );
  }
  // Ver la nota equivalente en rankingClientes: el texto sigue a `soloAceptados`
  // porque con el filtro apagado estos comprobantes SÍ están contados.
  if (actual.sinEstado > 0) {
    warnings.push(
      soloAceptados
        ? `${actual.sinEstado} comprobante(s) llegaron sin estado DGI reconocible y NO se contaron: el ` +
          'criterio es contar solo "Aceptado DGI", que es con el que Biller arma sus números. Si se ' +
          "concentran en una sucursal, su participación en el ranking sale más baja de lo real."
        : `${actual.sinEstado} comprobante(s) llegaron sin estado DGI reconocible y SÍ están contados ` +
          "porque solo_aceptados=false. Ese monto NO va a coincidir con lo que muestra Biller.",
    );
  }
  if (Object.keys(nombres).length === 0 && actual.porSucursal.size > 1) {
    warnings.push(
      "No hay nombres de sucursal configurados (BILLER_SUCURSALES_JSON), así que el ranking dice " +
        '"Sucursal 6" en vez de "Pocitos". Biller no expone un endpoint de sucursales: el mapa es ' +
        "la única forma de nombrarlas.",
    );
  }
  if (previo === null) {
    warnings.push(
      "Sin período de comparación: se calculó la participación de cada sucursal pero no su evolución. " +
        "La participación sola no dice si una sucursal está ganando o perdiendo terreno.",
    );
  }

  return {
    sucursales,
    moneda_orden: monedaOrden,
    monedas_presentes: monedasPresentes,
    total_facturado_por_moneda: actual.totalPorMoneda,
    con_comparacion: previo !== null,
    sucursales_totales: sucursales.length,
    comprobantes_analizados: actual.analizados,
    movimientos_relevantes: movimientos,
    warnings,
  };
}
