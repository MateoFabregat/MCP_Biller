// =============================================================================
// Token de confirmación (human-in-the-loop).
//
// Flujo:
//   1. dry-run   -> se devuelve el `confirmation_token` junto al preview.
//   2. ejecución -> el caller reenvía confirm=true + ese token.
//
// El token liga la ejecución al payload EXACTO que se previsualizó: si cambia
// cualquier campo, deja de coincidir y la ejecución se rechaza.
//
// EL TOKEN NO ES UN SECRETO. Cualquiera con el payload puede recalcularlo — no
// hay clave. Es un binding de INTENCIÓN, no una credencial: existe para que no
// se ejecute algo distinto de lo que el humano leyó.
//
// TTL (PLAN_V2 §5.4). Sin vencimiento, un token emitido a las 9 AM sigue siendo
// válido a las 6 PM. En ese lapso el contexto cambió: cotizaciones, stock,
// numeración, o simplemente el usuario ya no se acuerda de qué aprobó. Un
// preview viejo confirmado a ciegas es justamente lo que el human-in-the-loop
// tiene que evitar, así que el token lleva su fecha de emisión FIRMADA dentro
// del hash — mover el timestamp invalida el token.
//
// Formato:  <issuedAtMs>.<sha256>
// =============================================================================

import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stableStringify.js";

// Se re-exporta porque los tests y la capa de escritura la consumían desde acá.
export { stableStringify };

/** Vida útil del token de confirmación. */
export const CONFIRMATION_TTL_MS = 15 * 60 * 1000; // 15 minutos

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashCon(
  endpoint: string,
  environment: string,
  payload: unknown,
  issuedAt: number,
): string {
  return createHash("sha256")
    .update(stableStringify({ endpoint, environment, payload, issuedAt }))
    .digest("hex");
}

/** `ahora` se inyecta para poder testear el vencimiento sin esperar. */
export function computeConfirmationToken(
  endpoint: string,
  environment: string,
  payload: unknown,
  ahora: number = Date.now(),
): string {
  return `${ahora}.${hashCon(endpoint, environment, payload, ahora)}`;
}

export type ConfirmationCheck =
  | { ok: true }
  | { ok: false; motivo: "ausente" | "formato" | "no_coincide" | "vencido"; mensaje: string };

/**
 * Verifica el token y devuelve POR QUÉ falla.
 *
 * La distinción importa: "vencido" se resuelve repitiendo el dry-run, mientras
 * que "no coincide" significa que el payload cambió respecto de lo previsualizado
 * — que es un problema muy distinto y hay que decirlo con esas palabras.
 */
export function checkConfirmationToken(
  provided: string | undefined,
  endpoint: string,
  environment: string,
  payload: unknown,
  opciones: { ahora?: number; ttlMs?: number } = {},
): ConfirmationCheck {
  const ahora = opciones.ahora ?? Date.now();
  const ttl = opciones.ttlMs ?? CONFIRMATION_TTL_MS;

  if (!provided || provided.trim() === "") {
    return {
      ok: false,
      motivo: "ausente",
      mensaje:
        "Falta el confirmation_token. Ejecutá primero la operación en modo dry-run, mostrale el " +
        "preview al usuario, y recién con su aprobación reenviá confirm=true con el token devuelto.",
    };
  }

  const partes = provided.trim().split(".");
  if (partes.length !== 2) {
    return {
      ok: false,
      motivo: "formato",
      mensaje:
        "El confirmation_token no tiene el formato esperado (<timestamp>.<hash>). " +
        "Usá el valor tal cual lo devolvió el dry-run, sin modificarlo.",
    };
  }

  const issuedAt = Number(partes[0]);
  if (!Number.isFinite(issuedAt)) {
    return { ok: false, motivo: "formato", mensaje: "El confirmation_token tiene un timestamp inválido." };
  }

  const esperado = hashCon(endpoint, environment, payload, issuedAt);
  if (partes[1]!.toLowerCase() !== esperado) {
    return {
      ok: false,
      motivo: "no_coincide",
      mensaje:
        "El confirmation_token no corresponde a esta operación: el payload cambió respecto del que " +
        "se previsualizó. NO se ejecuta. Volvé a hacer el dry-run con los datos actuales y pedile " +
        "al usuario que revise el preview nuevo.",
    };
  }

  const edadMs = ahora - issuedAt;
  if (edadMs > ttl) {
    const minutos = Math.round(edadMs / 60_000);
    return {
      ok: false,
      motivo: "vencido",
      mensaje:
        `El confirmation_token venció: se emitió hace ${minutos} minuto(s) y la ventana es de ` +
        `${Math.round(ttl / 60_000)}. Repetí el dry-run y confirmá sobre el preview nuevo — ` +
        "ejecutar algo aprobado hace rato, sin volver a mirarlo, es lo que esta barrera evita.",
    };
  }

  // Un token del futuro indica reloj desincronizado o manipulación: se rechaza.
  if (edadMs < -60_000) {
    return {
      ok: false,
      motivo: "formato",
      mensaje: "El confirmation_token está fechado en el futuro. Repetí el dry-run.",
    };
  }

  return { ok: true };
}

/** Compatibilidad con el chequeo booleano previo. */
export function verifyConfirmationToken(
  provided: string | undefined,
  endpoint: string,
  environment: string,
  payload: unknown,
  opciones: { ahora?: number; ttlMs?: number } = {},
): boolean {
  return checkConfirmationToken(provided, endpoint, environment, payload, opciones).ok;
}
