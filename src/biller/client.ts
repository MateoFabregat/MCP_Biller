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

import { createHash } from "node:crypto";
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
import { readTextBounded } from "../utils/boundedResponse.js";

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
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class BillerClient {
  private readonly fetchImpl: FetchImpl;
  private readonly rateLimiters: RateLimiters;

  /**
   * Identidad OPACA de este cliente, para usar como parte de una clave de cache.
   *
   * Es un hash de (base URL + token), no el token. Dos motivos: con
   * multi-empresa, cachear sin distinguir la credencial le serviría a una
   * empresa los comprobantes de otra —el peor bug posible acá, y silencioso—; y
   * una clave de cache puede terminar en un log de diagnóstico, donde un token
   * no tiene nada que hacer.
   *
   * Vive en el cliente y no en el llamador a propósito: hay una docena de
   * lugares que consultan períodos, y "acordate de pasar la clave" es una
   * convención que alguien va a olvidar. Derivándola de quien hace la request,
   * no se puede omitir.
   */
  readonly cacheId: string;

  constructor(
    private readonly config: BillerConfig,
    deps: BillerClientDeps = {},
  ) {
    this.cacheId = createHash("sha256")
      .update(`${config.apiBaseUrl}\u0000${config.apiToken}`)
      .digest("hex")
      .slice(0, 32);
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
        redirect: "error",
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

    const { text: rawText, truncated } = await this.safeReadText(res);

    if (!res.ok) {
      const suffix = truncated ? " [respuesta truncada]" : "";
      const snippet = rawText
        ? `${this.redact(rawText).slice(0, MAX_BODY_SNIPPET)}${suffix}`
        : undefined;
      logger.warn("biller.response.error", { status: res.status, path: options.path });
      throw new BillerApiError(res.status, snippet);
    }

    if (truncated) {
      throw new BillerParseError(
        `la respuesta supera el límite seguro de ${MAX_RESPONSE_BYTES} bytes. Acotá la consulta.`,
      );
    }

    return this.parseBody<T>(rawText);
  }

  private async safeReadText(res: Response): Promise<{ text: string; truncated: boolean }> {
    try {
      return await readTextBounded(res, MAX_RESPONSE_BYTES);
    } catch {
      return { text: "", truncated: false };
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
