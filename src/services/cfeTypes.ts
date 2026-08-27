// =============================================================================
// Clasificación de tipos de comprobante fiscal electrónico (CFE).
//
// Tabla basada en la documentación provista. El "signo" indica el aporte al
// total de facturación en `resumen_facturacion_periodo`:
//   ventas      -> suman   (+1)
//   notas crédito -> restan (-1)
//   notas débito  -> suman  (+1)
//   cobranzas   -> NO se suman: son cobro de algo ya facturado (0)
//   especiales  -> NO se suman automáticamente sin validación (0)
//   desconocido -> NO se suma; se reporta como warning (0)
//
// ⚠️ EL TIPO NO ALCANZA PARA CLASIFICAR. Un recibo (comprobante de cobranza) se
// emite como e-Ticket (101) o e-Factura (111): mirando solo `tipo_comprobante`
// es indistinguible de una venta. Lo que lo distingue es
// `indicador_cobranza_propia = 1`, documentado en GET /v2/comprobantes/obtener:
//
//   "Para identificar comprobantes de cobranza, habrá un campo
//    `indicador_cobranza_propia` que estará en 1 cuando el comprobante
//    obtenido sea un recibo."
//
// Sin ese chequeo, facturar $100 a crédito y cobrarlo con un recibo reporta
// $200 facturados. Por eso `classifyCfe` recibe el indicador y NO el tipo solo.
// =============================================================================

export type CfeCategoria =
  | "venta"
  | "nota_credito"
  | "nota_debito"
  | "cobranza"
  | "especial"
  | "desconocido";

export interface CfeClassification {
  tipo: number | null;
  categoria: CfeCategoria;
  /** +1 suma, -1 resta, 0 no aporta al total. */
  signo: 1 | -1 | 0;
  etiqueta: string;
  /** true si participa del cálculo del total. */
  suma_en_resumen: boolean;
}

const VENTAS: Record<number, string> = {
  101: "e-Ticket",
  111: "e-Factura",
  121: "e-Factura de exportación",
  131: "e-Ticket venta por cuenta ajena",
  141: "e-Factura venta por cuenta ajena",
  151: "eBoleta de entrada",
};

const NOTAS_CREDITO: Record<number, string> = {
  102: "Nota de Crédito de e-Ticket",
  112: "Nota de Crédito de e-Factura",
  122: "Nota de Crédito de e-Factura de exportación",
  132: "Nota de Crédito de e-Ticket venta por cuenta ajena",
  142: "Nota de Crédito de e-Factura venta por cuenta ajena",
  152: "Nota de Crédito de eBoleta de entrada",
};

const NOTAS_DEBITO: Record<number, string> = {
  103: "Nota de Débito de e-Ticket",
  113: "Nota de Débito de e-Factura",
  123: "Nota de Débito de e-Factura de exportación",
  133: "Nota de Débito de e-Ticket venta por cuenta ajena",
  143: "Nota de Débito de e-Factura venta por cuenta ajena",
  153: "Nota de Débito de eBoleta de entrada",
};

const ESPECIALES: Record<number, string> = {
  181: "eRemito",
  182: "eResguardo",
  124: "eRemito de exportación",
};

// NOTA: la familia e-Factura (receptor obligatorio ante DGI) vive en
// `FAMILIA_EFACTURA` de src/biller/cfeSchema.ts, junto al resto de las reglas de
// emisión. Este módulo solo clasifica para el resumen de facturación.

/**
 * true cuando el comprobante es un recibo (comprobante de cobranza propia).
 *
 * Se compara contra 1 y no por "truthy" porque el campo llega como 0/1 y el 0
 * es el caso normal: cualquier laxitud acá convierte ventas en cobranzas.
 */
export function esCobranza(indicadorCobranzaPropia: number | null | undefined): boolean {
  return indicadorCobranzaPropia === 1;
}

/** Nombre del tipo, sin clasificar. "" si el tipo no está en ninguna tabla. */
function etiquetaTipo(tipo: number): string {
  return VENTAS[tipo] ?? NOTAS_CREDITO[tipo] ?? NOTAS_DEBITO[tipo] ?? ESPECIALES[tipo] ?? "";
}

/**
 * @param tipo  `tipo_comprobante` del CFE.
 * @param indicadorCobranzaPropia  `indicador_cobranza_propia`: 1 = es un recibo.
 *   Omitirlo hace que un recibo se clasifique como venta (doble conteo): pasalo
 *   siempre que estés clasificando un comprobante real de la API.
 */
export function classifyCfe(
  tipo: number | null,
  indicadorCobranzaPropia?: number | null,
): CfeClassification {
  // Va primero: el recibo se emite como e-Ticket/e-Factura, así que el tipo lo
  // clasificaría como venta. El indicador manda sobre la tabla de tipos.
  if (esCobranza(indicadorCobranzaPropia)) {
    const base = typeof tipo === "number" && Number.isFinite(tipo) ? etiquetaTipo(tipo) : "";
    return {
      tipo,
      categoria: "cobranza",
      signo: 0,
      etiqueta: base === "" ? "Recibo (comprobante de cobranza)" : `Recibo de ${base}`,
      suma_en_resumen: false,
    };
  }

  if (tipo === null || tipo === undefined || !Number.isFinite(tipo)) {
    return {
      tipo,
      categoria: "desconocido",
      signo: 0,
      etiqueta: "Tipo de comprobante ausente o no numérico",
      suma_en_resumen: false,
    };
  }
  if (tipo in VENTAS) {
    return { tipo, categoria: "venta", signo: 1, etiqueta: VENTAS[tipo]!, suma_en_resumen: true };
  }
  if (tipo in NOTAS_CREDITO) {
    return {
      tipo,
      categoria: "nota_credito",
      signo: -1,
      etiqueta: NOTAS_CREDITO[tipo]!,
      suma_en_resumen: true,
    };
  }
  if (tipo in NOTAS_DEBITO) {
    return {
      tipo,
      categoria: "nota_debito",
      signo: 1,
      etiqueta: NOTAS_DEBITO[tipo]!,
      suma_en_resumen: true,
    };
  }
  if (tipo in ESPECIALES) {
    return {
      tipo,
      categoria: "especial",
      signo: 0,
      etiqueta: ESPECIALES[tipo]!,
      suma_en_resumen: false,
    };
  }
  return {
    tipo,
    categoria: "desconocido",
    signo: 0,
    etiqueta: `Tipo de comprobante ${tipo} no clasificado`,
    suma_en_resumen: false,
  };
}
