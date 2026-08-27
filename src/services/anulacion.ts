// =============================================================================
// Anulación y reversión de un CFE: qué hay que emitir para deshacer qué.
//
// LA CORRECCIÓN CONCEPTUAL QUE ORIGINÓ ESTE MÓDULO.
// El resto del proyecto venía diciendo que emitir es "irreversible ante DGI".
// Es falso, y la diferencia importa para el producto:
//
//   · Un CFE mal emitido se ANULA con una Nota de Crédito por el total. El
//     comprobante original sigue existiendo —la numeración ante DGI no se
//     recicla— pero queda sin efecto económico.
//   · Si esa anulación fue el error, se emite una Nota de DÉBITO contra la
//     Nota de Crédito, y el comprobante original vuelve a tener validez.
//
// O sea: no es irreversible, es CORREGIBLE, y cada corrección deja rastro. Eso
// cambia el tono correcto de las barreras de escritura: no son un "cuidado, esto
// no tiene vuelta atrás" (mentira que paraliza), sino un "esto emite un
// documento fiscal real; si sale mal, se arregla con otro documento, no con un
// undo". El costo de equivocarse es la cadena de correcciones, no la catástrofe.
//
// EL PATRÓN DE LOS TIPOS. La tabla de valores de Biller es regular: para cada
// familia, el tipo base termina en 1, su nota de crédito en 2 y su nota de
// débito en 3 (101/102/103, 111/112/113, 121/122/123, …). Esa regularidad es lo
// que hace que anular sea mecánico. Igual NO se calcula con aritmética sobre el
// número: se declara el mapa explícito, porque una familia futura que rompa el
// patrón produciría, en silencio, una nota de crédito de un tipo inexistente.
// =============================================================================

import { TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { estaAceptado } from "./resumenFacturacion.js";

/** tipo original -> tipo de la Nota de Crédito que lo anula. */
export const NOTA_CREDITO_DE: Record<number, number> = {
  101: 102,
  111: 112,
  121: 122,
  131: 132,
  141: 142,
  151: 152,
};

/** tipo de Nota de Crédito -> tipo de la Nota de Débito que la revierte. */
export const NOTA_DEBITO_DE: Record<number, number> = {
  102: 103,
  112: 113,
  122: 123,
  132: 133,
  142: 143,
  152: 153,
};

/** Tipos que el endpoint POST /v2/comprobantes/anular sabe anular solo. */
const ANULABLES_POR_ENDPOINT = new Set([101, 111]);

export type AccionAnulacion =
  /** Emitir una NC que deja sin efecto el comprobante. */
  | "nota_credito"
  /** Emitir una ND que revierte una NC previa y devuelve validez al original. */
  | "nota_debito_reversion"
  /** El comprobante no se anula con una nota de ajuste. */
  | "no_aplica";

export interface ComprobanteAAnular {
  id: number | null;
  tipo_comprobante: number | null;
  serie: string | null;
  numero: number | null;
  moneda: string | null;
  total: number | null;
  fecha_emision: string | null;
  estado: string | null;
}

export interface PlanAnulacion {
  accion: AccionAnulacion;
  /** Tipo de CFE que hay que emitir. null si no aplica. */
  tipo_a_emitir: number | null;
  etiqueta_a_emitir: string | null;
  /** Qué efecto tiene, en castellano. */
  efecto: string;
  /**
   * true si se puede usar `biller_anular_comprobante` (POST /v2/comprobantes/anular),
   * que arma la NC solo. Solo aplica a e-Tickets y e-Facturas SIN comprobantes
   * asociados; si ya tiene una NC encima, hay que emitirla a mano.
   */
  usa_endpoint_anular: boolean;
  /** Cuerpo sugerido para `biller_emitir_comprobante`, si hay que emitir a mano. */
  cuerpo_sugerido: Record<string, unknown> | null;
  /** Pasos concretos, en orden. */
  pasos: string[];
  advertencias: string[];
}

/**
 * Arma el plan para dejar sin efecto un comprobante.
 *
 * @param yaTieneNotaCredito true si ya se le emitió una NC. Cambia el plan por
 *   completo: sobre un comprobante ya anulado, emitir OTRA nota de crédito lo
 *   acredita dos veces. Lo que corresponde ahí es una nota de débito, y solo si
 *   lo que se quiere es RESUCITAR el original.
 */
export function planAnulacion(
  c: ComprobanteAAnular,
  opciones: { ya_tiene_nota_credito?: boolean; razon?: string } = {},
): PlanAnulacion {
  const tipo = c.tipo_comprobante;
  const advertencias: string[] = [];

  if (tipo === null) {
    return {
      accion: "no_aplica",
      tipo_a_emitir: null,
      etiqueta_a_emitir: null,
      efecto: "No se puede planificar la anulación: el comprobante no trae tipo_comprobante.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: null,
      pasos: [],
      advertencias: ["Falta 'tipo_comprobante': sin eso no se sabe qué nota de ajuste corresponde."],
    };
  }

  const etiquetaOriginal = TIPOS_COMPROBANTE[tipo] ?? `tipo ${tipo}`;

  // --- Caso 2: lo que hay que deshacer es una NOTA DE CRÉDITO ---------------
  const tipoNd = NOTA_DEBITO_DE[tipo];
  if (tipoNd !== undefined) {
    return {
      accion: "nota_debito_reversion",
      tipo_a_emitir: tipoNd,
      etiqueta_a_emitir: TIPOS_COMPROBANTE[tipoNd] ?? null,
      efecto:
        `El comprobante ${c.serie ?? ""}-${c.numero ?? ""} ES una ${etiquetaOriginal}. ` +
        `Emitir una ${TIPOS_COMPROBANTE[tipoNd]} contra ella revierte la anulación: el comprobante ` +
        "original vuelve a tener validez económica.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: cuerpoNota(tipoNd, c, opciones.razon ?? "Reversión de nota de crédito"),
      pasos: [
        `Emitir un CFE tipo ${tipoNd} (${TIPOS_COMPROBANTE[tipoNd]}) por el mismo importe (${c.moneda ?? "?"} ${Math.abs(c.total ?? 0)}).`,
        `Referenciarlo a la nota de crédito ${c.serie ?? "?"}-${c.numero ?? "?"}${c.id !== null ? ` (id ${c.id})` : ""}.`,
        "Verificar después con biller_obtener_comprobante que quedó en estado \"Aceptado DGI\".",
      ],
      advertencias: [
        "Una nota de débito SUMA: si el objetivo no era resucitar el comprobante original sino " +
          "corregir un importe, revisá que el monto sea el correcto antes de emitir.",
      ],
    };
  }

  // --- Caso 1: anular un comprobante de venta ------------------------------
  const tipoNc = NOTA_CREDITO_DE[tipo];
  if (tipoNc === undefined) {
    return {
      accion: "no_aplica",
      tipo_a_emitir: null,
      etiqueta_a_emitir: null,
      efecto:
        `El tipo ${tipo} (${etiquetaOriginal}) no tiene una nota de crédito asociada en la tabla ` +
        "de valores: no se anula por esta vía.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: null,
      pasos: [],
      advertencias: [
        tipo === 181 || tipo === 124
          ? "Los remitos no se anulan con nota de crédito: se corrigen con un remito de ajuste."
          : tipo === 182
            ? "Un e-Resguardo se anula con un ítem de indicador_facturacion 9 en otro e-Resguardo."
            : "Revisá en la documentación de DGI qué corresponde para este tipo.",
      ],
    };
  }

  const yaAnulado = opciones.ya_tiene_nota_credito === true;
  if (yaAnulado) {
    advertencias.push(
      "⚠️ Este comprobante YA tiene una nota de crédito asociada. Emitir otra lo acreditaría dos " +
        "veces y dejaría un saldo a favor del cliente que no corresponde. Si lo que querés es " +
        "revertir la anulación, hay que emitir una NOTA DE DÉBITO contra esa nota de crédito.",
    );
  }

  const puedeEndpoint = ANULABLES_POR_ENDPOINT.has(tipo) && !yaAnulado;

  return {
    accion: "nota_credito",
    tipo_a_emitir: tipoNc,
    etiqueta_a_emitir: TIPOS_COMPROBANTE[tipoNc] ?? null,
    efecto:
      `Emitir una ${TIPOS_COMPROBANTE[tipoNc]} por el total deja sin efecto ` +
      `${etiquetaOriginal} ${c.serie ?? ""}-${c.numero ?? ""}. El original NO desaparece: sigue ` +
      "existiendo ante DGI con su numeración, pero queda saldado. Si esto fuera un error, se " +
      `revierte después con una ${TIPOS_COMPROBANTE[NOTA_DEBITO_DE[tipoNc]!] ?? "nota de débito"}.`,
    usa_endpoint_anular: puedeEndpoint,
    cuerpo_sugerido: puedeEndpoint
      ? null
      : cuerpoNota(tipoNc, c, opciones.razon ?? "Anulación de comprobante"),
    pasos: puedeEndpoint
      ? [
          `Usar biller_anular_comprobante con id=${c.id ?? "(o tipo+serie+numero)"} y ` +
            "fecha_emision_hoy=true. Biller arma la nota de crédito por el total.",
          "Correr primero el dry-run (sin confirm) para leer el preview.",
          "Verificar después con biller_obtener_comprobante que la NC quedó \"Aceptado DGI\".",
        ]
      : [
          `Emitir un CFE tipo ${tipoNc} (${TIPOS_COMPROBANTE[tipoNc]}) con biller_emitir_comprobante.`,
          `Referenciarlo al comprobante ${c.serie ?? "?"}-${c.numero ?? "?"}${c.id !== null ? ` (id ${c.id})` : ""}.`,
          `Por el mismo importe: ${c.moneda ?? "?"} ${c.total ?? "?"}.`,
          "Correr primero el dry-run para verificar el total calculado.",
        ],
    advertencias: [
      ...advertencias,
      ...(puedeEndpoint
        ? [
            "POST /v2/comprobantes/anular solo funciona si el comprobante NO tiene comprobantes " +
              "asociados. Si falla por eso, emití la nota de crédito a mano con el cuerpo sugerido.",
          ]
        : []),
      // `estaAceptado` es el dueño único del criterio "Aceptado DGI": el mismo
      // que hace que los totales coincidan con Biller. Reimplementarlo acá con
      // otro regex sería tener dos definiciones de lo mismo.
      ...(c.estado !== null && !estaAceptado(c.estado)
        ? [
            `El comprobante original está en estado "${c.estado}", no "Aceptado DGI". Un CFE que DGI ` +
              "no aceptó no tiene efecto fiscal: anularlo puede no ser lo que hace falta. Revisalo antes.",
          ]
        : []),
    ],
  };
}

/** Cuerpo listo para `biller_emitir_comprobante`, referenciando el original. */
function cuerpoNota(
  tipo: number,
  c: ComprobanteAAnular,
  razon: string,
): Record<string, unknown> {
  const referencia =
    c.id !== null
      ? [c.id]
      : [{ tipo: c.tipo_comprobante, serie: c.serie, numero: c.numero }];

  return {
    tipo_comprobante: tipo,
    moneda: c.moneda ?? "UYU",
    referencias: referencia,
    razon_referencia: razon,
    // CRÍTICO: `total` de un CFE ya viene con IVA incluido. Sin montos_brutos,
    // Biller interpreta el precio como neto y le SUMA el IVA otra vez: la nota
    // de crédito saldría por total × 1,22 y acreditaría de más. Este flag es lo
    // único que hace que la nota anule por el importe exacto del original.
    montos_brutos: true,
    items: [
      {
        concepto: `${razon} ${c.serie ?? ""}-${c.numero ?? ""}`.trim(),
        cantidad: 1,
        // Positivo: el signo lo da el TIPO de comprobante, no el importe. Una
        // nota de crédito con importe negativo se resta dos veces.
        precio: Math.abs(c.total ?? 0),
        indicador_facturacion: 3,
      },
    ],
    // El receptor de la nota tiene que ser el mismo del original; se completa
    // desde el comprobante consultado y no se inventa acá.
    cliente: "<mismo receptor que el comprobante original>",
  };
}
