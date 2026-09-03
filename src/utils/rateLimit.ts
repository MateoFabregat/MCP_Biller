// =============================================================================
// Rate limiter simple por "clase" de operación.
//
// Biller documenta:
//   - 1 req/seg por token para consultas a DGI y comprobantes recibidos.
//   - 30 req/seg para el resto de las operaciones.
//
// Implementación: separación mínima entre inicios de request (no es un
// token-bucket sofisticado; alcanza para respetar el límite en un MVP local).
// =============================================================================

export interface RateLimiter {
  acquire(): Promise<void>;
}

/** Defaults published by Biller for the two request classes. */
export const DEFAULT_RATE_LIMIT_DEFAULT_RPS = 30;
export const DEFAULT_RATE_LIMIT_DGI_RPS = 1;

/**
 * A limiter configured above this ceiling is almost certainly a typo (and
 * would make the client ignore the upstream contract).  `config.ts` enforces
 * the same ceiling for values coming from the environment.
 */
export const MAX_RATE_LIMIT_RPS = 1_000;

/** Effective requests-per-second values used to build a context's limiters. */
export interface EffectiveRateLimits {
  defaultRps?: number;
  dgiRps?: number;
  // Accept the config-shaped names too.  This keeps the factory convenient for
  // callers that already have a BillerConfig without importing that type here.
  rateLimitDefaultRps?: number;
  rateLimitDgiRps?: number;
}

export interface RateLimiterFactoryDeps {
  /** Fake clock and wait function for deterministic tests. */
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  /** Alias useful to callers that describe this hook as `sleep`. */
  sleep?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Garantiza al menos `minIntervalMs` entre el inicio de dos `acquire()`. */
export class IntervalRateLimiter implements RateLimiter {
  private nextAvailable = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  async acquire(): Promise<void> {
    const now = this.now();
    const startAt = Math.max(now, this.nextAvailable);
    this.nextAvailable = startAt + this.minIntervalMs;
    const wait = startAt - now;
    if (wait > 0) {
      await this.sleepFn(wait);
    }
  }
}

/** No-op: usado en tests para evitar esperas reales. */
export class NoopRateLimiter implements RateLimiter {
  async acquire(): Promise<void> {
    /* sin espera */
  }
}

export type RateLimitClass = "default" | "dgi";

/**
 * El par de limiters de UN contexto de tools, o sea de UNA empresa.
 *
 * NO son de proceso, y la diferencia importa: el límite que estamos respetando
 * es el que Biller aplica POR TOKEN, así que compartir el espaciado entre
 * empresas haría que veinte tenants se estorbaran contra un límite que cada uno
 * tiene entero para sí. `createToolContext` arma un par propio por contexto, y
 * `ContextosPorTenant` crea un contexto por empresa; el espaciado persiste
 * porque el contexto vive, no porque el módulo tenga estado.
 */
export interface RateLimiters {
  default: RateLimiter;
  dgi: RateLimiter;
}

export function createDefaultRateLimiters(
  limits: EffectiveRateLimits = {},
  deps: RateLimiterFactoryDeps = {},
): RateLimiters {
  const configuredDefault = limits.defaultRps ?? limits.rateLimitDefaultRps;
  const configuredDgi = limits.dgiRps ?? limits.rateLimitDgiRps;
  const validRps = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= MAX_RATE_LIMIT_RPS
      ? value
      : fallback;
  const defaultRps = validRps(configuredDefault, DEFAULT_RATE_LIMIT_DEFAULT_RPS);
  const dgiRps = validRps(configuredDgi, DEFAULT_RATE_LIMIT_DGI_RPS);
  const now = deps.now ?? (() => Date.now());
  const sleepFn = deps.sleepFn ?? deps.sleep ?? sleep;
  return {
    // 30 req/seg -> ~34 ms entre requests by default.
    default: new IntervalRateLimiter(Math.ceil(1000 / defaultRps), now, sleepFn),
    // 1 req/seg para DGI y recibidos by default.
    dgi: new IntervalRateLimiter(Math.ceil(1000 / dgiRps), now, sleepFn),
  };
}

/** Explicit name for new callers; the old factory remains source-compatible. */
export function createRateLimiters(
  limits: EffectiveRateLimits = {},
  deps: RateLimiterFactoryDeps = {},
): RateLimiters {
  return createDefaultRateLimiters(limits, deps);
}
