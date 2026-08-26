// =============================================================================
// La ventana de comprobantes de un período: una sola vez, para todas las tools.
//
// EL PREÁMBULO QUE ESTABA COPIADO ONCE VECES
//
// Cada tool que contesta algo sobre un período hacía exactamente lo mismo, en
// el mismo orden, con las mismas seis líneas:
//
//   1. resolver `periodo` (o `desde`/`hasta`) a un rango de EMISIÓN,
//   2. devolver un error legible si no se entiende la expresión,
//   3. rechazar el rango invertido,
//   4. aplicar el default de sucursal de la empresa,
//   5. `consultarPorPeriodo` (que consulta por CREACIÓN con margen y ventanea),
//   6. recortar localmente por fecha de EMISIÓN y unir los warnings de las dos
//      etapas.
//
// Once copias del mismo orden es once oportunidades de saltearse el paso 6, que
// es justamente el que hace que el número coincida con Biller. Ya había pasado
// con el default de sucursal, que aparecía quince veces y en un par de tools no
// estaba: la misma pregunta contestaba distinto según qué tool la atendiera.
//
// QUÉ HACE ESTE MÓDULO QUE NINGUNA DE LAS COPIAS HACÍA
//
// Además de unificar los seis pasos, cuenta el uso del cache POR EMPRESA. El
// cache de ventanas es del proceso —tiene que serlo, ahí está el ahorro entre
// tools— pero el contador no puede serlo: un contador global le mostraría a una
// empresa cuánto consulta la otra. El registro de métricas ya es por tenant y
// llega por `ctx`; este módulo es el único lugar donde las dos cosas se cruzan.
//
// INTERFAZ CHICA
//
// Afuera se ven dos funciones (`traerVentana`, `traerVentanaRecibidos`) y una
// para el preámbulo suelto (`resolverRango`, para las tools que necesitan el
// rango ANTES de consultar: comparar contra el período anterior, buscar quién
// compró antes). Adentro quedan el margen de creación, el ventaneo, el cache,
// el paralelismo acotado, el reintento, la deduplicación y el recorte fiscal.
// =============================================================================

import { fetchRecibidos } from "../biller/queries.js";
import type { ComprobanteEmitido, ComprobanteRecibido } from "../biller/types.js";
import type { ToolContext } from "../tools/shared.js";
import { filterEmitidos } from "./comprobanteFilters.js";
import {
  PERIODOS_SOPORTADOS,
  consultarPorPeriodo,
  partirEnVentanas,
  resolverPeriodo,
  type RangoFechas,
} from "./periodo.js";

// ---------------------------------------------------------------------------
// Paso 1 a 3: el rango
// ---------------------------------------------------------------------------

export interface EntradaPeriodo {
  /** Expresión de período ("2026-06", "mes_pasado", "ultimos_90_dias"). */
  periodo?: string;
  /** Alternativa explícita a `periodo`, en aaaa-mm-dd. */
  desde?: string;
  hasta?: string;
  /**
   * Cuál gana si vienen los dos.
   *
   * No es un capricho: `biller_resumen_facturacion_periodo` documenta que
   * `periodo` tiene prioridad, y el resto de las tools —donde `periodo` tiene
   * un default de schema y por lo tanto SIEMPRE viene— tiene que mirar primero
   * `desde`/`hasta` o el default pisaría lo que pidió el usuario.
   */
  prioridad?: "periodo" | "fechas";
  /** Se inyecta para poder testear sin depender del reloj. */
  hoy?: Date;
}

export type RangoResuelto =
  | { ok: true; rango: RangoFechas }
  | { ok: false; error: string };

/**
 * Resuelve la entrada de período a un rango de fechas de EMISIÓN.
 *
 * Devuelve un resultado en vez de lanzar: el error es una respuesta de
 * validación para el usuario ("no entendí ese período"), no una falla del
 * sistema, y las tools lo convierten con `simpleErrorResult`.
 */
export function resolverRango(entrada: EntradaPeriodo): RangoResuelto {
  const prioridad = entrada.prioridad ?? "fechas";
  const conFechas = entrada.desde !== undefined && entrada.hasta !== undefined;
  const conPeriodo = entrada.periodo !== undefined;

  let rango: RangoFechas;
  if (prioridad === "periodo" ? conPeriodo : !conFechas && conPeriodo) {
    const resuelto = resolverPeriodo(entrada.periodo!, entrada.hoy);
    if (resuelto === null) {
      return {
        ok: false,
        error:
          `No se pudo interpretar el período "${entrada.periodo!}". ` +
          `Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
      };
    }
    rango = resuelto;
  } else if (conFechas) {
    rango = { desde: entrada.desde!, hasta: entrada.hasta! };
  } else {
    return {
      ok: false,
      error:
        "Falta el período: pasá 'periodo' (ej: \"2026-06\", \"mes_pasado\") o 'desde' + 'hasta' en aaaa-mm-dd.",
    };
  }

  // Un rango invertido no devuelve cero resultados: devuelve cero ventanas, o
  // sea silencio. Mejor decirlo.
  if (rango.desde > rango.hasta) {
    return {
      ok: false,
      error: `El período está invertido: 'desde' (${rango.desde}) es posterior a 'hasta' (${rango.hasta}).`,
    };
  }

  return { ok: true, rango };
}

// ---------------------------------------------------------------------------
// Pasos 4 a 6: la ventana
// ---------------------------------------------------------------------------

export interface OpcionesVentana {
  /** Rango de EMISIÓN ya resuelto (ver `resolverRango`). */
  rango: RangoFechas;
  /**
   * Sucursal a consultar.
   *
   * `undefined` = la default de la empresa (BILLER_DEFAULT_SUCURSAL_ID).
   * `null` = TODAS, ignorando ese default a propósito. Lo necesita el ranking
   * de sucursales: un ranking filtrado a un local es un ranking de un elemento
   * con participación 100%.
   */
  sucursal?: string | null;
  /** Tamaño de cada ventana de consulta, en días. Default: VENTANA_DIAS. */
  ventana_dias?: number;
  /**
   * Saltea la LECTURA del cache. Solo para el paso previo a algo que sale hacia
   * afuera (ver el porqué en `consultarPorPeriodo`).
   */
  sinCache?: boolean;
  /** Filtro LOCAL por moneda, aplicado junto con el recorte por emisión. */
  moneda?: string;
  /** Filtro LOCAL por RUT de cliente (solo si es extraíble del campo `cliente`). */
  cliente_rut?: string;
}

export interface Ventana {
  /** Los comprobantes del período: ya recortados por fecha de EMISIÓN. */
  comprobantes: ComprobanteEmitido[];
  /**
   * Todo lo que devolvió la API para el rango de CREACIÓN, sin recortar.
   *
   * Existe para las tools que miran varios sub-rangos de una misma consulta
   * (el reporte diario mira alertas + mes + mes previo + deuda). Usar esto en
   * vez de `comprobantes` sin recortar después es exactamente el bug que el
   * paso 6 evita: son comprobantes de FUERA del período.
   */
  crudos: ComprobanteEmitido[];
  /** Recorta `crudos` a un sub-rango por fecha de emisión. */
  recorte: (sub: RangoFechas) => ComprobanteEmitido[];
  /** El rango de EMISIÓN pedido. */
  rango: RangoFechas;
  /** El rango de CREACIÓN efectivamente consultado (incluye el margen). */
  rango_consultado: RangoFechas;
  /** La sucursal que se terminó usando (con el default de la empresa aplicado). */
  sucursal: string | undefined;
  ventanas: number;
  /** Cuántas de esas ventanas salieron de memoria. */
  desdeCache: number;
  /**
   * Los dos grupos de abajo, en orden. Es lo que usa casi toda tool.
   *
   * Están separados porque hay una que NO quiere los dos: el resolvedor de
   * nombres contesta "¿quién es Pérez?" y contarle a esa respuesta en cuántas
   * ventanas se partió la consulta es ruido sobre una pregunta que no era esa.
   */
  warnings: string[];
  /** Cómo se trajo: ventaneo y deduplicación. */
  warnings_consulta: string[];
  /** Qué quedó afuera: el recorte local por fecha de emisión y los filtros. */
  warnings_recorte: string[];
}

/**
 * Trae los comprobantes emitidos de un período, listos para agregar.
 *
 * Lo que devuelve en `comprobantes` ya pasó por el recorte fiscal: son los
 * emitidos DENTRO del rango, no los creados dentro del rango de consulta.
 */
export async function traerVentana(ctx: ToolContext, o: OpcionesVentana): Promise<Ventana> {
  return consultar(ctx, o, true);
}

/**
 * Igual que `traerVentana` pero SIN el recorte por emisión.
 *
 * Para las tools que piden un rango grande y después miran varios sub-rangos
 * adentro (el reporte diario mira alertas + mes + mes previo + deuda con una
 * sola consulta). Ahí recortar al rango completo no filtra nada y además
 * agregaría un warning que habla de un "período" que no es ninguno de los
 * cuatro. Esas tools usan `recorte(sub)`, que sí recorta.
 */
export async function traerVentanaAmplia(ctx: ToolContext, o: OpcionesVentana): Promise<Ventana> {
  return consultar(ctx, o, false);
}

async function consultar(
  ctx: ToolContext,
  o: OpcionesVentana,
  recortar: boolean,
): Promise<Ventana> {
  const config = ctx.getConfig();
  const client = ctx.getClient();
  // El default de sucursal vivía copiado en quince tools. Acá una sola vez, y
  // `null` es la forma de decir "a propósito, todas".
  const sucursal = o.sucursal === null ? undefined : (o.sucursal ?? config.defaultSucursalId);

  const consulta = await consultarPorPeriodo(client, o.rango, {
    sucursal,
    ventanaDias: o.ventana_dias,
    sinCache: o.sinCache,
  });

  registrarCache(ctx, consulta.ventanas, consulta.desde_cache);

  const recorte = (sub: RangoFechas): ComprobanteEmitido[] =>
    filterEmitidos(consulta.comprobantes, {
      emitidas_desde: sub.desde,
      emitidas_hasta: sub.hasta,
    }).list;

  const filtrado = recortar
    ? filterEmitidos(consulta.comprobantes, {
        moneda: o.moneda,
        cliente_rut: o.cliente_rut,
        emitidas_desde: o.rango.desde,
        emitidas_hasta: o.rango.hasta,
      })
    : { list: consulta.comprobantes, warnings: [] };

  return {
    comprobantes: filtrado.list,
    crudos: consulta.comprobantes,
    recorte,
    rango: o.rango,
    rango_consultado: consulta.rango_consultado,
    sucursal,
    ventanas: consulta.ventanas,
    desdeCache: consulta.desde_cache,
    warnings: [...consulta.warnings, ...filtrado.warnings],
    warnings_consulta: consulta.warnings,
    warnings_recorte: filtrado.warnings,
  };
}

// ---------------------------------------------------------------------------
// Recibidos
// ---------------------------------------------------------------------------

export interface VentanaRecibidos {
  comprobantes: ComprobanteRecibido[];
  ventanas: number;
  warnings: string[];
}

/**
 * Trae los comprobantes RECIBIDOS de un rango, deduplicados por identidad fiscal.
 *
 * Estaba duplicado literal entre `biller_compras_proveedores` y
 * `biller_posicion_iva` —el mismo bucle, la misma clave, el mismo warning— y
 * las dos tools contestan sobre la misma plata: si una de las copias hubiera
 * cambiado la clave de deduplicación, el IVA crédito y las compras del mismo
 * mes habrían dejado de coincidir sin que nada fallara.
 *
 * SE PIDE DE A UNA, A DIFERENCIA DE LOS EMITIDOS. El endpoint de recibidos está
 * limitado a 1 req/seg (`rateLimitClass: "dgi"`), así que pedirlas en paralelo
 * no ahorra nada: el rate limiter las volvería a serializar. Tampoco pasan por
 * el cache de ventanas, que está tipado sobre emitidos.
 */
export async function traerVentanaRecibidos(
  ctx: ToolContext,
  rango: RangoFechas,
  opciones: { ventana_dias?: number } = {},
): Promise<VentanaRecibidos> {
  const client = ctx.getClient();
  const ventanas = partirEnVentanas(rango, opciones.ventana_dias);
  const warnings: string[] = [];
  const vistos = new Map<string, ComprobanteRecibido>();

  for (const v of ventanas) {
    const lote = await fetchRecibidos(client, { fecha_desde: v.desde, fecha_hasta: v.hasta });
    for (const r of lote) {
      // Los recibidos no traen `id`. La identidad fiscal de un CFE es
      // emisor+tipo+serie+número: dos comprobantes con esa terna igual del mismo
      // RUT son el mismo documento.
      const clave = `${r.rut_emisor ?? "?"}|${r.tipo ?? "?"}|${r.serie ?? "?"}|${r.numero ?? "?"}`;
      if (!vistos.has(clave)) vistos.set(clave, r);
    }
  }

  if (ventanas.length > 1) {
    warnings.push(
      `Los comprobantes recibidos se consultaron en ${ventanas.length} ventanas (la API los limita ` +
        "a 1 req/seg y falla con rangos amplios). Se deduplicaron por emisor+tipo+serie+número.",
    );
  }

  return { comprobantes: [...vistos.values()], ventanas: ventanas.length, warnings };
}

// ---------------------------------------------------------------------------

/** Suma al contador POR EMPRESA cuántas ventanas se ahorraron y cuántas no. */
function registrarCache(ctx: ToolContext, ventanas: number, desdeCache: number): void {
  ctx.metricas.contar("cache.ventana", { resultado: "hit" }, desdeCache);
  ctx.metricas.contar("cache.ventana", { resultado: "miss" }, ventanas - desdeCache);
}
