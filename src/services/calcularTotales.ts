// =============================================================================
// Cálculo LOCAL del total de un CFE antes de emitirlo.
//
// Para qué: el dry-run tiene que poder decir "esto va a salir $1.220 IVA
// incluido". Sin esto, confirmar una emisión es confirmar a ciegas — y por
// WhatsApp, donde el humano solo ve el mensaje de confirmación, es la única
// forma de que sepa qué está aprobando.
//
// ⚠️ Es una ESTIMACIÓN, no el cálculo fiscal de Biller. El total autoritativo es
// el que devuelve la API al emitir. Todo lo que no se puede determinar con
// certeza baja el flag `exacto` y se explica en `supuestos`/`advertencias`.
// =============================================================================

import type { ComprobanteBody } from "../biller/cfeSchema.js";
import { INDICADORES_FACTURACION } from "../biller/cfeSchema.js";
import { round2 } from "../biller/coerce.js";

/**
 * Tasas de IVA por indicador de facturación (Uruguay: básica 22%, mínima 10%).
 * `null` = la tasa no se puede determinar desde el payload.
 */
const TASA_IVA: Record<number, number | null> = {
  1: 0, // Exento de IVA
  2: 0.1, // Tasa mínima
  3: 0.22, // Tasa básica
  4: null, // Otra tasa -> desconocida, no se puede calcular
  5: 0, // Entrega gratuita
  10: 0, // Exportación y asimiladas
  12: 0, // IVA en suspenso
  13: 0, // Ítem vendido no contribuyente
  14: 0, // Contribuyente monotributo
  15: 0, // Contribuyente IMEBA
  16: 0, // Contribuyente IVA mínimo / Monotributo / MIDES
};

/**
 * Indicadores cuyos ítems NO aportan al total monetario del comprobante
 * (entregas gratuitas, no facturables, ítems de ajuste de remito/resguardo).
 */
const NO_APORTAN_AL_TOTAL = new Set([5, 6, 7, 8, 9, 11]);

export interface LineaCalculada {
  concepto: string;
  cantidad: number;
  precio: number;
  indicador_facturacion: number | null;
  tratamiento: string;
  /** Importe de la línea después de descuentos/recargos del ítem. */
  neto: number;
  iva: number;
  total: number;
  aporta_al_total: boolean;
}

export interface TotalesEstimados {
  moneda: string | null;
  /** Suma de las líneas sin IVA. */
  subtotal: number;
  /** IVA discriminado por tasa (clave = porcentaje, ej. "22"). */
  iva_por_tasa: Record<string, number>;
  total_iva: number;
  /** Descuentos (negativo) y recargos (positivo) globales aplicados. */
  ajustes_globales: number;
  total: number;
  /** Suma de retenciones/percepciones (tasa/100 * monto_sujeto). Informativo. */
  total_retenciones_percepciones: number;
  lineas: LineaCalculada[];
  /**
   * false si algún ítem usa una tasa que no se puede determinar. Cuando es
   * false, el total es un piso, no el número final.
   */
  exacto: boolean;
  /** Interpretaciones que tomó el cálculo (la doc no las define del todo). */
  supuestos: string[];
  advertencias: string[];
}

/** Aplica un descuento/recargo "$" (importe sobre la línea) o "%" (porcentaje). */
function aplicarAjuste(base: number, tipo: "$" | "%" | undefined, cantidad: number | undefined, signo: 1 | -1): number {
  if (tipo === undefined || cantidad === undefined) return 0;
  const valor = tipo === "%" ? (base * cantidad) / 100 : cantidad;
  return signo * valor;
}

/**
 * Calcula los totales estimados de un CFE a partir de su cuerpo.
 *
 * Semántica de `montos_brutos` (documentada):
 *   - true/1  -> los precios de los ítems YA incluyen IVA: se desagrega hacia atrás.
 *   - false/0 -> el IVA se calcula y SE SUMA al total.
 */
export function calcularTotales(body: ComprobanteBody): TotalesEstimados {
  const supuestos: string[] = [];
  const advertencias: string[] = [];
  const lineas: LineaCalculada[] = [];
  const ivaPorTasa: Record<string, number> = {};

  const montosBrutos = body.montos_brutos === true;
  const items = body.items ?? [];
  let exacto = true;

  // Neto acumulado por indicador, para poder repartir los descuentos globales.
  const netoPorIndicador = new Map<number, number>();

  for (const item of items) {
    const cantidad = typeof item.cantidad === "number" ? item.cantidad : 0;
    const precio = typeof item.precio === "number" ? item.precio : 0;
    const indicador = typeof item.indicador_facturacion === "number" ? item.indicador_facturacion : null;

    let linea = cantidad * precio;
    linea += aplicarAjuste(linea, item.descuento_tipo, item.descuento_cantidad, -1);
    linea += aplicarAjuste(linea, item.recargo_tipo, item.recargo_cantidad, 1);

    const aporta = indicador === null || !NO_APORTAN_AL_TOTAL.has(indicador);
    const tasa = indicador === null ? null : TASA_IVA[indicador] ?? null;

    if (indicador !== null && tasa === null && aporta) {
      exacto = false;
      advertencias.push(
        `El ítem "${item.concepto}" usa indicador_facturacion ${indicador} ` +
          `(${INDICADORES_FACTURACION[indicador] ?? "desconocido"}): la tasa de IVA no se puede ` +
          "determinar desde el payload, así que no se sumó IVA por esa línea.",
      );
    }
    if (indicador === null) {
      exacto = false;
    }

    let neto: number;
    let iva: number;
    const tasaEfectiva = tasa ?? 0;
    if (montosBrutos) {
      // El precio incluye IVA: se desagrega.
      neto = tasaEfectiva > 0 ? linea / (1 + tasaEfectiva) : linea;
      iva = linea - neto;
    } else {
      neto = linea;
      iva = neto * tasaEfectiva;
    }

    if (aporta) {
      if (indicador !== null) {
        netoPorIndicador.set(indicador, (netoPorIndicador.get(indicador) ?? 0) + neto);
      }
      if (iva > 0) {
        const clave = String(round2(tasaEfectiva * 100));
        ivaPorTasa[clave] = round2((ivaPorTasa[clave] ?? 0) + iva);
      }
    }

    lineas.push({
      concepto: typeof item.concepto === "string" ? item.concepto : "(sin concepto)",
      cantidad,
      precio,
      indicador_facturacion: indicador,
      tratamiento:
        indicador === null
          ? "sin indicador_facturacion"
          : INDICADORES_FACTURACION[indicador] ?? `indicador ${indicador}`,
      neto: round2(neto),
      iva: round2(iva),
      total: round2(neto + iva),
      aporta_al_total: aporta,
    });
  }

  const noAportan = lineas.filter((l) => !l.aporta_al_total);
  if (noAportan.length > 0) {
    supuestos.push(
      `${noAportan.length} ítem(s) con indicador de entrega gratuita / no facturable no se sumaron al total.`,
    );
  }

  let subtotal = lineas.filter((l) => l.aporta_al_total).reduce((acc, l) => acc + l.neto, 0);
  let totalIva = Object.values(ivaPorTasa).reduce((acc, v) => acc + v, 0);

  // --- Descuentos y recargos globales -------------------------------------
  // Se aplican sobre el neto de los ítems que comparten indicador_facturacion.
  let ajustesGlobales = 0;
  for (const dr of body.descuentosRecargos ?? []) {
    const base = netoPorIndicador.get(dr.indicador_facturacion) ?? 0;
    if (base === 0) {
      advertencias.push(
        `El descuento/recargo global "${dr.glosa ?? ""}" (indicador ${dr.indicador_facturacion}) ` +
          "no tiene ítems que le correspondan: no se aplicó al cálculo.",
      );
      continue;
    }
    const signo: 1 | -1 = dr.es_recargo ? 1 : -1;
    const monto = aplicarAjuste(base, dr.desc_rec_tipo, dr.valor, signo);
    ajustesGlobales += monto;

    // El ajuste arrastra su parte proporcional de IVA.
    const tasa = TASA_IVA[dr.indicador_facturacion] ?? 0;
    if (tasa > 0) {
      const ivaAjuste = monto * tasa;
      const clave = String(round2(tasa * 100));
      ivaPorTasa[clave] = round2((ivaPorTasa[clave] ?? 0) + ivaAjuste);
      totalIva += ivaAjuste;
    }
  }
  subtotal += ajustesGlobales;

  if ((body.descuentosRecargos?.length ?? 0) > 0) {
    supuestos.push(
      'Los descuentos/recargos globales se aplicaron sobre el neto de los ítems con el mismo ' +
        "indicador_facturacion, que es como la doc los describe.",
    );
  }
  if (items.some((i) => i.descuento_tipo === "$" || i.recargo_tipo === "$")) {
    supuestos.push(
      'Los descuentos/recargos de ítem en "$" se interpretaron como importe sobre la LÍNEA ' +
        "(cantidad × precio), no por unidad.",
    );
  }

  // --- Retenciones / percepciones (informativo) ---------------------------
  // "El valor será calculado automáticamente como tasa / 100 * monto_sujeto."
  let totalRetenciones = 0;
  const todasLasRetenciones = [
    ...(body.retencionesPercepciones ?? []),
    ...items.flatMap((i) => i.retencionesPercepciones ?? []),
  ];
  for (const r of todasLasRetenciones) {
    totalRetenciones += (r.tasa / 100) * r.monto_sujeto;
  }
  if (todasLasRetenciones.length > 0) {
    supuestos.push(
      "Las retenciones/percepciones se informan aparte: no se suman al total del comprobante.",
    );
  }

  if (montosBrutos) {
    supuestos.push("montos_brutos activo: los precios ya incluían IVA y se desagregó hacia atrás.");
  }

  return {
    moneda: body.moneda ?? null,
    subtotal: round2(subtotal),
    iva_por_tasa: ivaPorTasa,
    total_iva: round2(totalIva),
    ajustes_globales: round2(ajustesGlobales),
    total: round2(subtotal + totalIva),
    total_retenciones_percepciones: round2(totalRetenciones),
    lineas,
    exacto,
    supuestos,
    advertencias,
  };
}

/** Resumen de una línea para mostrar en el preview/confirmación. */
export function formatearTotales(t: TotalesEstimados): string {
  const moneda = t.moneda ?? "";
  const aprox = t.exacto ? "" : " (aprox.)";
  const iva =
    Object.keys(t.iva_por_tasa).length > 0
      ? ` — IVA ${Object.entries(t.iva_por_tasa)
          .map(([tasa, monto]) => `${tasa}%: ${monto}`)
          .join(", ")}`
      : "";
  return `Total estimado${aprox}: ${moneda} ${t.total} (neto ${t.subtotal}${iva})`;
}
