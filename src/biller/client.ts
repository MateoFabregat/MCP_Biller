// =============================================================================
// Cliente HTTP de Biller — ESTRICTAMENTE GET-only.
//
// - Único método público: `get`.
// - No existe `post`/`put`/`patch`/`delete`. El request interno pasa por
//   `assertReadOnlyMethod`, que rechaza cualquier método != GET.
// - Bearer token desde config. El token NUNCA se incluye en errores ni logs.
// - Timeout configurable vía AbortController.
// - Rate limiting por clase (default / dgi).
// - Parseo robusto: Biller a veces responde JSON con content-type text/plain.
// =============================================================================

import type { BillerConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  BillerApiError,
  BillerNetworkError,
  BillerParseError,
  BillerTimeoutError,
  redactSecrets,
} from "../utils/errors.js";
import {
  createDefaultRateLimiters,
  type RateLimitClass,
  type RateLimiters,
} from "../utils/rateLimit.js";
import { ALLOWED_METHOD, assertReadOnlyMethod } from "./httpGuard.js";

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface BillerGetOptions {
  /** Path absoluto desde la base, p.ej. "/v2/comprobantes/obtener". */
  path: string;
  query?: QueryParams;
  /** Clase de rate limit. "dgi" = 1 req/seg; "default" = 30 req/seg. */
  rateLimitClass?: RateLimitClass;
  /** AbortSignal externo opcional (además del timeout interno). */
  signal?: AbortSignal;
}

export type FetchImpl = typeof fetch;

export interface BillerClientDeps {
  fetchImpl?: FetchImpl;
  rateLimiters?: RateLimiters;
}

const MAX_BODY_SNIPPET = 600;

export class BillerClient {
  private readonly fetchImpl: FetchImpl;
  private readonly rateLimiters: RateLimiters;

  constructor(
    private readonly config: BillerConfig,
    deps: BillerClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new BillerNetworkError(
        "fetch no está disponible en este runtime. Usá Node >= 18 o proveé un fetch.",
      );
    }
    this.rateLimiters = deps.rateLimiters ?? createDefaultRateLimiters();
  }

  /** Única operación pública. Lectura read-only contra Biller. */
  async get<T = unknown>(options: BillerGetOptions): Promise<T> {
    return this.request<T>(ALLOWED_METHOD, options);
  }

  /**
   * Request genérico interno. Rechaza cualquier método != GET mediante
   * `assertReadOnlyMethod`. No se expone públicamente.
   */
  private async request<T>(method: string, options: BillerGetOptions): Promise<T> {
    assertReadOnlyMethod(method);

    const url = this.buildUrl(options.path, options.query);
    const limiterClass: RateLimitClass = options.rateLimitClass ?? "default";
    await this.rateLimiters[limiterClass].acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // Encadenar abort externo si se provee.
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    logger.debug("biller.request", { method, path: options.path, rateLimitClass: limiterClass });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: ALLOWED_METHOD,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BillerTimeoutError(this.config.timeoutMs);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new BillerNetworkError(this.redact(message));
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await this.safeReadText(res);

    if (!res.ok) {
      const snippet = rawText ? this.redact(rawText).slice(0, MAX_BODY_SNIPPET) : undefined;
      logger.warn("biller.response.error", { status: res.status, path: options.path });
      throw new BillerApiError(res.status, snippet);
    }

    return this.parseBody<T>(rawText);
  }

  private async safeReadText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  /** Parsea como JSON; si no es JSON válido devuelve el texto crudo. */
  private parseBody<T>(text: string): T {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return undefined as unknown as T;
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Algunas respuestas DGI/recibidos llegan como text/plain con JSON dentro;
      // si igual no parsea, el contenido no es JSON y lo devolvemos como texto.
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        throw new BillerParseError("la respuesta parecía JSON pero no se pudo parsear.");
      }
      return trimmed as unknown as T;
    }
  }

  /** Construye la URL final normalizando base + path + query. */
  buildUrl(path: string, query?: QueryParams): string {
    const base = this.config.apiBaseUrl.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private redact(input: string): string {
    return redactSecrets(input, [this.config.apiToken]);
  }
}
