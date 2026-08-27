// =============================================================================
// Comparación de períodos, proyección de cierre y exposición cambiaria.
//
// Tres preguntas que comparten los mismos datos:
//   A4 — ¿vendí más o menos que el mes pasado?
//   A5 — si sigo a este ritmo, ¿en cuánto cierro el mes?
//   A6 — ¿cuánto de lo que facturo está en dólares y qué pasa si se mueve?
//
// DECISIONES QUE DEFINEN SI LOS NÚMEROS SIRVEN:
//
// 1. LA COMPARACIÓN ES POR MONEDA. Comparar "total" entre dos meses mezclando
//    UYU y USD produce una variación que refleja el mix de monedas, no las
//    ventas.
//
// 2. LA PROYECCIÓN SOLO EXISTE SI EL PERÍODO ESTÁ ABIERTO. Proyectar un mes ya
//    cerrado no es una proyección: es el dato. Si el período terminó, se
//    devuelve `null` en vez de un número redundante que se puede confundir.
//
// 3. LA PROYECCIÓN ES LINEAL Y LO DICE. Un run-rate no sabe de fines de semana,
//    feriados ni del pico de fin de mes que tienen casi todos los rubros. Es
//    útil como orden de magnitud y peligrosa como promesa, así que viaja con su
//    caveat y con los días efectivamente transcurridos a la vista.
//
// 4. LA EXPOSICIÓN CAMBIARIA USA `tasa_cambio` DEL PROPIO COMPROBANTE, que es
//    la cotización del día de emisión — no una cotización de hoy que no
//    tenemos. Es exposición histórica de lo facturado, no una posición viva.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { clasificarEstado } from "./estadoDgi.js";
import type { RangoFechas } from "./periodo.js";
import { hoyComoDateUy, hoyIsoUy } from "./fechaUy.js";

/** Moneda local: no genera exposición cambiaria. */
export const MONEDA_LOCAL = "UYU";

/**
 * Cómo se proyectó el cierre del período. UNA sola definición, en un array y no
 * en un `type`, porque el schema de salida de `biller_comparar_periodos` los
 * necesita EN TIEMPO DE EJECUCIÓN para armar su `z.enum`.
 *
 * Escrito a mano en los dos lados, se desincronizó: la tool declaraba un
 * `z.literal("run_rate_lineal")` —un solo valor— mientras el servicio devolvía
 * `run_rate_por_dia_de_semana` cada vez que había datos suficientes para
 * aprender el patrón semanal. O sea que la proyección fallaba con un error de
 * validación de salida justo en su mejor caso, que es el caso con más datos.
 */
export const METODOS_PROYECCION = [
  /** Se aprendió el patrón semanal: los sábados del negocio pesan distinto. */
  "run_rate_por_dia_de_semana",
  /** No hubo datos para aprender el patrón: promedio diario parejo. */
  "run_rate_lineal",
] as const;

export type MetodoProyeccion = (typeof METODOS_PROYECCION)[number];

export interface TotalesPeriodo {
  rango: RangoFechas;
  total_por_moneda: Record<string, number>;
  comprobantes: number;
}

export interface VariacionMoneda {
  moneda: string;
  actual: number;
  anterior: number;
  absoluta: number;
  /** null cuando el período anterior fue 0: dividir por cero no es "infinito %". */
  porcentual: number | null;
  lectura: string;
}

export interface Proyeccion {
  moneda: string;
  facturado_hasta_ahora: number;
  dias_transcurridos: number;
  dias_del_periodo: number;
  promedio_diario: number;
  proyectado_al_cierre: number;
  /** Variación proyectada contra el período anterior completo. */
  variacion_proyectada_pct: number | null;
  /**
   * `run_rate_por_dia_de_semana` cuando se pudo aprender el patrón semanal del
   * negocio; `run_rate_lineal` cuando no hubo datos para aprenderlo.
   */
  metodo: MetodoProyeccion;
  /** Promedio de un día hábil y de un día de fin de semana, según los datos. */
  promedio_habil: number | null;
  promedio_finde: number | null;
  advertencia: string;
}

export interface ExposicionCambiaria {
  moneda: string;
  total_moneda_extranjera: number;
  /** Equivalente en moneda local usando la tasa de cada comprobante. */
  equivalente_local: number;
  /** Cotización implícita promedio, ponderada por importe. */
  tasa_promedio_ponderada: number | null;
  /** % de la facturación total (en equivalente local) que está en esta moneda. */
  participacion_pct: number;
  comprobantes: number;
  /** Cuánto cambia el equivalente local si la cotización se mueve. */
  sensibilidad: Array<{ variacion_pct: number; impacto_local: number }>;
}

export interface ComparacionResultado {
  actual: TotalesPeriodo;
  anterior: TotalesPeriodo;
  variaciones: VariacionMoneda[];
  proyeccion: Proyeccion | null;
  exposicion_cambiaria: ExposicionCambiaria[];
  moneda_principal: string | null;
  lectura: string;
  warnings: string[];
}

export interface ComparacionOptions {
  /** Default true: contar solo "Aceptado DGI". */
  solo_aceptados?: boolean;
  /** Fecha de referencia para decidir si el período actual sigue abierto. */
  hoy?: Date;
}

function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1; // inclusive
}

/** Suma los totales netos por moneda de un conjunto de comprobantes. */
function totalizar(
  comprobantes: ComprobanteEmitido[],
  soloAceptados: boolean,
): { totales: Record<string, number>; conteo: number; sinEstado: number } {
  const totales: Record<string, number> = {};
  let conteo = 0;
  // Comprobantes con estado DGI irreconocible. Se cuentan aunque no sumen,
  // porque acá la exclusión silenciosa miente más que en otros lados: una
  // variación se lee como "vendí menos", y si lo único que cambió fue cuántos
  // estados vinieron nulos, la caída es del dato y no del negocio.
  let sinEstado = 0;

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (!clasificacion.suma_en_resumen) continue;
    const clase = clasificarEstado(c.estado);
    if (clase === "desconocido") sinEstado += 1;
    if (soloAceptados && clase !== "aceptado") continue;
    if (c.total === null || c.moneda === null) continue;
    totales[c.moneda] = round2((totales[c.moneda] ?? 0) + c.total * clasificacion.signo);
    conteo += 1;
  }
  return { totales, conteo, sinEstado };
}

function lecturaVariacion(moneda: string, pct: number | null, abs: number): string {
  if (pct === null) {
    return abs > 0
      ? `${moneda}: no había facturación en el período anterior, ahora hay ${round2(abs)}.`
      : `${moneda}: sin facturación en ninguno de los dos períodos.`;
  }
  if (Math.abs(pct) < 1) return `${moneda}: prácticamente igual que el período anterior (${pct}%).`;
  const verbo = pct > 0 ? "subió" : "bajó";
  return `${moneda}: ${verbo} ${Math.abs(pct)}% respecto del período anterior.`;
}

/** Calcula la exposición cambiaria de un conjunto de comprobantes. */
function calcularExposicion(
  comprobantes: ComprobanteEmitido[],
  soloAceptados: boolean,
  totalLocalEquivalente: number,
): { exposiciones: ExposicionCambiaria[]; warnings: string[] } {
  const warnings: string[] = [];
  const porMoneda = new Map<
    string,
    { total: number; equivalente: number; conteo: number; sinTasa: number }
  >();

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (!clasificacion.suma_en_resumen) continue;
    if (soloAceptados && clasificarEstado(c.estado) !== "aceptado") continue;
    if (c.total === null || c.moneda === null || c.moneda === MONEDA_LOCAL) continue;

    const actual = porMoneda.get(c.moneda) ?? { total: 0, equivalente: 0, conteo: 0, sinTasa: 0 };
    const monto = c.total * clasificacion.signo;
    actual.total = round2(actual.total + monto);

    // Sin tasa no se puede convertir. Se cuenta aparte en vez de asumir 1:1,
    // que daría un equivalente absurdamente bajo y sin aviso.
    if (c.tasa_cambio !== null && c.tasa_cambio > 0) {
      actual.equivalente = round2(actual.equivalente + monto * c.tasa_cambio);
    } else {
      actual.sinTasa += 1;
    }
    actual.conteo += 1;
    porMoneda.set(c.moneda, actual);
  }

  const exposiciones: ExposicionCambiaria[] = [];
  for (const [moneda, d] of porMoneda) {
    if (d.sinTasa > 0) {
      warnings.push(
        `${d.sinTasa} comprobante(s) en ${moneda} no traen tasa de cambio: no se pudieron convertir ` +
          "y quedan fuera del equivalente en moneda local.",
      );
    }
    exposiciones.push({
      moneda,
      total_moneda_extranjera: d.total,
      equivalente_local: d.equivalente,
      tasa_promedio_ponderada: d.total !== 0 ? round2(d.equivalente / d.total) : null,
      participacion_pct:
        totalLocalEquivalente > 0 ? round2((d.equivalente / totalLocalEquivalente) * 100) : 0,
      comprobantes: d.conteo,
      // Qué pasa con el equivalente local si la cotización se mueve.
      sensibilidad: [-10, -5, 5, 10].map((v) => ({
        variacion_pct: v,
        impacto_local: round2(d.equivalente * (v / 100)),
      })),
    });
  }

  exposiciones.sort((a, b) => b.equivalente_local - a.equivalente_local);
  return { exposiciones, warnings };
}

/** Un día es de fin de semana si cae sábado o domingo. */
function esFinDeSemana(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Cuántos días hábiles y de fin de semana hay en [desde, hasta], AMBOS incluidos.
 *
 * Inclusivo a propósito, para que coincida con `diasEntre` de este mismo archivo
 * —que también lo es (`+1 // inclusive`)—. Cuando esto era exclusivo, la
 * proyección se comía el último día del mes en silencio: los números seguían
 * siendo razonables, solo que un día más bajos.
 *
 * (Ojo: `services/vencimientos.ts` exporta OTRO `diasEntre` que es exclusivo.
 * Mismo nombre, resultados distintos por uno. No los mezcles.)
 */
function contarDias(desde: string, hasta: string): { habiles: number; finde: number } {
  let habiles = 0;
  let finde = 0;
  for (let t = Date.parse(`${desde}T12:00:00Z`); t <= Date.parse(`${hasta}T12:00:00Z`); t += 86_400_000) {
    if (esFinDeSemana(new Date(t).toISOString().slice(0, 10))) finde += 1;
    else habiles += 1;
  }
  return { habiles, finde };
}

/**
 * Reparte lo facturado hasta hoy entre días hábiles y días de fin de semana.
 *
 * POR QUÉ NO ALCANZA CON "DÍAS HÁBILES"
 *
 * El plan pedía run-rate sobre días hábiles y el código hacía run-rate sobre
 * días calendario. Las dos cosas están mal para este producto, por el mismo
 * motivo: son una SUPOSICIÓN sobre cuándo trabaja el negocio.
 *
 * Un almacén uruguayo factura los sábados —el sábado es el mejor día de la
 * semana en varios rubros—. Un estudio contable no factura ninguno. Dividir por
 * días hábiles sobreestima al primero; dividir por días calendario subestima al
 * segundo. No hay un divisor correcto para los dos.
 *
 * Así que no se supone: se MIDE. Sale del propio historial del período cuánto
 * factura este negocio un día hábil y cuánto un fin de semana, y los días que
 * faltan se proyectan con el promedio del tipo de día que son. El almacén
 * proyecta sábados llenos; el estudio, sábados en cero. Los dos, con sus datos.
 */
function proyectarPorPatron(
  comprobantes: ComprobanteEmitido[],
  soloAceptados: boolean,
  moneda: string,
  desde: string,
  hoyIso: string,
  hasta: string,
): {
  proyectado: number;
  promedioHabil: number | null;
  promedioFinde: number | null;
  metodo: MetodoProyeccion;
} | null {
  let totalHabil = 0;
  let totalFinde = 0;

  for (const c of comprobantes) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (!clasificacion.suma_en_resumen) continue;
    if (soloAceptados && clasificarEstado(c.estado) !== "aceptado") continue;
    if (c.total === null || c.moneda !== moneda) continue;
    const dia = c.fecha_emision?.slice(0, 10);
    if (dia === undefined || dia === "") continue;
    // Fuera del tramo transcurrido no cuenta. El llamador YA filtra por rango,
    // pero esta función divide por una cantidad de días: un comprobante de otro
    // mes que se colara subiría el promedio de un tipo de día sin haber sumado
    // un día al divisor. Es una precondición demasiado silenciosa para confiar.
    if (dia < desde || dia > hoyIso) continue;
    const monto = c.total * clasificacion.signo;
    if (esFinDeSemana(dia)) totalFinde += monto;
    else totalHabil += monto;
  }

  // Transcurrido = [desde, hoy]: hoy YA cuenta, porque ya se facturó en él.
  // Restante = [mañana, hasta]. Las dos mitades son inclusivas y no se pisan.
  const manana = new Date(Date.parse(`${hoyIso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const corridos = contarDias(desde, hoyIso);
  const restantes = manana > hasta ? { habiles: 0, finde: 0 } : contarDias(manana, hasta);

  if (corridos.habiles + corridos.finde === 0) return null;

  const facturado = totalHabil + totalFinde;
  const promedioHabil = corridos.habiles > 0 ? totalHabil / corridos.habiles : null;
  const promedioFinde = corridos.finde > 0 ? totalFinde / corridos.finde : null;

  // Si todavía no pasó ningún fin de semana no se puede saber si este negocio
  // factura o no los sábados. Ahí sí se cae al promedio plano, y se DECLARA:
  // inventar un cero sería afirmar que cierra, que es justo lo que no sabemos.
  const sinPatron = restantes.finde > 0 && promedioFinde === null;
  if (sinPatron) {
    const plano = facturado / (corridos.habiles + corridos.finde);
    return {
      proyectado: round2(facturado + plano * (restantes.habiles + restantes.finde)),
      promedioHabil: promedioHabil === null ? null : round2(promedioHabil),
      promedioFinde: null,
      metodo: "run_rate_lineal",
    };
  }

  return {
    proyectado: round2(
      facturado + (promedioHabil ?? 0) * restantes.habiles + (promedioFinde ?? 0) * restantes.finde,
    ),
    promedioHabil: promedioHabil === null ? null : round2(promedioHabil),
    promedioFinde: promedioFinde === null ? null : round2(promedioFinde),
    metodo: "run_rate_por_dia_de_semana",
  };
}

export function compararPeriodos(
  actualComprobantes: ComprobanteEmitido[],
  anteriorComprobantes: ComprobanteEmitido[],
  rangoActual: RangoFechas,
  rangoAnterior: RangoFechas,
  opciones: ComparacionOptions = {},
): ComparacionResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const hoy = opciones.hoy ?? hoyComoDateUy();
  const warnings: string[] = [];

  const act = totalizar(actualComprobantes, soloAceptados);
  const ant = totalizar(anteriorComprobantes, soloAceptados);

  if (soloAceptados && act.sinEstado + ant.sinEstado > 0) {
    warnings.push(
      `Quedaron fuera de la comparación ${act.sinEstado} comprobante(s) del período actual y ` +
        `${ant.sinEstado} del anterior por no tener un estado DGI reconocible. El criterio es ` +
        'contar solo "Aceptado DGI" (el de Biller), pero OJO: si los dos períodos no tienen la ' +
        "misma cantidad de estados faltantes, parte de la variación que muestra este informe es " +
        "del dato y no de las ventas.",
    );
  }

  // --- Variaciones por moneda ----------------------------------------------
  const monedas = [...new Set([...Object.keys(act.totales), ...Object.keys(ant.totales)])].sort();
  const variaciones: VariacionMoneda[] = monedas.map((moneda) => {
    const a = act.totales[moneda] ?? 0;
    const b = ant.totales[moneda] ?? 0;
    const absoluta = round2(a - b);
    // Dividir por cero no es "creció infinito": es "no hay base de comparación".
    const porcentual = b !== 0 ? round2(((a - b) / Math.abs(b)) * 100) : null;
    return { moneda, actual: a, anterior: b, absoluta, porcentual, lectura: lecturaVariacion(moneda, porcentual, absoluta) };
  });

  const monedaPrincipal =
    monedas.length > 0
      ? monedas.reduce((mejor, m) =>
          Math.abs(act.totales[m] ?? 0) > Math.abs(act.totales[mejor] ?? 0) ? m : mejor,
        )
      : null;

  // --- Proyección (solo si el período sigue abierto) ------------------------
  let proyeccion: Proyeccion | null = null;
  // El día URUGUAYO, no el UTC del proceso. Con `toISOString()` esto sumaba un
  // día fantasma todas las noches (21:00 en adelante): el conteo de días
  // corridos ganaba un día sin facturación, deflactando los promedios, y el
  // último día del mes el período se declaraba cerrado antes de tiempo.
  // Mismo bug y mismo arreglo que `periodo.ts`. Ver `services/fechaUy.ts`.
  const hoyIso = hoyIsoUy(hoy);
  const periodoAbierto = hoyIso >= rangoActual.desde && hoyIso < rangoActual.hasta;

  if (periodoAbierto && monedaPrincipal !== null) {
    const diasTranscurridos = diasEntre(rangoActual.desde, hoyIso);
    const diasTotales = diasEntre(rangoActual.desde, rangoActual.hasta);
    const facturado = act.totales[monedaPrincipal] ?? 0;

    if (diasTranscurridos > 0) {
      const promedioDiario = round2(facturado / diasTranscurridos);
      const patron = proyectarPorPatron(
        actualComprobantes,
        soloAceptados,
        monedaPrincipal,
        rangoActual.desde,
        hoyIso,
        rangoActual.hasta,
      );
      const proyectado = patron?.proyectado ?? round2(promedioDiario * diasTotales);
      const base = ant.totales[monedaPrincipal] ?? 0;
      const porPatron = patron?.metodo === "run_rate_por_dia_de_semana";
      proyeccion = {
        moneda: monedaPrincipal,
        facturado_hasta_ahora: facturado,
        dias_transcurridos: diasTranscurridos,
        dias_del_periodo: diasTotales,
        promedio_diario: promedioDiario,
        promedio_habil: patron?.promedioHabil ?? null,
        promedio_finde: patron?.promedioFinde ?? null,
        proyectado_al_cierre: proyectado,
        variacion_proyectada_pct: base !== 0 ? round2(((proyectado - base) / Math.abs(base)) * 100) : null,
        metodo: patron?.metodo ?? "run_rate_lineal",
        advertencia: porPatron
          ? `Proyección sobre ${diasTranscurridos} de ${diasTotales} días, separando días hábiles ` +
            `(promedio ${monedaPrincipal} ${patron?.promedioHabil ?? 0}) de fines de semana ` +
            `(${monedaPrincipal} ${patron?.promedioFinde ?? 0}), según lo que facturaste vos en cada ` +
            "uno. NO contempla feriados ni el pico de cierre de mes. Sirve como orden de magnitud, " +
            "no como compromiso."
          : `Proyección lineal sobre ${diasTranscurridos} de ${diasTotales} días. Todavía no pasó un ` +
            "fin de semana completo en este período, así que no se puede saber si este negocio " +
            "factura sábados: se reparte parejo. NO contempla feriados ni el pico de cierre de mes.",
      };
    }
  } else if (!periodoAbierto) {
    warnings.push(
      "El período consultado ya está cerrado: no se proyecta nada (el número real ya está en 'actual').",
    );
  }

  // --- Exposición cambiaria -------------------------------------------------
  const totalLocal = act.totales[MONEDA_LOCAL] ?? 0;
  const { exposiciones, warnings: warnFx } = calcularExposicion(
    actualComprobantes,
    soloAceptados,
    totalLocal + Object.entries(act.totales).reduce((acc, [m, v]) => (m === MONEDA_LOCAL ? acc : acc + v), 0),
  );
  warnings.push(...warnFx);

  // --- Lectura --------------------------------------------------------------
  const partes: string[] = [];
  for (const v of variaciones) partes.push(v.lectura);
  if (proyeccion !== null) {
    partes.push(
      `A este ritmo el período cerraría en ${proyeccion.moneda} ${proyeccion.proyectado_al_cierre.toLocaleString("es-UY")} ` +
        `(proyección lineal sobre ${proyeccion.dias_transcurridos} de ${proyeccion.dias_del_periodo} días).`,
    );
  }
  if (exposiciones.length > 0) {
    const e = exposiciones[0]!;
    partes.push(
      `El ${e.participacion_pct}% de la facturación está en ${e.moneda}: una variación del 10% en la ` +
        `cotización mueve ${MONEDA_LOCAL} ${Math.abs(e.sensibilidad[3]?.impacto_local ?? 0).toLocaleString("es-UY")}.`,
    );
  }

  if (monedas.length > 1) {
    warnings.push(
      "Hay más de una moneda: las variaciones se calculan POR MONEDA y no se suman entre sí. " +
        "La exposición cambiaria usa la cotización de cada comprobante, no la de hoy.",
    );
  }

  return {
    actual: { rango: rangoActual, total_por_moneda: act.totales, comprobantes: act.conteo },
    anterior: { rango: rangoAnterior, total_por_moneda: ant.totales, comprobantes: ant.conteo },
    variaciones,
    proyeccion,
    exposicion_cambiaria: exposiciones,
    moneda_principal: monedaPrincipal,
    lectura: partes.join(" "),
    warnings,
  };
}
