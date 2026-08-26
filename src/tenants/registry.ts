// =============================================================================
// Varias empresas en un mismo despliegue.
//
// EL PROBLEMA
//
// El token de Biller está atado a UNA empresa, y toda la configuración vive en
// variables de entorno. Replicar el producto significaba, hasta acá, un
// despliegue por cliente: su proceso, su `.env` de veinticinco variables, su
// número de Kapso, su túnel. Con tres empresas se aguanta; con veinte, cada
// cambio de código son veinte despliegues y cada error de configuración se
// descubre de a uno.
//
// LA IDEA: UN TENANT ES UN OVERLAY DE ENTORNO
//
// No hay un modelo de configuración nuevo. Un tenant es un puñado de variables
// que PISAN a las del proceso, y la config resultante se arma con el mismo
// `loadConfig` de siempre. Eso significa que toda validación, todo default y
// todo warning que ya existían siguen valiendo tal cual, y que agregar una
// variable al producto no obliga a tocar este archivo.
//
// QUIÉN ELIGE EL TENANT: LA CREDENCIAL, Y NADA MÁS
//
// El tenant se resuelve por el token del `Authorization: Bearer`, no por un
// header aparte ni por el teléfono de quien escribe.
//
// La alternativa "header `X-Biller-Tenant`" es la que sale sola y es la
// equivocada: con un token compartido, cualquiera que pueda hablarle al server
// cambia de empresa cambiando un header, y la contabilidad de un cliente queda
// a un string de distancia de la de otro. Y el teléfono tampoco sirve: llega
// como parámetro de tool, o sea elegido por el modelo, que es exactamente la
// superficie de la que no puede depender un límite de aislamiento.
//
// Con el token como selector, no hay nada que validar: el que no tiene la
// credencial de una empresa no puede nombrarla.
//
// SIN TENANTS CONFIGURADOS NO CAMBIA NADA
//
// `BILLER_TENANTS_JSON` vacío = el comportamiento de siempre, un tenant
// implícito tomado del entorno del proceso. Es el modo en que corre el server de
// escritorio y no tiene por qué enterarse de que esto existe.
// =============================================================================

import { readFileSync } from "node:fs";
import { compararSeguro } from "../transport/httpAuth.js";

export interface Tenant {
  /** Id corto y estable. Va en los logs; NO es un secreto. */
  id: string;
  /** Nombre legible de la empresa, para diagnóstico. */
  nombre: string;
  /**
   * Variables que pisan a las del proceso para este tenant.
   * Se aplican sobre `process.env` y el resultado va a `loadConfig`.
   */
  env: Record<string, string>;
}

/** Lo que se define por tenant en el JSON. Todo opcional salvo id y token. */
interface TenantCrudo {
  id?: unknown;
  nombre?: unknown;
  /** El bearer que identifica a este tenant. Es su credencial Y su selector. */
  auth_token?: unknown;
  /** Cualquier variable de entorno (BILLER_…, KAPSO_…) que este tenant pise. */
  env?: unknown;
}

export class TenantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantConfigError";
  }
}

/**
 * Largo mínimo del token de un tenant. Igual que el del transporte: es la misma
 * credencial cumpliendo la misma función, más la de aislar una empresa de otra.
 */
export const MIN_TENANT_TOKEN_LENGTH = 32;

export interface RegistroTenants {
  /** Los tenants, por id. Vacío = modo de un solo tenant (el del proceso). */
  tenants: Tenant[];
  /** Token -> tenant. No se expone: es el índice de resolución. */
  porToken: Map<string, Tenant>;
}

/**
 * Lee el registro desde el entorno.
 *
 * Acepta el JSON inline (`BILLER_TENANTS_JSON`) o un archivo
 * (`BILLER_TENANTS_PATH`). El archivo es lo razonable apenas hay más de dos
 * empresas: un JSON con veinte tokens adentro de una variable de entorno es
 * imposible de revisar y termina copiado a mano con un token de menos.
 *
 * A diferencia de casi todo el resto de la configuración, esto NO es tolerante:
 * un JSON mal formado tira. Un registro de tenants que se degrada en silencio a
 * "cero tenants" convierte un error de tipeo en "todas las empresas dejaron de
 * responder", o peor, en que todas caigan al tenant implícito del proceso —
 * o sea, todas leyendo la contabilidad de la misma.
 */
export function cargarTenants(env: Record<string, string | undefined> = process.env): RegistroTenants {
  const inline = (env.BILLER_TENANTS_JSON ?? "").trim();
  const ruta = (env.BILLER_TENANTS_PATH ?? "").trim();

  if (inline === "" && ruta === "") return { tenants: [], porToken: new Map() };
  if (inline !== "" && ruta !== "") {
    throw new TenantConfigError(
      "BILLER_TENANTS_JSON y BILLER_TENANTS_PATH están las dos configuradas y definen cosas " +
        "distintas. Dejá una sola: con las dos, cuál gana es una decisión que nadie escribió.",
    );
  }

  let texto: string;
  if (inline !== "") {
    texto = inline;
  } else {
    try {
      texto = readFileSync(ruta, "utf8");
    } catch (err) {
      throw new TenantConfigError(
        `No se pudo leer BILLER_TENANTS_PATH ("${ruta}"): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(texto);
  } catch (err) {
    throw new TenantConfigError(
      `El registro de tenants no es JSON válido: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return construirRegistro(parsed);
}

/** Valida y arma el registro. Separado de la lectura para poder testearlo. */
export function construirRegistro(parsed: unknown): RegistroTenants {
  if (!Array.isArray(parsed)) {
    throw new TenantConfigError(
      'El registro de tenants tiene que ser un ARRAY de objetos: [{"id":"…","auth_token":"…","env":{…}}].',
    );
  }

  const tenants: Tenant[] = [];
  const porToken = new Map<string, Tenant>();
  const idsVistos = new Set<string>();

  parsed.forEach((crudoRaw, i) => {
    const crudo = (crudoRaw ?? {}) as TenantCrudo;
    const id = typeof crudo.id === "string" ? crudo.id.trim() : "";
    if (id === "") {
      throw new TenantConfigError(`El tenant #${i + 1} no tiene 'id'. El id va en los logs y no es un secreto.`);
    }
    if (idsVistos.has(id)) {
      throw new TenantConfigError(`Hay dos tenants con id "${id}". Los ids tienen que ser únicos.`);
    }
    idsVistos.add(id);

    const token = typeof crudo.auth_token === "string" ? crudo.auth_token.trim() : "";
    if (token === "") {
      throw new TenantConfigError(
        `El tenant "${id}" no tiene 'auth_token'. Es su credencial Y lo que lo identifica: sin token ` +
          "no hay forma de dirigirle una request. Generá uno con: openssl rand -hex 32",
      );
    }
    if (token.length < MIN_TENANT_TOKEN_LENGTH) {
      throw new TenantConfigError(
        `El 'auth_token' del tenant "${id}" tiene ${token.length} caracteres (mínimo ` +
          `${MIN_TENANT_TOKEN_LENGTH}). Este token es lo único que separa la contabilidad de una ` +
          "empresa de la de otra. Generá uno con: openssl rand -hex 32",
      );
    }
    if (porToken.has(token)) {
      throw new TenantConfigError(
        `Dos tenants comparten el mismo 'auth_token' ("${id}" y "${porToken.get(token)!.id}"). ` +
          "Con un token compartido, las dos empresas ven los datos de una sola.",
      );
    }

    const envCrudo = (crudo.env ?? {}) as Record<string, unknown>;
    if (typeof envCrudo !== "object" || envCrudo === null || Array.isArray(envCrudo)) {
      throw new TenantConfigError(`El 'env' del tenant "${id}" tiene que ser un objeto de variables.`);
    }
    const envTenant: Record<string, string> = {};
    for (const [k, v] of Object.entries(envCrudo)) {
      if (typeof v === "string") envTenant[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") envTenant[k] = String(v);
    }
    if ((envTenant.BILLER_API_TOKEN ?? "").trim() === "") {
      throw new TenantConfigError(
        `El tenant "${id}" no define BILLER_API_TOKEN en su 'env'. El token de Biller está atado a ` +
          "una empresa: sin uno propio, este tenant leería la contabilidad de la empresa del proceso.",
      );
    }

    const tenant: Tenant = {
      id,
      nombre: typeof crudo.nombre === "string" && crudo.nombre.trim() !== "" ? crudo.nombre.trim() : id,
      env: envTenant,
    };
    tenants.push(tenant);
    porToken.set(token, tenant);
  });

  return { tenants, porToken };
}

/**
 * Qué tenant corresponde a un bearer.
 *
 * La comparación es en TIEMPO CONSTANTE contra todos los tokens, y no un
 * `Map.get`. Un lookup de hash filtra por timing cuál es el prefijo correcto y
 * permite reconstruir un token válido intento a intento — que acá no es "entrar
 * al server" sino "entrar a la contabilidad de una empresa concreta".
 *
 * Se recorren TODOS los tenants aunque haya coincidencia, para que el tiempo de
 * respuesta no diga en qué posición del registro está el token que acertaste.
 */
export function resolverTenant(registro: RegistroTenants, token: string | null): Tenant | null {
  if (token === null || token === "") return null;
  let encontrado: Tenant | null = null;
  for (const [tokenTenant, tenant] of registro.porToken) {
    if (compararSeguro(token, tokenTenant)) encontrado = tenant;
  }
  return encontrado;
}

/**
 * El entorno efectivo de un tenant: el del proceso con su overlay encima.
 *
 * El overlay pisa, no completa: si el tenant define `BILLER_API_TOKEN`, el del
 * proceso no se usa ni como fallback. Eso es lo que hace que un tenant mal
 * configurado falle en vez de leer los datos de otra empresa — el modo de falla
 * silencioso que más caro sale acá.
 */
export function entornoDe(
  tenant: Tenant,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...base, ...tenant.env };
}
