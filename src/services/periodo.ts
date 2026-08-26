// =============================================================================
// Resolución de períodos y consulta por ventanas.
//
// Dos problemas reales que resuelve este módulo:
//
// 1. SEMÁNTICA DE FECHAS. `desde`/`hasta` de la API filtran por fecha de
//    CREACIÓN (carga en Biller), no por fecha de EMISIÓN fiscal. Preguntar
//    "¿cuánto vendí en junio?" y filtrar por creación devuelve un número
//    silenciosamente equivocado: una venta del 30/06 cargada el 02/07 queda
//    afuera. Acá se consulta por creación con un MARGEN y después se filtra
//    localmente por emisión, que es lo que la pregunta realmente significa.
//
// 2. RANGOS AMPLIOS. La API no pagina y devuelve 500 cuando el rango trae
//    demasiados resultados (ver BillerApiError.messageForStatus). Las consultas
//    se parten en ventanas y se unen deduplicando por id.
// =============================================================================

import { CacheVentanas } from "../biller/cacheVentanas.js";
import type { BillerClient } from "../biller/client.js";
import { fetchEmitidos } from "../biller/queries.js";
import { CONCURRENCIA, conReintento, mapConLimite } from "../biller/traerVentanas.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { stableStringify } from "../utils/stableStringify.js";
import { hoyIsoUy } from "./fechaUy.js";

/**
 * Cache compartido del proceso.
 *
 * Es un singleton y no una dependencia inyectada porque el beneficio aparece
 * justamente ENTRE tools distintas: el resolvedor de clientes y el ranking
 * consultan el mismo período con segundos de diferencia, y si cada uno trajera
 * su propio cache no se ahorraría nada. La clave incluye un hash del token, así
 * que compartirlo entre empresas es seguro (ver `biller/cacheVentanas.ts`).
 */
const cacheGlobal = new CacheVentanas(
  (process.env.BILLER_CACHE_ENABLED ?? "").trim().toLowerCase() !== "false",
);

/** Para tests y diagnóstico: cuántas ventanas se sirvieron de memoria. */
export function estadisticasCache(): { hits: number; misses: number; entradas: number } {
  return cacheGlobal.stats;
}

/** Margen (en días) que se agrega al rango de CREACIÓN al filtrar por EMISIÓN. */
export const MARGEN_CREACION_DIAS = 5;

/** Tamaño por defecto de cada ventana de consulta, en días. */
export const VENTANA_DIAS = 7;

export interface RangoFechas {
  /** aaaa-mm-dd inclusive. */
  desde: string;
  /** aaaa-mm-dd inclusive. */
  hasta: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function aIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function desdeIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function sumarDias(d: Date, dias: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + dias);
  return out;
}

function ultimoDiaDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * Resuelve una expresión de período a un rango de fechas de EMISIÓN.
 *
 * Acepta:
 *   - "2026-06"        -> mes completo
 *   - "2026"           -> año completo
 *   - "2026-06-15"     -> un día
 *   - "hoy" | "ayer"
 *   - "mes_actual" | "mes_pasado"
 *   - "ultimos_7_dias" | "ultimos_30_dias" | "ultimos_90_dias"
 *   - "anio_actual"
 *
 * `hoy` se inyecta para poder testear sin depender del reloj.
 */
export function resolverPeriodo(expresion: string, hoy: Date = new Date()): RangoFechas | null {
  const e = expresion.trim().toLowerCase();
  // `hoyIsoUy` y no `aIso`: `aIso` lee el Date en UTC, y en UTC−3 eso adelanta
  // un día todas las noches — "¿cuánto vendí hoy?" después de las 21:00
  // contestaba cero porque armaba el rango del día siguiente.
  const hoyUtc = desdeIso(hoyIsoUy(hoy));

  const mMes = /^(\d{4})-(\d{2})$/.exec(e);
  if (mMes) {
    const anio = Number(mMes[1]);
    const mes = Number(mMes[2]);
    if (mes < 1 || mes > 12) return null;
    return {
      desde: `${anio}-${pad(mes)}-01`,
      hasta: `${anio}-${pad(mes)}-${pad(ultimoDiaDelMes(anio, mes))}`,
    };
  }

  const mAnio = /^(\d{4})$/.exec(e);
  if (mAnio) {
    return { desde: `${mAnio[1]}-01-01`, hasta: `${mAnio[1]}-12-31` };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) {
    return { desde: e, hasta: e };
  }

  switch (e) {
    case "hoy":
      return { desde: aIso(hoyUtc), hasta: aIso(hoyUtc) };
    case "ayer": {
      const ayer = sumarDias(hoyUtc, -1);
      return { desde: aIso(ayer), hasta: aIso(ayer) };
    }
    case "mes_actual": {
      const anio = hoyUtc.getUTCFullYear();
      const mes = hoyUtc.getUTCMonth() + 1;
      return {
        desde: `${anio}-${pad(mes)}-01`,
        hasta: `${anio}-${pad(mes)}-${pad(ultimoDiaDelMes(anio, mes))}`,
      };
    }
    case "mes_pasado": {
      const ref = new Date(Date.UTC(hoyUtc.getUTCFullYear(), hoyUtc.getUTCMonth() - 1, 1));
      const anio = ref.getUTCFullYear();
      const mes = ref.getUTCMonth() + 1;
      return {
        desde: `${anio}-${pad(mes)}-01`,
        hasta: `${anio}-${pad(mes)}-${pad(ultimoDiaDelMes(anio, mes))}`,
      };
    }
    case "ultimos_7_dias":
      return { desde: aIso(sumarDias(hoyUtc, -6)), hasta: aIso(hoyUtc) };
    case "ultimos_30_dias":
      return { desde: aIso(sumarDias(hoyUtc, -29)), hasta: aIso(hoyUtc) };
    case "ultimos_90_dias":
      return { desde: aIso(sumarDias(hoyUtc, -89)), hasta: aIso(hoyUtc) };
    case "anio_actual":
      return { desde: `${hoyUtc.getUTCFullYear()}-01-01`, hasta: `${hoyUtc.getUTCFullYear()}-12-31` };
    default:
      return null;
  }
}

/** Lista de expresiones aceptadas, para los mensajes de error y las descripciones. */
export const PERIODOS_SOPORTADOS = [
  "aaaa-mm (mes)",
  "aaaa (año)",
  "aaaa-mm-dd (un día)",
  "hoy",
  "ayer",
  "mes_actual",
  "mes_pasado",
  "ultimos_7_dias",
  "ultimos_30_dias",
  "ultimos_90_dias",
  "anio_actual",
];

/** Parte un rango en ventanas de a lo sumo `dias` días. */
export function partirEnVentanas(rango: RangoFechas, dias: number = VENTANA_DIAS): RangoFechas[] {
  const inicio = desdeIso(rango.desde);
  const fin = desdeIso(rango.hasta);
  if (inicio.getTime() > fin.getTime()) return [];

  const ventanas: RangoFechas[] = [];
  let cursor = inicio;
  while (cursor.getTime() <= fin.getTime()) {
    const finVentana = sumarDias(cursor, dias - 1);
    const hasta = finVentana.getTime() > fin.getTime() ? fin : finVentana;
    ventanas.push({ desde: aIso(cursor), hasta: aIso(hasta) });
    cursor = sumarDias(hasta, 1);
  }
  return ventanas;
}

/** Expande un rango de emisión al rango de creación que hay que consultar. */
export function rangoDeConsulta(
  rangoEmision: RangoFechas,
  margenDias: number = MARGEN_CREACION_DIAS,
): RangoFechas {
  return {
    desde: aIso(sumarDias(desdeIso(rangoEmision.desde), -margenDias)),
    hasta: aIso(sumarDias(desdeIso(rangoEmision.hasta), margenDias)),
  };
}

export interface ConsultaPorPeriodoResult {
  comprobantes: ComprobanteEmitido[];
  /** Rango de creación efectivamente consultado (incluye el margen). */
  rango_consultado: RangoFechas;
  ventanas: number;
  warnings: string[];
}

/**
 * Trae todos los comprobantes EMITIDOS en un rango de fechas de emisión.
 *
 * Consulta por fecha de creación (lo único que la API filtra) con margen, en
 * ventanas para no gatillar el 500 de rangos amplios, y deduplica por id.
 * El filtro final por fecha de emisión lo aplica el llamador.
 */
export async function consultarPorPeriodo(
  client: BillerClient,
  rangoEmision: RangoFechas,
  opciones: {
    sucursal?: string;
    ventanaDias?: number;
    margenDias?: number;
    /**
     * Saltea el cache de ventanas y vuelve a pedirle todo a la API.
     *
     * Existe para UN caso: el paso de confirmación de algo que sale hacia
     * afuera. El cache tiene 120 s de TTL para lo reciente, que es correcto
     * para una consulta —y un ahorro enorme— pero no para el instante anterior
     * a mandarle a un cliente cuánto debe. Un cobro registrado hace un minuto
     * tiene que verse antes de reclamarle esa plata.
     */
    sinCache?: boolean;
  } = {},
): Promise<ConsultaPorPeriodoResult> {
  const rangoConsulta = rangoDeConsulta(rangoEmision, opciones.margenDias);
  const ventanas = partirEnVentanas(rangoConsulta, opciones.ventanaDias ?? VENTANA_DIAS);
  const warnings: string[] = [];

  const porId = new Map<number, ComprobanteEmitido>();
  // Comprobantes sin `id`: se deduplican por el CONTENIDO COMPLETO.
  // Una clave compuesta parcial (tipo+serie+número) colapsaría ventas distintas
  // que comparten esos campos —perder una venta real de un total fiscal es el
  // peor error posible—, mientras que el contenido completo solo colapsa
  // repeticiones idénticas, que es exactamente lo que produce el ventaneo.
  const porContenido = new Map<string, ComprobanteEmitido>();

  // Las ventanas son independientes y se piden EN PARALELO acotado, con
  // reintento de lo transitorio y pasando por el cache. Ver
  // `biller/traerVentanas.ts` y `biller/cacheVentanas.ts` para el porqué de
  // cada una de las tres cosas.
  let desdeCache = 0;
  const lotes = await mapConLimite(ventanas, CONCURRENCIA, async (ventana) => {
    // La clave sale del cliente, no del llamador: así ninguna de la docena de
    // tools que consultan períodos puede olvidarse de cachear, ni cachear con
    // la credencial equivocada.
    //
    // UN CLIENTE SIN IDENTIDAD NO SE CACHEA. Si `cacheId` viniera vacío, todas
    // las instancias compartirían la misma clave y una empresa recibiría los
    // comprobantes de otra. Esto no es defensivo de más: apareció de verdad, con
    // los clientes falsos de los tests, y el síntoma fue justamente ese —datos
    // de un caso apareciendo en otro—. Ante la duda, no cachear.
    const clave =
      typeof client.cacheId === "string" && client.cacheId !== ""
        ? {
            cacheId: client.cacheId,
            sucursal: opciones.sucursal,
            desde: ventana.desde,
            hasta: ventana.hasta,
          }
        : null;

    // `sinCache` saltea la LECTURA, no la escritura: lo que se acaba de traer
    // es más fresco que lo guardado, así que refrescar la entrada le sirve a la
    // próxima consulta en vez de dejarla mirando lo viejo.
    if (clave !== null && opciones.sinCache !== true) {
      const cacheado = cacheGlobal.get(clave);
      if (cacheado !== null) {
        desdeCache += 1;
        return cacheado;
      }
    }

    const lote = await conReintento(
      () =>
        fetchEmitidos(client, {
          desde: `${ventana.desde} 00:00:00`,
          hasta: `${ventana.hasta} 23:59:59`,
          sucursal: opciones.sucursal,
        }),
      { etiqueta: `${ventana.desde}..${ventana.hasta}` },
    );

    if (clave !== null) cacheGlobal.set(clave, lote);
    return lote;
  });

  // La unión se hace DESPUÉS y en orden cronológico: `mapConLimite` preserva el
  // orden justamente para que dos ejecuciones idénticas den el mismo resultado.
  for (const lote of lotes) {
    for (const c of lote) {
      if (c.id !== null) {
        if (!porId.has(c.id)) porId.set(c.id, c);
      } else {
        const clave = stableStringify(c);
        if (!porContenido.has(clave)) porContenido.set(clave, c);
      }
    }
  }

  if (porContenido.size > 0) {
    warnings.push(
      `${porContenido.size} comprobante(s) llegaron sin 'id': se deduplicaron por contenido completo ` +
        "en vez de por identificador.",
    );
  }
  if (ventanas.length > 1) {
    warnings.push(
      `El período se consultó en ${ventanas.length} ventanas de hasta ${opciones.ventanaDias ?? VENTANA_DIAS} días ` +
        "(la API no pagina y falla con rangos amplios). Los resultados se unieron deduplicando por id.",
    );
  }

  return {
    comprobantes: [...porId.values(), ...porContenido.values()],
    rango_consultado: rangoConsulta,
    ventanas: ventanas.length,
    warnings,
  };
}
