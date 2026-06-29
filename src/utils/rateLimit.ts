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

/** Limiters compartidos a nivel proceso para que el espaciado persista. */
export interface RateLimiters {
  default: RateLimiter;
  dgi: RateLimiter;
}

export function createDefaultRateLimiters(): RateLimiters {
  return {
    // 30 req/seg -> ~34 ms entre requests.
    default: new IntervalRateLimiter(Math.ceil(1000 / 30)),
    // 1 req/seg para DGI y recibidos.
    dgi: new IntervalRateLimiter(1000),
  };
}
