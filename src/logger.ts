// =============================================================================
// Logger mínimo a STDERR.
//
// CRÍTICO: en transporte MCP stdio, stdout está reservado para el protocolo.
// Cualquier log debe ir a stderr para no corromper la comunicación.
// El logger nunca recibe ni imprime el token (los callers no se lo pasan).
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
  // Siempre a stderr.
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
};
