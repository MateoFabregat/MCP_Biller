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
// DE QUIÉN ES EL TOKEN (identidad). Hasta acá el material hasheado era
// {endpoint, environment, payload, issuedAt}: nada de quién lo pidió. Con dos
// números autorizados en la misma empresa —el dueño y el contador, que es el
// caso normal— el token que A recibía en su dry-run lo podía confirmar B: el
// payload estaba congelado, así que B no podía cambiar el CONTENIDO, pero sí
// disparar la EMISIÓN de A. Ante DGI eso sale como un documento fiscal con
// numeración real, y no se deshace: se anula con otro documento. Por eso la
// identidad entra al hash, y el confirm lo recalcula con la identidad de ESA
// llamada.
//
// La identidad que entra acá NO es el teléfono: es la clave opaca y salada del
// store de borradores (`BorradorStore.clave`). El token viaja por el modelo y
// queda escrito en transcripciones; un número de teléfono adentro sería un dato
// personal más circulando, y para lo único que lo necesitamos —comparar— la
// clave opaca sirve igual.
//
// Sin Kapso configurado no hay canal no confiable (es el server de escritorio,
// donde quien lo abre ya es el dueño de la máquina): la identidad es `null` y el
// ciclo valida exactamente como antes.
//
// Formato:  <issuedAtMs>.<huellaIdentidad>.<sha256>
//
// La huella existe SOLO para diagnosticar. Sin ella, un confirm ajeno y un
// payload cambiado dan el mismo "el hash no coincide", y son dos problemas
// distintos: uno se arregla repitiendo el dry-run, el otro es alguien
// confirmando lo que no es suyo y hay que decírselo con esas palabras. No es la
// barrera —la barrera es que la identidad está DENTRO del hash—, así que
// falsificar la huella no habilita nada: el hash sigue sin cerrar.
//
// COMPATIBILIDAD: un token de dos partes (emitido antes de este cambio) ya no
// valida. Se decidió no aceptarlo: el TTL es de 15 minutos y el token pertenece
// a una conversación en curso, así que el costo máximo es que alguien que estaba
// justo en el medio de un confirm rehaga el dry-run — contra el costo de dejar
// abierta, por una ventana de un cuarto de hora, la puerta que este cambio
// cierra.
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
  identidad: string | null,
): string {
  return createHash("sha256")
    .update(stableStringify({ endpoint, environment, payload, issuedAt, identidad }))
    .digest("hex");
}

/**
 * Huella de la identidad, para poder DECIR "esto es de otro" en vez de "el
 * payload cambió". La identidad ya llega opaca y salada; esto la acorta.
 */
function huellaIdentidad(identidad: string | null): string {
  return createHash("sha256").update(`huella:${identidad ?? ""}`).digest("hex").slice(0, 16);
}

/**
 * `ahora` se inyecta para poder testear el vencimiento sin esperar.
 * `identidad` es null cuando no hay canal no confiable (Claude Desktop/stdio).
 */
export function computeConfirmationToken(
  endpoint: string,
  environment: string,
  payload: unknown,
  ahora: number = Date.now(),
  identidad: string | null = null,
): string {
  return `${ahora}.${huellaIdentidad(identidad)}.${hashCon(endpoint, environment, payload, ahora, identidad)}`;
}

export type ConfirmationCheck =
  | { ok: true }
  | {
      ok: false;
      motivo: "ausente" | "formato" | "no_coincide" | "vencido" | "sesion_ajena";
      mensaje: string;
    };

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
  opciones: { ahora?: number; ttlMs?: number; identidad?: string | null } = {},
): ConfirmationCheck {
  const ahora = opciones.ahora ?? Date.now();
  const ttl = opciones.ttlMs ?? CONFIRMATION_TTL_MS;
  const identidad = opciones.identidad ?? null;

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
  if (partes.length !== 3) {
    return {
      ok: false,
      motivo: "formato",
      mensaje:
        "El confirmation_token no tiene el formato esperado (<timestamp>.<huella>.<hash>). " +
        "Usá el valor tal cual lo devolvió el dry-run, sin modificarlo. Si lo tenías de antes, " +
        "repetí el dry-run: el formato cambió y los tokens viejos no valen más.",
    };
  }

  const issuedAt = Number(partes[0]);
  if (!Number.isFinite(issuedAt)) {
    return { ok: false, motivo: "formato", mensaje: "El confirmation_token tiene un timestamp inválido." };
  }

  // DE OTRA CONVERSACIÓN. Va antes que el hash y antes que el TTL porque es el
  // diagnóstico más específico de los tres: un token ajeno también "no coincide"
  // y también puede estar vencido, y contestar eso manda a repetir el dry-run —
  // que es exactamente lo que NO queremos que haga quien está por confirmar la
  // emisión de otro.
  //
  // El mensaje no nombra a nadie: no tenemos el número del otro (la identidad
  // que entra acá es una clave opaca) y no habría que decirlo aunque lo
  // tuviéramos, porque quien recibe este error es justamente el que no es dueño
  // de ese token.
  if (partes[1]!.toLowerCase() !== huellaIdentidad(identidad)) {
    return {
      ok: false,
      motivo: "sesion_ajena",
      mensaje:
        "Ese confirmation_token lo emitió el dry-run de OTRA conversación, no de esta. NO se " +
        "ejecuta: una emisión la confirma quien la previsualizó, aunque las dos personas estén " +
        "autorizadas en la misma empresa — si no, alcanza con reenviar el token del otro para " +
        "que se emita un comprobante real a su nombre. NO reintentes con otro token ni busques " +
        "otra tool que haga lo mismo. Hacé vos el dry-run de esta operación, mostrale el preview " +
        "al usuario y confirmá con el token que devuelva. Si la persona quiere aprobar algo que " +
        "armó otro, contestale que cada uno confirma lo suyo.",
    };
  }

  const esperado = hashCon(endpoint, environment, payload, issuedAt, identidad);
  if (partes[2]!.toLowerCase() !== esperado) {
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
  opciones: { ahora?: number; ttlMs?: number; identidad?: string | null } = {},
): boolean {
  return checkConfirmationToken(provided, endpoint, environment, payload, opciones).ok;
}
