// =============================================================================
// Autenticación del transporte HTTP.
//
// POR QUÉ UN TOKEN PROPIO Y NO EL DE BILLER:
// quien puede hablarle a este server puede leer toda la contabilidad de la
// empresa, pero NO debería poder hablarle a Biller directamente ni emitir
// comprobantes fuera de este server. Reusar `BILLER_API_TOKEN` como credencial
// de entrada significaría que cualquier integración a la que le dieras acceso
// al MCP tendría, de hecho, la llave de la API completa. Son dos permisos
// distintos y llevan dos credenciales distintas.
//
// El token se compara en TIEMPO CONSTANTE. Con `===`, el tiempo de respuesta
// varía según cuántos caracteres coinciden, lo que permite reconstruirlo byte a
// byte con suficientes intentos. Es un ataque conocido y la mitigación es de
// una línea, así que no hay motivo para no hacerla.
// =============================================================================

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Largo mínimo del token del transporte. 32 caracteres de entropía razonable
 * hacen inviable la fuerza bruta; menos que eso da falsa sensación de seguridad.
 */
export const MIN_HTTP_TOKEN_LENGTH = 32;

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

/** Comparación en tiempo constante, tolerante a largos distintos. */
export function compararSeguro(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual exige el mismo largo. Comparar los largos por separado
  // filtra el largo del token, que no es información sensible de por sí.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extrae el token de `Authorization: Bearer <token>`. null si no viene. */
export function extraerBearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const m = /^bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Valida la credencial de una request HTTP entrante.
 *
 * `tokenEsperado` undefined es un ERROR DE CONFIGURACIÓN, no "sin auth": se
 * rechaza todo. Un transporte HTTP que arranca sin token y acepta a cualquiera
 * es la falla que este módulo existe para prevenir.
 */
export function autenticar(req: IncomingMessage, tokenEsperado: string | undefined): AuthResult {
  if (tokenEsperado === undefined || tokenEsperado === "") {
    return {
      ok: false,
      status: 403,
      message:
        "El transporte HTTP no tiene BILLER_HTTP_AUTH_TOKEN configurado. Se rechazan todas las " +
        "solicitudes: un endpoint sin autenticación expone la contabilidad completa.",
    };
  }

  const presentado = extraerBearer(req.headers.authorization);
  if (presentado === null) {
    return {
      ok: false,
      status: 401,
      message: "Falta el header 'Authorization: Bearer <token>'.",
    };
  }

  if (!compararSeguro(presentado, tokenEsperado)) {
    return { ok: false, status: 401, message: "Token inválido." };
  }

  return { ok: true };
}

/**
 * Valida el token AL ARRANCAR, no en la primera request.
 * Devuelve la lista de problemas; vacía significa que se puede arrancar.
 */
export function validarTokenDeArranque(token: string | undefined): string[] {
  if (token === undefined || token === "") {
    return [
      "BILLER_HTTP_AUTH_TOKEN es obligatorio para el transporte HTTP. " +
        "Generá uno con: openssl rand -hex 32",
    ];
  }
  const problemas: string[] = [];
  if (token.length < MIN_HTTP_TOKEN_LENGTH) {
    problemas.push(
      `BILLER_HTTP_AUTH_TOKEN es demasiado corto (${token.length} caracteres, mínimo ` +
        `${MIN_HTTP_TOKEN_LENGTH}). Generá uno con: openssl rand -hex 32`,
    );
  }
  if (/^(test|token|secret|changeme|password|biller)/i.test(token)) {
    problemas.push(
      "BILLER_HTTP_AUTH_TOKEN parece un valor de ejemplo. Usá uno generado al azar: openssl rand -hex 32",
    );
  }
  return problemas;
}
