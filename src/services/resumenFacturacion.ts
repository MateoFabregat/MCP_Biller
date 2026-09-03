// =============================================================================
// Servicio de agregación: resumen de facturación por período.
//
// Reglas:
//  - Separar totales por moneda. NO convertir monedas.
//  - Ventas suman; Notas de Crédito restan; Notas de Débito suman.
//  - Especiales (eRemito/eResguardo/eRemito exportación) NO se suman.
//  - Si falta total, moneda o tipo_comprobante -> excluir del cálculo + warning.
//
// ESTADO DGI (`solo_aceptados`, default true): por defecto el total cuenta
// únicamente los comprobantes en estado "Aceptado DGI", que es el criterio con
// el que Biller muestra sus propios números. Contar los rechazados/pendientes
// da un total que no coincide con el panel de Biller. El total con todos los
// estados se devuelve igual, aparte, para poder comparar. El criterio vive en
// `estaAceptado` (`estadoDgi.ts`), una sola vez para todo el proyecto.
//
// AGRUPACIÓN (`agrupar_por`): permite cortar el período por sucursal, día, mes,
// tipo de comprobante, moneda o cliente — p.ej. "cuánto vendí en cada local".
//
// EQUIVALENTE EN PESOS (`equivalente_uyu`): además del desglose por moneda —que
// sigue siendo la verdad primaria— se ofrece la suma en UYU calculada con la
// cotización que trae CADA comprobante. Ver `tipoCambio.ts`: es aritmética
// sobre `tasa_cambio`, no una estimación.
//
// DETALLE (`incluir_detalle`): la lista de los comprobantes que forman el
// total, con el aporte de cada uno. Se arma DENTRO del mismo recorrido que
// suma, para que "las facturas de este total" sean exactamente las que se
// sumaron y no una segunda consulta con otro criterio.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe, type CfeCategoria } from "./cfeTypes.js";
import { formatearUy } from "./importe.js";
import { clasificarEstado, estaAceptado } from "./estadoDgi.js";
import { SIN_RECEPTOR } from "./rankingClientes.js";
import { AcumuladorUyu, type EquivalenteUyuResultado } from "./tipoCambio.js";

export interface MonedaTotal {
  total: number;
  comprobantes: number;
}

export interface TipoTotal {
  tipo: number;
  categoria: CfeCategoria;
  etiqueta: string;
  signo: 1 | -1 | 0;
  /** Total (con signo aplicado) separado por moneda. */
  total_por_moneda: Record<string, number>;
  conteo: number;
}

/** Dimensiones por las que se puede cortar el resumen. */
export type Dimension = "sucursal" | "dia" | "mes" | "tipo_comprobante" | "moneda" | "cliente" | "estado";

export const DIMENSIONES: Dimension[] = [
  "sucursal",
  "dia",
  "mes",
  "tipo_comprobante",
  "moneda",
  "cliente",
  "estado",
];

export interface GrupoResumen {
  /** Valor de cada dimensión de agrupación, ej: { sucursal: "6" }. */
  clave: Record<string, string>;
  /** Texto legible del grupo, ej: "Sucursal 6 (Pocitos)". */
  etiqueta: string;
  totales_por_moneda: Record<string, MonedaTotal>;
  conteo: number;
}

/**
 * Un comprobante tal como entró (o no) al total. Es la respuesta a "mostrame
 * las facturas de ese número": trae el `id` con el que se puede pedir el
 * detalle completo a `biller_obtener_comprobante`.
 */
export interface ComprobanteDelTotal {
  id: number | null;
  tipo_comprobante: number | null;
  etiqueta_tipo: string;
  categoria: CfeCategoria;
  serie: string | null;
  numero: number | null;
  fecha_emision: string | null;
  estado: string | null;
  moneda: string;
  total: number;
  /** Aporte al total con el signo aplicado (negativo en notas de crédito). */
  aporte: number;
  /** Cotización declarada en el comprobante. null en moneda base. */
  tasa_cambio: number | null;
  /** Aporte convertido a pesos con esa cotización. null si no había tasa. */
  aporte_uyu: number | null;
  cliente_rut: string | null;
  cliente_nombre: string | null;
  sucursal: number | null;
}

export interface ResumenResultado {
  /** Totales según el criterio de estado activo (por defecto, solo aceptados). */
  totales_por_moneda: Record<string, MonedaTotal>;
  /**
   * Suma en pesos de `totales_por_moneda`, usando la cotización de cada
   * comprobante. Convive con el desglose, no lo reemplaza.
   */
  equivalente_uyu: EquivalenteUyuResultado;
  /** Ídem para `cobrado_por_moneda`. */
  equivalente_uyu_cobrado: EquivalenteUyuResultado;
  /** Comprobantes que forman el total. Vacío salvo que se pida `incluir_detalle`. */
  detalle: ComprobanteDelTotal[];
  /** true si el detalle se recortó por `limite_detalle` (los totales NO se recortan). */
  detalle_truncado: boolean;
  /**
   * Recibos emitidos en el período (`indicador_cobranza_propia = 1`). NO forman
   * parte de `totales_por_moneda`: son cobro de facturación previa, que puede
   * ser de otro período.
   */
  cobrado_por_moneda: Record<string, MonedaTotal>;
  /** Totales contando TODOS los estados DGI, para comparar. */
  totales_por_moneda_todos_los_estados: Record<string, MonedaTotal>;
  totales_por_tipo_comprobante: Record<string, TipoTotal>;
  conteo_por_tipo_comprobante: Record<string, number>;
  /** Conteo de comprobantes por estado DGI (ej. "Aceptado DGI", "Rechazado DGI"). */
  conteo_por_estado: Record<string, number>;
  /** Cortes del período por las dimensiones pedidas. Vacío si no se agrupó. */
  grupos: GrupoResumen[];
  agrupado_por: Dimension[];
  solo_aceptados: boolean;
  conteo_total: number;
  conteo_incluidos: number;
  conteo_excluidos: number;
  warnings: string[];
  no_convertir_moneda: true;
}

const ESTADO_SIN_DATO = "(sin estado)";

/**
 * El estado como CLAVE de un conteo o de un grupo, normalizado igual que en
 * `clasificarEstado`: el vacío y el whitespace son "sin dato", no una categoría
 * propia.
 *
 * `||` y no `??` a propósito: el caso que arregla es justamente la cadena
 * vacía, que `??` deja pasar. Con `??`, un `estado: ""` abría su propia clave y
 * el aviso salía con una entrada sin nombre —"(sin estado): 1, : 1"—, o sea el
 * mismo comprobante contado en dos categorías distintas según qué mandó la API.
 */
function claveEstado(estado: string | null): string {
  return estado?.trim() || ESTADO_SIN_DATO;
}

export interface ResumenOptions {
  incluir_anulados: boolean;
  /** Default true: contar solo "Aceptado DGI" (criterio que usa Biller). */
  solo_aceptados?: boolean;
  agrupar_por?: Dimension[];
  /** Mapa id de sucursal -> nombre legible, desde configuración. */
  nombres_sucursal?: Record<string, string>;
  /** Devolver la lista de comprobantes que forman el total. Default false. */
  incluir_detalle?: boolean;
  /** Tope de filas del detalle. Default 200. No afecta a los totales. */
  limite_detalle?: number;
}

// El criterio de estado ya no vive acá.
//
// Hasta agosto de 2026 este archivo tenía su propia `clasificarEstado`
// (`aceptado | no_aceptado | desconocido`) que CONTABA el estado desconocido en
// el total, mientras las otras siete implementaciones lo excluían: para los
// mismos comprobantes, el resumen y el ranking contestaban distinto. Se unificó
// en `estadoDgi.ts`, que es la que tiene escrito qué significa cada estado.
// Se re-exporta `estaAceptado` porque es el nombre con el que la piden
// `anulacion.ts`, `cuentaCorriente.ts` y `vencimientos.ts`; el dueño del
// criterio sigue siendo uno solo.
export { estaAceptado };

function valorDimension(
  c: ComprobanteEmitido,
  dim: Dimension,
  nombresSucursal: Record<string, string>,
): { valor: string; etiqueta: string } {
  switch (dim) {
    case "sucursal": {
      const id = c.sucursal === null ? "(sin sucursal)" : String(c.sucursal);
      const nombre = nombresSucursal[id];
      return { valor: id, etiqueta: nombre ? `Sucursal ${id} (${nombre})` : `Sucursal ${id}` };
    }
    case "dia": {
      const dia = c.fecha_emision?.slice(0, 10) ?? "(sin fecha)";
      return { valor: dia, etiqueta: dia };
    }
    case "mes": {
      const mes = c.fecha_emision?.slice(0, 7) ?? "(sin fecha)";
      return { valor: mes, etiqueta: mes };
    }
    case "tipo_comprobante": {
      const tipo = c.tipo_comprobante;
      const clasif = classifyCfe(tipo, c.indicador_cobranza_propia);
      const valor = tipo === null ? "(sin tipo)" : String(tipo);
      return { valor, etiqueta: tipo === null ? "(sin tipo)" : `${tipo} — ${clasif.etiqueta}` };
    }
    case "moneda": {
      const moneda = c.moneda ?? "(sin moneda)";
      return { valor: moneda, etiqueta: moneda };
    }
    case "cliente": {
      const rut = extractClienteRut(c.cliente);
      const valor = rut ?? SIN_RECEPTOR;
      return { valor, etiqueta: valor };
    }
    case "estado": {
      // Misma normalización que el conteo: agrupar por estado no puede abrir un
      // grupo con la etiqueta vacía.
      const estado = claveEstado(c.estado);
      return { valor: estado, etiqueta: estado };
    }
  }
}

/**
 * Símbolo de la moneda para un eco de plata. El peso y el dólar tienen el suyo;
 * cualquier otra cosa se nombra con su código antes que inventarle un signo.
 *
 * No se importa `simboloMoneda` de `kapso/emision.ts` a propósito: un servicio
 * de agregación no puede depender de la capa de WhatsApp. Si algún día hace
 * falta en un tercer lugar, el que se mueve es aquel, hacia `importe.ts`.
 */
function simboloDe(moneda: string): string {
  if (moneda === "UYU") return "$";
  if (moneda === "USD") return "US$";
  return `${moneda} `;
}

/**
 * "$1.500, US$30" a partir de un mapa por moneda. `null` si no hay nada, para
 * que el llamador decida si esa rama del texto existe o no: un "sumaban " vacío
 * es peor que no decir nada.
 *
 * Dos reglas, y ninguna es cosmética:
 *
 *   - Los importes pasan por `formatearUy` como toda la plata del proyecto (ver
 *     el comentario de `calcularTotales.ts`): un eco escrito "5000" en un país
 *     que escribe "5.000" es un eco que el usuario no puede verificar de un
 *     vistazo.
 *   - Se imprime el VALOR ABSOLUTO, y el signo lo pone la palabra de al lado
 *     ("sumaban" / "restaban"). El bucket negativo viene acumulado con signo, y
 *     escribir "restaban -90.000" es doble negación: quien lo lee rápido
 *     corrige el total para el lado contrario, que es exactamente lo que este
 *     aviso vino a evitar.
 */
function formatearMontos(porMoneda: Record<string, number>): string | null {
  const partes = Object.entries(porMoneda)
    .filter(([, v]) => v !== 0)
    .map(([m, v]) => `${simboloDe(m)}${formatearUy(Math.abs(round2(v)))}`);
  return partes.length === 0 ? null : partes.join(", ");
}

export function resumirFacturacion(
  comprobantes: ComprobanteEmitido[],
  options: ResumenOptions,
): ResumenResultado {
  const soloAceptados = options.solo_aceptados ?? true;
  const agruparPor = options.agrupar_por ?? [];
  const nombresSucursal = options.nombres_sucursal ?? {};

  const incluirDetalle = options.incluir_detalle ?? false;
  const limiteDetalle = options.limite_detalle ?? 200;

  const totales_por_moneda: Record<string, MonedaTotal> = {};
  const totales_todos: Record<string, MonedaTotal> = {};
  const cobrado_por_moneda: Record<string, MonedaTotal> = {};
  // Los acumuladores en pesos corren dentro de este mismo bucle a propósito:
  // ver la nota de cabecera de `AcumuladorUyu`.
  const acumuladorUyu = new AcumuladorUyu();
  const acumuladorUyuCobrado = new AcumuladorUyu();
  const detalle: ComprobanteDelTotal[] = [];
  let detalleOmitidos = 0;
  const totales_por_tipo_comprobante: Record<string, TipoTotal> = {};
  const conteo_por_tipo_comprobante: Record<string, number> = {};
  const conteo_por_estado: Record<string, number> = {};
  const gruposMap = new Map<string, GrupoResumen>();
  const warningsSet = new Set<string>();

  let conteo_incluidos = 0;
  let conteo_excluidos = 0;
  let excluidosPorEstado = 0;
  let cobranzasExcluidasPorEstado = 0;
  let sinEstadoConocido = 0;
  // Cuánto sumaban los de estado desconocido, por moneda. Es la mitad que hace
  // tolerable el criterio estricto: sin el monto, "3 comprobantes sin estado"
  // no le dice al usuario si el total le quedó $600 o $600.000 corto.
  //
  // Van SEPARADOS lo que suma y lo que resta, y no un neto, porque el neto
  // miente en el caso que más importa: una venta de +5.000 y su nota de crédito
  // de −5.000, las dos sin estado, dan un neto de 0 y el aviso diría "sumaban
  // UYU 0" — o sea, "no te quedó nada afuera" cuando quedaron afuera diez mil
  // pesos de movimiento. Que la NC de estado desconocido no reste es
  // justamente el riesgo grande de este criterio: infla el total.
  const montoSinEstadoPositivo: Record<string, number> = {};
  const montoSinEstadoNegativo: Record<string, number> = {};
  // Cuánto sumaban los recibos que quedaron fuera de `cobrado_por_moneda`.
  const montoCobranzasExcluidas: Record<string, number> = {};

  for (const c of comprobantes) {
    // Validación de campos mínimos: si falta alguno, no inventar -> excluir.
    if (c.total === null || c.moneda === null || c.tipo_comprobante === null) {
      conteo_excluidos += 1;
      warningsSet.add(
        "Se excluyeron del cálculo uno o más comprobantes por faltar total, moneda o tipo_comprobante.",
      );
      continue;
    }

    const clasif = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);

    // Un recibo NO es facturación: es el cobro de un CFE ya facturado. Se emite
    // como e-Ticket/e-Factura, así que sumarlo duplicaría la venta. Se
    // contabiliza aparte, en `cobrado_por_moneda`.
    if (clasif.categoria === "cobranza") {
      conteo_excluidos += 1;
      // Mismo criterio de estado que el total de facturación, a propósito:
      // `cobrado_por_moneda` también es plata que el usuario compara contra
      // Biller. Un recibo sin estado reconocible tampoco cuenta acá.
      if (!soloAceptados || estaAceptado(c.estado)) {
        const bucketCobrado = (cobrado_por_moneda[c.moneda] ??= { total: 0, comprobantes: 0 });
        bucketCobrado.total = round2(bucketCobrado.total + c.total);
        bucketCobrado.comprobantes += 1;
        acumuladorUyuCobrado.agregar(c.total, c.moneda, c.tasa_cambio);
      } else {
        cobranzasExcluidasPorEstado += 1;
        montoCobranzasExcluidas[c.moneda] = round2(
          (montoCobranzasExcluidas[c.moneda] ?? 0) + c.total,
        );
      }
      continue;
    }

    if (clasif.categoria === "desconocido") {
      conteo_excluidos += 1;
      warningsSet.add(
        `Tipo de comprobante ${c.tipo_comprobante} no clasificable: se excluyó del total (no se inventa categoría).`,
      );
      continue;
    }

    if (clasif.categoria === "especial") {
      conteo_excluidos += 1;
      warningsSet.add(
        `Comprobante tipo ${c.tipo_comprobante} (${clasif.etiqueta}) es especial: no se suma automáticamente sin validación.`,
      );
      continue;
    }

    const moneda = c.moneda;
    const aporte = clasif.signo * c.total;

    // Desglose por estado DGI de todos los comprobantes clasificables.
    const estadoKey = claveEstado(c.estado);
    conteo_por_estado[estadoKey] = (conteo_por_estado[estadoKey] ?? 0) + 1;

    // Total con TODOS los estados (referencia de comparación).
    const bucketTodos = (totales_todos[moneda] ??= { total: 0, comprobantes: 0 });
    bucketTodos.total = round2(bucketTodos.total + aporte);
    bucketTodos.comprobantes += 1;

    // Criterio de estado para el total principal: CFE fiscalmente válido
    // (aceptado individualmente o informado por reporte diario). El estado
    // desconocido tampoco cuenta.
    //
    // Antes acá se excluía únicamente lo que se sabía rechazado, con el
    // argumento de que "la ausencia del dato no es evidencia de rechazo". El
    // argumento es cierto pero perdió: mientras el resumen contaba los
    // desconocidos y los rankings los excluían, las dos tools contestaban
    // números distintos PARA LOS MISMOS COMPROBANTES. Se resolvió a favor de
    // "Aceptado DGI" porque ese es el criterio con el que Biller arma sus
    // propios totales, y un número que no cierra contra el panel no sirve
    // aunque sea más generoso. Lo que sobrevive del argumento viejo es el
    // aviso: se cuenta cuántos desconocidos hubo y cuánto sumaban, y
    // `totales_por_moneda_todos_los_estados` deja ver el total sin el filtro.
    const estadoClasificado = clasificarEstado(c.estado);
    if (estadoClasificado === "desconocido") {
      sinEstadoConocido += 1;
      const bruto = aporte >= 0 ? montoSinEstadoPositivo : montoSinEstadoNegativo;
      bruto[moneda] = round2((bruto[moneda] ?? 0) + aporte);
    }
    if (soloAceptados && !estaAceptado(c.estado)) {
      excluidosPorEstado += 1;
      conteo_excluidos += 1;
      continue;
    }

    const bucket = (totales_por_moneda[moneda] ??= { total: 0, comprobantes: 0 });
    bucket.total = round2(bucket.total + aporte);
    bucket.comprobantes += 1;

    const conversion = acumuladorUyu.agregar(aporte, moneda, c.tasa_cambio);

    if (incluirDetalle) {
      if (detalle.length < limiteDetalle) {
        detalle.push({
          id: c.id,
          tipo_comprobante: c.tipo_comprobante,
          etiqueta_tipo: clasif.etiqueta,
          categoria: clasif.categoria,
          serie: c.serie,
          numero: c.numero,
          fecha_emision: c.fecha_emision?.slice(0, 10) ?? null,
          estado: c.estado,
          moneda,
          total: c.total,
          aporte: round2(aporte),
          tasa_cambio: c.tasa_cambio,
          aporte_uyu: conversion.monto_uyu,
          cliente_rut: extractClienteRut(c.cliente),
          cliente_nombre: extractClienteNombre(c.cliente),
          sucursal: c.sucursal,
        });
      } else {
        detalleOmitidos += 1;
      }
    }

    const tipoKey = String(c.tipo_comprobante);
    const tipoBucket = (totales_por_tipo_comprobante[tipoKey] ??= {
      tipo: c.tipo_comprobante,
      categoria: clasif.categoria,
      etiqueta: clasif.etiqueta,
      signo: clasif.signo,
      total_por_moneda: {},
      conteo: 0,
    });
    tipoBucket.total_por_moneda[moneda] = round2(
      (tipoBucket.total_por_moneda[moneda] ?? 0) + aporte,
    );
    tipoBucket.conteo += 1;

    conteo_por_tipo_comprobante[tipoKey] = (conteo_por_tipo_comprobante[tipoKey] ?? 0) + 1;

    // --- Agrupación ------------------------------------------------------
    if (agruparPor.length > 0) {
      const clave: Record<string, string> = {};
      const etiquetas: string[] = [];
      for (const dim of agruparPor) {
        const { valor, etiqueta } = valorDimension(c, dim, nombresSucursal);
        clave[dim] = valor;
        etiquetas.push(etiqueta);
      }
      const claveGrupo = agruparPor.map((d) => `${d}=${clave[d]}`).join("|");
      const grupo = gruposMap.get(claveGrupo) ?? {
        clave,
        etiqueta: etiquetas.join(" · "),
        totales_por_moneda: {},
        conteo: 0,
      };
      const gb = (grupo.totales_por_moneda[moneda] ??= { total: 0, comprobantes: 0 });
      gb.total = round2(gb.total + aporte);
      gb.comprobantes += 1;
      grupo.conteo += 1;
      gruposMap.set(claveGrupo, grupo);
    }

    conteo_incluidos += 1;
  }

  // --- Warnings sobre el criterio de estado -------------------------------
  // "(sin estado)" entra en la lista: desde que el criterio es "solo Aceptado
  // DGI", esos comprobantes también quedan afuera, y una enumeración que no los
  // nombra no suma la cantidad que dice el warning de al lado.
  const noAceptados = Object.entries(conteo_por_estado)
    .filter(([e]) => !estaAceptado(e === ESTADO_SIN_DATO ? null : e))
    .map(([e, n]) => `${e}: ${n}`);

  if (sinEstadoConocido > 0) {
    const suman = formatearMontos(montoSinEstadoPositivo);
    const restan = formatearMontos(montoSinEstadoNegativo);
    // Tres redacciones y no una con ceros adentro: "sumaban 0 en ventas" no
    // dice de qué moneda ni si el 0 es un total o la ausencia de ese lado.
    const detalle =
      restan === null
        ? `sumaban ${suman ?? "0"}`
        : suman === null
          ? `restaban ${restan} en notas de crédito, sin ninguna venta del otro lado`
          : `sumaban ${suman} en ventas y restaban ${restan} en notas de crédito`;
    warningsSet.add(
      `${sinEstadoConocido} comprobante(s) vinieron SIN un estado DGI reconocible (null, vacío o un ` +
        `texto que no conocemos) y ${detalle}. ` +
        (soloAceptados
          ? "NO se contaron en el total: el criterio es contar solo \"Aceptado DGI\", que es con el " +
            "que Biller arma sus números. Ojo en las dos direcciones: si lo que quedó afuera son " +
            "ventas, el total está corto; si son notas de crédito, el total está INFLADO porque esa " +
            "anulación no restó. Comparalo contra 'totales_por_moneda_todos_los_estados' antes de " +
            "darlo por bueno."
          : "Están contados en el total porque solo_aceptados=false."),
    );
  }

  if (soloAceptados) {
    if (excluidosPorEstado > 0) {
      warningsSet.add(
        `El total cuenta SOLO comprobantes "Aceptado DGI" (criterio de Biller). Se excluyeron ` +
          `${excluidosPorEstado} comprobante(s) por estado (${noAceptados.join(", ")}). ` +
          "Mirá 'totales_por_moneda_todos_los_estados' para el total sin ese filtro.",
      );
    }
    if (cobranzasExcluidasPorEstado > 0) {
      // Con el monto, no solo la cantidad: es la misma regla que le exigimos al
      // aviso del total (ver `estaAceptado` en estadoDgi.ts). Estos recibos no
      // aparecen en `conteo_por_estado` —esa enumeración se llena después de
      // este `continue`, y es la de la FACTURACIÓN—, así que este warning es lo
      // único que los nombra.
      warningsSet.add(
        `${cobranzasExcluidasPorEstado} recibo(s) de cobranza por ` +
          `${formatearMontos(montoCobranzasExcluidas) ?? "0"} quedaron fuera de ` +
          '\'cobrado_por_moneda\' por no estar en estado "Aceptado DGI". Se les aplica el mismo ' +
          "criterio que al total: lo cobrado también se compara contra Biller. No están contados " +
          "en 'conteo_por_estado', que es el desglose de la facturación.",
      );
    }
  } else if (noAceptados.length > 0) {
    const total = noAceptados.length;
    warningsSet.add(
      `solo_aceptados=false: el total INCLUYE comprobantes que NO están aceptados por DGI ` +
        `(${noAceptados.join(", ")}). Ese monto NO va a coincidir con lo que muestra Biller. ` +
        `Hay ${total} estado(s) no aceptados en el período.`,
    );
  }

  // Anulación: NO existe un estado "Anulado". Anular un CFE genera una Nota de
  // Crédito separada, que ya resta en el total.
  if (!options.incluir_anulados) {
    warningsSet.add(
      "Nota sobre anulados: anular un CFE genera una Nota de Crédito separada (no hay estado " +
        '"Anulado"). Este resumen no detecta anulaciones por estado; si una venta fue anulada, ' +
        "su Nota de Crédito ya resta en el total.",
    );
  }

  // Ordena los grupos por total descendente de la moneda más frecuente.
  const grupos = [...gruposMap.values()].sort((a, b) => {
    const totalA = Math.max(...Object.values(a.totales_por_moneda).map((m) => m.total), 0);
    const totalB = Math.max(...Object.values(b.totales_por_moneda).map((m) => m.total), 0);
    return totalB - totalA;
  });

  const conteoCobranzas = Object.values(cobrado_por_moneda).reduce(
    (n, m) => n + m.comprobantes,
    0,
  );
  if (conteoCobranzas > 0) {
    warningsSet.add(
      `${conteoCobranzas} recibo(s) de cobranza (indicador_cobranza_propia=1) NO se sumaron a la ` +
        "facturación: son el cobro de comprobantes ya facturados y contarlos duplicaría la venta. " +
        "Su monto está en 'cobrado_por_moneda'. Ojo: ese cobro puede corresponder a facturas de " +
        "períodos anteriores, así que no es 'lo cobrado de lo facturado en este período'.",
    );
  }

  // --- Equivalente en pesos -------------------------------------------------
  const equivalente_uyu = acumuladorUyu.resultado();
  const equivalente_uyu_cobrado = acumuladorUyuCobrado.resultado();
  for (const w of equivalente_uyu.warnings) warningsSet.add(w);

  const monedasDelTotal = Object.keys(totales_por_moneda);
  if (monedasDelTotal.length > 1) {
    warningsSet.add(
      `Se facturó en ${monedasDelTotal.length} monedas (${monedasDelTotal.join(", ")}). ` +
        "'totales_por_moneda' es el dato primario y NO convierte nada. 'equivalente_uyu' suma todo " +
        "en pesos usando la cotización que declara cada comprobante (campo tasa_cambio): sirve para " +
        "tener un único número, no para revaluar la facturación a la cotización de hoy.",
    );
  }

  if (detalleOmitidos > 0) {
    warningsSet.add(
      `El detalle se recortó a ${limiteDetalle} comprobante(s) y quedaron ${detalleOmitidos} afuera. ` +
        "Los TOTALES se calcularon sobre todos: subí 'limite_comprobantes' o acotá el período si " +
        "necesitás la lista completa.",
    );
  }

  return {
    totales_por_moneda,
    equivalente_uyu,
    equivalente_uyu_cobrado,
    detalle,
    detalle_truncado: detalleOmitidos > 0,
    cobrado_por_moneda,
    totales_por_moneda_todos_los_estados: totales_todos,
    totales_por_tipo_comprobante,
    conteo_por_tipo_comprobante,
    conteo_por_estado,
    grupos,
    agrupado_por: agruparPor,
    solo_aceptados: soloAceptados,
    conteo_total: comprobantes.length,
    conteo_incluidos,
    conteo_excluidos,
    warnings: [...warningsSet],
    no_convertir_moneda: true,
  };
}
