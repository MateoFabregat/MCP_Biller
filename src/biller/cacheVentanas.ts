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
//
// EL PRESUPUESTO TAMBIÉN ES POR EMPRESA, Y ANTES NO LO ERA
//
// Aislar los DATOS por credencial no alcanza: mientras el techo de entradas fue
// uno solo para todo el proceso, las empresas competían por él. Una consulta de
// `anio_actual` son 53 ventanas, así que tres empresas preguntando eso a la vez
// llenaban las 500 entradas y desalojaban las ventanas calientes de las otras
// diecisiete. El modo de falla es el peor de todos: no falla ningún test, no
// salta ninguna alerta, y la promesa medida del producto —"la segunda pregunta
// contesta en 4 ms"— se degrada a segundos en silencio. Lo que ve el usuario es
// el visto sin respuesta que este módulo entero vino a evitar.
//
// Ahora el cache es un mapa de mapas: un presupuesto propio por `cacheId`, y un
// techo de cuántas empresas se guardan a la vez. Nadie desaloja a nadie.
// =============================================================================

import type { ComprobanteEmitido } from "./types.js";

/** TTL de una ventana que puede seguir moviéndose. */
export const TTL_RECIENTE_MS = 120_000;

/** TTL de una ventana cuyos estados de DGI ya están asentados. */
export const TTL_VIEJA_MS = 30 * 60_000;

/** A partir de cuántos días una ventana se considera asentada. */
export const DIAS_ASENTADA = 7;

/**
 * Techo de ventanas guardadas POR EMPRESA.
 *
 * 64 no es redondo por casualidad: la consulta más cara del producto
 * ("anio_actual") son 53 ventanas, así que el working set de UNA empresa
 * —el año entero más un par de períodos solapados— entra completo. Bajar de 53
 * sería garantizar que la pregunta más cara nunca se sirva entera de memoria;
 * subir mucho más solo guardaría historia que nadie va a volver a pedir en los
 * 30 min del TTL viejo.
 *
 * LA CUENTA GRUESA DE MEMORIA. Una entrada es el array de `ComprobanteEmitido`
 * de una ventana de 7 días. Un `ComprobanteEmitido` tiene ~35 campos escalares
 * más `cliente` crudo, `iva`, `campos_presentes` y `campos_extra`: contando el
 * overhead de objeto de V8, entre 1,5 y 2 KB en heap. Para el emisor típico de
 * este producto (una pyme uruguaya, decenas de comprobantes por semana) una
 * ventana son ~30 comprobantes ≈ 60 KB; para uno grande (500 por semana) ≈ 1 MB.
 *
 *   · Típico:  64 × 60 KB ≈ 4 MB por empresa → 16 empresas ≈ 60 MB.
 *   · Grande:  64 × 1 MB  ≈ 64 MB por empresa. Con varios así se va de las manos.
 *
 * O sea: el techo cuenta ENTRADAS, no bytes, y una empresa con mucho volumen
 * pesa muchísimo más que otra con el mismo número de entradas. Eso es una
 * limitación conocida y aceptada por ahora —medir bytes en cada `set` cuesta más
 * que lo que ahorra— pero es el próximo lugar a mirar si el proceso crece de
 * memoria: lo que falta es un presupuesto en bytes, no más entradas.
 */
export const MAX_VENTANAS_POR_EMPRESA = 64;

/**
 * Cuántas empresas se guardan a la vez.
 *
 * Sin este segundo techo el aislamiento sería una fuga: un proceso HTTP que
 * atiende cien tenants acumularía cien presupuestos de 64 entradas. Al tocarlo
 * se descarta la empresa que hace más rato que no consulta —no la primera que
 * llegó—, que es la que menos chance tiene de estar en medio de una
 * conversación.
 */
export const MAX_EMPRESAS = 16;

/**
 * Techo total del proceso, derivado. Se exporta porque es el número que hay que
 * mirar para razonar sobre memoria (y porque los tests lo usan).
 *
 * Pasó de 500 globales a 1024 repartidos: el doble de memoria en el peor caso, a
 * cambio de que ninguna empresa pueda desalojar a otra. El intercambio es
 * deliberado — 500 entradas compartidas se veían más baratas y en realidad
 * costaban lo que costaba la promesa de latencia.
 */
export const MAX_ENTRADAS = MAX_VENTANAS_POR_EMPRESA * MAX_EMPRESAS;

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
export function ttlPara(hasta: string, hoy: Date = new Date()): number { // fecha-uy:allow mide una DURACIÓN contra un instante, no "qué día es": anclar al mediodía uruguayo metería un error de doce horas
  const finVentana = Date.parse(`${hasta}T23:59:59Z`);
  if (Number.isNaN(finVentana)) return TTL_RECIENTE_MS;
  const diasAtras = (hoy.getTime() - finVentana) / 86_400_000;
  return diasAtras > DIAS_ASENTADA ? TTL_VIEJA_MS : TTL_RECIENTE_MS;
}

/**
 * Si el cache está prendido, y para quién.
 *
 * Un booleano suelto es el default de hoy. La forma de función existe porque
 * `BILLER_CACHE_ENABLED` era la ÚNICA variable del producto que un tenant no
 * podía pisar con su overlay: se leía de `process.env` al cargar el módulo, así
 * que una empresa que necesita el cache apagado para diagnosticar un total que
 * no le cierra no tenía cómo pedirlo. Con la función la decisión se toma en cada
 * llamada y con el `cacheId` a la vista, que es lo que el registro de tenants
 * necesita para resolverla por empresa.
 */
export type HabilitacionCache = boolean | ((cacheId: string) => boolean);

export class CacheVentanas {
  /**
   * Mapa de mapas: `cacheId` -> sus ventanas. La anidación NO es cosmética: es
   * lo que hace que el presupuesto sea por empresa, porque el desalojo solo
   * puede sacar entradas del mapa de la empresa que acaba de escribir.
   *
   * El orden de iteración de un Map es el de inserción, y eso es lo que se usa
   * como LRU: cada acceso reinserta, así que el primero del mapa es siempre el
   * que hace más rato que nadie mira. Mismo mecanismo que
   * `kapso/borradorStore.ts`.
   */
  private readonly porEmpresa = new Map<string, Map<string, Entrada>>();
  private hits = 0;
  private misses = 0;
  private readonly cuentasPorEmpresa = new Map<string, { hits: number; misses: number }>();

  constructor(
    private readonly habilitacion: HabilitacionCache = true,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  /** Si el cache está prendido para esta empresa. Ver `HabilitacionCache`. */
  habilitadaPara(cacheId: string): boolean {
    return typeof this.habilitacion === "function" ? this.habilitacion(cacheId) : this.habilitacion;
  }

  /** Mueve la empresa al final del orden: la que consulta es la más reciente. */
  private tocarEmpresa(cacheId: string, ventanas: Map<string, Entrada>): void {
    this.porEmpresa.delete(cacheId); // check-readonly:allow Map.delete sobre el cache en memoria, no es HTTP
    this.porEmpresa.set(cacheId, ventanas);
  }

  private contar(cacheId: string, campo: "hits" | "misses"): void {
    this[campo] += 1;
    const previo = this.cuentasPorEmpresa.get(cacheId) ?? { hits: 0, misses: 0 };
    previo[campo] += 1;
    this.cuentasPorEmpresa.set(cacheId, previo);
  }

  private clave(c: ClaveVentana): string {
    // `cacheId` ya viene hasheado desde el cliente: ni la base URL ni el token
    // aparecen acá, ni siquiera de paso.
    return [c.cacheId, c.sucursal ?? "", c.desde, c.hasta].join("\u0000");
  }

  get(c: ClaveVentana): ComprobanteEmitido[] | null {
    if (!this.habilitadaPara(c.cacheId)) return null;
    const ventanas = this.porEmpresa.get(c.cacheId);
    const clave = this.clave(c);
    const entrada = ventanas?.get(clave);
    if (ventanas === undefined || entrada === undefined) {
      this.contar(c.cacheId, "misses");
      return null;
    }
    if (entrada.expira <= this.ahora()) {
      ventanas.delete(clave); // check-readonly:allow Map.delete sobre el cache en memoria, no es HTTP
      this.contar(c.cacheId, "misses");
      return null;
    }
    // LRU DE VERDAD: reinsertar EN EL ACCESO es lo que separa "la menos usada"
    // de "la más vieja de creación". Sin esto, la ventana de enero que se pide
    // en cada pregunta se caía antes que la de marzo pedida una sola vez.
    ventanas.delete(clave); // check-readonly:allow Map.delete sobre el cache en memoria, no es HTTP
    ventanas.set(clave, entrada);
    this.tocarEmpresa(c.cacheId, ventanas);
    this.contar(c.cacheId, "hits");
    // Copia defensiva: quien la reciba puede ordenarla o filtrarla in place, y
    // eso mutaría lo que va a recibir la próxima pregunta.
    return [...entrada.datos];
  }

  set(c: ClaveVentana, datos: ComprobanteEmitido[], hoy: Date = new Date()): void { // fecha-uy:allow solo se lo pasa a ttlPara, que mide duración; ver el allow de ahí
    if (!this.habilitadaPara(c.cacheId)) return;
    const ventanas = this.porEmpresa.get(c.cacheId) ?? new Map<string, Entrada>();
    const clave = this.clave(c);
    ventanas.delete(clave); // check-readonly:allow Map.delete, reinserción del LRU
    ventanas.set(clave, {
      expira: this.ahora() + ttlPara(c.hasta, hoy),
      datos: [...datos],
    });
    // El desalojo mira SOLO el mapa de esta empresa. Es todo el punto: lo que se
    // cae por escribir mucho es lo propio, nunca lo ajeno.
    while (ventanas.size > MAX_VENTANAS_POR_EMPRESA) {
      const menosUsada = ventanas.keys().next();
      if (menosUsada.done === true) break;
      ventanas.delete(menosUsada.value); // check-readonly:allow Map.delete, no es HTTP
    }
    this.tocarEmpresa(c.cacheId, ventanas);
    // Y recién acá el techo de empresas: se descarta la que hace más rato que no
    // consulta, nunca la que acaba de escribir — `tocarEmpresa` la dejó última.
    while (this.porEmpresa.size > MAX_EMPRESAS) {
      const empresaFria = this.porEmpresa.keys().next();
      if (empresaFria.done === true) break;
      this.porEmpresa.delete(empresaFria.value); // check-readonly:allow Map.delete, no es HTTP
      this.cuentasPorEmpresa.delete(empresaFria.value); // check-readonly:allow Map.delete, no es HTTP
    }
  }

  /** Cuántas ventanas tiene guardadas esta empresa. */
  entradasDe(cacheId: string): number {
    return this.porEmpresa.get(cacheId)?.size ?? 0;
  }

  /**
   * Las cuentas. Sin argumento, las del proceso entero (lo que miran los tests y
   * el diagnóstico global); con `cacheId`, las de esa empresa — que es el único
   * contador que significa algo con veinte tenants en un proceso, porque el
   * global mezcla los hits de todos y no dice de quién es el ahorro.
   */
  estadisticas(cacheId?: string): CacheStats {
    if (cacheId === undefined) {
      let entradas = 0;
      for (const ventanas of this.porEmpresa.values()) entradas += ventanas.size;
      return { hits: this.hits, misses: this.misses, entradas };
    }
    const propias = this.cuentasPorEmpresa.get(cacheId) ?? { hits: 0, misses: 0 };
    return { ...propias, entradas: this.entradasDe(cacheId) };
  }

  get stats(): CacheStats {
    return this.estadisticas();
  }
}
