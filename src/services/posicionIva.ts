// =============================================================================
// Posición de IVA del período: IVA ventas (débito) − IVA compras (crédito).
//
// Es la pregunta que toda PyME uruguaya se hace antes de cada vencimiento, y
// hoy se contesta esperando al contador. Los dos lados ya están en la API:
//
//   IVA DÉBITO  (ventas)  -> `tot_iva_tasa_min` + `tot_iva_tasa_bas` +
//                            `tot_iva_tasa_otra` de cada comprobante emitido,
//                            normalizados en `iva.{tasa_minima,tasa_basica,tasa_otra}`
//   IVA CRÉDITO (compras) -> `total_iva` de cada comprobante recibido
//
// ADVERTENCIA QUE VIAJA EN LA RESPUESTA, no solo en este comentario:
// esto es una ESTIMACIÓN de gestión, NO una declaración jurada. Quedan afuera,
// entre otras cosas, las retenciones y percepciones, el IVA de importaciones,
// las prorratas por operaciones exentas, el IVA de servicios del exterior y
// cualquier ajuste contable que no pase por un CFE.
//
// Aun así vale: una estimación el día 5 sirve para decidir; el número exacto el
// día 25 solo sirve para pagar. El valor está en la anticipación, y el riesgo
// está en que alguien la confunda con la declaración — por eso el caveat es un
// campo del resultado y no una nota al pie.
//
// NO SE CONVIERTE MONEDA. El IVA se declara en pesos, pero convertir acá
// implicaría elegir una cotización y esconder el supuesto. Se separa por moneda
// y se avisa cuando hay más de una.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import type { ComprobanteEmitido, ComprobanteRecibido } from "../biller/types.js";
import { classifyCfe, importeFirmadoRecibido } from "./cfeTypes.js";
import { clasificarEstado, estaAceptado } from "./estadoDgi.js";

export interface IvaPorTasa {
  tasa_minima: number;
  tasa_basica: number;
  tasa_otra: number;
  total: number;
}

export interface PosicionIvaMoneda {
  moneda: string;
  /** IVA de ventas. Las notas de crédito lo restan. */
  debito: IvaPorTasa;
  /** IVA de compras (comprobantes recibidos). */
  credito: number;
  /** débito − crédito. Positivo = a pagar; negativo = crédito a favor. */
  posicion: number;
  /** Retenciones sufridas informadas en los recibidos (NO se descuentan de `posicion`). */
  retenciones_sufridas: number;
  comprobantes_emitidos: number;
  comprobantes_recibidos: number;
}

export interface PosicionIvaResultado {
  por_moneda: PosicionIvaMoneda[];
  /** Moneda con mayor movimiento; la que el usuario probablemente quiere ver. */
  moneda_principal: string | null;
  /** Texto en castellano de la conclusión, listo para mostrar. */
  lectura: string;
  es_estimacion: true;
  limitaciones: string[];
  emitidos_analizados: number;
  recibidos_analizados: number;
  warnings: string[];
}

export interface PosicionIvaOptions {
  /** Default true: contar solo emitidos "Aceptado DGI". */
  solo_aceptados?: boolean;
}

/** Lo que esta estimación NO contempla. Viaja en la respuesta a propósito. */
export const LIMITACIONES_IVA: string[] = [
  "NO es una declaración jurada: es una estimación de gestión sobre los CFE del período.",
  "No incluye IVA de importaciones ni de servicios contratados en el exterior.",
  "No aplica prorrata por operaciones exentas o no gravadas.",
  "No incluye ajustes contables que no pasen por un comprobante fiscal electrónico.",
  "Las retenciones y percepciones se informan aparte y NO se descuentan de la posición.",
  "Los comprobantes recibidos dependen de que DGI ya los haya puesto a disposición: " +
    "una compra reciente puede todavía no figurar.",
];

function nuevaIva(): IvaPorTasa {
  return { tasa_minima: 0, tasa_basica: 0, tasa_otra: 0, total: 0 };
}

function nuevaMoneda(moneda: string): PosicionIvaMoneda {
  return {
    moneda,
    debito: nuevaIva(),
    credito: 0,
    posicion: 0,
    retenciones_sufridas: 0,
    comprobantes_emitidos: 0,
    comprobantes_recibidos: 0,
  };
}

function formatearMonto(n: number, moneda: string): string {
  const simbolo = moneda === "USD" ? "US$" : "$";
  return `${simbolo} ${Math.abs(n).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Calcula la posición de IVA a partir de los comprobantes emitidos y recibidos
 * del período. Ambas listas ya vienen filtradas por fecha.
 */
export function calcularPosicionIva(
  emitidos: ComprobanteEmitido[],
  recibidos: ComprobanteRecibido[],
  opciones: PosicionIvaOptions = {},
): PosicionIvaResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const warnings: string[] = [];
  const porMoneda = new Map<string, PosicionIvaMoneda>();

  const obtener = (moneda: string): PosicionIvaMoneda => {
    const actual = porMoneda.get(moneda) ?? nuevaMoneda(moneda);
    porMoneda.set(moneda, actual);
    return actual;
  };

  // --- IVA débito (ventas) --------------------------------------------------
  let emitidosAnalizados = 0;
  let emitidosSinIva = 0;
  let emitidosSinEstado = 0;

  for (const c of emitidos) {
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    // Los recibos no generan IVA: son cobro de una factura que ya lo generó.
    if (!clasificacion.suma_en_resumen) continue;
    const claseEstado = clasificarEstado(c.estado);
    if (claseEstado === "desconocido") emitidosSinEstado += 1;
    if (soloAceptados && !estaAceptado(c.estado)) continue;
    if (c.moneda === null) continue;

    const min = c.iva.tasa_minima ?? 0;
    const bas = c.iva.tasa_basica ?? 0;
    const otra = c.iva.tasa_otra ?? 0;
    if (min === 0 && bas === 0 && otra === 0) emitidosSinIva += 1;

    // El signo de la clasificación es lo que hace que una nota de crédito
    // RESTE IVA débito en vez de sumarlo.
    const signo = clasificacion.signo;
    const m = obtener(c.moneda);
    m.debito.tasa_minima = round2(m.debito.tasa_minima + min * signo);
    m.debito.tasa_basica = round2(m.debito.tasa_basica + bas * signo);
    m.debito.tasa_otra = round2(m.debito.tasa_otra + otra * signo);
    m.comprobantes_emitidos += 1;
    emitidosAnalizados += 1;
  }

  // --- IVA crédito (compras) ------------------------------------------------
  let recibidosAnalizados = 0;
  let recibidosSinMoneda = 0;

  for (const r of recibidos) {
    // Un recibido rechazado por DGI no da crédito fiscal.
    if (r.estado !== null && /rechazado/i.test(r.estado)) continue;
    const moneda = r.moneda;
    if (moneda === null) {
      recibidosSinMoneda += 1;
      continue;
    }
    // El signo lo da el TIPO de CFE, no el importe. Ver `importeFirmadoRecibido`.
    const iva = importeFirmadoRecibido(r.tipo, r.total_iva);
    const retenido = importeFirmadoRecibido(r.tipo, r.total_retenido);
    const m = obtener(moneda);
    m.credito = round2(m.credito + iva);
    m.retenciones_sufridas = round2(m.retenciones_sufridas + retenido);
    m.comprobantes_recibidos += 1;
    recibidosAnalizados += 1;
  }

  // --- Cierre ---------------------------------------------------------------
  const lista = [...porMoneda.values()];
  for (const m of lista) {
    m.debito.total = round2(m.debito.tasa_minima + m.debito.tasa_basica + m.debito.tasa_otra);
    m.posicion = round2(m.debito.total - m.credito);
  }
  lista.sort((a, b) => Math.abs(b.posicion) - Math.abs(a.posicion));

  const principal = lista[0] ?? null;

  let lectura: string;
  if (principal === null) {
    lectura = "No hay comprobantes con IVA en el período consultado.";
  } else if (principal.posicion > 0) {
    lectura =
      `Estimación: te da IVA A PAGAR por ${formatearMonto(principal.posicion, principal.moneda)} ` +
      `(débito ${formatearMonto(principal.debito.total, principal.moneda)} − crédito ` +
      `${formatearMonto(principal.credito, principal.moneda)}). Es una estimación de gestión, ` +
      "no una declaración: revisala con tu contador antes de pagar.";
  } else if (principal.posicion < 0) {
    lectura =
      `Estimación: te queda CRÉDITO FISCAL a favor por ${formatearMonto(principal.posicion, principal.moneda)} ` +
      `(compraste más IVA del que facturaste). Es una estimación de gestión, no una declaración.`;
  } else {
    lectura = "Estimación: la posición de IVA del período queda en cero.";
  }

  if (lista.length > 1) {
    warnings.push(
      `Hay movimiento en ${lista.length} monedas (${lista.map((m) => m.moneda).join(", ")}). ` +
        "NO se convirtieron: cada moneda tiene su propia posición. La lectura se refiere a " +
        `${principal?.moneda ?? "la principal"}.`,
    );
  }
  if (recibidosAnalizados === 0 && emitidosAnalizados > 0) {
    warnings.push(
      "No se encontraron comprobantes recibidos en el período: la posición mostrada es solo el IVA " +
        "débito, SIN crédito fiscal. Verificá que las compras estén disponibles en DGI antes de usar " +
        "este número.",
    );
  }
  // Este número lo puede terminar mirando alguien para saber cuánto va a pagar.
  // Un IVA débito calculado sobre menos ventas de las que hubo da una posición
  // más baja que la real, y eso se paga en multa: el aviso no es opcional.
  if (soloAceptados && emitidosSinEstado > 0) {
    warnings.push(
      `${emitidosSinEstado} comprobante(s) emitidos llegaron sin estado DGI reconocible y NO ` +
        'entraron en el IVA débito (el criterio es contar solo "Aceptado DGI"). Si el estado falta ' +
        "por un problema de la API y no del comprobante, la posición estimada queda MÁS BAJA que la " +
        "real: verificá esos comprobantes en Biller antes de usar este número.",
    );
  }
  if (emitidosSinIva > 0) {
    warnings.push(
      `${emitidosSinIva} comprobante(s) emitidos no informan IVA en ninguna tasa. Puede ser correcto ` +
        "(exportación, exentos) o indicar un dato faltante.",
    );
  }
  if (recibidosSinMoneda > 0) {
    warnings.push(`${recibidosSinMoneda} comprobante(s) recibidos sin moneda: quedaron fuera del cálculo.`);
  }

  return {
    por_moneda: lista,
    moneda_principal: principal?.moneda ?? null,
    lectura,
    es_estimacion: true,
    limitaciones: LIMITACIONES_IVA,
    emitidos_analizados: emitidosAnalizados,
    recibidos_analizados: recibidosAnalizados,
    warnings,
  };
}
