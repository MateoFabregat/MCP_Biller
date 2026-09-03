// =============================================================================
// Servicio de alertas operativas: lo que hay que mirar HOY y nadie mira.
//
// Problemas reales que ya se pueden detectar con lo que la API devuelve, y que
// hoy se descubren cuando ya rompieron:
//
//  1. RECHAZOS DGI. El campo `estado` viene en cada comprobante pero nadie lo
//     revisa. Un CFE "Rechazado DGI" no tiene validez fiscal: la venta existe
//     en el sistema y no existe ante DGI.
//
//  2. CAE POR AGOTARSE O VENCER. Cada CFE trae su CAE con el rango autorizado
//     (`inicio`..`fin`) y la fecha de expiración. Cuando se agota el rango o se
//     vence la autorización, la facturación se detiene — siempre un viernes.
//
//  3. EMISIÓN TARDÍA. `fecha_creacion` (cuándo se cargó el CFE en Biller) puede
//     ser muy posterior a `fecha_emision` (la fecha fiscal declarada). Ese
//     delta es riesgo real: un CFE emitido el 30/06 y cargado el 12/07 se
//     declaró fuera de plazo ante DGI, aunque el sistema lo muestre como una
//     factura más.
//
//  4. RACHA SIN FACTURAR. No hay un número mágico de "días sin facturar": una
//     empresa que factura una vez por semana no tiene nada de raro un martes.
//     Lo que importa es la racha actual COMPARADA con el comportamiento propio
//     del período, no un umbral absoluto.
//
// (El certificado único de DGI, otro corte de facturación posible, requiere una
// consulta HTTP aparte con estructura de respuesta no documentada: el I/O y el
// armado de la alerta viven en la tool `biller_alertas_operativas`, y el parseo
// del vencimiento con sus umbrales en `services/certificadoDgi.ts`.)
//
// LÍMITE del análisis de CAE: solo se ven los comprobantes del período
// consultado, así que `ultimo_numero_usado` es una COTA INFERIOR y los
// disponibles son una estimación OPTIMISTA. Se avisa explícitamente.
// =============================================================================

import { asRecord, toNumberOrNull, toStringOrNull } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { hoyComoDateUy } from "./fechaUy.js";
import { aIso } from "./periodo.js";
import { clasificarEstado } from "./estadoDgi.js";
import { diasEntre } from "./vencimientos.js";

export type Severidad = "critica" | "advertencia" | "info";

const ORDEN_SEVERIDAD: Record<Severidad, number> = { critica: 0, advertencia: 1, info: 2 };

/** Umbrales de CAE. Elegidos para avisar con tiempo de pedir uno nuevo a DGI. */
export const CAE_DIAS_CRITICO = 15;
export const CAE_DIAS_ADVERTENCIA = 45;
export const CAE_NUMEROS_CRITICO = 100;
export const CAE_NUMEROS_ADVERTENCIA = 500;
/** Porcentaje restante del rango autorizado por debajo del cual se avisa. */
export const CAE_PORCENTAJE_CRITICO = 0.05;
export const CAE_PORCENTAJE_ADVERTENCIA = 0.2;

/**
 * Umbrales de emisión tardía (delta en días entre fecha_creacion y
 * fecha_emision). 3 días es la tolerancia operativa razonable: cierres de
 * caja, carga en lote un lunes de lo facturado el viernes, feriados. A partir
 * de 10 días ya no es un desfasaje puntual sino un problema de proceso (el
 * circuito de carga está roto, no una excepción aislada).
 */
export const EMISION_TARDIA_DIAS_ADVERTENCIA = 3;
export const EMISION_TARDIA_DIAS_CRITICA = 10;

/**
 * Criterio de "racha anómala sin facturar": se alerta cuando la racha actual
 * (desde la última emisión hasta hoy) más que DUPLICA la brecha más grande
 * observada dentro del propio período. Así una empresa que factura una vez
 * por semana (brecha habitual ~7 días) no dispara nada un martes cualquiera:
 * necesita saltearse más de dos ciclos completos para alertar. El piso
 * mínimo cubre el caso contrario, una empresa que factura todos los días
 * (brecha habitual ~1 día o 0): sin piso, un solo día de corte ya "duplicaría"
 * la brecha habitual y alertaría por nada.
 */
export const RACHA_FACTOR_ANOMALIA = 2;
export const RACHA_MINIMO_DIAS = 3;

export type TipoAlerta =
  | "rechazo_dgi"
  | "estado_pendiente"
  | "cae_por_agotarse"
  | "cae_por_vencer"
  | "cae_vencido"
  | "emision_tardia"
  | "sin_facturar"
  | "certificado_vencido"
  | "certificado_por_vencer";

export interface Alerta {
  tipo: TipoAlerta;
  severidad: Severidad;
  titulo: string;
  detalle: string;
  /** Cuántos comprobantes/series afecta. */
  cantidad: number;
  /** Datos estructurados de la alerta, para que el asistente pueda profundizar. */
  datos: Record<string, unknown>;
}

// --- Rechazos DGI -----------------------------------------------------------

export interface ComprobanteConProblema {
  id: number | null;
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  estado: string | null;
  moneda: string | null;
  total: number | null;
  sucursal: number | null;
}

function aProblema(c: ComprobanteEmitido): ComprobanteConProblema {
  return {
    id: c.id,
    tipo_comprobante: c.tipo_comprobante,
    // Con el indicador, un recibo rechazado se lee "Recibo de e-Factura" y no
    // "e-Factura": al ir a corregirlo, importa saber que es una cobranza.
    etiqueta_tipo: classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia).etiqueta,
    serie: c.serie,
    numero: c.numero,
    fecha_emision: c.fecha_emision?.slice(0, 10) ?? null,
    estado: c.estado,
    moneda: c.moneda,
    total: c.total,
    sucursal: c.sucursal,
  };
}

/** Un estado "Rechazado" es fiscalmente inválido; "Pendiente" solo está en curso. */
function severidadDeEstado(estado: string): Severidad {
  return /rechazado/i.test(estado) ? "critica" : "advertencia";
}

export interface RechazosResultado {
  por_estado: Array<{
    estado: string;
    severidad: Severidad;
    conteo: number;
    comprobantes: ComprobanteConProblema[];
  }>;
  conteo_total: number;
}

/**
 * Agrupa por estado DGI todos los comprobantes que NO fueron aceptados.
 *
 * El estado AUSENTE (null o vacío) no se reporta como problema: la falta del
 * dato no es evidencia de rechazo, y llenar la pantalla de alertas por un campo
 * que la API no mandó es ruido. Un estado PRESENTE pero que no reconocemos SÍ
 * se reporta, y esa distinción es deliberada: son dos cosas distintas metidas
 * en la misma clase `desconocido`. Si DGI o Biller estrenan una redacción de
 * rechazo que no contiene la palabra "rechazado", el comprobante tiene que
 * aparecer igual en el panel; que el asistente se calle es la dirección
 * equivocada del error. Un texto nuevo e inofensivo, en cambio, cuesta una
 * línea de advertencia que el usuario descarta mirándola.
 *
 * (Los TOTALES contestan otra pregunta y ahí las dos variantes de `desconocido`
 * se tratan igual —ninguna suma—: ver `estaAceptado` en `estadoDgi.ts`.)
 */
export function detectarRechazos(
  comprobantes: ComprobanteEmitido[],
  opciones: { max_por_estado?: number } = {},
): RechazosResultado {
  const maxPorEstado = opciones.max_por_estado ?? 20;
  const porEstado = new Map<string, ComprobanteConProblema[]>();

  for (const c of comprobantes) {
    // Antes esto era `!== "no_aceptado"` contra la `clasificarEstado` del
    // resumen, donde SOLO null y el vacío daban `desconocido` y un texto
    // irreconocible caía en `no_aceptado` —o sea que se alertaba—. La
    // clasificación unificada mete las dos cosas en `desconocido`, así que hay
    // que volver a separarlas acá a mano para no perder esa alerta: este cambio
    // unificó el criterio de los TOTALES, no el de las alertas.
    const clase = clasificarEstado(c.estado);
    if (clase === "aceptado" || clase === "no_corresponde_enviar") continue;
    if (clase === "desconocido" && (c.estado === null || c.estado.trim() === "")) continue;
    // No hace falta default: los dos filtros de arriba ya sacaron el null y el
    // vacío, así que acá siempre hay texto. Se trimea para que "Rechazado DGI"
    // y " Rechazado DGI " no abran dos filas del mismo problema.
    const estado = (c.estado ?? "").trim();
    const lista = porEstado.get(estado) ?? [];
    lista.push(aProblema(c));
    porEstado.set(estado, lista);
  }

  const por_estado = [...porEstado.entries()]
    .map(([estado, comprobantes_estado]) => ({
      estado,
      severidad: severidadDeEstado(estado),
      conteo: comprobantes_estado.length,
      comprobantes: comprobantes_estado.slice(0, maxPorEstado),
    }))
    .sort(
      (a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad] || b.conteo - a.conteo,
    );

  return {
    por_estado,
    conteo_total: por_estado.reduce((acc, e) => acc + e.conteo, 0),
  };
}

// --- CAE --------------------------------------------------------------------

export interface CaeSerie {
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  serie: string | null;
  cae_numero: string | null;
  inicio: number | null;
  fin: number | null;
  /** Mayor número visto en el período consultado. Cota INFERIOR de lo usado. */
  ultimo_numero_usado: number | null;
  /** fin - ultimo_numero_usado. Estimación OPTIMISTA (ver nota del módulo). */
  disponibles_estimados: number | null;
  /** Proporción del rango autorizado que queda libre (0..1). */
  porcentaje_disponible: number | null;
  fecha_expiracion: string | null;
  /** Negativo = ya vencido. */
  dias_para_expirar: number | null;
  severidad: Severidad;
  motivos: string[];
  comprobantes_en_periodo: number;
}

interface CaeCrudo {
  numero: string | null;
  serie: string | null;
  inicio: number | null;
  fin: number | null;
  fecha_expiracion: string | null;
}

export function parseCae(cae: unknown): CaeCrudo | null {
  const rec = asRecord(cae);
  if (Object.keys(rec).length === 0) return null;
  return {
    numero: toStringOrNull(rec.numero),
    serie: toStringOrNull(rec.serie),
    inicio: toNumberOrNull(rec.inicio),
    fin: toNumberOrNull(rec.fin),
    fecha_expiracion: toStringOrNull(rec.fecha_expiracion),
  };
}

/**
 * Consolida el estado de cada CAE visto en el período: cuánto rango queda y
 * cuándo expira la autorización.
 */
export function analizarCae(
  comprobantes: ComprobanteEmitido[],
  opciones: { hoy?: Date } = {},
): CaeSerie[] {
  const hoyIso = aIso(opciones.hoy ?? hoyComoDateUy());
  const series = new Map<string, CaeSerie>();

  for (const c of comprobantes) {
    const cae = parseCae(c.cae);
    if (cae === null) continue;

    const clave = `${c.tipo_comprobante ?? "?"}|${cae.serie ?? c.serie ?? "?"}|${cae.numero ?? "?"}`;
    const actual = series.get(clave) ?? {
      tipo_comprobante: c.tipo_comprobante,
      etiqueta_tipo: classifyCfe(c.tipo_comprobante).etiqueta,
      serie: cae.serie ?? c.serie,
      cae_numero: cae.numero,
      inicio: cae.inicio,
      fin: cae.fin,
      ultimo_numero_usado: null,
      disponibles_estimados: null,
      porcentaje_disponible: null,
      fecha_expiracion: cae.fecha_expiracion,
      dias_para_expirar: null,
      severidad: "info" as Severidad,
      motivos: [],
      comprobantes_en_periodo: 0,
    };

    if (c.numero !== null) {
      actual.ultimo_numero_usado =
        actual.ultimo_numero_usado === null
          ? c.numero
          : Math.max(actual.ultimo_numero_usado, c.numero);
    }
    actual.comprobantes_en_periodo += 1;
    series.set(clave, actual);
  }

  for (const s of series.values()) {
    const motivos: string[] = [];
    let severidad: Severidad = "info";
    const subir = (nueva: Severidad): void => {
      if (ORDEN_SEVERIDAD[nueva] < ORDEN_SEVERIDAD[severidad]) severidad = nueva;
    };

    if (s.fin !== null && s.ultimo_numero_usado !== null) {
      s.disponibles_estimados = s.fin - s.ultimo_numero_usado;
      const rango = s.inicio !== null ? s.fin - s.inicio + 1 : null;
      s.porcentaje_disponible =
        rango !== null && rango > 0
          ? Math.max(0, Math.min(1, s.disponibles_estimados / rango))
          : null;

      const pocosNumeros = s.disponibles_estimados <= CAE_NUMEROS_CRITICO;
      const pocoPorcentaje =
        s.porcentaje_disponible !== null && s.porcentaje_disponible <= CAE_PORCENTAJE_CRITICO;
      if (pocosNumeros || pocoPorcentaje) {
        subir("critica");
        motivos.push(
          `Quedan ~${s.disponibles_estimados} números autorizados (de ${rango ?? "?"}). Pedí un CAE nuevo ya.`,
        );
      } else if (
        s.disponibles_estimados <= CAE_NUMEROS_ADVERTENCIA ||
        (s.porcentaje_disponible !== null &&
          s.porcentaje_disponible <= CAE_PORCENTAJE_ADVERTENCIA)
      ) {
        subir("advertencia");
        motivos.push(`Quedan ~${s.disponibles_estimados} números autorizados (de ${rango ?? "?"}).`);
      }
    }

    if (s.fecha_expiracion !== null && /^\d{4}-\d{2}-\d{2}/.test(s.fecha_expiracion)) {
      const dias = diasEntre(hoyIso, s.fecha_expiracion.slice(0, 10));
      s.dias_para_expirar = dias;
      if (dias < 0) {
        subir("critica");
        motivos.push(`El CAE venció hace ${-dias} día(s) (${s.fecha_expiracion}).`);
      } else if (dias <= CAE_DIAS_CRITICO) {
        subir("critica");
        motivos.push(`El CAE vence en ${dias} día(s) (${s.fecha_expiracion}).`);
      } else if (dias <= CAE_DIAS_ADVERTENCIA) {
        subir("advertencia");
        motivos.push(`El CAE vence en ${dias} día(s) (${s.fecha_expiracion}).`);
      }
    }

    s.motivos = motivos;
    s.severidad = severidad;
  }

  return [...series.values()].sort(
    (a, b) =>
      ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad] ||
      (a.disponibles_estimados ?? Number.POSITIVE_INFINITY) -
        (b.disponibles_estimados ?? Number.POSITIVE_INFINITY),
  );
}

// --- Emisión tardía ----------------------------------------------------------

export interface ComprobanteEmisionTardia extends ComprobanteConProblema {
  fecha_creacion: string | null;
  /** fecha_creacion - fecha_emision, en días. Siempre positivo acá (ver filtro). */
  dias_de_atraso: number;
}

export interface EmisionTardiaGrupo {
  severidad: Severidad;
  conteo: number;
  comprobantes: ComprobanteEmisionTardia[];
}

export interface EmisionTardiaResultado {
  por_severidad: EmisionTardiaGrupo[];
  conteo_total: number;
  /**
   * Comprobantes con fecha_creacion ANTERIOR a fecha_emision (delta negativo).
   * No es emisión tardía — es otra cosa (error de carga/reloj, o directamente
   * una emisión con fecha fiscal futura) — así que se cuentan aparte y no
   * entran en `por_severidad`.
   */
  conteo_emision_futura: number;
}

/**
 * Compara `fecha_creacion` (cuándo se cargó el CFE en Biller) contra
 * `fecha_emision` (la fecha fiscal declarada ante DGI). Un delta grande es
 * riesgo fiscal real: la DGI ve un comprobante declarado fuera de plazo.
 *
 * Un delta de 0 o negativo NO se reporta como tardío: 0 es carga el mismo día
 * y negativo es "creado antes de su propia fecha de emisión", que es un caso
 * distinto (ver `conteo_emision_futura`), no una demora.
 */
export function detectarEmisionTardia(
  comprobantes: ComprobanteEmitido[],
  opciones: { max_por_severidad?: number } = {},
): EmisionTardiaResultado {
  const maxPorSeveridad = opciones.max_por_severidad ?? 20;
  const grupos = new Map<Severidad, ComprobanteEmisionTardia[]>();
  let emisionFutura = 0;

  for (const c of comprobantes) {
    const emision = c.fecha_emision?.slice(0, 10) ?? null;
    const creacion = c.fecha_creacion?.slice(0, 10) ?? null;
    // Sin ambas fechas no hay delta que calcular sin inventar un dato.
    if (emision === null || creacion === null) continue;

    const dias = diasEntre(emision, creacion);
    if (dias < 0) {
      emisionFutura += 1;
      continue;
    }
    if (dias < EMISION_TARDIA_DIAS_ADVERTENCIA) continue;

    const severidad: Severidad = dias >= EMISION_TARDIA_DIAS_CRITICA ? "critica" : "advertencia";
    const lista = grupos.get(severidad) ?? [];
    lista.push({ ...aProblema(c), fecha_creacion: creacion, dias_de_atraso: dias });
    grupos.set(severidad, lista);
  }

  const por_severidad = [...grupos.entries()]
    .map(([severidad, lista]) => ({
      severidad,
      conteo: lista.length,
      comprobantes: [...lista]
        .sort((a, b) => b.dias_de_atraso - a.dias_de_atraso)
        .slice(0, maxPorSeveridad),
    }))
    .sort((a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad]);

  return {
    por_severidad,
    conteo_total: por_severidad.reduce((acc, g) => acc + g.conteo, 0),
    conteo_emision_futura: emisionFutura,
  };
}

// --- Racha sin facturar ------------------------------------------------------

export interface RachaSinFacturarResultado {
  /** Cantidad de días distintos con al menos una emisión dentro del período. */
  dias_con_emision: number;
  /** Mayor brecha (en días) entre dos días consecutivos con emisión, dentro del período. */
  brecha_habitual_dias: number;
  /** Días transcurridos desde la última emisión del período hasta `hoy`. */
  racha_actual_dias: number;
  ultima_emision: string | null;
  /** Umbral que superó (o no) la racha actual: max(brecha_habitual * factor, mínimo). */
  umbral_dias: number;
  alerta: boolean;
}

export interface RachaSinFacturarOptions {
  /** Fecha de referencia ("hoy"). Inyectable para poder testear sin depender del reloj. */
  hoy?: Date;
  factor?: number;
  minimoDias?: number;
}

/**
 * Detecta un corte de facturación RELATIVO al comportamiento propio del
 * período, no contra un umbral fijo. Una empresa que factura una vez por
 * semana no tiene que sufrir una alerta cada martes: lo anómalo es que la
 * racha actual supere claramente su propia brecha habitual (ver
 * `RACHA_FACTOR_ANOMALIA` / `RACHA_MINIMO_DIAS`).
 *
 * Devuelve `null` cuando no hay ningún comprobante con fecha_emision
 * utilizable: no hay racha que calcular, y ya existe un warning aparte para
 * "no hay comprobantes en el período" (o, si los hay pero sin fecha usable,
 * `generarAlertas` avisa igual).
 */
export function detectarRachaSinFacturar(
  comprobantes: ComprobanteEmitido[],
  opciones: RachaSinFacturarOptions = {},
): RachaSinFacturarResultado | null {
  const hoyIso = aIso(opciones.hoy ?? hoyComoDateUy());
  const factor = opciones.factor ?? RACHA_FACTOR_ANOMALIA;
  const minimoDias = opciones.minimoDias ?? RACHA_MINIMO_DIAS;

  const dias = [
    ...new Set(
      comprobantes
        .map((c) => c.fecha_emision?.slice(0, 10) ?? null)
        .filter((d): d is string => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ].sort();

  if (dias.length === 0) return null;

  // Brecha habitual = la mayor separación entre dos días CON emisión dentro
  // del período. Con un solo día de emisión no hay brecha que medir (queda 0):
  // cualquier corte posterior se juzga solo contra el piso mínimo.
  let brechaHabitual = 0;
  for (let i = 1; i < dias.length; i++) {
    brechaHabitual = Math.max(brechaHabitual, diasEntre(dias[i - 1]!, dias[i]!));
  }

  const ultimaEmision = dias[dias.length - 1]!;
  // Math.max(0, ...) por si `hoy` cae antes de la última emisión del período
  // consultado (p.ej. se pasó un `hoy` de test desalineado): una racha no
  // puede ser negativa.
  const rachaActual = Math.max(0, diasEntre(ultimaEmision, hoyIso));

  const umbral = Math.max(brechaHabitual * factor, minimoDias);

  return {
    dias_con_emision: dias.length,
    brecha_habitual_dias: brechaHabitual,
    racha_actual_dias: rachaActual,
    ultima_emision: ultimaEmision,
    umbral_dias: umbral,
    alerta: rachaActual > umbral,
  };
}

// --- Composición ------------------------------------------------------------

export interface AlertasResultado {
  alertas: Alerta[];
  rechazos: RechazosResultado;
  cae: CaeSerie[];
  emision_tardia: EmisionTardiaResultado;
  racha_sin_facturar: RachaSinFacturarResultado | null;
  conteo_por_severidad: Record<Severidad, number>;
  comprobantes_analizados: number;
  warnings: string[];
}

export interface AlertasOptions {
  hoy?: Date;
  /** Cuántos comprobantes de ejemplo devolver por cada estado con problema. */
  max_por_estado?: number;
}

export function generarAlertas(
  comprobantes: ComprobanteEmitido[],
  options: AlertasOptions = {},
): AlertasResultado {
  const rechazos = detectarRechazos(comprobantes, { max_por_estado: options.max_por_estado });
  const cae = analizarCae(comprobantes, { hoy: options.hoy });
  const emisionTardia = detectarEmisionTardia(comprobantes, {
    max_por_severidad: options.max_por_estado,
  });
  const racha = detectarRachaSinFacturar(comprobantes, { hoy: options.hoy });
  const alertas: Alerta[] = [];

  for (const grupo of rechazos.por_estado) {
    const esRechazo = /rechazado/i.test(grupo.estado);
    alertas.push({
      tipo: esRechazo ? "rechazo_dgi" : "estado_pendiente",
      severidad: grupo.severidad,
      titulo: `${grupo.conteo} comprobante(s) en estado "${grupo.estado}"`,
      detalle: esRechazo
        ? `Esos comprobantes NO tienen validez fiscal: la venta figura en el sistema pero no ante DGI. ` +
          "Hay que reemitirlos o corregirlos."
        : `Esos comprobantes todavía no fueron aceptados por DGI. Si el estado no cambia, revisá el envío.`,
      cantidad: grupo.conteo,
      datos: { estado: grupo.estado, comprobantes: grupo.comprobantes },
    });
  }

  for (const s of cae) {
    if (s.severidad === "info") continue;
    const porVencer =
      s.dias_para_expirar !== null && s.dias_para_expirar <= CAE_DIAS_ADVERTENCIA;
    const vencido = s.dias_para_expirar !== null && s.dias_para_expirar < 0;
    alertas.push({
      tipo: vencido ? "cae_vencido" : porVencer ? "cae_por_vencer" : "cae_por_agotarse",
      severidad: s.severidad,
      titulo: `CAE ${s.cae_numero ?? "(sin número)"} — ${s.etiqueta_tipo} serie ${s.serie ?? "?"}`,
      detalle: s.motivos.join(" "),
      cantidad: 1,
      datos: { cae: s },
    });
  }

  for (const grupo of emisionTardia.por_severidad) {
    const umbralDias =
      grupo.severidad === "critica" ? EMISION_TARDIA_DIAS_CRITICA : EMISION_TARDIA_DIAS_ADVERTENCIA;
    alertas.push({
      tipo: "emision_tardia",
      severidad: grupo.severidad,
      titulo: `${grupo.conteo} comprobante(s) cargados en Biller ${umbralDias}+ día(s) después de su fecha de emisión`,
      detalle:
        "La fecha de carga (fecha_creacion) es muy posterior a la fecha fiscal (fecha_emision): " +
        "ese delta es riesgo de haber declarado el CFE fuera de plazo ante DGI.",
      cantidad: grupo.conteo,
      datos: { comprobantes: grupo.comprobantes },
    });
  }

  if (racha !== null && racha.alerta) {
    alertas.push({
      tipo: "sin_facturar",
      // Fija en "advertencia": a diferencia del rechazo DGI o el CAE vencido,
      // esto es una inferencia estadística (comparación contra el propio
      // histórico), no un hecho fiscal consumado. Puede explicarse por un
      // cierre, una licencia, una temporada baja — amerita mirar, no pánico.
      severidad: "advertencia",
      titulo: `Sin comprobantes emitidos hace ${racha.racha_actual_dias} día(s)`,
      detalle:
        `La brecha máxima habitual del período es de ${racha.brecha_habitual_dias} día(s) entre ` +
        `emisiones; la racha actual (desde el ${racha.ultima_emision}) ya la supera claramente. ` +
        "Puede ser un corte real de facturación o un problema de carga: conviene revisar.",
      cantidad: racha.racha_actual_dias,
      datos: { racha },
    });
  }

  alertas.sort(
    (a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad] || b.cantidad - a.cantidad,
  );

  const conteo_por_severidad: Record<Severidad, number> = {
    critica: 0,
    advertencia: 0,
    info: 0,
  };
  for (const a of alertas) conteo_por_severidad[a.severidad] += 1;

  const warnings: string[] = [];
  if (cae.length > 0) {
    warnings.push(
      "Los números de CAE disponibles son una estimación OPTIMISTA: solo se ven los comprobantes del " +
        "período consultado, así que el último número usado puede ser mayor al observado. Ampliá el " +
        "período para una estimación más ajustada.",
    );
  }
  if (comprobantes.length === 0) {
    warnings.push("No hay comprobantes en el período: no se pudo evaluar ninguna alerta.");
  }
  if (emisionTardia.conteo_emision_futura > 0) {
    warnings.push(
      `${emisionTardia.conteo_emision_futura} comprobante(s) tienen fecha_creacion ANTERIOR a ` +
        "fecha_emision. No se cuentan como emisión tardía (es una situación distinta: posible error " +
        "de carga o de reloj) pero conviene revisarlos aparte.",
    );
  }
  if (racha === null && comprobantes.length > 0) {
    warnings.push(
      "No se pudo evaluar la racha sin facturar: ningún comprobante del período trae fecha_emision utilizable.",
    );
  }

  return {
    alertas,
    rechazos,
    cae,
    emision_tardia: emisionTardia,
    racha_sin_facturar: racha,
    conteo_por_severidad,
    comprobantes_analizados: comprobantes.length,
    warnings,
  };
}
