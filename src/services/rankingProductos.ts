// =============================================================================
// Ranking de productos: qué se vende, a qué precio, y a quién le estoy
// haciendo más descuento sin darme cuenta.
//
// PROBLEMA ESTRUCTURAL (léase antes de tocar esto): GET /v2/comprobantes/obtener
// devuelve la LISTA de comprobantes SIN el array `items` (código, concepto,
// cantidad, precio, descuentos). Ese detalle SOLO viene consultando cada
// comprobante por `id` (ver src/biller/types.ts: `items` es opcional, y
// src/biller/normalize.ts: `normalizeItemEmitido`). No hay forma de evitarlo:
// un ranking de productos es, por diseño de la API, un N+1 — una llamada HTTP
// por comprobante. Este servicio no lo esconde: recibe comprobantes que YA
// tienen `items` cargado (responsabilidad de la tool, que decide cuántos y
// por qué — ver src/tools/rankingProductos.ts) y arma el agregado sobre eso.
//
// Tres decisiones que definen si el número sirve:
//
// 1. CLAVE DE AGRUPACIÓN. Se agrupa por `codigo` cuando el ítem lo trae; si
//    no, por `concepto` normalizado (trim + minúsculas + espacios colapsados).
//    Ninguna de las dos es perfecta: agrupar por descripción libre puede
//    juntar productos que en realidad son distintos (o separarlos, si se
//    describieron distinto en dos comprobantes); agrupar solo por código deja
//    afuera lo cargado a mano sin código. Se declara siempre en un warning.
//
// 2. LAS NOTAS DE CRÉDITO RESTAN unidades e importe (mismo signo que usa
//    `classifyCfe` en el resumen de facturación y en el ranking de clientes),
//    pero NO alimentan las estadísticas de precio unitario (min/max/promedio
//    ponderado/dispersión): una nota de crédito no es un nuevo precio de
//    venta, es la reversión de uno ya registrado, y mezclarla ahí solo
//    duplicaría o distorsionaría el precio que ya se vio en la venta original.
//
// 3. NO SE CONVIERTE MONEDA. Todo se acumula por moneda y el ranking se
//    ordena por UNA moneda elegida (default: la de mayor facturación).
//
// SIN MÁRGENES: Biller no tiene el costo del producto. Los importes acá son
// de VENTA, no de rentabilidad — nunca hay que leerlos como margen.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import { extractClienteNombre, extractClienteRut } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { clasificarParaFacturacion, contarSinEstadoConocido } from "./comprobanteFilters.js";
import { monedaDeOrden } from "./monedaOrden.js";

/**
 * Umbral de dispersión de precio (%) a partir del cual un producto se marca
 * para revisar (`dispersion_alta`). 20% se eligió más laxo que el umbral de
 * notas de crédito anómalas (15%, ver UMBRAL_NC_ANOMALAS_PCT en
 * rankingClientes.ts): variar el precio entre clientes es normal —descuentos
 * por volumen, acuerdos comerciales—, y un umbral más ajustado marcaría como
 * "alta" a casi cualquier producto vendido a más de un cliente.
 */
export const UMBRAL_DISPERSION_PCT = 20;

/** Etiqueta del grupo que junta ítems sin código NI concepto utilizable. */
export const SIN_IDENTIFICAR = "(sin identificar)";

export interface ClientePrecioProducto {
  rut: string | null;
  nombre: string | null;
  precio_unitario_promedio: number;
}

export interface ProductoRanking {
  /** Código del producto (el primero visto para esta clave). null si se agrupó por concepto o sin identificar. */
  codigo: string | null;
  /** Concepto/descripción (el primero visto para esta clave), tal cual llegó. */
  concepto: string | null;
  /** Unidades netas: ventas − notas de crédito + notas de débito. */
  unidades: number;
  /** Importe neto por moneda (cantidad × precio, con el signo del comprobante). */
  importe_por_moneda: Record<string, number>;
  /** Comprobantes distintos que incluyen este producto. */
  comprobantes: number;
  /** Clientes distintos (por RUT) asociados a este producto. Ventas sin receptor no cuentan (no son un cliente identificable). */
  clientes_distintos: number;
  /** Precio unitario mínimo observado en ventas/notas de débito. null si no hubo ninguna. */
  precio_unitario_min: number | null;
  precio_unitario_max: number | null;
  /** Promedio ponderado por cantidad vendida — NO es el promedio simple de los precios observados. */
  precio_unitario_promedio_ponderado: number | null;
  /**
   * (max − min) / min × 100. null si no hay base para calcularlo (sin ventas,
   * o precio mínimo <= 0: dividir por cero no tiene una lectura porcentual).
   */
  dispersion_pct: number | null;
  /** true si dispersion_pct >= el umbral configurado (default UMBRAL_DISPERSION_PCT). */
  dispersion_alta: boolean;
  /**
   * Hasta 5 clientes con su precio unitario promedio para este producto,
   * ordenados de MENOR a MAYOR precio: el primero es a quién se le está
   * haciendo el mayor descuento (a igualdad de producto). Responde "¿a qué
   * cliente le estoy haciendo más descuento sin darme cuenta?".
   */
  clientes_precio: ClientePrecioProducto[];
  primera_venta: string | null;
  ultima_venta: string | null;
}

export interface RankingProductosResultado {
  productos: ProductoRanking[];
  /** Moneda usada para ordenar y de la que se toman los importes de referencia. */
  moneda_orden: string;
  monedas_presentes: string[];
  total_importe_por_moneda: Record<string, number>;
  /** Cantidad de productos distintos detectados (antes de aplicar `limite`). */
  productos_totales: number;
  /** Comprobantes considerados (aceptados, con items, no recibos/especiales). */
  comprobantes_analizados: number;
  warnings: string[];
}

export interface RankingProductosOptions {
  /** Moneda para ordenar. Si se omite, la de mayor importe. */
  moneda?: string;
  /** Default true: contar solo comprobantes "Aceptado DGI". */
  solo_aceptados?: boolean;
  /** Cuántos productos devolver. Default 20. */
  limite?: number;
  /** Umbral de dispersión de precio, en %. Default UMBRAL_DISPERSION_PCT. */
  umbral_dispersion_pct?: number;
}

function sumar(mapa: Record<string, number>, moneda: string, monto: number): void {
  mapa[moneda] = round2((mapa[moneda] ?? 0) + monto);
}

/** Toma los primeros 10 caracteres: las fechas llegan como "aaaa-mm-dd hh:mm:ss". */
function soloFecha(valor: string | null): string | null {
  if (valor === null) return null;
  const t = valor.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

function normalizarConcepto(concepto: string): string {
  return concepto.trim().toLowerCase().replace(/\s+/g, " ");
}

interface Acumulador {
  codigo: string | null;
  concepto: string | null;
  unidades: number;
  importePorMoneda: Record<string, number>;
  comprobantesSet: Set<number | string>;
  clientesSet: Set<string>;
  primeraVenta: string | null;
  ultimaVenta: string | null;
  // Estadísticas de precio: SOLO de transacciones con signo positivo (ventas
  // y notas de débito). Ver punto 2 del comentario de cabecera.
  precioMin: number | null;
  precioMax: number | null;
  sumaCantidadPrecioPositivo: number;
  sumaCantidadPositiva: number;
  porCliente: Map<string, { suma: number; cantidad: number; nombre: string | null }>;
}

function nuevoAcumulador(): Acumulador {
  return {
    codigo: null,
    concepto: null,
    unidades: 0,
    importePorMoneda: {},
    comprobantesSet: new Set(),
    clientesSet: new Set(),
    primeraVenta: null,
    ultimaVenta: null,
    precioMin: null,
    precioMax: null,
    sumaCantidadPrecioPositivo: 0,
    sumaCantidadPositiva: 0,
    porCliente: new Map(),
  };
}

/**
 * Construye el ranking de productos de un conjunto de comprobantes emitidos
 * que YA tienen `items` cargado (consulta por `id`). Un comprobante sin
 * `items` se cuenta y se avisa, pero no rompe el cálculo del resto.
 */
export function rankingProductos(
  comprobantes: ComprobanteEmitido[],
  opciones: RankingProductosOptions = {},
): RankingProductosResultado {
  const soloAceptados = opciones.solo_aceptados ?? true;
  const limite = opciones.limite ?? 20;
  const umbralDispersion = opciones.umbral_dispersion_pct ?? UMBRAL_DISPERSION_PCT;
  const warnings: string[] = [];

  const porProducto = new Map<string, Acumulador>();
  const totalPorMoneda: Record<string, number> = {};
  let analizados = 0;
  let sinItems = 0;
  let itemsSinCantidadOPrecio = 0;

  comprobantes.forEach((c, idx) => {
    // La regla de qué suma en un total de facturación (tipo de CFE + estado
    // DGI) vive una sola vez, en comprobanteFilters: acá se consume, no se
    // reimplementa. La tool usa la MISMA para calcular la cobertura.
    const clasificacion = clasificarParaFacturacion(c, soloAceptados);
    if (clasificacion === null) return; // recibos, especiales y no aceptados

    if (c.moneda === null) return;

    if (!Array.isArray(c.items)) {
      sinItems += 1;
      return;
    }

    analizados += 1;
    const rutCliente = extractClienteRut(c.cliente);
    const nombreCliente = extractClienteNombre(c.cliente);
    const fecha = soloFecha(c.fecha_emision);
    const comprobanteKey: number | string = c.id ?? `idx:${idx}`;

    for (const item of c.items) {
      if (item.cantidad === null || item.precio === null) {
        itemsSinCantidadOPrecio += 1;
        continue;
      }

      const codigo = item.codigo && item.codigo.trim() !== "" ? item.codigo.trim() : null;
      const conceptoNormalizado =
        item.concepto && item.concepto.trim() !== "" ? normalizarConcepto(item.concepto) : null;
      const clave =
        codigo !== null
          ? `codigo:${codigo}`
          : conceptoNormalizado !== null
            ? `concepto:${conceptoNormalizado}`
            : SIN_IDENTIFICAR;

      const acc = porProducto.get(clave) ?? nuevoAcumulador();
      if (acc.codigo === null) acc.codigo = codigo;
      if (acc.concepto === null && item.concepto) acc.concepto = item.concepto;

      const cantidadConSigno = item.cantidad * clasificacion.signo;
      const importeConSigno = item.cantidad * item.precio * clasificacion.signo;

      acc.unidades = round2(acc.unidades + cantidadConSigno);
      sumar(acc.importePorMoneda, c.moneda, importeConSigno);
      sumar(totalPorMoneda, c.moneda, importeConSigno);
      acc.comprobantesSet.add(comprobanteKey);
      if (rutCliente !== null) acc.clientesSet.add(rutCliente);
      if (fecha !== null) {
        if (acc.primeraVenta === null || fecha < acc.primeraVenta) acc.primeraVenta = fecha;
        if (acc.ultimaVenta === null || fecha > acc.ultimaVenta) acc.ultimaVenta = fecha;
      }

      if (clasificacion.signo > 0) {
        acc.precioMin = acc.precioMin === null ? item.precio : Math.min(acc.precioMin, item.precio);
        acc.precioMax = acc.precioMax === null ? item.precio : Math.max(acc.precioMax, item.precio);
        acc.sumaCantidadPrecioPositivo += item.cantidad * item.precio;
        acc.sumaCantidadPositiva += item.cantidad;

        if (rutCliente !== null) {
          const cliente = acc.porCliente.get(rutCliente) ?? {
            suma: 0,
            cantidad: 0,
            nombre: nombreCliente,
          };
          cliente.suma += item.cantidad * item.precio;
          cliente.cantidad += item.cantidad;
          if (cliente.nombre === null) cliente.nombre = nombreCliente;
          acc.porCliente.set(rutCliente, cliente);
        }
      }

      porProducto.set(clave, acc);
    }
  });

  // --- Moneda de ordenamiento ----------------------------------------------
  const monedasPresentes = Object.keys(totalPorMoneda).sort();
  const monedaOrden = monedaDeOrden(totalPorMoneda, opciones.moneda);

  if (monedasPresentes.length > 1) {
    warnings.push(
      `Hay facturación en ${monedasPresentes.length} monedas (${monedasPresentes.join(", ")}). ` +
        `El ranking se ordena por ${monedaOrden} y los importes de referencia son sobre esa moneda. ` +
        "Los montos de las demás monedas están en 'importe_por_moneda' SIN convertir.",
    );
  }

  // --- Derivados por producto ------------------------------------------------
  const productos: ProductoRanking[] = [...porProducto.values()].map((acc) => {
    const dispersion_pct =
      acc.precioMin !== null && acc.precioMax !== null && acc.precioMin > 0
        ? round2(((acc.precioMax - acc.precioMin) / acc.precioMin) * 100)
        : null;

    const clientes_precio = [...acc.porCliente.entries()]
      .filter(([, v]) => v.cantidad > 0)
      .map(([rut, v]) => ({
        rut,
        nombre: v.nombre,
        precio_unitario_promedio: round2(v.suma / v.cantidad),
      }))
      .sort((a, b) => a.precio_unitario_promedio - b.precio_unitario_promedio)
      .slice(0, 5);

    return {
      codigo: acc.codigo,
      concepto: acc.concepto,
      unidades: acc.unidades,
      importe_por_moneda: acc.importePorMoneda,
      comprobantes: acc.comprobantesSet.size,
      clientes_distintos: acc.clientesSet.size,
      precio_unitario_min: acc.precioMin,
      precio_unitario_max: acc.precioMax,
      precio_unitario_promedio_ponderado:
        acc.sumaCantidadPositiva > 0
          ? round2(acc.sumaCantidadPrecioPositivo / acc.sumaCantidadPositiva)
          : null,
      dispersion_pct,
      dispersion_alta: dispersion_pct !== null && dispersion_pct >= umbralDispersion,
      clientes_precio,
      primera_venta: acc.primeraVenta,
      ultima_venta: acc.ultimaVenta,
    };
  });

  productos.sort(
    (a, b) => (b.importe_por_moneda[monedaOrden] ?? 0) - (a.importe_por_moneda[monedaOrden] ?? 0),
  );

  // --- Warnings de metodología y calidad de dato -----------------------------
  if (porProducto.size > 0) {
    warnings.push(
      "Los productos se agrupan por 'codigo' cuando el ítem lo trae; si no hay código, se agrupa por " +
        "'concepto' normalizado (texto libre). Agrupar por descripción puede juntar productos que en " +
        "realidad son distintos, o separar el mismo producto si se describió distinto en dos " +
        "comprobantes. Agrupar solo por código, a su vez, deja afuera lo cargado a mano sin código.",
    );
    warnings.push(
      "Los importes son de VENTA, no de margen: Biller no expone el costo de los productos, así que " +
        "esta tool no puede (ni debe leerse como) rentabilidad por producto.",
    );
  }

  const grupoSinIdentificar = porProducto.get(SIN_IDENTIFICAR);
  if (grupoSinIdentificar !== undefined) {
    warnings.push(
      `${grupoSinIdentificar.comprobantesSet.size} comprobante(s) tienen ítems sin código NI concepto ` +
        `utilizable: se agruparon como "${SIN_IDENTIFICAR}".`,
    );
  }

  if (sinItems > 0) {
    warnings.push(
      `${sinItems} comprobante(s) no traían 'items' y se ignoraron para este ranking: hay que ` +
        "consultarlos por 'id' para tener el detalle de productos.",
    );
  }

  // El filtro por estado lo aplica `clasificarParaFacturacion`, que devuelve
  // null y no dice por qué. Era el único ranking que excluía en silencio: el
  // resto avisa, y el criterio solo es defendible acompañado del aviso (ver
  // `estaAceptado` en estadoDgi.ts).
  const sinEstadoConocido = soloAceptados ? contarSinEstadoConocido(comprobantes) : 0;
  if (sinEstadoConocido > 0) {
    warnings.push(
      `${sinEstadoConocido} comprobante(s) llegaron sin estado DGI reconocible y NO se contaron: el ` +
        'criterio es contar solo "Aceptado DGI", que es con el que Biller arma sus números. Si el ' +
        "estado falta por un problema de la API y no del comprobante, este ranking está calculado " +
        "sobre menos ventas de las que hubo, y la cobertura también.",
    );
  }

  if (itemsSinCantidadOPrecio > 0) {
    warnings.push(
      `${itemsSinCantidadOPrecio} ítem(s) sin cantidad o precio utilizable se excluyeron del cálculo.`,
    );
  }

  const conDispersionAlta = productos.filter((p) => p.dispersion_alta).length;
  if (conDispersionAlta > 0) {
    warnings.push(
      `${conDispersionAlta} producto(s) tienen dispersión de precio >= ${umbralDispersion}% ` +
        "(campo dispersion_alta): el mismo producto se vendió a precios muy distintos según el " +
        "cliente. Mirá 'clientes_precio' en cada uno para ver a quién se le está haciendo más descuento.",
    );
  }

  return {
    productos: productos.slice(0, limite),
    moneda_orden: monedaOrden,
    monedas_presentes: monedasPresentes,
    total_importe_por_moneda: totalPorMoneda,
    productos_totales: porProducto.size,
    comprobantes_analizados: analizados,
    warnings,
  };
}
