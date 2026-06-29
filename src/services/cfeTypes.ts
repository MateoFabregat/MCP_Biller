// =============================================================================
// Clasificación de tipos de comprobante fiscal electrónico (CFE).
//
// Tabla basada en la documentación provista. El "signo" indica el aporte al
// total de facturación en `resumen_facturacion_periodo`:
//   ventas      -> suman   (+1)
//   notas crédito -> restan (-1)
//   notas débito  -> suman  (+1)
//   especiales  -> NO se suman automáticamente sin validación (0)
//   desconocido -> NO se suma; se reporta como warning (0)
// =============================================================================

export type CfeCategoria = "venta" | "nota_credito" | "nota_debito" | "especial" | "desconocido";

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

export function classifyCfe(tipo: number | null): CfeClassification {
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
