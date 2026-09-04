// =============================================================================
// Carga y validación de variables de entorno.
//
// - `loadConfig`   : estricta. Lanza BillerConfigError si falta lo requerido.
//                    La usan las tools que llaman a Biller.
// - `inspectConfig`: tolerante. Nunca lanza y NUNCA expone el token.
//                    La usa `biller_health_check` para diagnosticar.
// =============================================================================

import { mkdirSync } from "node:fs";
import { join as unirRuta } from "node:path";
import { logger, registrarSecretosParaLogs } from "./logger.js";
import { BillerConfigError } from "./utils/errors.js";
import {
  DEFAULT_RATE_LIMIT_DEFAULT_RPS,
  DEFAULT_RATE_LIMIT_DGI_RPS,
  MAX_RATE_LIMIT_RPS,
} from "./utils/rateLimit.js";
export {
  DEFAULT_RATE_LIMIT_DEFAULT_RPS,
  DEFAULT_RATE_LIMIT_DGI_RPS,
  MAX_RATE_LIMIT_RPS,
} from "./utils/rateLimit.js";
import { parseLimitesMonto, type LimitesMonto } from "./write/limiteMonto.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * TTL de una sesión del transporte HTTP y techo de sesiones simultáneas.
 *
 * Viven acá y no en `transport/http.ts` —donde se usan— porque hasta agosto de
 * 2026 se leían del entorno con un helper local, fuera de la config validada y
 * por lo tanto fuera del overlay de tenants. Hoy no duele (son parámetros del
 * proceso, no de una empresa), pero es exactamente el camino por el que
 * `BILLER_CACHE_ENABLED` se volvió la única variable imposible de pisar: una
 * variable que nadie valida es una variable que nadie puede pisar.
 *
 * El porqué de cada número está en `transport/http.ts`, al lado de quien los usa.
 */
export const DEFAULT_HTTP_SESSION_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_HTTP_MAX_SESSIONS = 200;
/** Retención máxima de ids de mensajes entrantes para evitar replays. */
export const DEFAULT_WEBHOOK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
/** Techo por tenant del estado de replay en memoria y disco. */
export const DEFAULT_WEBHOOK_REPLAY_MAX_ENTRIES = 10_000;

/**
 * El id que se le da a "la única empresa" cuando no hay registro de tenants.
 *
 * Sirve para que `BILLER_DATA_DIR` funcione igual en modo mono-tenant: las rutas
 * se derivan a `<data_dir>/_proceso/…` y el operador no tiene que escribir tres
 * rutas para un despliegue de una sola empresa.
 *
 * Empieza con `_` a propósito: `construirRegistro` rechaza los ids que no sean
 * `[a-z0-9-]` en minúsculas y de hasta 48 caracteres, así que ningún tenant
 * real puede llamarse así y quedarse con el directorio del proceso. La
 * colisión no se detecta, no se puede cometer.
 */
export const TENANT_IMPLICITO = "_proceso";

/** Nombre de archivo de cada ruta derivada. Cambiarlos es cambiar de archivo. */
const ARCHIVO_AUDIT = "audit.jsonl";
const ARCHIVO_IDEMPOTENCIA = "idempotencia.jsonl";
const ARCHIVO_BORRADORES = "borradores.jsonl";
/** Namespace separado: nunca mezclar salidas Kapso con operaciones fiscales. */
const ARCHIVO_KAPSO_IDEMPOTENCIA = "kapso-idempotencia.jsonl";

export type BillerEnvironment = "test" | "production";

/**
 * Modo operativo central del servidor MCP.
 * - `read_only`    : solo se registran las tools de `READ_TOOL_NAMES` (default seguro).
 * - `write_enabled`: se registran además las de `WRITE_TOOL_NAMES` (con barreras).
 *
 * Los conteos no se escriben acá a propósito: las listas son la única fuente
 * de verdad y un número copiado envejece sin que nada falle.
 *
 * Controlado por la variable de entorno `BILLER_CAPABILITY_MODE`.
 * Default: `read_only`.
 */
export type BillerCapabilityMode = "read_only" | "write_enabled";

function parseCapabilityMode(raw: string | undefined): BillerCapabilityMode {
  return (raw ?? "").trim().toLowerCase() === "write_enabled" ? "write_enabled" : "read_only";
}

export interface BillerConfig {
  /**
   * Id de la empresa de esta config. `_proceso` en modo mono-tenant.
   *
   * No identifica nada ante Biller —eso lo hace el token—: es el nombre con el
   * que esta empresa aparece en los logs y, sobre todo, el que separa su
   * directorio de datos del de las demás. Ver `BILLER_DATA_DIR`.
   */
  tenantId: string;
  /** Directorio base de persistencia, si está configurado. Ver `derivarRutas`. */
  dataDir?: string;
  /** Base URL normalizada (sin barra final), p.ej. https://test.biller.uy */
  apiBaseUrl: string;
  /** Bearer token. Nunca se loguea ni se devuelve. */
  apiToken: string;
  /** Metadata local; NO se envía a la API (el token ya está atado a la empresa). */
  defaultEmpresaRut?: string;
  /**
   * Valor por defecto del parámetro `sucursal` en /v2/comprobantes/obtener.
   * Es el ID REAL que Biller asigna a la sucursal (Ajustes → Sucursales), no un
   * número genérico. Opcional: el endpoint no exige sucursal.
   */
  defaultSucursalId?: string;
  /**
   * Mapa `id de sucursal -> nombre legible`, desde BILLER_SUCURSALES_JSON.
   * Biller no expone un endpoint de sucursales, así que sin esto los reportes
   * solo pueden decir "sucursal 6" en vez de "Pocitos".
   */
  sucursales: Record<string, string>;
  timeoutMs: number;
  logLevel: string;
  /** Ambiente derivado de la base URL (test si el host empieza con "test."). */
  environment: BillerEnvironment;
  /** Master switch de escritura. Si false, los POST no se ejecutan (sí el dry-run). */
  writeEnabled: boolean;
  /** Habilita ejecutar POST contra PRODUCCIÓN (además requiere allow_production=true). */
  allowProductionWrites: boolean;
  /**
   * Clave server-side para firmar confirmation_token v2. Nunca se expone.
   * Es obligatoria si se registran tools de escritura o si Kapso está activo.
   */
  approvalSecret: string | null;
  /** Ruta opcional de archivo para el audit log (además de stderr). */
  auditLogPath?: string;
  /** Modo operativo: qué tools se registran en el servidor MCP. */
  capabilityMode: BillerCapabilityMode;
  /**
   * Token que exige el transporte HTTP en `Authorization: Bearer`.
   * DISTINTO del de Biller a propósito: quien puede hablarle al MCP no debería
   * poder hablarle a Biller directamente. Sin esto el transporte HTTP no arranca.
   */
  httpAuthToken?: string;
  /** Puerto del transporte HTTP (solo si se arranca en modo http). */
  httpPort: number;
  /** Interfaz de escucha del transporte HTTP. Default 127.0.0.1 (no expuesto). */
  httpHost: string;
  /**
   * Hostnames públicos que pueden aparecer en el header `Host`, además de los
   * locales. Vacío por defecto.
   *
   * El transporte tiene protección contra DNS rebinding: sin ella, un sitio
   * malicioso abierto en el navegador del operador puede hablarle a 127.0.0.1.
   * Esa protección compara el `Host` contra una allowlist, y detrás de un túnel
   * o un dominio propio el `Host` que llega es el PÚBLICO — así que la petición
   * se rechaza con "Invalid Host header" antes de tocar ninguna tool.
   *
   * Se declara el host en vez de apagar la protección: apagarla vale para
   * cualquier atacante, mientras que declarar un nombre vale solo para ese
   * nombre. Ej: BILLER_HTTP_ALLOWED_HOSTS=mi-tunel.ngrok-free.dev,mcp.miempresa.uy
   */
  httpAllowedHosts: string[];
  /** Configuración de Kapso (WhatsApp). `undefined` si no está configurado. */
  kapso?: KapsoConfig;
  /**
   * Allowlist de REMITENTES: quién puede preguntarle a este server.
   *
   * Distinta de `kapso.destinatariosPermitidos`, que dice a quién se le puede
   * MANDAR algo. Son dos permisos y se pueden separar (un contador que recibe el
   * digest pero no puede emitir), pero cuando esta va vacía cae a la de
   * destinatarios: quien puede recibir datos fiscales es quien puede pedirlos.
   * Ver `src/security/remitentes.ts`.
   */
  remitentesAutorizados: string[];
  /**
   * Registra `biller_posicion_iva` (estimación de IVA débito − crédito).
   *
   * DESHABILITADA POR DEFECTO. El cálculo es correcto sobre los CFE del
   * período, pero deja afuera importaciones, prorrata por exentos, servicios
   * del exterior y ajustes contables. Como el número se parece mucho a una
   * declaración jurada, es fácil que se use como tal — y ahí el error no es de
   * software sino fiscal. Se habilita a conciencia con
   * BILLER_ENABLE_IVA_ESTIMADO=true.
   */
  enableIvaEstimado: boolean;
  /**
   * Ruta del registro PERSISTENTE de idempotencia. Sin esto, el registro es en
   * memoria y una key ya ejecutada vuelve a considerarse nueva tras reiniciar
   * — que es como se duplica un comprobante ante DGI.
   */
  idempotencyLogPath?: string;
  /** Ruta del journal persistente de deduplicación de webhooks entrantes. */
  webhookReplayLogPath?: string;
  /** TTL del journal de replay, en milisegundos. */
  webhookReplayTtlMs?: number;
  /** Máximo de ids retenidos por tenant. */
  webhookReplayMaxEntries?: number;
  /**
   * Ruta del store PERSISTENTE de borradores de emisión.
   *
   * A diferencia del de idempotencia, este default (memoria) es el recomendado:
   * el archivo guarda el CONTENIDO del borrador —qué se vendió, a quién, la
   * adenda—, así que es información comercial en disco. Se pide a conciencia,
   * cuando hay varias instancias y el proceso no dura lo que la conversación.
   */
  borradorStorePath?: string;
  /**
   * true = el `tools/list` sale SIN los outputSchema.
   *
   * Existe por el Agent Node de Kapso: con la lista completa (159 KB) el agente
   * quedaba configurado con cero tools nuestras, sin error visible. Los
   * outputSchema son opcionales en MCP y un agente conversacional no los usa;
   * un cliente estricto (Claude Code) sí, por eso es opt-in y no default.
   */
  wireLiviano: boolean;
  /** Topes de monto por operación y por moneda (BILLER_MAX_MONTO_UYU, …). */
  maxMontos: LimitesMonto;
  /**
   * Valor de la Unidad Indexada en pesos, y la fecha de ese valor.
   *
   * DGI exige identificar al receptor cuando un e-Ticket supera cierto monto
   * expresado en UI, y el decreto lo fija con la UI **del 1º de enero del año**
   * —no la del día— para que el mismo importe no cambie de régimen a mitad de
   * año. No está en la API de Biller, así que se configura acá y se cambia una
   * vez por año. Sin esto el chequeo igual se hace, con un valor de referencia
   * conservador y avisando que es aproximado: un aviso de más cuesta una
   * pregunta, uno de menos cuesta un comprobante mal emitido.
   */
  valorUi?: number;
  valorUiFecha?: string;
  /** Umbral en UI para exigir receptor. Default 5000 (ver requisitos.ts). */
  umbralUiReceptor?: number;
  /**
   * Cache de ventanas de consulta. Prendido salvo `BILLER_CACHE_ENABLED=false`.
   *
   * Está en la config validada —y no solo leído del entorno donde se usa— para
   * que un tenant lo pueda pisar en su overlay: apagar el cache para diagnosticar
   * un total que no cierra en UNA empresa no tiene por qué apagarlo para las
   * veinte. Quien conecta esto con el cache es `tenants/contextos.ts`.
   */
  cacheEnabled: boolean;
  /** TTL de una sesión del transporte HTTP, en ms. */
  httpSessionTtlMs: number;
  /** Techo de sesiones HTTP simultáneas. */
  httpMaxSessions: number;
  /** Requests por segundo para operaciones normales (default 30). */
  rateLimitDefaultRps: number;
  /** Requests por segundo para DGI/recibidos (default 1). */
  rateLimitDgiRps: number;
}

/** Configuración del canal de salida por WhatsApp (Kapso). */
export interface KapsoConfig {
  /** API key del proyecto. Va en el header `X-API-Key`. Nunca se loguea. */
  apiKey: string;
  /** Base URL de la API de Kapso. */
  baseUrl: string;
  /** ID del número de WhatsApp emisor (`{phone_number_id}` en la ruta). */
  phoneNumberId?: string;
  /**
   * Secreto con el que se verifica la firma HMAC del webhook entrante
   * (`X-Hub-Signature-256`). Sin esto, la ruta del webhook NO EXISTE.
   *
   * No es una comodidad de configuración: un endpoint de entrada sin firma, en
   * una URL pública, deja que cualquiera nos mande un evento con el `from` que
   * quiera — o sea, que se presente como un remitente autorizado. La allowlist
   * de remitentes solo sirve si el `from` es confiable, y lo único que lo hace
   * confiable es la firma.
   */
  webhookSecret?: string;
  /**
   * Allowlist de destinatarios en E.164 sin '+'. Un mensaje a un número que no
   * esté acá se rechaza ANTES de salir.
   *
   * No es una comodidad: el contenido que manda este server son datos fiscales
   * (quién le debe cuánto a quién). Un `to` equivocado —un dígito de más, una
   * variable mal interpolada por el modelo— se los entrega a un tercero. La
   * allowlist convierte ese error de "fuga de datos" en "error de validación".
   */
  destinatariosPermitidos: string[];
  /** Tenant que posee el canal. Solo se usa para saltear claves entre empresas. */
  tenantId?: string;
  /** Journal propio de salidas Kapso (null/undefined = store en memoria). */
  idempotencyLogPath?: string;
  /** Marca interna del handler serverless: el filesystem efímero no alcanza. */
  serverless?: boolean;
}

export const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai";
export const DEFAULT_HTTP_PORT = 8848;

/** Deja solo dígitos: acepta "+598 99 123 456" y devuelve "59899123456". */
export function normalizarTelefono(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Parsea la allowlist de destinatarios (separada por comas). */
export function parseDestinatarios(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => normalizarTelefono(s))
    .filter((s) => s.length > 0);
}

/**
 * Revisa la allowlist buscando errores de formato que, si no se avisan, hacen
 * que el envío falle SIN explicación: el número simplemente no matchea y el
 * mensaje se rechaza como "destinatario no autorizado".
 *
 * El caso frecuente en Uruguay es el prefijo nacional 0. Un celular se escribe
 * 095 923 567 dentro del país, pero en E.164 ese 0 NO va: es 598 95923567, no
 * 598 095923567. Copiar el número como se marca localmente produce 12 dígitos
 * en vez de 11, y nada funciona.
 *
 * Se avisa en vez de corregir automáticamente: tocarle los dígitos al
 * destinatario de un mensaje con datos fiscales es exactamente el tipo de
 * "ayuda" que puede terminar mandándoselo a otra persona.
 */
export function advertenciasDestinatarios(destinatarios: string[]): string[] {
  const out: string[] = [];
  for (const d of destinatarios) {
    // Los números se enmascaran: son datos personales y estos mensajes terminan
    // en logs y en la respuesta de health_check, que lee el modelo.
    const masc = `…${d.slice(-4)}`;
    if (/^5980/.test(d)) {
      out.push(
        `El destinatario ${masc} (${d.length} dígitos) parece llevar el prefijo nacional 0 después ` +
          "del código de país 598. En formato internacional ese 0 se descarta: 095 923 567 se " +
          "escribe 59895923567, no 598095923567. Tal como está no va a coincidir y el envío se rechazará.",
      );
    } else if (d.length < 8 || d.length > 15) {
      // E.164 admite hasta 15 dígitos; menos de 8 no es un número internacional.
      out.push(
        `El destinatario ${masc} tiene ${d.length} dígitos, fuera del rango de un número ` +
          "internacional válido (8 a 15). Revisá el formato: código de país + número, sin el 0 nacional.",
      );
    }
  }
  return out;
}

function parseKapso(env: Env, idempotencyLogPath?: string): KapsoConfig | undefined {
  const apiKey = trimOrUndefined(env.KAPSO_API_KEY);
  if (apiKey === undefined) return undefined;
  return {
    apiKey,
    baseUrl: normalizeKapsoBaseUrl(trimOrUndefined(env.KAPSO_API_BASE_URL) ?? DEFAULT_KAPSO_BASE_URL),
    phoneNumberId: trimOrUndefined(env.KAPSO_PHONE_NUMBER_ID),
    destinatariosPermitidos: parseDestinatarios(env.KAPSO_DESTINATARIOS_PERMITIDOS),
    webhookSecret: trimOrUndefined(env.KAPSO_WEBHOOK_SECRET),
    tenantId: tenantIdDe(env),
    idempotencyLogPath,
  };
}

/**
 * El puerto, con el CERO como valor válido.
 *
 * `0` no es un error: es "elegí cualquiera que esté libre", que es como se
 * levantan dos instancias sin pisarse y como corren los tests de integración.
 * Rechazarlo hacía que cayeran al default 8848 y explotaran con EADDRINUSE
 * contra el server que uno tiene corriendo mientras desarrolla — verdes en una
 * máquina limpia, rojos en la de quien está trabajando.
 */
function parsePort(raw: string | undefined, fallback: number): number {
  const crudo = (raw ?? "").trim();
  if (crudo === "") return fallback;
  const n = Number(crudo);
  return Number.isInteger(n) && n >= 0 && n < 65_536 ? n : fallback;
}

/**
 * Hostnames públicos declarados, separados por coma.
 *
 * Se acepta que venga con esquema o con path ("https://x.ngrok-free.dev/mcp"):
 * el que configura esto tiene la URL del túnel en el portapapeles y pegarla
 * entera es lo que va a hacer. Se queda con el host (y el puerto si lo trae),
 * que es lo único que el header `Host` puede contener.
 *
 * Un comodín ("*") NO se acepta: sería apagar la protección por la puerta de
 * atrás y sin que quede escrito en ningún lado que se apagó.
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "*")
    .map((s) => {
      const sinEsquema = s.replace(/^[a-z]+:\/\//i, "");
      return (sinEsquema.split("/")[0] ?? "").toLowerCase();
    })
    .filter((s) => s !== "");
}

/**
 * Deriva el ambiente desde la base URL. Conservador: solo se considera "test"
 * si el host empieza con "test." (p.ej. test.biller.uy); cualquier otra cosa se
 * trata como PRODUCCIÓN para exigir la habilitación explícita.
 */
export function detectEnvironment(baseUrl: string): BillerEnvironment {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return /^test\./.test(host) ? "test" : "production";
  } catch {
    return "production";
  }
}

/**
 * Número positivo o undefined. Tolerante: un valor basura no rompe el
 * arranque, cae a "no configurado" — pero, a diferencia de antes, YA NO EN
 * SILENCIO cuando se le pasan `nombre`/`warnings`: un tipeo en una variable
 * como `BILLER_VALOR_UI` no puede pasar inadvertido, porque lo que decide
 * mal, río abajo, es si un e-Ticket exige receptor ante DGI (ver
 * `biller/requisitos.ts`). "Basura" acá es solo lo que ni siquiera parsea
 * como número positivo; un número sintácticamente válido pero fuera de rango
 * plausible (una coma corrida) lo valida `resolverUmbralReceptor`, que es
 * quien conoce la banda razonable para CADA variable — este parser es
 * genérico y no la conoce.
 */
function parseNumeroPositivo(
  raw: string | undefined,
  nombre?: string,
  warnings?: string[],
): number | undefined {
  const t = (raw ?? "").trim().replace(",", ".");
  if (t === "") return undefined;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) return n;
  if (nombre !== undefined) {
    const warning = `${nombre}="${raw}" no es un número positivo: se ignora.`;
    logger.warn(warning);
    warnings?.push(warning);
  }
  return undefined;
}

/**
 * `BILLER_VALOR_UI_FECHA` tiene que ser aaaa-mm-dd: es lo único que
 * `resolverUmbralReceptor` sabe leer para calcular si el valor de UI está
 * vencido. Una fecha con otro formato (o basura) no se corrige a mano —está
 * en el mismo espíritu que `advertenciasDestinatarios`: tocarle el formato a
 * un dato que alimenta una decisión fiscal es una mala idea— se descarta y se
 * avisa, y el chequeo de vencimiento queda igual de "no puedo saberlo" que si
 * la fecha faltara.
 */
const FORMATO_FECHA_UI_ENV = /^\d{4}-\d{2}-\d{2}$/;

function parseFechaUi(raw: string | undefined, warnings?: string[]): string | undefined {
  const t = (raw ?? "").trim();
  if (t === "") return undefined;
  if (FORMATO_FECHA_UI_ENV.test(t)) return t;
  const warning =
    `BILLER_VALOR_UI_FECHA="${raw}" no tiene el formato aaaa-mm-dd: se ignora. Sin fecha confiable ` +
    "no se puede saber si BILLER_VALOR_UI está vencido.";
  logger.warn(warning);
  warnings?.push(warning);
  return undefined;
}

function parseBool(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/**
 * Booleano que viene PRENDIDO de fábrica: solo el literal "false" lo apaga.
 *
 * Se avisa —y no se rompe— cuando el valor no es ni "true" ni "false": el modo
 * de falla que importa es el de quien escribe `BILLER_CACHE_ENABLED=0` creyendo
 * que apagó el cache y se queda diagnosticando un total contra datos cacheados.
 * Romper el arranque por esto sería peor: es una optimización, no una barrera.
 */
function parseBoolPrendido(raw: string | undefined, nombre: string): boolean {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "") return true;
  if (t === "true") return true;
  if (t === "false") return false;
  logger.warn(
    `${nombre}="${raw}" no es "true" ni "false": se ignora y queda PRENDIDO. Si querías apagarlo, ` +
      `el único valor que lo apaga es exactamente "false".`,
  );
  return true;
}

/**
 * Entero positivo del entorno, con default y aviso.
 *
 * Un valor no numérico o <= 0 cae al default en vez de romper el arranque:
 * quedarse sin server de facturación por un TTL mal tipeado es peor que
 * ignorarlo. Pero se avisa, porque el silencio es lo que hace que alguien crea
 * que configuró un techo de sesiones que en realidad no está puesto.
 */
function parseEnteroPositivo(raw: string | undefined, porDefecto: number, nombre: string): number {
  const t = (raw ?? "").trim();
  if (t === "") return porDefecto;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      `${nombre}="${raw}" no es un entero positivo: se ignora y se usa el default (${porDefecto}).`,
    );
    return porDefecto;
  }
  return Math.floor(n);
}

/**
 * Lee un límite de requests por segundo de forma conservadora.
 *
 * Estos son límites operativos, no cantidades donde tenga sentido redondear:
 * un decimal o una notación exponencial se considera un valor mal tipeado.
 * Un valor inválido vuelve al default y deja un warning tanto en logs como en
 * la inspección que consume `biller_health_check`.
 */
function parseRateLimitRps(
  raw: string | undefined,
  porDefecto: number,
  nombre: string,
  warnings?: string[],
): number {
  const t = (raw ?? "").trim();
  if (t === "") return porDefecto;
  const n = Number(t);
  const valido = /^[0-9]+$/.test(t) && Number.isSafeInteger(n) && n > 0 && n <= MAX_RATE_LIMIT_RPS;
  if (valido) return n;

  const warning =
    `${nombre}="${raw}" no es un entero positivo entre 1 y ${MAX_RATE_LIMIT_RPS}: ` +
    `se ignora y se usa el default (${porDefecto}).`;
  logger.warn(warning);
  warnings?.push(warning);
  return porDefecto;
}

/**
 * Las cinco rutas de persistencia, derivadas de `BILLER_DATA_DIR` + el id de la
 * empresa.
 *
 * EL PROBLEMA QUE RESUELVE. Declararlas a mano son varias rutas por empresa, y la
 * de más arriba está a un copy-paste de distancia: dar de alta la vigésima
 * empresa copiando la entrada de la decimonovena deja a las dos escribiendo el
 * audit fiscal en el mismo archivo. Hasta acá la única defensa era la validación
 * de duplicados de `construirRegistro`, que es una red, no una imposibilidad.
 *
 * Con el id adentro de la ruta, compartir archivo deja de ser detectable y pasa
 * a ser IMPOSIBLE: el id ya es único por construcción (el registro lo valida) y
 * dos ids distintos no pueden producir el mismo directorio.
 *
 * LA DECLARACIÓN EXPLÍCITA GANA. Quien ya tiene sus rutas escritas —y el layout
 * de disco atado a ellas: backups, permisos, un volumen montado -- no se entera
 * de que esto existe. La derivación solo llena lo que nadie declaró.
 *
 * SIN `BILLER_DATA_DIR` NO PASA NADA. Sin rutas no hay persistencia, que es el
 * comportamiento de siempre y ya está documentado qué implica (idempotencia en
 * memoria, sin rastro fiscal en disco).
 */
function derivarRutas(env: Env): {
  auditLogPath?: string;
  idempotencyLogPath?: string;
  borradorStorePath?: string;
  kapsoIdempotencyLogPath?: string;
  webhookReplayLogPath?: string;
} {
  const explicitas = {
    auditLogPath: trimOrUndefined(env.BILLER_AUDIT_LOG_PATH),
    idempotencyLogPath: trimOrUndefined(env.BILLER_IDEMPOTENCY_LOG_PATH),
    borradorStorePath: trimOrUndefined(env.BILLER_BORRADOR_STORE_PATH),
    kapsoIdempotencyLogPath: trimOrUndefined(env.KAPSO_IDEMPOTENCY_LOG_PATH),
    webhookReplayLogPath: trimOrUndefined(env.BILLER_WEBHOOK_REPLAY_LOG_PATH),
  };
  const dataDir = trimOrUndefined(env.BILLER_DATA_DIR);
  if (dataDir === undefined) return explicitas;

  const derivadas = rutasDerivadasDe(dataDir, tenantIdDe(env));
  return {
    auditLogPath: explicitas.auditLogPath ?? derivadas.BILLER_AUDIT_LOG_PATH,
    idempotencyLogPath: explicitas.idempotencyLogPath ?? derivadas.BILLER_IDEMPOTENCY_LOG_PATH,
    borradorStorePath: explicitas.borradorStorePath ?? derivadas.BILLER_BORRADOR_STORE_PATH,
    kapsoIdempotencyLogPath:
      explicitas.kapsoIdempotencyLogPath ?? derivadas.KAPSO_IDEMPOTENCY_LOG_PATH,
    webhookReplayLogPath:
      explicitas.webhookReplayLogPath ?? derivadas.BILLER_WEBHOOK_REPLAY_LOG_PATH,
  };
}

/**
 * Las cinco rutas derivadas, indexadas por el NOMBRE DE LA VARIABLE que cada una
 * reemplaza.
 *
 * Se indexa así —y no por el campo de la config— porque el otro consumidor es
 * `tenants/registry.ts`, que razona sobre variables de entorno: necesita saber
 * qué archivo le va a tocar a un tenant que no declaró `BILLER_AUDIT_LOG_PATH`
 * para poder chequearlo contra el que otro tenant declaró a mano.
 */
export function rutasDerivadasDe(dataDir: string, tenantId: string): Record<string, string> {
  const dir = directorioDeDatos(dataDir, tenantId);
  return {
    BILLER_AUDIT_LOG_PATH: unirRuta(dir, ARCHIVO_AUDIT),
    BILLER_IDEMPOTENCY_LOG_PATH: unirRuta(dir, ARCHIVO_IDEMPOTENCIA),
    BILLER_BORRADOR_STORE_PATH: unirRuta(dir, ARCHIVO_BORRADORES),
    KAPSO_IDEMPOTENCY_LOG_PATH: unirRuta(dir, ARCHIVO_KAPSO_IDEMPOTENCIA),
    BILLER_WEBHOOK_REPLAY_LOG_PATH: unirRuta(dir, "webhook-replay.jsonl"),
  };
}

/** El id de empresa del entorno efectivo. Lo pone el overlay del tenant. */
export function tenantIdDe(env: Env): string {
  return trimOrUndefined(env.BILLER_TENANT_ID) ?? TENANT_IMPLICITO;
}

/** `<data_dir>/<id>`. Función y no un template suelto para que haya UN solo lugar. */
export function directorioDeDatos(dataDir: string, tenantId: string): string {
  return unirRuta(dataDir, tenantId);
}

/**
 * Crea el directorio derivado si no existe.
 *
 * Se hace acá y no en cada store porque el modo de falla es de arranque, no de
 * emisión: si el directorio no se puede crear, quien tiene que enterarse es el
 * operador al levantar el proceso, no el almacenero a mitad de una factura con
 * un `ENOENT` que no le dice nada. Solo se crea el DERIVADO: para una ruta que
 * el operador escribió a mano, el directorio es parte de lo que él decidió y
 * crearlo por las nuestras puede terminar en un `data/` inventado al lado del
 * volumen que en realidad quería usar.
 */
function asegurarDirectorio(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new BillerConfigError(
      `No se pudo crear el directorio de datos "${dir}" (BILLER_DATA_DIR): ` +
        (err instanceof Error ? err.message : String(err)) +
        ". Ahí van el audit fiscal, la idempotencia y los borradores de esta empresa. " +
        "Crealo a mano y dale permiso de escritura al usuario del proceso, o apuntá " +
        "BILLER_DATA_DIR a un directorio escribible.",
    );
  }
}

/**
 * Parsea BILLER_SUCURSALES_JSON, p.ej. {"6":"Pocitos","7":"Centro"}.
 * Tolerante: si el JSON es inválido devuelve un mapa vacío en vez de romper el
 * arranque — es metadata de presentación, no algo crítico.
 */
export function parseSucursales(raw: string | undefined): Record<string, string> {
  const t = (raw ?? "").trim();
  if (t === "") return {};
  try {
    const parsed: unknown = JSON.parse(t);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") out[k.trim()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export interface ConfigInspection {
  /** Id de la empresa de esta config (`_proceso` sin registro de tenants). */
  tenantId: string;
  /** Directorio base de persistencia (null = sin derivación). */
  dataDir: string | null;
  hasBaseUrl: boolean;
  apiBaseUrl: string | null;
  hasToken: boolean;
  defaultEmpresaRut: string | null;
  defaultSucursalId: string | null;
  /** Cantidad de sucursales nombradas en BILLER_SUCURSALES_JSON (no expone los nombres). */
  sucursalesConfiguradas: number;
  timeoutMs: number;
  logLevel: string;
  environment: BillerEnvironment | null;
  writeEnabled: boolean;
  allowProductionWrites: boolean;
  /** true si existe la clave de firma de approvals; nunca expone su valor. */
  approvalSecretConfigurado: boolean;
  auditLogPath: string | null;
  /** Modo operativo: qué tools se registran en el servidor MCP. */
  capabilityMode: BillerCapabilityMode;
  /** true si el transporte HTTP tiene token configurado (no expone el valor). */
  httpAuthTokenConfigurado: boolean;
  httpPort: number;
  httpHost: string;
  /** Hostnames públicos declarados. Se muestran: son nombres, no secretos. */
  httpAllowedHosts: string[];
  /** Estado de Kapso, SIN exponer la API key. */
  kapso: {
    configurado: boolean;
    baseUrl: string | null;
    phoneNumberIdConfigurado: boolean;
    destinatariosPermitidos: number;
    /** El journal de salidas sobrevive reinicios (solo booleano; no expone ruta). */
    idempotenciaPersistente: boolean;
    /** true si hay secreto de webhook (no expone el valor). Sin esto la ruta no existe. */
    webhookHabilitado: boolean;
    /** Problemas de formato en la allowlist (números enmascarados). */
    advertencias: string[];
  };
  /**
   * Barrera de entrada: quién puede preguntarle a este server.
   * Nunca expone los números, solo cuántos y de dónde salen.
   */
  remitentes: {
    /** true si se exige `remitente` (o sea: si hay canal de WhatsApp). */
    exigido: boolean;
    /** Cuántos números autorizados hay, sumando el fallback. */
    autorizados: number;
    /** De dónde sale la allowlist efectiva. */
    fuente: "propia" | "destinatarios" | "ninguna";
    /** Problemas de formato en la allowlist propia (números enmascarados). */
    advertencias: string[];
  };
  /** true si la estimación de IVA está habilitada (opt-in). */
  enableIvaEstimado: boolean;
  /** Ruta del registro persistente de idempotencia (null = solo memoria). */
  idempotencyLogPath: string | null;
  /** Ruta del journal persistente de replay de webhooks (null = solo memoria). */
  webhookReplayLogPath: string | null;
  webhookReplayTtlMs: number;
  webhookReplayMaxEntries: number;
  /** Ruta del store persistente de borradores de emisión (null = solo memoria). */
  borradorStorePath: string | null;
  /** true = tools/list sale sin outputSchema (para clientes que se ahogan con la lista completa). */
  wireLiviano: boolean;
  /** Topes de monto configurados, por moneda. */
  maxMontos: LimitesMonto;
  /** Valor de la UI configurado (null = se usa el de referencia). */
  valorUi: number | null;
  valorUiFecha: string | null;
  umbralUiReceptor: number | null;
  /** Cache de ventanas prendido para ESTA empresa. */
  cacheEnabled: boolean;
  httpSessionTtlMs: number;
  httpMaxSessions: number;
  /** Requests por segundo para operaciones normales (default 30). */
  rateLimitDefaultRps: number;
  /** Requests por segundo para DGI/recibidos (default 1). */
  rateLimitDgiRps: number;
  /** Advertencias de parseo de límites operativos. No contiene secretos. */
  configWarnings: string[];
  /** Nombres de variables requeridas que faltan. */
  missing: string[];
}

type Env = Record<string, string | undefined>;

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

const BILLER_API_HOSTS = new Set(["biller.uy", "test.biller.uy"]);

/**
 * Hosts a los que puede salir la API key de Kapso.
 *
 * SIMETRÍA CON BILLER, Y POR EL MISMO MOTIVO. La base de Biller estaba
 * encerrada en dos hosts porque el bearer viaja en el header y una base
 * arbitraria lo entrega. La de Kapso pasaba por `normalizeBaseUrl`, que solo
 * saca la barra final: un typo o una variable de entorno mal puesta mandaba la
 * API key de Kapso —y con ella la capacidad de escribirle a los clientes de la
 * empresa por WhatsApp— a cualquier host que aceptara el POST.
 *
 * Se permite `localhost` porque el desarrollo contra un mock es un caso real y
 * un host local no filtra nada afuera de la máquina.
 */
const KAPSO_API_HOSTS = new Set(["api.kapso.ai", "kapso.ai", "localhost", "127.0.0.1"]);

/**
 * Misma regla que `normalizeBillerBaseUrl`, sobre la lista de Kapso.
 *
 * `localhost` puede llevar puerto y http: sin eso no hay forma de apuntar a un
 * mock local. Los hosts remotos exigen https y nada más que el host.
 */
function normalizeKapsoBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BillerConfigError("KAPSO_API_BASE_URL no es una URL válida.");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  const pathValido = url.pathname === "" || url.pathname === "/";
  if (
    !KAPSO_API_HOSTS.has(host) ||
    (!local && url.protocol !== "https:") ||
    (local && url.protocol !== "http:" && url.protocol !== "https:") ||
    (!local && url.port !== "") ||
    url.username !== "" ||
    url.password !== "" ||
    !pathValido ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BillerConfigError(
      "KAPSO_API_BASE_URL debe ser https://api.kapso.ai (o un http://localhost:PUERTO para " +
        "desarrollo), sin path, query, credenciales ni fragmento. La API key de Kapso viaja en el " +
        "header: una base arbitraria la entrega.",
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * El bearer de Biller solo puede salir hacia los dos hosts oficiales conocidos.
 * También se prohíben credenciales, puertos, query, fragmentos y subpaths: una
 * base ambigua no debe convertirse en un canal para filtrar el token.
 */
function normalizeBillerBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BillerConfigError("BILLER_API_BASE_URL no es una URL válida.");
  }
  const pathValido = url.pathname === "" || url.pathname === "/";
  if (
    url.protocol !== "https:" ||
    !BILLER_API_HOSTS.has(url.hostname.toLowerCase()) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !pathValido ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BillerConfigError(
      "BILLER_API_BASE_URL debe ser exactamente https://test.biller.uy o https://biller.uy.",
    );
  }
  return `https://${url.hostname.toLowerCase()}`;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BillerConfigError(
      `BILLER_TIMEOUT_MS inválido: "${raw}". Debe ser un número positivo de milisegundos.`,
    );
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

/**
 * Carga estricta. Lanza BillerConfigError listando TODAS las variables
 * requeridas que falten.
 */
export function loadConfig(env: Env = process.env): BillerConfig {
  const missing: string[] = [];

  const baseUrlRaw = trimOrUndefined(env.BILLER_API_BASE_URL);
  if (!baseUrlRaw) missing.push("BILLER_API_BASE_URL");

  const token = trimOrUndefined(env.BILLER_API_TOKEN);
  if (!token) {
    missing.push("BILLER_API_TOKEN");
  } else if (token.length < 8) {
    missing.push("BILLER_API_TOKEN debe tener al menos 8 caracteres");
  }

  const capabilityMode = parseCapabilityMode(env.BILLER_CAPABILITY_MODE);
  const approvalSecret = trimOrUndefined(env.BILLER_APPROVAL_SECRET);
  const approvalRequired =
    capabilityMode === "write_enabled" || trimOrUndefined(env.KAPSO_API_KEY) !== undefined;
  if (approvalRequired) {
    if (!approvalSecret) {
      missing.push("BILLER_APPROVAL_SECRET");
    } else if (approvalSecret.length < 32) {
      missing.push("BILLER_APPROVAL_SECRET debe tener al menos 32 caracteres");
    }
  }

  if (missing.length > 0) {
    throw new BillerConfigError(
      `Faltan variables de entorno requeridas: ${missing.join(", ")}. ` +
        `Configurá un archivo .env (ver .env.example) o exportalas en el entorno.`,
    );
  }

  // En este punto baseUrlRaw y token están definidos.
  const apiBaseUrl = normalizeBillerBaseUrl(baseUrlRaw!);
  const dataDir = trimOrUndefined(env.BILLER_DATA_DIR);
  const tenantId = tenantIdDe(env);
  const rutas = derivarRutas(env);
  const rateLimitDefaultRps = parseRateLimitRps(
    env.BILLER_RATE_LIMIT_DEFAULT_RPS,
    DEFAULT_RATE_LIMIT_DEFAULT_RPS,
    "BILLER_RATE_LIMIT_DEFAULT_RPS",
  );
  const rateLimitDgiRps = parseRateLimitRps(
    env.BILLER_RATE_LIMIT_DGI_RPS,
    DEFAULT_RATE_LIMIT_DGI_RPS,
    "BILLER_RATE_LIMIT_DGI_RPS",
  );
  // El directorio se crea solo si hay algo derivado que vaya a caer adentro: con
  // todas las rutas declaradas a mano, `BILLER_DATA_DIR` no manda nada y crear un
  // directorio vacío sería ruido en el disco de alguien.
  if (
    dataDir !== undefined &&
    (rutas.auditLogPath !== trimOrUndefined(env.BILLER_AUDIT_LOG_PATH) ||
      rutas.idempotencyLogPath !== trimOrUndefined(env.BILLER_IDEMPOTENCY_LOG_PATH) ||
      rutas.borradorStorePath !== trimOrUndefined(env.BILLER_BORRADOR_STORE_PATH) ||
      rutas.kapsoIdempotencyLogPath !== trimOrUndefined(env.KAPSO_IDEMPOTENCY_LOG_PATH) ||
      rutas.webhookReplayLogPath !== trimOrUndefined(env.BILLER_WEBHOOK_REPLAY_LOG_PATH))
  ) {
    asegurarDirectorio(directorioDeDatos(dataDir, tenantId));
  }
  // Los secretos del proceso, en el logger, ANTES de devolver la config: a
  // partir de acá ninguna línea de log puede imprimirlos aunque un caller le
  // pase el mensaje crudo de un error. Ver `registrarSecretosParaLogs`.
  registrarSecretosParaLogs([
    token,
    approvalSecret,
    trimOrUndefined(env.BILLER_HTTP_AUTH_TOKEN),
    trimOrUndefined(env.KAPSO_API_KEY),
    trimOrUndefined(env.KAPSO_WEBHOOK_SECRET),
  ]);

  return {
    tenantId,
    dataDir,
    apiBaseUrl,
    apiToken: token!,
    defaultEmpresaRut: trimOrUndefined(env.BILLER_DEFAULT_EMPRESA_RUT),
    defaultSucursalId: trimOrUndefined(env.BILLER_DEFAULT_SUCURSAL_ID),
    sucursales: parseSucursales(env.BILLER_SUCURSALES_JSON),
    timeoutMs: parseTimeout(env.BILLER_TIMEOUT_MS),
    logLevel: trimOrUndefined(env.LOG_LEVEL) ?? "info",
    environment: detectEnvironment(apiBaseUrl),
    writeEnabled: parseBool(env.BILLER_WRITE_ENABLED),
    allowProductionWrites: parseBool(env.BILLER_ALLOW_PRODUCTION_WRITES),
    approvalSecret: approvalSecret ?? null,
    auditLogPath: rutas.auditLogPath,
    capabilityMode,
    httpAuthToken: trimOrUndefined(env.BILLER_HTTP_AUTH_TOKEN),
    httpPort: parsePort(env.BILLER_HTTP_PORT, DEFAULT_HTTP_PORT),
    httpHost: trimOrUndefined(env.BILLER_HTTP_HOST) ?? "127.0.0.1",
    httpAllowedHosts: parseAllowedHosts(env.BILLER_HTTP_ALLOWED_HOSTS),
    kapso: parseKapso(env, rutas.kapsoIdempotencyLogPath),
    remitentesAutorizados: parseDestinatarios(env.BILLER_REMITENTES_AUTORIZADOS),
    enableIvaEstimado: parseBool(env.BILLER_ENABLE_IVA_ESTIMADO),
    idempotencyLogPath: rutas.idempotencyLogPath,
    webhookReplayLogPath: rutas.webhookReplayLogPath,
    webhookReplayTtlMs: parseEnteroPositivo(
      env.BILLER_WEBHOOK_REPLAY_TTL_MS,
      DEFAULT_WEBHOOK_REPLAY_TTL_MS,
      "BILLER_WEBHOOK_REPLAY_TTL_MS",
    ),
    webhookReplayMaxEntries: parseEnteroPositivo(
      env.BILLER_WEBHOOK_REPLAY_MAX_ENTRIES,
      DEFAULT_WEBHOOK_REPLAY_MAX_ENTRIES,
      "BILLER_WEBHOOK_REPLAY_MAX_ENTRIES",
    ),
    borradorStorePath: rutas.borradorStorePath,
    wireLiviano: parseBool(env.BILLER_WIRE_LIVIANO),
    maxMontos: parseLimitesMonto(env),
    valorUi: parseNumeroPositivo(env.BILLER_VALOR_UI, "BILLER_VALOR_UI"),
    valorUiFecha: parseFechaUi(env.BILLER_VALOR_UI_FECHA),
    umbralUiReceptor: parseNumeroPositivo(env.BILLER_UMBRAL_UI_RECEPTOR, "BILLER_UMBRAL_UI_RECEPTOR"),
    cacheEnabled: parseBoolPrendido(env.BILLER_CACHE_ENABLED, "BILLER_CACHE_ENABLED"),
    httpSessionTtlMs: parseEnteroPositivo(
      env.BILLER_HTTP_SESSION_TTL_MS,
      DEFAULT_HTTP_SESSION_TTL_MS,
      "BILLER_HTTP_SESSION_TTL_MS",
    ),
    httpMaxSessions: parseEnteroPositivo(
      env.BILLER_HTTP_MAX_SESSIONS,
      DEFAULT_HTTP_MAX_SESSIONS,
      "BILLER_HTTP_MAX_SESSIONS",
    ),
    rateLimitDefaultRps,
    rateLimitDgiRps,
  };
}

/**
 * Inspección tolerante para diagnóstico. NUNCA lanza, NUNCA expone el token
 * (solo informa `hasToken`).
 */
export function inspectConfig(env: Env = process.env): ConfigInspection {
  const baseUrlRaw = trimOrUndefined(env.BILLER_API_BASE_URL);
  const token = trimOrUndefined(env.BILLER_API_TOKEN);
  const approvalSecret = trimOrUndefined(env.BILLER_APPROVAL_SECRET);

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push("BILLER_API_BASE_URL");
  if (!token) {
    missing.push("BILLER_API_TOKEN");
  } else if (token.length < 8) {
    // Mismo mínimo que loadConfig: si no, biller_health_check reporta "ok"
    // para un token que haría fallar toda llamada con BillerConfigError.
    missing.push("BILLER_API_TOKEN debe tener al menos 8 caracteres");
  }
  const capabilityMode = parseCapabilityMode(env.BILLER_CAPABILITY_MODE);
  const approvalRequired =
    capabilityMode === "write_enabled" || trimOrUndefined(env.KAPSO_API_KEY) !== undefined;
  if (approvalRequired) {
    if (!approvalSecret) missing.push("BILLER_APPROVAL_SECRET");
    else if (approvalSecret.length < 32) {
      missing.push("BILLER_APPROVAL_SECRET debe tener al menos 32 caracteres");
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    timeoutMs = parseTimeout(env.BILLER_TIMEOUT_MS);
  } catch {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  let apiBaseUrl: string | null = null;
  if (baseUrlRaw) {
    try {
      apiBaseUrl = normalizeBillerBaseUrl(baseUrlRaw);
    } catch {
      missing.push(
        "BILLER_API_BASE_URL debe ser exactamente https://test.biller.uy o https://biller.uy",
      );
    }
  }
  const rutas = derivarRutas(env);
  const kapso = parseKapso(env, rutas.kapsoIdempotencyLogPath);
  // Las rutas se DERIVAN igual que en `loadConfig` —el diagnóstico tiene que
  // decir el archivo que se va a usar de verdad, no la variable que alguien
  // escribió—, pero acá no se crea ningún directorio: `inspectConfig` no toca
  // el disco ni lanza, por definición.
  const configWarnings: string[] = [];
  const rateLimitDefaultRps = parseRateLimitRps(
    env.BILLER_RATE_LIMIT_DEFAULT_RPS,
    DEFAULT_RATE_LIMIT_DEFAULT_RPS,
    "BILLER_RATE_LIMIT_DEFAULT_RPS",
    configWarnings,
  );
  const rateLimitDgiRps = parseRateLimitRps(
    env.BILLER_RATE_LIMIT_DGI_RPS,
    DEFAULT_RATE_LIMIT_DGI_RPS,
    "BILLER_RATE_LIMIT_DGI_RPS",
    configWarnings,
  );
  return {
    tenantId: tenantIdDe(env),
    dataDir: trimOrUndefined(env.BILLER_DATA_DIR) ?? null,
    hasBaseUrl: Boolean(baseUrlRaw),
    apiBaseUrl,
    hasToken: Boolean(token),
    defaultEmpresaRut: trimOrUndefined(env.BILLER_DEFAULT_EMPRESA_RUT) ?? null,
    defaultSucursalId: trimOrUndefined(env.BILLER_DEFAULT_SUCURSAL_ID) ?? null,
    sucursalesConfiguradas: Object.keys(parseSucursales(env.BILLER_SUCURSALES_JSON)).length,
    timeoutMs,
    logLevel: trimOrUndefined(env.LOG_LEVEL) ?? "info",
    environment: apiBaseUrl ? detectEnvironment(apiBaseUrl) : null,
    writeEnabled: parseBool(env.BILLER_WRITE_ENABLED),
    allowProductionWrites: parseBool(env.BILLER_ALLOW_PRODUCTION_WRITES),
    approvalSecretConfigurado: approvalSecret !== undefined && approvalSecret.length >= 32,
    auditLogPath: rutas.auditLogPath ?? null,
    capabilityMode,
    httpAuthTokenConfigurado: trimOrUndefined(env.BILLER_HTTP_AUTH_TOKEN) !== undefined,
    httpPort: parsePort(env.BILLER_HTTP_PORT, DEFAULT_HTTP_PORT),
    httpHost: trimOrUndefined(env.BILLER_HTTP_HOST) ?? "127.0.0.1",
    httpAllowedHosts: parseAllowedHosts(env.BILLER_HTTP_ALLOWED_HOSTS),
    kapso: {
      configurado: kapso !== undefined,
      baseUrl: kapso?.baseUrl ?? null,
      phoneNumberIdConfigurado: kapso?.phoneNumberId !== undefined,
      destinatariosPermitidos: kapso?.destinatariosPermitidos.length ?? 0,
      idempotenciaPersistente: kapso?.idempotencyLogPath !== undefined,
      webhookHabilitado: kapso?.webhookSecret !== undefined,
      advertencias: advertenciasDestinatarios(kapso?.destinatariosPermitidos ?? []),
    },
    remitentes: (() => {
      const propios = parseDestinatarios(env.BILLER_REMITENTES_AUTORIZADOS);
      const efectivos = propios.length > 0 ? propios : (kapso?.destinatariosPermitidos ?? []);
      return {
        exigido: kapso !== undefined,
        autorizados: efectivos.length,
        fuente:
          propios.length > 0 ? "propia" : efectivos.length > 0 ? "destinatarios" : "ninguna",
        advertencias: advertenciasDestinatarios(propios),
      } as const;
    })(),
    enableIvaEstimado: parseBool(env.BILLER_ENABLE_IVA_ESTIMADO),
    idempotencyLogPath: rutas.idempotencyLogPath ?? null,
    webhookReplayLogPath: rutas.webhookReplayLogPath ?? null,
    webhookReplayTtlMs: parseEnteroPositivo(
      env.BILLER_WEBHOOK_REPLAY_TTL_MS,
      DEFAULT_WEBHOOK_REPLAY_TTL_MS,
      "BILLER_WEBHOOK_REPLAY_TTL_MS",
    ),
    webhookReplayMaxEntries: parseEnteroPositivo(
      env.BILLER_WEBHOOK_REPLAY_MAX_ENTRIES,
      DEFAULT_WEBHOOK_REPLAY_MAX_ENTRIES,
      "BILLER_WEBHOOK_REPLAY_MAX_ENTRIES",
    ),
    borradorStorePath: rutas.borradorStorePath ?? null,
    wireLiviano: parseBool(env.BILLER_WIRE_LIVIANO),
    maxMontos: parseLimitesMonto(env),
    valorUi: parseNumeroPositivo(env.BILLER_VALOR_UI, "BILLER_VALOR_UI", configWarnings) ?? null,
    valorUiFecha: parseFechaUi(env.BILLER_VALOR_UI_FECHA, configWarnings) ?? null,
    umbralUiReceptor:
      parseNumeroPositivo(env.BILLER_UMBRAL_UI_RECEPTOR, "BILLER_UMBRAL_UI_RECEPTOR", configWarnings) ?? null,
    cacheEnabled: parseBoolPrendido(env.BILLER_CACHE_ENABLED, "BILLER_CACHE_ENABLED"),
    httpSessionTtlMs: parseEnteroPositivo(
      env.BILLER_HTTP_SESSION_TTL_MS,
      DEFAULT_HTTP_SESSION_TTL_MS,
      "BILLER_HTTP_SESSION_TTL_MS",
    ),
    httpMaxSessions: parseEnteroPositivo(
      env.BILLER_HTTP_MAX_SESSIONS,
      DEFAULT_HTTP_MAX_SESSIONS,
      "BILLER_HTTP_MAX_SESSIONS",
    ),
    rateLimitDefaultRps,
    rateLimitDgiRps,
    configWarnings,
    missing,
  };
}
