// =============================================================================
// Carga y validación de variables de entorno.
//
// - `loadConfig`   : estricta. Lanza BillerConfigError si falta lo requerido.
//                    La usan las tools que llaman a Biller.
// - `inspectConfig`: tolerante. Nunca lanza y NUNCA expone el token.
//                    La usa `biller_health_check` para diagnosticar.
// =============================================================================

import { BillerConfigError } from "./utils/errors.js";
import { parseLimitesMonto, type LimitesMonto } from "./write/limiteMonto.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export type BillerEnvironment = "test" | "production";

/**
 * Modo operativo central del servidor MCP.
 * - `read_only`    : solo se registran las 6 tools de lectura (default seguro).
 * - `write_enabled`: se registran también las 6 tools de escritura (con barreras).
 *
 * Controlado por la variable de entorno `BILLER_CAPABILITY_MODE`.
 * Default: `read_only`.
 */
export type BillerCapabilityMode = "read_only" | "write_enabled";

function parseCapabilityMode(raw: string | undefined): BillerCapabilityMode {
  return (raw ?? "").trim().toLowerCase() === "write_enabled" ? "write_enabled" : "read_only";
}

export interface BillerConfig {
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
   * expresado en UI. La UI cambia todos los días y NO está en la API de Biller,
   * así que el valor se configura acá. Sin esto el chequeo igual se hace, con un
   * valor de referencia conservador y avisando que es aproximado: un aviso de
   * más cuesta una pregunta, uno de menos cuesta un comprobante mal emitido.
   */
  valorUi?: number;
  valorUiFecha?: string;
  /** Umbral en UI para exigir receptor. Default 5000 (ver requisitos.ts). */
  umbralUiReceptor?: number;
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

function parseKapso(env: Env): KapsoConfig | undefined {
  const apiKey = trimOrUndefined(env.KAPSO_API_KEY);
  if (apiKey === undefined) return undefined;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(trimOrUndefined(env.KAPSO_API_BASE_URL) ?? DEFAULT_KAPSO_BASE_URL),
    phoneNumberId: trimOrUndefined(env.KAPSO_PHONE_NUMBER_ID),
    destinatariosPermitidos: parseDestinatarios(env.KAPSO_DESTINATARIOS_PERMITIDOS),
    webhookSecret: trimOrUndefined(env.KAPSO_WEBHOOK_SECRET),
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback;
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

/** Número positivo o undefined. Tolerante: un valor basura no rompe el arranque. */
function parseNumeroPositivo(raw: string | undefined): number | undefined {
  const t = (raw ?? "").trim().replace(",", ".");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseBool(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
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
  /** Nombres de variables requeridas que faltan. */
  missing: string[];
}

type Env = Record<string, string | undefined>;

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
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

  if (missing.length > 0) {
    throw new BillerConfigError(
      `Faltan variables de entorno requeridas: ${missing.join(", ")}. ` +
        `Configurá un archivo .env (ver .env.example) o exportalas en el entorno.`,
    );
  }

  // En este punto baseUrlRaw y token están definidos.
  const apiBaseUrl = normalizeBaseUrl(baseUrlRaw!);
  return {
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
    auditLogPath: trimOrUndefined(env.BILLER_AUDIT_LOG_PATH),
    capabilityMode: parseCapabilityMode(env.BILLER_CAPABILITY_MODE),
    httpAuthToken: trimOrUndefined(env.BILLER_HTTP_AUTH_TOKEN),
    httpPort: parsePort(env.BILLER_HTTP_PORT, DEFAULT_HTTP_PORT),
    httpHost: trimOrUndefined(env.BILLER_HTTP_HOST) ?? "127.0.0.1",
    httpAllowedHosts: parseAllowedHosts(env.BILLER_HTTP_ALLOWED_HOSTS),
    kapso: parseKapso(env),
    remitentesAutorizados: parseDestinatarios(env.BILLER_REMITENTES_AUTORIZADOS),
    enableIvaEstimado: parseBool(env.BILLER_ENABLE_IVA_ESTIMADO),
    idempotencyLogPath: trimOrUndefined(env.BILLER_IDEMPOTENCY_LOG_PATH),
    borradorStorePath: trimOrUndefined(env.BILLER_BORRADOR_STORE_PATH),
    wireLiviano: parseBool(env.BILLER_WIRE_LIVIANO),
    maxMontos: parseLimitesMonto(env),
    valorUi: parseNumeroPositivo(env.BILLER_VALOR_UI),
    valorUiFecha: trimOrUndefined(env.BILLER_VALOR_UI_FECHA),
    umbralUiReceptor: parseNumeroPositivo(env.BILLER_UMBRAL_UI_RECEPTOR),
  };
}

/**
 * Inspección tolerante para diagnóstico. NUNCA lanza, NUNCA expone el token
 * (solo informa `hasToken`).
 */
export function inspectConfig(env: Env = process.env): ConfigInspection {
  const baseUrlRaw = trimOrUndefined(env.BILLER_API_BASE_URL);
  const token = trimOrUndefined(env.BILLER_API_TOKEN);

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push("BILLER_API_BASE_URL");
  if (!token) {
    missing.push("BILLER_API_TOKEN");
  } else if (token.length < 8) {
    // Mismo mínimo que loadConfig: si no, biller_health_check reporta "ok"
    // para un token que haría fallar toda llamada con BillerConfigError.
    missing.push("BILLER_API_TOKEN debe tener al menos 8 caracteres");
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    timeoutMs = parseTimeout(env.BILLER_TIMEOUT_MS);
  } catch {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  const apiBaseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : null;
  const kapso = parseKapso(env);
  return {
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
    auditLogPath: trimOrUndefined(env.BILLER_AUDIT_LOG_PATH) ?? null,
    capabilityMode: parseCapabilityMode(env.BILLER_CAPABILITY_MODE),
    httpAuthTokenConfigurado: trimOrUndefined(env.BILLER_HTTP_AUTH_TOKEN) !== undefined,
    httpPort: parsePort(env.BILLER_HTTP_PORT, DEFAULT_HTTP_PORT),
    httpHost: trimOrUndefined(env.BILLER_HTTP_HOST) ?? "127.0.0.1",
    httpAllowedHosts: parseAllowedHosts(env.BILLER_HTTP_ALLOWED_HOSTS),
    kapso: {
      configurado: kapso !== undefined,
      baseUrl: kapso?.baseUrl ?? null,
      phoneNumberIdConfigurado: kapso?.phoneNumberId !== undefined,
      destinatariosPermitidos: kapso?.destinatariosPermitidos.length ?? 0,
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
    idempotencyLogPath: trimOrUndefined(env.BILLER_IDEMPOTENCY_LOG_PATH) ?? null,
    borradorStorePath: trimOrUndefined(env.BILLER_BORRADOR_STORE_PATH) ?? null,
    wireLiviano: parseBool(env.BILLER_WIRE_LIVIANO),
    maxMontos: parseLimitesMonto(env),
    valorUi: parseNumeroPositivo(env.BILLER_VALOR_UI) ?? null,
    valorUiFecha: trimOrUndefined(env.BILLER_VALOR_UI_FECHA) ?? null,
    umbralUiReceptor: parseNumeroPositivo(env.BILLER_UMBRAL_UI_RECEPTOR) ?? null,
    missing,
  };
}
