// =============================================================================
// La puerta: autenticar y, de paso, saber de qué empresa es la request.
//
// Es UNA sola decisión y no dos, y por eso vive en una sola función. Separarlas
// —"primero autenticá, después fijate el tenant"— es lo que abre la puerta a que
// alguien autenticado indique un tenant distinto del suyo. Acá el token
// autentica Y selecciona: no hay un segundo paso donde meterse.
//
// LAS DOS MODALIDADES SON EXCLUYENTES
//
// Con tenants configurados, el `BILLER_HTTP_AUTH_TOKEN` global deja de servir
// para entrar. Aceptar los dos obligaría a contestar "¿de qué empresa es una
// request con el token global?", y la única respuesta posible —la del proceso—
// es un tenant fantasma con la configuración de otro. Es mejor que ese token
// deje de funcionar, ruidosamente, a que funcione y devuelva los datos
// equivocados.
// =============================================================================

import type { IncomingMessage } from "node:http";
import { autenticar, extraerBearer, type AuthResult } from "../transport/httpAuth.js";
import { resolverTenant, type RegistroTenants, type Tenant } from "./registry.js";

export type AccesoResult =
  | { ok: true; tenant: Tenant | null }
  | { ok: false; status: 401 | 403; message: string };

/**
 * Valida la credencial y devuelve el tenant al que pertenece.
 *
 * `tenant: null` significa "modo de un solo tenant": no hay registro y la
 * configuración es la del proceso. Es el caso del server de escritorio y el de
 * cualquier despliegue de una sola empresa.
 */
export function autenticarConTenants(
  req: IncomingMessage,
  tokenGlobal: string | undefined,
  registro: RegistroTenants,
): AccesoResult {
  if (registro.tenants.length === 0) {
    const base: AuthResult = autenticar(req, tokenGlobal);
    return base.ok ? { ok: true, tenant: null } : base;
  }

  const presentado = extraerBearer(req.headers.authorization);
  if (presentado === null) {
    return {
      ok: false,
      status: 401,
      message: "Falta el header 'Authorization: Bearer <token>'.",
    };
  }

  const tenant = resolverTenant(registro, presentado);
  if (tenant === null) {
    // El mensaje NO dice si el token existe pero es de otra cosa, ni cuántos
    // tenants hay: eso es reconocimiento gratis para quien está probando.
    return { ok: false, status: 401, message: "Token inválido." };
  }

  return { ok: true, tenant };
}
