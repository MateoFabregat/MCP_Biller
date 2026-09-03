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
//
// LO QUE UN TENANT NO DECLARA: HERENCIA POR DEFECTO, Y POR QUÉ NO ALCANZA
//
// El overlay resuelve lo que el tenant SÍ declara. El agujero está en lo que no
// declara: hasta acá lo heredaba en silencio del proceso, y ese silencio no era
// neutral. `KAPSO_API_KEY` heredada manda los mensajes de la empresa B por la
// cuenta de WhatsApp de la A, y el operador de esa cuenta lee las conversaciones
// de un cliente que no es suyo. `KAPSO_DESTINATARIOS_PERMITIDOS` heredada deja
// la ÚNICA barrera de egreso (`kapso/client.ts`) apuntando a los teléfonos de
// otra empresa — una inyección de prompt en la adenda de una factura recibida
// tiene ahí una ruta de exfiltración con destino ya autorizado.
// `BILLER_REMITENTES_AUTORIZADOS` heredada hace valer la allowlist de consulta
// de A para B. Y `BILLER_CAPABILITY_MODE` o `BILLER_ALLOW_PRODUCTION_WRITES`
// heredadas le regalan a una empresa el permiso de emitir en producción que
// alguien habilitó para otra.
//
// El criterio, entonces, es al revés del natural: lo sensible NO se hereda. El
// overlay lo BORRA del entorno base salvo que el tenant lo declare
// (`VARIABLES_QUE_NO_SE_HEREDAN`). Se eligió borrar y no "exigir que lo declare"
// porque borrar hace el error IMPOSIBLE en vez de detectable: no hay orden de
// carga, variable olvidada en el systemd de producción ni tenant agregado
// apurado a las siete de la tarde que pueda reintroducirlo. Y no rompe
// despliegues legítimos porque el default de cada una de esas variables es el
// seguro: sin capability mode se queda en `read_only`, sin allowlist de Kapso no
// sale ningún mensaje. El que borra falla ruidoso hacia el lado correcto.
//
// La excepción son las variables donde BORRAR DEJA PEOR que heredar
// (`RUTAS_DE_PERSISTENCIA` y los `BILLER_MAX_MONTO_*`): los topes de monto y las
// rutas de persistencia. Sin `BILLER_MAX_MONTO_UYU` no hay tope ninguno, y sin
// `BILLER_AUDIT_LOG_PATH` no hay rastro fiscal de lo que se emitió. Ahí borrar
// sería fallar hacia el lado abierto, así que la regla es la otra: si el proceso
// las tiene y el tenant no las declara, es error fatal. Que el operador elija,
// pero explícito y por empresa.
//
// Salvo que haya de dónde derivar: con `BILLER_DATA_DIR` configurado, las tres
// rutas salen de `<data_dir>/<id del tenant>/…` y vuelven al régimen de las
// sensibles —se borran si el tenant no las declara, para que la derivación
// corra—. La fatalidad existía porque no había una tercera opción; con un
// directorio base y un id único por construcción, el caso correcto sale solo y
// compartir archivo pasa de detectable a imposible. La declaración explícita
// sigue ganando, y la validación de duplicados sigue valiendo para ella.
//
// Lo que SÍ se hereda es lo que no distingue una empresa de otra —
// `BILLER_API_BASE_URL`, timeouts, el puerto HTTP—: son el despliegue, no el
// cliente, y obligar a repetirlos veinte veces solo agrega veinte lugares donde
// equivocarse.
//
// DOS TENANTS NO PUEDEN COMPARTIR NI EL TOKEN DE BILLER NI UN ARCHIVO
//
// El registro rechazaba `auth_token` duplicados pero no `BILLER_API_TOKEN`
// duplicados, que es peor: mismo token de Biller ⇒ mismo `cacheId` (sha256 de
// baseUrl+token, `biller/client.ts`) ⇒ misma sal y mismo espacio de nombres del
// BorradorStore, o sea que el `sesion.id` del tenant A resuelve contra el
// borrador del tenant B. Y como las idempotencias sí quedan separadas, un
// reintento que entre por el otro token no lo frena nadie: emisión duplicada
// ante DGI, que se arregla con una nota de crédito y no con un rollback.
// Lo mismo vale para las rutas: dos tenants apuntando al mismo archivo de audit
// o de idempotencia son veinte empresas en un solo libro.
// =============================================================================

import { readFileSync } from "node:fs";
import { resolve as resolverRuta } from "node:path";
import { rutasDerivadasDe } from "../config.js";
import { compararSeguro } from "../transport/httpAuth.js";

export interface Tenant {
  /** Id corto y estable. Va en los logs; NO es un secreto. */
  id: string;
  /** Nombre legible de la empresa, para diagnóstico. */
  nombre: string;
  /**
   * Variables que pisan a las del proceso para este tenant.
   * Se aplican sobre `process.env` y el resultado va a `loadConfig`.
   *
   * Un valor `undefined` NO es "no está": es un BORRADO explícito. Es lo que
   * hace que las variables sensibles que el tenant no declaró no se hereden del
   * proceso — la clave existe en el overlay, con valor vacío, y pisa igual.
   */
  env: Record<string, string | undefined>;
}

/**
 * Lo que un tenant no hereda del proceso ni aunque el proceso lo tenga.
 *
 * Criterio de la lista: entra todo lo que identifica a UNA empresa o gobierna
 * una barrera de seguridad. Queda afuera lo que describe al despliegue
 * (base URL, timeouts, puerto), que compartir es correcto y repetir es peor.
 *
 * El default de cada una de estas es el seguro, y por eso borrar se puede: sin
 * `KAPSO_API_KEY` no sale ningún mensaje, sin allowlist no se contesta a nadie,
 * sin `BILLER_CAPABILITY_MODE` el server queda en `read_only`.
 */
export const VARIABLES_QUE_NO_SE_HEREDAN: readonly string[] = [
  // La cuenta de WhatsApp por la que sale todo, y las dos allowlists que
  // deciden a quién se le contesta y a quién se le manda un documento fiscal.
  "KAPSO_API_KEY",
  "KAPSO_PHONE_NUMBER_ID",
  "KAPSO_DESTINATARIOS_PERMITIDOS",
  "KAPSO_WEBHOOK_SECRET",
  "BILLER_REMITENTES_AUTORIZADOS",
  // El permiso de emitir. Heredarlo es que una empresa emita en producción
  // porque otra lo tenía habilitado.
  "BILLER_CAPABILITY_MODE",
  "BILLER_WRITE_ENABLED",
  "BILLER_ALLOW_PRODUCTION_WRITES",
  // La clave firma approvals de UNA empresa; heredarla permitiría que un token
  // emitido en un tenant se autentique con material compartido por accidente.
  "BILLER_APPROVAL_SECRET",
  // La identidad fiscal: heredarla mete el RUT o la sucursal de otra empresa
  // adentro de un CFE.
  "BILLER_DEFAULT_EMPRESA_RUT",
  "BILLER_DEFAULT_SUCURSAL_ID",
  "BILLER_SUCURSALES_JSON",
];

/**
 * Las rutas de persistencia, y las dos reglas distintas que las gobiernan según
 * haya o no `BILLER_DATA_DIR`.
 *
 * El problema de fondo no cambió: borrarlas afloja —sin ruta de audit no queda
 * rastro de lo emitido— y heredarlas mezcla el audit fiscal y la idempotencia de
 * veinte empresas en el mismo archivo. Lo que cambió es que ahora hay una
 * tercera salida que no existía.
 *
 * CON `BILLER_DATA_DIR`: el overlay las BORRA cuando el tenant no las declara,
 * igual que a las sensibles, y `config.ts` las deriva a `<data_dir>/<id>/…`. Ese
 * borrado es imprescindible y no una prolijidad: sin él, un proceso que además
 * defina `BILLER_AUDIT_LOG_PATH` se lo heredaría a todos los tenants que no
 * declaran la suya —la derivación nunca correría, porque la explícita gana— y
 * las veinte empresas volverían al mismo archivo por la puerta de atrás. Con el
 * id adentro de la ruta, dos empresas compartiendo archivo pasa de detectable a
 * imposible: el id es único por construcción y se valida más abajo.
 *
 * SIN `BILLER_DATA_DIR`: la regla vieja, tal cual. Si el proceso las define y el
 * tenant no declara la suya, el registro no arranca. No hay de dónde derivar,
 * así que la única salida honesta sigue siendo que el operador la escriba.
 *
 * En los dos casos, dos tenants no pueden terminar en el mismo archivo: las
 * declaradas a mano se comparan entre sí Y contra las derivadas de los demás.
 */
export const RUTAS_DE_PERSISTENCIA: readonly string[] = [
  "BILLER_AUDIT_LOG_PATH",
  "BILLER_IDEMPOTENCY_LOG_PATH",
  "BILLER_BORRADOR_STORE_PATH",
  "KAPSO_IDEMPOTENCY_LOG_PATH",
  "BILLER_WEBHOOK_REPLAY_LOG_PATH",
];

/** Los topes de monto son `BILLER_MAX_MONTO_<MONEDA>`: la lista no se puede fijar de antemano. */
const PREFIJO_TOPES = "BILLER_MAX_MONTO_";

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
  /**
   * `phone_number_id` del número receptor -> tenant. Es el selector del WEBHOOK.
   *
   * Es la contraparte de `porToken` para la puerta que NO tiene bearer: al
   * webhook lo llama Kapso, no un cliente MCP, así que su credencial es la firma
   * HMAC y no hay token del que sacar la empresa. El `phone_number_id` sirve
   * como selector por la misma razón que el bearer: es un hecho de
   * infraestructura y no un parámetro. Quien escribe elige a qué número mandar
   * el mensaje, pero no puede falsificar en qué número lo recibió Meta, y el
   * dato viene ADENTRO del cuerpo firmado.
   *
   * Acá sí es un `Map.get` común, a diferencia de `resolverTenant`: conocer un
   * `phone_number_id` no habilita nada sin la firma, así que no hay secreto que
   * un canal de tiempo pueda filtrar.
   */
  porPhoneNumberId: Map<string, Tenant>;
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

  if (inline === "" && ruta === "") return { tenants: [], porToken: new Map(), porPhoneNumberId: new Map() };
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

  return construirRegistro(parsed, env);
}

/**
 * Valida y arma el registro. Separado de la lectura para poder testearlo.
 *
 * `base` es el entorno del proceso, y hace falta acá —no solo en `entornoDe`—
 * porque hay reglas que dependen de lo que el proceso tiene: los topes de monto
 * y las rutas de persistencia no se pueden heredar ni borrar, así que si el
 * proceso las define, cada tenant tiene que decir la suya.
 */
export function construirRegistro(
  parsed: unknown,
  base: Record<string, string | undefined> = process.env,
): RegistroTenants {
  if (!Array.isArray(parsed)) {
    throw new TenantConfigError(
      'El registro de tenants tiene que ser un ARRAY de objetos: [{"id":"…","auth_token":"…","env":{…}}].',
    );
  }

  const tenants: Tenant[] = [];
  const porToken = new Map<string, Tenant>();
  const porPhoneNumberId = new Map<string, Tenant>();
  const idsVistos = new Set<string>();
  /** Token de Biller -> id del tenant que ya lo usó. Ver el bloque de abajo. */
  const porApiToken = new Map<string, string>();
  /** Ruta absoluta -> quién la declaró y en qué variable. */
  const porRuta = new Map<string, { tenant: string; variable: string }>();
  /** Los topes que el proceso trae puestos, si los trae. */
  const topesDelProceso = Object.keys(base).filter(
    (k) => k.startsWith(PREFIJO_TOPES) && (base[k] ?? "").trim() !== "",
  );

  parsed.forEach((crudoRaw, i) => {
    const crudo = (crudoRaw ?? {}) as TenantCrudo;
    const id = typeof crudo.id === "string" ? crudo.id.trim() : "";
    if (id === "") {
      throw new TenantConfigError(`El tenant #${i + 1} no tiene 'id'. El id va en los logs y no es un secreto.`);
    }
    // El id dejó de ser solo una etiqueta de log: con `BILLER_DATA_DIR` es un
    // COMPONENTE DE RUTA, y ahí un id con `/` o `..` sale del directorio de
    // datos y se lleva puesto el archivo de otra empresa —o cualquier archivo
    // del disco—. Se valida el charset en vez de sanitizar porque sanitizar
    // COLAPSA: "a/b" y "a-b" se vuelven el mismo directorio, y dos ids distintos
    // compartiendo archivo es exactamente lo que esto tiene que hacer imposible.
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      throw new TenantConfigError(
        `El id del tenant "${id}" tiene caracteres que no son letras, dígitos o guion. El id es un ` +
          "componente de ruta (BILLER_DATA_DIR deriva <data_dir>/<id>/audit.jsonl), así que una " +
          "barra o un punto lo sacan de su directorio. Usá algo como \"panaderia-rivera\".",
      );
    }
    // De yapa, el charset deja afuera el `_` inicial de `TENANT_IMPLICITO`
    // ("_proceso"): ningún tenant puede llamarse como la empresa del proceso y
    // quedarse con su directorio de datos.
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
    const envTenant: Record<string, string | undefined> = {};
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

    // El token de Biller repetido es el error más caro que se puede cometer acá,
    // y el más fácil: es un copy-paste de la entrada de arriba con el id
    // cambiado. No se nota nunca —los dos tenants andan— hasta el día que el
    // `sesion.id` de uno resuelve contra el borrador del otro, porque el
    // `cacheId` del cliente es sha256(baseUrl+token) y con el mismo token es el
    // mismo: misma sal, mismo espacio de nombres del BorradorStore. Peor todavía
    // con la idempotencia, que SÍ queda separada por tenant: un reintento que
    // entra por el otro token no lo frena nadie y sale un CFE duplicado ante
    // DGI, que después se corrige con una nota de crédito y su propia
    // numeración. Dos empresas distintas no comparten token de Biller: si lo
    // comparten, no son dos empresas, es una sola con dos entradas.
    const apiToken = (envTenant.BILLER_API_TOKEN ?? "").trim();
    const duenoPrevio = porApiToken.get(apiToken);
    if (duenoPrevio !== undefined) {
      throw new TenantConfigError(
        `Los tenants "${duenoPrevio}" y "${id}" tienen el MISMO BILLER_API_TOKEN. Ese token es la ` +
          "empresa: con el mismo, los dos comparten el espacio de borradores (el id de sesión de uno " +
          "resuelve contra el borrador del otro) y NO comparten la idempotencia, así que un reintento " +
          "que entre por el otro token emite un comprobante duplicado ante DGI. Si son dos empresas, " +
          "cada una tiene su token en Biller; si es una sola, dejá un solo tenant.",
      );
    }
    porApiToken.set(apiToken, id);

    // EL NÚMERO DE WHATSAPP REPETIDO: mismo filo que el token de Biller, otra
    // puerta. El `phone_number_id` es el selector del webhook —lo único que dice
    // a qué empresa le escribieron— y es igual de fácil de duplicar: se copia la
    // entrada de arriba y se cambia el id. Con dos empresas declarando el mismo
    // número, "de quién es este mensaje" deja de tener respuesta: los mensajes de
    // una caen en la contabilidad de la otra, con su allowlist de remitentes, su
    // capability mode y su borrador. Se valida al arrancar por la misma razón que
    // el token: es el error que no se nota nunca hasta que ya pasó.
    const phoneNumberId = (envTenant.KAPSO_PHONE_NUMBER_ID ?? "").trim();
    if (phoneNumberId !== "") {
      const previoPhone = porPhoneNumberId.get(phoneNumberId);
      if (previoPhone !== undefined) {
        throw new TenantConfigError(
          `Los tenants "${previoPhone.id}" y "${id}" declaran el MISMO KAPSO_PHONE_NUMBER_ID ` +
            `("${phoneNumberId}"). Ese id es a qué número de WhatsApp le escribieron, y es lo único ` +
            "con lo que el webhook decide de qué empresa es un mensaje entrante: compartido, los " +
            "mensajes de una empresa se atienden con la allowlist, el permiso de emitir y los " +
            "borradores de la otra. Un número de WhatsApp por empresa.",
        );
      }
    }

    // EL ID VIAJA EN EL OVERLAY, y siempre pisa: es lo que le permite a
    // `config.ts` derivar el directorio de datos de esta empresa sin saber que
    // existe un registro de tenants. Se escribe acá y no se lee del 'env' del
    // tenant a propósito: un `BILLER_TENANT_ID` puesto a mano que no coincida
    // con el id sería un tenant escribiendo en el directorio de otro, con la
    // unicidad del id validada y sirviendo para nada.
    envTenant.BILLER_TENANT_ID = id;

    // El data dir puede venir del proceso (lo normal: un directorio para el
    // despliegue) o pisarse por tenant (una empresa con su volumen aparte).
    const dataDirTenant = (envTenant.BILLER_DATA_DIR ?? base.BILLER_DATA_DIR ?? "").trim();
    const derivadas = dataDirTenant === "" ? null : rutasDerivadasDe(dataDirTenant, id);

    // Las rutas de persistencia: ni heredadas ni compartidas ni ausentes.
    // Ver el comentario de RUTAS_DE_PERSISTENCIA para las dos reglas.
    for (const variable of RUTAS_DE_PERSISTENCIA) {
      const propia = (envTenant[variable] ?? "").trim();
      /** La que va a usar de verdad: la declarada, o la derivada del data dir. */
      let efectiva = propia;

      if (propia === "") {
        if (derivadas !== null) {
          // Hay de dónde derivar. Se BORRA la del proceso para que la derivación
          // corra: si se heredara, la explícita ganaría y todos los tenants sin
          // ruta propia terminarían en el archivo del proceso.
          envTenant[variable] = undefined;
          efectiva = derivadas[variable] ?? "";
        } else if ((base[variable] ?? "").trim() !== "") {
          // Sin data dir no hay de dónde derivar. Borrarla dejaría al tenant sin
          // audit fiscal o sin idempotencia; heredarla lo pondría a escribir en
          // el archivo de otra empresa. La única salida honesta es que el
          // operador la escriba —o que configure BILLER_DATA_DIR.
          throw new TenantConfigError(
            `El proceso define ${variable} y el tenant "${id}" no declara la suya. Heredarla pondría ` +
              "a las dos empresas a escribir en el mismo archivo —el audit fiscal y la idempotencia " +
              "de una mezclados con los de la otra—, y borrarla dejaría a esta empresa sin ese " +
              `registro. Poné ${variable} en el 'env' de cada tenant, con un archivo por empresa, ` +
              "o configurá BILLER_DATA_DIR y dejá que las tres rutas se deriven por id de empresa.",
          );
        } else {
          // Ni declarada, ni derivable, ni en el proceso: sin persistencia, que
          // es el comportamiento de siempre y está documentado qué implica.
          continue;
        }
      }

      // Se comparan rutas ABSOLUTAS: "./data/audit.log" y "data/audit.log" son
      // el mismo archivo y la comparación textual no lo ve. Se registran también
      // las DERIVADAS: dos derivadas nunca chocan (el id es único), pero una
      // declarada a mano sí puede caer justo encima de la derivada de otro.
      const absoluta = resolverRuta(efectiva);
      const previo = porRuta.get(absoluta);
      if (previo !== undefined) {
        throw new TenantConfigError(
          `Los tenants "${previo.tenant}" (${previo.variable}) y "${id}" (${variable}) apuntan al ` +
            `mismo archivo ("${absoluta}"). Un archivo por empresa: mezclados, el audit deja de ser ` +
            "el rastro fiscal de nadie y una clave de idempotencia de una empresa bloquea la emisión " +
            "de la otra.",
        );
      }
      porRuta.set(absoluta, { tenant: id, variable });
    }

    // Los topes de monto: mismo razonamiento que las rutas, con el filo al
    // revés. Heredarlos le da a esta empresa el tope que alguien calculó para
    // otra; borrarlos la deja sin tope, que es la única barrera entre una coma
    // mal puesta en un precio y un CFE por cien veces lo que valía.
    if (topesDelProceso.length > 0) {
      const declaraAlguno = Object.keys(envTenant).some(
        (k) => k.startsWith(PREFIJO_TOPES) && (envTenant[k] ?? "").trim() !== "",
      );
      if (!declaraAlguno) {
        throw new TenantConfigError(
          `El proceso define ${topesDelProceso.join(", ")} y el tenant "${id}" no declara ningún ` +
            `${PREFIJO_TOPES}<MONEDA>. El tope de monto se calcula por empresa —lo que para una es ` +
            "un error de tipeo para otra es una venta normal—: heredarlo le aplica el número de " +
            "otro, y no tenerlo la deja sin freno. Declaralo en el 'env' de este tenant.",
        );
      }
    }

    // Y todo el resto de lo sensible: si el tenant no lo declaró, el overlay lo
    // BORRA. No es un default, es un borrado: la clave queda en el overlay con
    // valor vacío y pisa lo que el proceso tenga. Es lo que hace que el error no
    // se pueda cometer, en vez de que se pueda detectar.
    for (const variable of VARIABLES_QUE_NO_SE_HEREDAN) {
      if ((envTenant[variable] ?? "").trim() === "") envTenant[variable] = undefined;
    }

    const tenant: Tenant = {
      id,
      nombre: typeof crudo.nombre === "string" && crudo.nombre.trim() !== "" ? crudo.nombre.trim() : id,
      env: envTenant,
    };
    tenants.push(tenant);
    porToken.set(token, tenant);
    if (phoneNumberId !== "") porPhoneNumberId.set(phoneNumberId, tenant);
  });

  return { tenants, porToken, porPhoneNumberId };
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
 * Qué tenant corresponde a un id — el que viene en el PATH del webhook.
 *
 * Comparación común, sin tiempo constante, y a propósito: el id no es una
 * credencial. Va en los logs, lo elige el operador y no habilita nada por sí
 * solo — para que la ruta de un tenant procese algo hay que traer además una
 * firma HMAC hecha con SU secreto. Blindar esto por timing sería proteger un
 * dato que ya es público.
 */
export function resolverTenantPorId(registro: RegistroTenants, id: string): Tenant | null {
  return registro.tenants.find((t) => t.id === id) ?? null;
}

/**
 * El entorno efectivo de un tenant: el del proceso con su overlay encima.
 *
 * El overlay pisa, no completa: si el tenant define `BILLER_API_TOKEN`, el del
 * proceso no se usa ni como fallback. Eso es lo que hace que un tenant mal
 * configurado falle en vez de leer los datos de otra empresa — el modo de falla
 * silencioso que más caro sale acá.
 *
 * Y pisa también con vacío: las claves que `construirRegistro` puso en
 * `undefined` (las sensibles que el tenant no declaró) quedan en el resultado
 * con ese valor y tapan lo que el proceso tenga. Por eso el spread es la
 * implementación correcta y un merge que "ignore los undefined" reabriría, de
 * una línea, todas las herencias que este módulo se ocupa de cortar.
 */
export function entornoDe(
  tenant: Tenant,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...base, ...tenant.env };
}
