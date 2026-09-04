// =============================================================================
// Namespace de idempotencia para salidas Kapso.
//
// No se reutiliza el archivo de idempotencia fiscal: un comprobante ante DGI y
// un mensaje de WhatsApp tienen proveedores, operadores y ciclos de vida
// distintos. Sí se reutiliza el primitive seguro de reserva atómica y estados
// de `write/idempotency.ts`, pero la ruta y las claves son propias de Kapso.
//
// La clave nunca contiene el payload. Se hashea el conjunto completo de
// tenant, actor, destinatario, operación y payload canónico; así dos actores o
// dos empresas no se bloquean entre sí, sin dejar teléfonos, nombres o montos
// en el journal.
// =============================================================================

import { createHash } from "node:crypto";
import { hoyIsoUy } from "../services/fechaUy.js";
import { stableStringify } from "../utils/stableStringify.js";
import {
  crearIdempotencyStore,
  type IdempotencyStore,
} from "../write/idempotency.js";
import { BillerError } from "../utils/errors.js";

export type KapsoOutgoingOperation =
  | "texto"
  | "interactivo"
  | "media"
  | "documento"
  | "menu"
  | "resolucion"
  | "paso_emision"
  | "confirmacion_emision"
  | "confirmacion_anulacion"
  | "reporte_diario"
  | "recordatorio"
  | "recordatorio_reenvio";

export interface KapsoKeyInput {
  tenantId: string;
  actorIdentity?: string;
  destinatario: string;
  operation: KapsoOutgoingOperation;
  payload: unknown;
  /**
   * QUÉ identifica al envío en la ventana de día, cuando no es su texto.
   *
   * LA PROMESA QUE ESTO CUMPLE. `biller_recordatorio_cobro` dice, en su
   * documentación y en su `description`, que no repite el reclamo al mismo
   * cliente el mismo día. La clave, en cambio, hasheaba el TEXTO del mensaje:
   * bastaba una `nota` distinta, otra firma de empresa, o que el saldo hubiera
   * cambiado un peso, para estrenar clave y mandar el segundo reclamo. La
   * garantía escrita era falsa justo en el caso que el módulo llama "quema una
   * relación comercial".
   *
   * Con `sujeto` (el RUT del deudor) la ventana de día pasa a preguntar lo que
   * dice preguntar: "¿ya le escribimos HOY a este cliente?", sin importar cómo
   * quedó redactado el mensaje.
   *
   * Solo aplica a la ventana `dia`. En las de reintento la identidad del envío
   * SÍ es su contenido: un mensaje corregido tiene que poder salir.
   */
  sujeto?: string;
}

/**
 * Cuánto tiempo dos salidas idénticas son el MISMO envío.
 *
 * Esto no es un detalle de tuning: sin ventana, la reserva no dedupe un
 * reintento, CONDENA al mensaje. La primera versión hasheaba
 * tenant+actor+destinatario+operación+payload sobre un journal que no expira,
 * así que el segundo mensaje byte a byte idéntico quedaba bloqueado para
 * siempre — y el segundo menú, o el primer paso de la segunda factura del día,
 * son byte a byte idénticos al primero. El chat quedaba mudo, que es el peor
 * modo de falla de este proyecto.
 *
 *  · `sin_reserva`: lo conversacional. Un menú repetido no cuesta nada y
 *    bloquearlo cuesta todo. El reenvío de un evento entrante ya lo corta el
 *    replay del webhook (`kapso/webhookReplay.ts`), que es donde vive de
 *    verdad la duplicación de Meta.
 *  · `reintento`: lo que cuesta si sale dos veces —un documento, un reporte, un
 *    pedido de confirmación—. Un reintento por respuesta perdida ocurre en
 *    segundos; pasados los 15 minutos, un mensaje idéntico es un pedido nuevo.
 *  · `dia`: la cobranza. `claveRecordatorio` metía el día uruguayo en la clave
 *    justamente porque "dos mensajes de cobranza el mismo día empeoran la
 *    cobranza en vez de mejorarla". El reenvío deliberado
 *    (`permitir_reenvio=true`) viaja como otra operación y no pisa ese candado.
 */
export type VentanaSalida = "sin_reserva" | "reintento" | "dia";

/** Holgada para cualquier reintento real, corta para no dejar a nadie mudo. */
export const VENTANA_REINTENTO_MS = 15 * 60 * 1000;

const VENTANA_POR_OPERACION: Record<KapsoOutgoingOperation, VentanaSalida> = {
  // Conversacional: repetirlo es ruido; bloquearlo es un flujo trancado.
  menu: "sin_reserva",
  resolucion: "sin_reserva",
  paso_emision: "sin_reserva",
  // Genéricas: no sabemos qué llevan, así que se tratan como costosas.
  texto: "reintento",
  interactivo: "reintento",
  media: "reintento",
  documento: "reintento",
  reporte_diario: "reintento",
  confirmacion_emision: "reintento",
  confirmacion_anulacion: "reintento",
  // Cobranza: uno por día, como antes.
  recordatorio: "dia",
  // El reenvío es una decisión explícita del usuario: se le permite otro, pero
  // un reintento de ESE reenvío sigue sin duplicarse.
  recordatorio_reenvio: "reintento",
};

export function ventanaDe(operation: KapsoOutgoingOperation): VentanaSalida {
  return VENTANA_POR_OPERACION[operation];
}

/** Clave opaca, estable y separada del namespace fiscal. */
export function claveSalidaKapso(input: KapsoKeyInput, ventana = ""): string {
  const material = stableStringify({
    tenant: input.tenantId,
    actor: input.actorIdentity ?? "",
    destinatario: input.destinatario,
    operacion: input.operation,
    payload: input.payload,
    ventana,
  });
  return `kapso:v1:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export interface ClavesSalida {
  /** La que se reserva. */
  actual: string;
  /**
   * El tramo anterior, que solo se CONSULTA.
   *
   * Sin esto, un reintento que cae del otro lado del borde de los 15 minutos
   * estrena tramo y se manda igual — justo el caso que la reserva existe para
   * evitar. Consultar el anterior hace que la ventana efectiva sea de 15 a 30
   * minutos, y ninguna reserva vieja bloquea más que eso.
   */
  previa?: string;
}

/**
 * Las claves de una salida, o `null` si esa operación no se reserva.
 *
 * `ahora` entra por parámetro (no `Date.now()` adentro) por la razón de
 * siempre en este proyecto: un default de día civil calculado en UTC se rompe
 * en la ventana de 21:00 a 00:00 de Uruguay, y acá el día decide si sale o no
 * una cobranza.
 */
export function clavesSalidaKapso(input: KapsoKeyInput, ahora: number): ClavesSalida | null {
  const ventana = ventanaDe(input.operation);
  if (ventana === "sin_reserva") return null;
  if (ventana === "dia") {
    // EL TEXTO NO ENTRA EN LA CLAVE DEL DÍA, Y ES A PROPÓSITO.
    //
    // Se descarta el payload SIEMPRE, no solo cuando hay `sujeto`. Si dependiera
    // de que quien llama se acuerde de pasarlo, la garantía volvería a ser una
    // convención — y la convención ya falló una vez acá: la tool prometía "uno
    // por cliente por día" mientras la clave hasheaba el mensaje. Sin `sujeto`,
    // la identidad del envío es el destinatario (que ya está en el material) y
    // el día. Con `sujeto`, además el deudor concreto.
    const porSujeto: KapsoKeyInput = { ...input, payload: { sujeto: input.sujeto ?? "(destinatario)" } };
    return { actual: claveSalidaKapso(porSujeto, `dia:${hoyIsoUy(new Date(ahora))}`) };
  }
  const tramo = Math.floor(ahora / VENTANA_REINTENTO_MS);
  return {
    actual: claveSalidaKapso(input, `tramo:${tramo}`),
    previa: claveSalidaKapso(input, `tramo:${tramo - 1}`),
  };
}

/** Error seguro: la clave es un digest, nunca PII. */
export class KapsoIdempotencyError extends BillerError {
  constructor() {
    super(
      "idempotency",
        "La salida de WhatsApp ya está reservada, ejecutada o en estado incierto. " +
        "No se repitió para evitar entregar el mismo mensaje dos veces. Verificá el estado en Kapso " +
        "antes de intentar otra operación. Para un recordatorio deliberadamente repetido, usá " +
        "permitir_reenvio=true.",
    );
  }
}

/** Serverless no debe intentar una salida sin un store durable entre invocaciones. */
export class KapsoPersistenciaRequeridaError extends BillerError {
  constructor() {
    super(
      "readonly",
      "Salida de WhatsApp bloqueada en serverless: requiere persistencia durable de idempotencia. " +
        "Este entorno no puede garantizarla entre invocaciones; usá un proceso HTTP/stdio con disco " +
        "o un store durable dedicado.",
    );
  }
}

/** Store con nombre explícito para no confundirlo con la idempotencia fiscal. */
export type KapsoIdempotencyStore = IdempotencyStore;

export function crearKapsoIdempotencyStore(path: string | undefined): KapsoIdempotencyStore {
  return crearIdempotencyStore(path);
}
