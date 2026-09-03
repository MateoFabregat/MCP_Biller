// =============================================================================
// "Facturale lo de siempre a Pérez" (V5.1).
//
// La factura repetida es LA factura de una PyME con clientes fijos: mismo
// cliente, mismos ítems, mismos precios, todas las semanas. Con el flujo guiado
// eran ~8 mensajes; con esto son 2: "lo de siempre a Pérez" → "¿confirmás?".
//
// CÓMO ESQUIVA LA BARRERA DE SALIDA SIN DEBILITARLA
//
// El problema de siempre: los `concepto` de los ítems están en
// CAMPOS_NO_CONFIABLES, así que no pueden volver en la respuesta sin quedar
// envueltos — y un borrador envuelto termina con las marcas impresas en el CFE.
//
// Acá la trampa es que NO HACE FALTA que vuelvan: el estado prellenado se
// guarda en el store de sesión, del lado del server, y `biller_emitir_comprobante`
// completa los conceptos que falten DESDE el store al armar el payload (ver
// `completarItemsDesdeSesion`). El texto viaja server → store → server; por el
// canal del modelo solo pasan los flags `concepto_cargado`.
//
// Vale notar por qué esto es legítimo y un comprobante RECIBIDO no lo sería: el
// concepto de un CFE EMITIDO lo escribió la propia empresa. Repetirlo es copiar
// texto propio, no texto de un tercero.
// =============================================================================

import { INDICADORES_FACTURACION } from "../biller/cfeSchema.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { estaAceptado } from "./estadoDgi.js";
import type { EstadoEmision, ItemEnCurso, PerfilCasa } from "../kapso/emision.js";

/** Qué se pudo copiar del comprobante anterior, para contárselo al agente. */
export interface ResultadoRepeticion {
  estado: EstadoEmision;
  /** id del comprobante que se copió. */
  copiado_de_id: number | null;
  copiado_de_fecha: string | null;
  items_copiados: number;
  advertencias: string[];
}

/**
 * Elige QUÉ comprobante repetir: la última VENTA aceptada del cliente.
 *
 * Notas de crédito, recibos y remitos no son "lo de siempre" — repetir una NC
 * sería acreditar de nuevo. Y una venta rechazada por DGI tampoco: lo de
 * siempre es lo que salió bien.
 */
export function elegirComprobanteARepetir(
  comprobantes: ReadonlyArray<ComprobanteEmitido>,
): ComprobanteEmitido | null {
  let mejor: ComprobanteEmitido | null = null;
  for (const c of comprobantes) {
    if (!esVentaAceptada(c)) continue;
    const fecha = c.fecha_emision ?? "";
    if (mejor === null || fecha > (mejor.fecha_emision ?? "")) mejor = c;
  }
  return mejor;
}

/**
 * El filtro que define QUÉ comprobante cuenta, acá y en el perfil de la casa.
 *
 * "Solo Aceptado DGI" es el criterio del proyecto para cualquier total (ver
 * MEMORY): un comprobante rechazado no facturó nada, y hacerlo votar en el
 * perfil sería derivar la costumbre de la casa de documentos que no existen
 * ante DGI. Notas de crédito, recibos y remitos tampoco: no son ventas.
 */
export function esVentaAceptada(c: ComprobanteEmitido): boolean {
  if (classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia).categoria !== "venta") {
    return false;
  }
  return estaAceptado(c.estado);
}

/**
 * Las últimas `cuantas` ventas aceptadas, de la más nueva a la más vieja.
 *
 * Se ordena por fecha de EMISIÓN y no por id: el id es orden de creación en
 * Biller, y una factura cargada hoy con fecha de la semana pasada no es la
 * costumbre más reciente de la casa.
 */
export function ultimasVentasAceptadas(
  comprobantes: ReadonlyArray<ComprobanteEmitido>,
  cuantas: number,
): ComprobanteEmitido[] {
  return comprobantes
    .filter(esVentaAceptada)
    .sort((a, b) => (b.fecha_emision ?? "").localeCompare(a.fecha_emision ?? ""))
    .slice(0, cuantas);
}

/**
 * Convierte el comprobante ya detallado (consultado por id, con `items`) en el
 * estado inicial del flujo guiado.
 *
 * LO QUE SE COPIA Y LO QUE NO — cada ausencia es una decisión:
 *
 *   · fecha_emision NO: la factura nueva es de HOY, y el flujo va a ofrecer el
 *     botón "Hoy". Copiar la fecha vieja es el error que el TTL del borrador
 *     existe para evitar.
 *   · tasa_cambio NO: la cotización de la semana pasada no es la de hoy. Si la
 *     moneda no es UYU, el flujo la va a volver a preguntar — ese re-preguntar
 *     es correcto, no una falla de la copia.
 *   · adenda NO: suele traer referencias de ESA venta (nro de orden, fecha de
 *     entrega). Copiarla pone datos viejos en un documento nuevo.
 *   · items, precios, IVA, forma de pago, montos_brutos SÍ: son "lo de siempre".
 */
export function estadoDesdeComprobante(detalle: ComprobanteEmitido): ResultadoRepeticion {
  const advertencias: string[] = [];
  const estado: EstadoEmision = {};

  const tipo = detalle.tipo_comprobante;
  if (tipo === 111 || tipo === 112 || tipo === 113) estado.clase_receptor = "empresa";
  else if (tipo === 101 || tipo === 102 || tipo === 103) estado.clase_receptor = "consumidor_final";

  const doc = (detalle.cliente as { documento?: unknown } | null)?.documento;
  if (typeof doc === "string" && doc.trim() !== "") {
    estado.documento = doc;
    // Ya se le facturó (estamos copiando su factura): el flujo no tiene que
    // pedir dirección/ciudad de alta.
    estado.cliente_ya_facturado = true;
  } else if (estado.clase_receptor === "consumidor_final") {
    estado.sin_receptor = true;
  }

  if (detalle.moneda !== null && detalle.moneda !== undefined) estado.moneda = detalle.moneda;

  // `forma_pago` no está entre los campos normalizados del GET: cuando la API
  // lo devuelve, cae en `campos_extra`. Se lee de ahí, defensivamente — si no
  // vino, el flujo lo pregunta, que es el comportamiento correcto para un dato
  // que no se pudo copiar.
  const formaPago = Number((detalle.campos_extra as Record<string, unknown>)?.["forma_pago"]);
  if (formaPago === 1 || formaPago === 2) {
    estado.forma_pago = formaPago;
    if (formaPago === 2) {
      advertencias.push(
        "La venta anterior fue a crédito: el vencimiento NO se copió (sería una fecha vieja). " +
          "El flujo lo va a preguntar.",
      );
    }
  }
  // TRES ESTADOS, NO DOS. `=== 1` sobre un campo que puede traer cualquier cosa
  // colapsaba TODO lo que no fuera exactamente 1 —un 2, un valor que el
  // normalizador no supo leer— a `false`, o sea a "los precios son netos, sumale
  // el 22%". Un valor que no entendemos tiene que salir de la muestra, no votar
  // por el lado caro. Ojo con el normalizador real: `toNumberOrNull` no lee
  // booleanos, así que un `true` de la API llega como null y también queda
  // afuera — que es la conducta correcta y está bajo test.
  const brutos = detalle.montos_brutos;
  if (brutos === 1) estado.montos_brutos = true;
  else if (brutos === 0) estado.montos_brutos = false;

  const items: ItemEnCurso[] = [];
  for (const item of detalle.items ?? []) {
    const concepto = item.concepto ?? item.descripcion ?? "";
    if (concepto === "" || item.precio === null) continue;
    items.push({
      concepto,
      precio: item.precio,
      ...(item.cantidad !== null ? { cantidad: item.cantidad } : {}),
      ...(item.indicador_facturacion !== null
        ? { indicador_facturacion: item.indicador_facturacion }
        : {}),
    });
  }
  if (items.length > 0) {
    estado.items = items;
    estado.items_cerrados = true;
  } else {
    advertencias.push(
      "El comprobante anterior no trajo ítems utilizables: el flujo los va a preguntar de cero.",
    );
  }

  const descartados = (detalle.items ?? []).length - items.length;
  if (descartados > 0) {
    advertencias.push(
      `${descartados} ítem(s) del comprobante anterior no se pudieron copiar (sin concepto o sin precio).`,
    );
  }

  return {
    estado,
    copiado_de_id: detalle.id ?? null,
    copiado_de_fecha: detalle.fecha_emision?.slice(0, 10) ?? null,
    items_copiados: items.length,
    advertencias,
  };
}

// =============================================================================
// El perfil de la casa
//
// `estadoDesdeComprobante` contesta "¿qué le facturé la última vez A ESTE
// CLIENTE?". Esto contesta la otra pregunta, la que no depende del cliente:
// "¿cómo factura ESTA EMPRESA?".
//
// Es la misma lectura corrida sobre varios comprobantes, y por eso reusa la
// función de arriba en vez de volver a mirar los campos crudos: si mañana
// cambia de dónde sale `forma_pago` (hoy vive en `campos_extra`, ver el
// comentario allá arriba), cambia en un solo lugar y las dos features siguen
// coincidiendo. Que la repetición y el perfil lean distinto el mismo
// comprobante sería un bug invisible: dos features contestando distinto sobre
// el mismo dato.
//
// LO QUE ESTE MÓDULO NO DECIDE: cuándo buscarlo, cada cuánto, y sobre qué
// ventana. Eso es política del flujo y vive en `tools/emisionGuiada.ts`. Acá
// entra una lista de comprobantes ya detallados y sale un perfil; es una
// función pura, y por eso se puede testear la regla fiscal —la unanimidad— sin
// tocar la red.
// =============================================================================

/**
 * Cuántos CFE aceptados hacen falta para que el perfil exista.
 *
 * Cinco no es un número mágico, es el piso: con menos, "todas coinciden" es
 * ruido. Una empresa que emitió tres facturas en noventa días no tiene todavía
 * una costumbre, tiene tres facturas — y el flujo sigue preguntando, que es
 * exactamente lo que hacía antes de que este perfil existiera.
 */
export const MUESTRAS_PERFIL = 5;

/** El valor unánime de la lista, o undefined si falta muestra o hay mezcla. */
function unanime<T>(valores: ReadonlyArray<T | undefined>, minimo: number): T | undefined {
  const presentes = valores.filter((v): v is T => v !== undefined);
  // Ojo: se exige `minimo` valores PRESENTES, no `minimo` comprobantes con
  // alguno presente. Un campo que la API no devolvió en dos de los cinco no
  // tiene cinco votos, tiene tres — y con tres no se defaultea nada que mueva
  // el 22% del total.
  if (presentes.length < minimo) return undefined;
  const primero = presentes[0]!;
  return presentes.every((v) => v === primero) ? primero : undefined;
}

/** El valor con MÁS DE LA MITAD de los votos, o undefined si no hay tal cosa. */
function mayoria<T>(valores: ReadonlyArray<T | undefined>, minimo: number): T | undefined {
  const presentes = valores.filter((v): v is T => v !== undefined);
  if (presentes.length < minimo) return undefined;
  const cuenta = new Map<T, number>();
  for (const v of presentes) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  for (const [valor, n] of cuenta) {
    // Más de la mitad, no "el más votado": con 2-2-1 el más votado representa
    // al 40% de las facturas, y eso no es una costumbre.
    if (n * 2 > presentes.length) return valor;
  }
  return undefined;
}

/**
 * La tasa de IVA de un comprobante entero, si tiene UNA sola.
 *
 * Un comprobante con líneas al 22% y al 10% no vota: no tiene "una tasa", y
 * elegirle una sería inventar el dato que este perfil existe para no inventar.
 * Devolver `undefined` lo saca de la muestra, y como la unanimidad exige la
 * muestra completa, un solo comprobante mezclado alcanza para que el flujo
 * siga preguntando la tasa. Es el lado conservador a propósito.
 */
function tasaUnicaDe(detalle: ComprobanteEmitido): number | undefined {
  const tasas = new Set<number>();
  for (const item of detalle.items ?? []) {
    if (item.indicador_facturacion === null || item.indicador_facturacion === undefined) {
      return undefined;
    }
    tasas.add(item.indicador_facturacion);
  }
  if (tasas.size !== 1) return undefined;
  return [...tasas][0];
}

/**
 * Deriva el perfil de la casa de los últimos CFE aceptados de la empresa.
 *
 * ENTRA: comprobantes YA DETALLADOS (con `items`), en cualquier orden — se
 * filtran a ventas aceptadas y se ordenan acá. El detalle hace falta por la
 * tasa de IVA, que vive en los ítems y el listado no trae.
 *
 * SALE: siempre un perfil, nunca null. Un perfil sin ningún campo derivado
 * también es una respuesta —"se miró y no alcanzó"— y sirve para no volver a
 * buscarlo cinco veces en la misma conversación. Lo que no pasa nunca es que
 * salga un campo que no cumplió su criterio.
 */
export function derivarPerfilCasa(
  detalles: ReadonlyArray<ComprobanteEmitido>,
  opciones: {
    minimo?: number;
    desde?: string;
    hasta?: string;
    /**
     * TODAS las ventas de la ventana, sin detalle. Ver `montos_brutos` abajo.
     *
     * Es el listado crudo que ya está en memoria (`traerVentana`), no una
     * consulta nueva: no cuesta un request.
     */
    ventana?: ReadonlyArray<ComprobanteEmitido>;
  } = {},
): PerfilCasa {
  const minimo = opciones.minimo ?? MUESTRAS_PERFIL;
  const muestra = ultimasVentasAceptadas(detalles, minimo);

  const perfil: PerfilCasa = {
    derivado: true,
    muestras: muestra.length,
    ...(opciones.desde !== undefined ? { desde: opciones.desde } : {}),
    ...(opciones.hasta !== undefined ? { hasta: opciones.hasta } : {}),
    detalles: [],
  };

  if (muestra.length < minimo) {
    perfil.detalles.push(
      `Sin perfil: se encontraron ${muestra.length} CFE aceptado(s) en la ventana y hacen falta ` +
        `${minimo}. El flujo pregunta como siempre.`,
    );
    return perfil;
  }

  // La misma lectura que usa "lo de siempre": un comprobante se interpreta en
  // un solo lugar del código.
  const estados = muestra.map((c) => estadoDesdeComprobante(c).estado);

  // --- El criterio de IVA: unanimidad SOBRE TODA LA VENTANA ----------------
  //
  // POR QUÉ ESTE CAMPO NO SE MIRA SOBRE LOS ÚLTIMOS CINCO COMO LOS DEMÁS
  //
  // Los otros campos se derivan de los cinco comprobantes que se pidieron con
  // DETALLE, porque la tasa de IVA vive en los ítems y el listado no los trae.
  // `montos_brutos` no: viene en el LISTADO, así que los ~200 comprobantes de
  // la ventana de 90 días ya están en memoria y mirar solo cinco era tirar
  // evidencia gratis.
  //
  // Y tirarla con consecuencia. Una ferretería que factura 80/20 —ocho de cada
  // diez con IVA incluido— tiene una chance nada despreciable de que sus
  // ÚLTIMAS cinco facturas coincidan por casualidad: ahí la unanimidad decía
  // "esta es la costumbre de la casa" sobre una racha, y el 20% restante salía
  // facturado con el criterio equivocado. Un 22% de diferencia, en silencio,
  // sobre un comprobante perfectamente bien formado.
  //
  // Sobre doscientos, una sola discrepancia rompe la unanimidad y el flujo
  // vuelve a preguntar. Es exactamente lo que tiene que pasar: la unanimidad no
  // es una estadística, es la afirmación de que esta empresa no cambia de
  // criterio. Un contraejemplo la refuta.
  const universoBrutos =
    opciones.ventana === undefined
      ? muestra
      : opciones.ventana.filter(esVentaAceptada);
  const brutosPorCfe = universoBrutos.map((c) => estadoDesdeComprobante(c).estado.montos_brutos);
  const conDato = brutosPorCfe.filter((v) => v !== undefined).length;
  const brutos = unanime(brutosPorCfe, minimo);
  if (brutos !== undefined) {
    perfil.montos_brutos = brutos;
    perfil.detalles.push(
      `montos_brutos=${brutos}: los ${conDato} CFE aceptados de la ventana que traen el campo ` +
        `coinciden TODOS (${brutos ? "precios con IVA incluido" : "IVA sumado aparte"}).`,
    );
  } else {
    perfil.detalles.push(
      `montos_brutos: los ${conDato} CFE aceptados de la ventana que traen el campo NO coinciden ` +
        `(o son menos de ${minimo}). Se sigue preguntando: es el campo que mueve el 22% del total.`,
    );
  }

  const tasa = unanime(muestra.map(tasaUnicaDe), minimo);
  if (tasa !== undefined && tasa in INDICADORES_FACTURACION) {
    perfil.indicador_facturacion = tasa;
    perfil.detalles.push(
      `indicador_facturacion=${tasa}: los ${minimo} últimos CFE aceptados usan esa única tasa ` +
        `(${INDICADORES_FACTURACION[tasa] ?? ""}).`,
    );
  } else {
    perfil.detalles.push(
      "indicador_facturacion: no hay una tasa única repetida en los últimos comprobantes " +
        "(o alguno mezcla tasas). Se sigue preguntando.",
    );
  }

  // --- Moneda y forma de pago: mayoría -------------------------------------
  //
  // Riesgo bajo y visible: la moneda sale en el símbolo de cada línea del
  // preview y la forma de pago sale escrita en la línea de supuestos. Un error
  // acá lo ve el usuario antes de confirmar; un error en el criterio de IVA
  // cambia el total sin cambiar nada que se vea.
  const moneda = mayoria(estados.map((e) => e.moneda), minimo);
  if (moneda !== undefined) {
    perfil.moneda = moneda;
    perfil.detalles.push(`moneda=${moneda}: es la mayoría de los últimos ${minimo} CFE aceptados.`);
  }

  const formaPago = mayoria(estados.map((e) => e.forma_pago), minimo);
  if (formaPago !== undefined) {
    perfil.forma_pago = formaPago;
    perfil.detalles.push(
      `forma_pago=${formaPago}: es la mayoría de los últimos ${minimo} CFE aceptados.`,
    );
  }

  return perfil;
}
