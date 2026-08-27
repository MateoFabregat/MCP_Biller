// =============================================================================
// Digest operativo: el resumen que se manda por WhatsApp.
//
// Convierte lo que ya calculan `alertas`, `vencimientos` y `resumenFacturacion`
// en un texto corto y accionable. La diferencia entre esto y llamar a las tres
// tools por separado es el ENCUADRE: acá cada dato viene con umbral, orden de
// urgencia y una acción sugerida.
//
// Reglas de redacción, que son reglas de producto:
//
//   1. LO CRÍTICO PRIMERO. Un CAE vencido corta la facturación de la empresa;
//      un cliente dormido no. El orden no es cronológico ni alfabético: es por
//      consecuencia.
//   2. SI NO HAY NADA QUE HACER, DECIRLO EN UNA LÍNEA. Un digest que siempre
//      manda tres párrafos se deja de leer a la segunda semana, y entonces el
//      día que sí importa tampoco se lee.
//   3. NADA DE DATOS DE TERCEROS QUE NO HAGAN FALTA. El mensaje va a WhatsApp,
//      que se sincroniza en varios dispositivos. Montos y conteos sí; listados
//      completos de clientes con RUT, no.
//   4. CABE EN UNA PANTALLA. WhatsApp corta a 4096 caracteres, pero el límite
//      real es la atención: si hay que scrollear, ya perdiste.
// =============================================================================

import type { AlertasResultado } from "./alertas.js";
import type { RiesgoPlataResultado } from "./riesgoPlata.js";
import type { VencimientosResultado } from "./vencimientos.js";
import type { ResumenResultado } from "./resumenFacturacion.js";

/** Cuántas líneas de detalle como mucho por sección. */
const MAX_LINEAS_SECCION = 5;

export interface DigestInput {
  /** Fecha del digest (aaaa-mm-dd), para el encabezado. */
  fecha: string;
  /** Nombre legible de la empresa, si está configurado. */
  empresa?: string;
  alertas?: AlertasResultado;
  /** Alertas sobre la plata (clientes en fuga, deuda vieja, etc.). */
  riesgo?: RiesgoPlataResultado;
  vencimientos?: VencimientosResultado;
  resumen?: ResumenResultado;
  /** Período que cubre `resumen`, para el encabezado. */
  periodo_resumen?: string;
}

export interface DigestResultado {
  texto: string;
  /** true si hay algo que requiere acción. Permite no mandar nada cuando está todo bien. */
  requiere_atencion: boolean;
  /** Cuántos ítems accionables se encontraron. */
  items_accionables: number;
  secciones: string[];
}

function formatearMonto(n: number, moneda: string): string {
  const simbolo = moneda === "USD" ? "US$" : "$";
  return `${simbolo}${Math.round(n).toLocaleString("es-UY")}`;
}

function montosPorMoneda(mapa: Record<string, number>): string {
  const entradas = Object.entries(mapa).filter(([, v]) => Math.abs(v) >= 1);
  if (entradas.length === 0) return "—";
  return entradas.map(([moneda, monto]) => formatearMonto(monto, moneda)).join(" + ");
}

/**
 * Arma el texto del digest. Es una función pura: recibe resultados ya
 * calculados y no consulta nada. Eso la hace testeable sin red y permite
 * reusarla tanto para WhatsApp como para una respuesta en el chat.
 */
export function construirDigest(input: DigestInput): DigestResultado {
  const lineas: string[] = [];
  const secciones: string[] = [];
  let accionables = 0;

  const encabezado = input.empresa !== undefined ? `*${input.empresa}* · ${input.fecha}` : `*Resumen ${input.fecha}*`;
  lineas.push(encabezado);

  // --- 1. Crítico: lo que corta la operación -------------------------------
  const criticas = (input.alertas?.alertas ?? []).filter((a) => a.severidad === "critica");
  if (criticas.length > 0) {
    secciones.push("critico");
    accionables += criticas.length;
    lineas.push("", "🔴 *Urgente*");
    for (const a of criticas.slice(0, MAX_LINEAS_SECCION)) {
      lineas.push(`• ${a.titulo}: ${a.detalle}`);
    }
    if (criticas.length > MAX_LINEAS_SECCION) {
      lineas.push(`• …y ${criticas.length - MAX_LINEAS_SECCION} más.`);
    }
  }

  // --- 2. Advertencias ------------------------------------------------------
  const advertencias = (input.alertas?.alertas ?? []).filter((a) => a.severidad === "advertencia");
  if (advertencias.length > 0) {
    secciones.push("advertencias");
    accionables += advertencias.length;
    lineas.push("", "🟡 *Para revisar*");
    for (const a of advertencias.slice(0, MAX_LINEAS_SECCION)) {
      lineas.push(`• ${a.titulo}: ${a.detalle}`);
    }
    if (advertencias.length > MAX_LINEAS_SECCION) {
      lineas.push(`• …y ${advertencias.length - MAX_LINEAS_SECCION} más.`);
    }
  }

  // --- 3. Plata en riesgo ---------------------------------------------------
  // Va ARRIBA de cobranzas a propósito: el detalle de vencimientos describe,
  // esta sección señala qué hacer y cuánto está en juego. Solo lo grave: en un
  // mensaje de WhatsApp, el tercer ítem ya no se lee.
  const riesgos = (input.riesgo?.alertas ?? []).filter((a) => a.severidad !== "info");
  if (riesgos.length > 0) {
    secciones.push("plata_en_riesgo");
    accionables += riesgos.length;
    lineas.push("", "🩸 *Plata en riesgo*");
    for (const a of riesgos.slice(0, MAX_LINEAS_SECCION)) {
      const monto = a.monto_en_riesgo
        .filter((m) => Math.abs(m.monto) >= 1)
        .map((m) => formatearMonto(m.monto, m.moneda))
        .join(" + ");
      lineas.push(`• ${a.titulo}${monto !== "" ? ` (${monto})` : ""}. ${a.accion}`);
    }
    if (riesgos.length > MAX_LINEAS_SECCION) {
      lineas.push(`• …y ${riesgos.length - MAX_LINEAS_SECCION} más.`);
    }
  }

  // --- 4. Cobranzas ---------------------------------------------------------
  const v = input.vencimientos;
  if (v !== undefined) {
    // `vencido_por_moneda` y `por_vencer_por_moneda` ya vienen agregados por el
    // servicio: recalcularlos desde los buckets sería duplicar el criterio de
    // qué cuenta como vencido, con el riesgo de que las dos versiones diverjan.
    const vencido = Object.fromEntries(
      Object.entries(v.vencido_por_moneda).map(([m, t]) => [m, t.total]),
    );
    const cantidadVencida = Object.values(v.vencido_por_moneda).reduce(
      (acc, t) => acc + t.comprobantes,
      0,
    );
    const porVencer = Object.fromEntries(
      Object.entries(v.por_vencer_por_moneda).map(([m, t]) => [m, t.total]),
    );
    const cantidadPorVencer = Object.values(v.por_vencer_por_moneda).reduce(
      (acc, t) => acc + t.comprobantes,
      0,
    );

    if (cantidadVencida > 0 || cantidadPorVencer > 0) {
      secciones.push("cobranzas");
      lineas.push("", "💰 *Cobranzas*");
      if (cantidadVencida > 0) {
        accionables += 1;
        lineas.push(`• Vencido: ${montosPorMoneda(vencido)} en ${cantidadVencida} documento(s).`);
      }
      if (cantidadPorVencer > 0) {
        lineas.push(`• Por vencer: ${montosPorMoneda(porVencer)} en ${cantidadPorVencer} documento(s).`);
      }
    }
  }

  // --- 5. Facturación del período ------------------------------------------
  const r = input.resumen;
  if (r !== undefined) {
    const totales = Object.fromEntries(
      Object.entries(r.totales_por_moneda).map(([m, t]) => [m, t.total]),
    );
    if (Object.keys(totales).length > 0) {
      secciones.push("facturacion");
      const etiqueta = input.periodo_resumen ?? "el período";
      const comprobantes = Object.values(r.totales_por_moneda).reduce(
        (n, m) => n + m.comprobantes,
        0,
      );
      lineas.push(
        "",
        `📊 *Facturado ${etiqueta}*`,
        `• ${montosPorMoneda(totales)} en ${comprobantes} comprobante(s).`,
      );
      // Con una sola moneda el equivalente repetiría el mismo número. Con
      // varias, es el único renglón que se puede leer de un vistazo — pero se
      // omite si quedó incompleto: un "≈" que en realidad deja plata afuera
      // engaña más que no ponerlo.
      const eq = r.equivalente_uyu;
      if (Object.keys(totales).length > 1 && eq.completo && eq.total_uyu !== 0) {
        lineas.push(`• ≈ ${formatearMonto(eq.total_uyu, "UYU")} al tipo de cambio de cada factura.`);
      }
    }
  }

  // --- 6. Todo en orden -----------------------------------------------------
  if (accionables === 0) {
    lineas.push("", "✅ Sin alertas ni vencimientos para atender.");
  }

  return {
    texto: lineas.join("\n"),
    requiere_atencion: accionables > 0,
    items_accionables: accionables,
    secciones,
  };
}
