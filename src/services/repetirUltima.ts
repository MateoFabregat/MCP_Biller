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

import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "./cfeTypes.js";
import { clasificarEstado } from "./estadoDgi.js";
import type { EstadoEmision, ItemEnCurso } from "../kapso/emision.js";

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
    const clasificacion = classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia);
    if (clasificacion.categoria !== "venta") continue;
    if (clasificarEstado(c.estado) !== "aceptado") continue;
    const fecha = c.fecha_emision ?? "";
    if (mejor === null || fecha > (mejor.fecha_emision ?? "")) mejor = c;
  }
  return mejor;
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
  if (detalle.montos_brutos !== null && detalle.montos_brutos !== undefined) {
    estado.montos_brutos = detalle.montos_brutos === 1;
  }

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
