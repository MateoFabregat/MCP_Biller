// =============================================================================
// Logger mínimo a STDERR.
//
// CRÍTICO: en transporte MCP stdio, stdout está reservado para el protocolo.
// Cualquier log debe ir a stderr para no corromper la comunicación.
//
// LA REDACCIÓN ES ESTRUCTURAL, NO UNA CONVENCIÓN.
//
// Decía "el logger nunca imprime el token porque los callers no se lo pasan", y
// eso es una convención: alcanza con que UN caller loguee el `message` crudo de
// un error de una dependencia —cosa que `http.request.error` hace— para que un
// secreto salga a stderr. Los secretos se registran al cargar cada
// configuración y a partir de ahí TODA línea que salga por acá pasa por el
// mismo filtro que las respuestas de las tools.
//
// LOS SECRETOS SE ACUMULAN, NO SE REEMPLAZAN.
//
// En multi-empresa, `loadConfig` corre una vez por tenant (al abrir sesión, al
// armar el contexto de una tool, y en CADA request en serverless), y cada
// corrida trae el token de UNA empresa. Si el registro reemplazara la lista en
// vez de sumarle, el token de la empresa A dejaría de estar protegido en
// cuanto la B cargara la suya: con veinte empresas en el mismo proceso, solo
// la última en cargar config queda redactada. Por eso `registrarSecretosParaLogs`
// agrega a un conjunto que vive mientras vive el proceso, y nunca lo vacía.
//
// El registro es best effort en el orden: lo que se loguee ANTES de que se
// cargue la primera config no tiene secretos que redactar, porque todavía no
// se leyeron.
// =============================================================================

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "info";
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Los secretos vivos del proceso. Los va sumando la carga de configuración de
 * cada empresa.
 *
 * Es un Set de módulo y no un parámetro porque el logger se usa desde 40
 * lugares que no tienen —ni deberían tener— acceso a la config. Un Set y no un
 * array porque lo que importa es la pertenencia, no el orden, y evita
 * duplicar el mismo secreto si dos tenants comparten alguna variable que no
 * gobierna aislamiento (p.ej. la misma KAPSO_WEBHOOK_SECRET a propósito).
 */
const secretos = new Set<string>();

/** Suma valores al conjunto de secretos a redactar en TODA línea de log. */
export function registrarSecretosParaLogs(valores: Array<string | undefined | null>): void {
  for (const v of valores) {
    if (typeof v === "string" && v.length >= 8) secretos.add(v);
  }
}

/**
 * Vacía el conjunto de secretos acumulados.
 *
 * SOLO para tests: sin esto, un test que registra un secreto lo deja vivo
 * para el resto de la suite, y otro test que emite ese mismo string por
 * casualidad lo vería redactado sin haber registrado nada.
 */
export function olvidarSecretosParaLogs(): void {
  secretos.clear();
}

function redactar(texto: string): string {
  let out = texto;
  for (const s of secretos) out = out.split(s).join("[REDACTED]");
  return out.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]");
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[currentLevel]) {
    return;
  }
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ? { meta } : {}),
  };
  // Se redacta el JSON YA SERIALIZADO: así se cubren los strings anidados a
  // cualquier profundidad del `meta` sin recorrer el objeto, y también el
  // propio `msg`. Un secreto partido por el escape de JSON no se reconstruye:
  // los tokens de este proyecto son alfanuméricos y no se escapan.
  // Siempre a stderr.
  process.stderr.write(`${redactar(JSON.stringify(line))}\n`);
}

export const logger = {
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
};
