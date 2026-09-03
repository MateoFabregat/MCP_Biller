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
}

/** Clave opaca, estable y separada del namespace fiscal. */
export function claveSalidaKapso(input: KapsoKeyInput): string {
  const material = stableStringify({
    tenant: input.tenantId,
    actor: input.actorIdentity ?? "",
    destinatario: input.destinatario,
    operacion: input.operation,
    payload: input.payload,
  });
  return `kapso:v1:${createHash("sha256").update(material, "utf8").digest("hex")}`;
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
