// =============================================================================
// Cache de ventanas de comprobantes.
//
// EL PROBLEMA, MEDIDO
//
// La API no pagina y falla con rangos amplios, así que `consultarPorPeriodo`
// parte el período en ventanas de 7 días y las pide DE A UNA. Medido contra
// test.biller.uy el 2026-07-29: mediana 391 ms por ventana.
//
//   · "ultimos_90_dias" (el default de media docena de tools) = 14 ventanas
//     ≈ 5,5 s de red.
//   · "anio_actual" = 53 ventanas ≈ 21 s.
//
// Y ese costo se paga ENTERO en cada tool. Una conversación de WhatsApp donde
// el usuario pregunta el saldo, después quién le debe y después le factura a
// alguien, vuelve a traer exactamente los mismos comprobantes tres veces. Son
// quince segundos de visto sin respuesta para contestar preguntas sobre datos
// que ya estaban en memoria.
//
// POR QUÉ SE PUEDE CACHEAR (Y HASTA DÓNDE)
//
// La consulta filtra por fecha de CREACIÓN. Una ventana que terminó en el
// pasado no puede ganar filas nuevas: nada se crea con fecha de creación de
// ayer. O sea, el CONJUNTO de comprobantes de una ventana pasada es inmutable.
//
// Lo que NO es inmutable es su CONTENIDO: el campo `estado` cambia solo
// (Pendiente DGI → Aceptado DGI) cuando DGI contesta, minutos u horas después.
// Y como los totales se calculan solo sobre "Aceptado DGI", servir un estado
// viejo devolvería un total que no coincide con el que muestra Biller — que es
// exactamente el error que este proyecto tiene prohibido cometer.
//
// De ahí los dos TTL, que no son un número elegido a ojo:
//
//   · Ventana RECIENTE (termina hoy, o hace menos de una semana): 120 s. Cubre
//     una conversación entera —que es donde está todo el beneficio— y ningún
//     estado tarda menos que eso en asentarse.
//   · Ventana VIEJA (terminó hace más de una semana): 30 min. A esa altura los
//     estados de DGI están resueltos hace días; lo único que se gana es no
//     volver a bajar seis meses de historia en cada pregunta.
//
// LA CLAVE INCLUYE LA CREDENCIAL, Y ESO NO ES OPCIONAL
//
// Con multi-empresa hay varias empresas en un mismo proceso. Una clave que no
// distinga la credencial le serviría a una empresa los comprobantes de otra —
// el peor bug imaginable en este producto, y silencioso. Entra como
// `BillerClient.cacheId`, que ya es un hash: ni la base URL ni el token
// aparecen en una clave que puede terminar en un log.
// =============================================================================

import type { ComprobanteEmitido } from "./types.js";

/** TTL de una ventana que puede seguir moviéndose. */
export const TTL_RECIENTE_MS = 120_000;

/** TTL de una ventana cuyos estados de DGI ya están asentados. */
export const TTL_VIEJA_MS = 30 * 60_000;

/** A partir de cuántos días una ventana se considera asentada. */
export const DIAS_ASENTADA = 7;

/** Techo de entradas. Evita que un proceso largo acumule medio año por empresa. */
export const MAX_ENTRADAS = 500;

interface Entrada {
  expira: number;
  datos: ComprobanteEmitido[];
}

export interface ClaveVentana {
  /** Identidad opaca del cliente que hace la request (`BillerClient.cacheId`). */
  cacheId: string;
  sucursal?: string;
  desde: string;
  hasta: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entradas: number;
}

/**
 * Cuánto vive una ventana según cuán vieja sea.
 * `hoy` se inyecta para poder testear sin depender del reloj.
 */
export function ttlPara(hasta: string, hoy: Date = new Date()): number {
  const finVentana = Date.parse(`${hasta}T23:59:59Z`);
  if (Number.isNaN(finVentana)) return TTL_RECIENTE_MS;
  const diasAtras = (hoy.getTime() - finVentana) / 86_400_000;
  return diasAtras > DIAS_ASENTADA ? TTL_VIEJA_MS : TTL_RECIENTE_MS;
}

export class CacheVentanas {
  private readonly mapa = new Map<string, Entrada>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly habilitada: boolean = true,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  private clave(c: ClaveVentana): string {
    // `cacheId` ya viene hasheado desde el cliente: ni la base URL ni el token
    // aparecen acá, ni siquiera de paso.
    return [c.cacheId, c.sucursal ?? "", c.desde, c.hasta].join("\u0000");
  }

  get(c: ClaveVentana): ComprobanteEmitido[] | null {
    if (!this.habilitada) return null;
    const entrada = this.mapa.get(this.clave(c));
    if (entrada === undefined) {
      this.misses += 1;
      return null;
    }
    if (entrada.expira <= this.ahora()) {
      this.mapa.delete(this.clave(c)); // check-readonly:allow Map.delete sobre el cache en memoria, no es HTTP
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    // Copia defensiva: quien la reciba puede ordenarla o filtrarla in place, y
    // eso mutaría lo que va a recibir la próxima pregunta.
    return [...entrada.datos];
  }

  set(c: ClaveVentana, datos: ComprobanteEmitido[], hoy: Date = new Date()): void {
    if (!this.habilitada) return;
    // Desalojo simple: la entrada más vieja primero. Un LRU de verdad no cambia
    // nada acá — las ventanas se piden en ráfagas y el techo casi nunca se toca.
    if (this.mapa.size >= MAX_ENTRADAS) {
      const primera = this.mapa.keys().next();
      if (!primera.done) this.mapa.delete(primera.value); // check-readonly:allow Map.delete sobre el cache en memoria, no es HTTP
    }
    this.mapa.set(this.clave(c), {
      expira: this.ahora() + ttlPara(c.hasta, hoy),
      datos: [...datos],
    });
  }

  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entradas: this.mapa.size };
  }
}
