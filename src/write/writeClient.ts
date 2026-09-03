// =============================================================================
// Cliente HTTP de ESCRITURA — ÚNICO módulo autorizado a hacer POST.
//
// Aislado a propósito en src/write/ para que el read-only guard estático pueda
// garantizar que ningún otro archivo escribe. Antes de cada POST:
//   - asserta el gate de escritura (write_enabled + producción) como red final,
//   - envía Authorization Bearer + Content-Type + Idempotency-Key,
//   - aplica timeout y rate limit,
//   - redacta el token de cualquier error.
//
// No expone GET ni otros métodos. Solo `post`.
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
import { createDefaultRateLimiters, type RateLimitClass, type RateLimiters } from "../utils/rateLimit.js";
import { assertWriteAllowed } from "./gate.js";
import { readTextBounded } from "../utils/boundedResponse.js";

export type WriteFetchImpl = typeof fetch;

export interface WriteClientDeps {
  fetchImpl?: WriteFetchImpl;
  rateLimiters?: RateLimiters;
}

export interface PostOptions {
  endpoint: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey: string;
  /** Confirmación del caller para producción (se valida contra el gate). */
  allowProduction: boolean;
  rateLimitClass?: RateLimitClass;
}

export interface PostResult<T = unknown> {
  status: number;
  data: T;
}

const MAX_BODY_SNIPPET = 600;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WRITE_METHOD = "POST" as const;

export class BillerWriteClient {
  private readonly fetchImpl: WriteFetchImpl;
  private readonly rateLimiters: RateLimiters;

  constructor(
    private readonly config: BillerConfig,
    deps: WriteClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new BillerNetworkError("fetch no está disponible. Usá Node >= 18 o proveé un fetch.");
    }
    this.rateLimiters = deps.rateLimiters ?? createDefaultRateLimiters();
  }

  async post<T = unknown>(options: PostOptions): Promise<PostResult<T>> {
    // Red final de seguridad: aunque el orquestador ya validó, re-asserta acá.
    assertWriteAllowed(this.config, { allowProduction: options.allowProduction });

    const url = this.buildUrl(options.endpoint, options.query);
    const limiterClass: RateLimitClass = options.rateLimitClass ?? "default";
    await this.rateLimiters[limiterClass].acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    logger.debug("biller.write.request", {
      endpoint: options.endpoint,
      environment: this.config.environment,
      rateLimitClass: limiterClass,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: WRITE_METHOD,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "Idempotency-Key": options.idempotencyKey,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (err) {
      if (controller.signal.aborted) throw new BillerTimeoutError(this.config.timeoutMs);
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
      logger.warn("biller.write.response.error", { status: res.status, endpoint: options.endpoint });
      throw new BillerApiError(res.status, snippet);
    }


    if (truncated) {
      throw new BillerParseError(
        `la respuesta supera el límite seguro de ${MAX_RESPONSE_BYTES} bytes. Acotá la operación.`,
      );
    }

    return { status: res.status, data: this.parseBody<T>(rawText) };
  }

  buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
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

  private async safeReadText(res: Response): Promise<{ text: string; truncated: boolean }> {
    try {
      return await readTextBounded(res, MAX_RESPONSE_BYTES);
    } catch {
      return { text: "", truncated: false };
    }
  }

  private parseBody<T>(text: string): T {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        throw new BillerParseError("la respuesta parecía JSON pero no se pudo parsear.");
      }
      return trimmed as unknown as T;
    }
  }

  private redact(input: string): string {
    return redactSecrets(input, [this.config.apiToken]);
  }
}
