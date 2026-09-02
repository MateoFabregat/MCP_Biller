// =============================================================================
// Tope de monto por operación de escritura (PLAN_V2 §5.4).
//
// PARA QUÉ SIRVE DE VERDAD: no protege contra un atacante —quien controla la
// conversación puede pedir dos facturas de la mitad— sino contra el error que
// de verdad ocurre: una coma mal puesta. "Facturale 1.500" interpretado como
// 1500000 es una e-Factura real ante DGI que después hay que anular con una
// nota de crédito, explicarle al cliente y arreglar en el IVA del mes.
//
// Un tope es la diferencia entre "el sistema me frenó" y "hay que llamar al
// contador". Por eso el mensaje de rechazo dice el monto y el tope: el usuario
// tiene que poder ver de un vistazo si fue un error de tipeo o una venta real.
//
// El tope es POR MONEDA. Un límite de 100.000 pensado en pesos aplicado a una
// factura en dólares bloquearía casi todo; aplicado al revés, no bloquearía nada.
// =============================================================================

import { BillerError } from "../utils/errors.js";

export class BillerMontoExcedidoError extends BillerError {
  constructor(monto: number, limite: number, moneda: string) {
    super(
      "validation",
      `El total de la operación (${moneda} ${monto.toLocaleString("es-UY")}) supera el tope ` +
        `configurado de ${moneda} ${limite.toLocaleString("es-UY")} por operación. ` +
        "NO se ejecutó. Si el monto es correcto, subí BILLER_MAX_MONTO_<MONEDA> o emitilo desde " +
        "Biller directamente. Si no lo es, revisá los decimales antes de reintentar.",
    );
  }
}

export class BillerMontoInvalidoError extends BillerError {
  constructor(detalle: string) {
    super(
      "validation",
      `El monto de la operación es inválido: ${detalle}. NO se ejecutó. ` +
        "Revisá el importe antes de volver a confirmar.",
    );
  }
}

/** Mapa moneda -> tope. Vacío = sin tope (comportamiento previo). */
export type LimitesMonto = Record<string, number>;

function monedaDelPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "UYU";
  const moneda = (payload as Record<string, unknown>).moneda;
  return typeof moneda === "string" && moneda.trim() !== ""
    ? moneda.trim().toUpperCase()
    : "UYU";
}

function tieneIndicioMonto(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(p, "total") ||
    Object.prototype.hasOwnProperty.call(p, "monto") ||
    Object.prototype.hasOwnProperty.call(p, "importe") ||
    Object.prototype.hasOwnProperty.call(p, "pago")
  );
}

/**
 * Parsea los topes desde el entorno: `BILLER_MAX_MONTO_UYU=500000`,
 * `BILLER_MAX_MONTO_USD=10000`.
 *
 * Se usa un prefijo por moneda en vez de un JSON porque estos valores se
 * configuran en paneles como el de Vercel, donde una variable por línea es
 * mucho más difícil de romper que un JSON en una sola celda.
 */
export function parseLimitesMonto(env: Record<string, string | undefined>): LimitesMonto {
  const out: LimitesMonto = {};
  for (const [clave, valor] of Object.entries(env)) {
    const m = /^BILLER_MAX_MONTO_([A-Z]{3})$/.exec(clave);
    if (m === null || valor === undefined) continue;
    const n = Number(valor.trim());
    // Un valor inválido se IGNORA en vez de tratarse como 0: un tope de 0 por
    // un typo bloquearía toda la facturación de la empresa.
    if (Number.isFinite(n) && n > 0) out[m[1]!] = n;
  }
  return out;
}

/**
 * Extrae el total y la moneda de un payload de escritura, sin conocer su forma
 * exacta. Devuelve null si no hay un total identificable — en cuyo caso no se
 * puede aplicar tope y la operación sigue (el tope es una red, no un requisito).
 */
export function extraerMonto(payload: unknown): { monto: number; moneda: string } | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // Los pagos genéricos llevan el monto en la raíz. Crear un recibo, en cambio,
  // lo lleva en `pago.monto`; es una ruta documentada y explícita (no una
  // recursión que podría confundir subtotales o referencias con el total real).
  const tienePago = Object.prototype.hasOwnProperty.call(p, "pago");
  const pago =
    p.pago !== null && typeof p.pago === "object"
      ? (p.pago as Record<string, unknown>)
      : undefined;
  const candidatos = tienePago
    ? [
        // En un recibo este es el monto autoritativo. No se deja que un campo
        // raíz extra (el schema admite passthrough) lo tape con un valor menor.
        { valor: pago?.monto, permiteNegativo: false },
      ]
    : [
        { valor: p.total, permiteNegativo: true },
        { valor: p.monto, permiteNegativo: true },
        { valor: p.importe, permiteNegativo: true },
      ];
  const moneda = monedaDelPayload(payload);

  for (const candidato of candidatos) {
    const c = candidato.valor;
    const n = typeof c === "number" ? c : typeof c === "string" ? Number(c) : NaN;
    if (Number.isFinite(n) && n < 0 && !candidato.permiteNegativo) {
      throw new BillerMontoInvalidoError("pago.monto no puede ser negativo en un recibo");
    }
    if (Number.isFinite(n)) return { monto: Math.abs(n), moneda };
  }
  return null;
}

/** Un total que el llamador ya calculó. Ver `verificarLimiteMonto`. */
export interface MontoExplicito {
  monto: number;
  moneda: string;
}

/**
 * Aplica el tope. Lanza `BillerMontoExcedidoError` si se supera.
 * Sin tope configurado para esa moneda, no hace nada.
 *
 * `explicito` EXISTE PORQUE EL PAYLOAD MÁS IMPORTANTE NO TIENE TOTAL.
 *
 * `extraerMonto` husmea `total`/`monto`/`importe` en la raíz, que es lo correcto
 * para un recibo o un pago. Un ComprobanteBody no tiene ninguno de los tres: el
 * total de un CFE es la suma de sus líneas con su IVA, y eso lo calcula
 * `calcularTotales`. Sin este parámetro, el tope se saltaba justo la operación
 * que lo motivó —una coma mal puesta en un precio— y BILLER_MAX_MONTO_UYU no
 * frenaba una emisión ni una vez.
 *
 * Cuando viene, GANA sobre lo husmeado: es un número calculado, no adivinado.
 */
export function verificarLimiteMonto(
  payload: unknown,
  limites: LimitesMonto | undefined,
  explicito?: MontoExplicito,
): void {
  // Tolera `undefined`: una config vieja sin este campo debe seguir escribiendo,
  // no romper toda la capa de escritura con un TypeError.
  if (limites === undefined || Object.keys(limites).length === 0) return;
  if (
    explicito !== undefined &&
    Number.isFinite(explicito.monto) &&
    explicito.monto !== 0
  ) {
    const moneda = explicito.moneda.trim().toUpperCase();
    const limite = limites[moneda];
    if (limite !== undefined && Math.abs(explicito.monto) > limite) {
      throw new BillerMontoExcedidoError(Math.abs(explicito.monto), limite, moneda);
    }
    return;
  }

  const monedaPayload = monedaDelPayload(payload);
  const limitePayload = limites[monedaPayload];
  if (limitePayload !== undefined) {
    const extraido = extraerMonto(payload);
    if (extraido !== null) {
      if (extraido.monto > limitePayload) {
        throw new BillerMontoExcedidoError(extraido.monto, limitePayload, monedaPayload);
      }
      return;
    }
    if (tieneIndicioMonto(payload)) {
      throw new BillerMontoInvalidoError(
        "hay campos monetarios, pero no contienen un número finito identificable",
      );
    }
  }

  if (explicito !== undefined) {
    // Cero es un total válido (p.ej. entrega gratuita). Conserva además la
    // compatibilidad anterior: si el payload sí trae un monto raíz, ese monto
    // ya se evaluó arriba antes de aceptar el cero explícito.
    if (Number.isFinite(explicito.monto) && explicito.monto === 0) return;
    const moneda = explicito.moneda.trim().toUpperCase();
    if (limites[moneda] !== undefined) {
      throw new BillerMontoInvalidoError("el total calculado no es un número finito");
    }
  }
}
