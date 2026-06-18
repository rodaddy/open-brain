import { createHash } from "node:crypto";
import { logger } from "./logger.ts";

const rawTimeout = parseInt(process.env.EMBEDDING_TIMEOUT_MS ?? "8000", 10);
const EMBEDDING_TIMEOUT_MS = Number.isNaN(rawTimeout) ? 8000 : rawTimeout;
const rawDimensions = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "768", 10);
export const EMBEDDING_DIMENSIONS =
  Number.isNaN(rawDimensions) || rawDimensions <= 0 ? 768 : rawDimensions;

const MAX_RETRIES = 2;
const BACKOFF_DELAYS_MS = [200, 800];

/**
 * Embedding model identifier. Used by embedding.ts to call the provider and stored
 * in embedding_model columns so we can track which model produced each vector.
 * Override via EMBEDDING_MODEL env var (must match the provider deployment name).
 */
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

export interface EmbeddingError {
  code:
    | "timeout"
    | "network"
    | "server_error"
    | "client_error"
    | "malformed_response"
    | "input_invalid"
    | "no_embedding_url";
  message: string;
  attempts: number;
  lastStatus?: number;
}

export interface EmbeddingResult {
  embedding: number[] | null;
  error?: EmbeddingError;
}

export interface EmbeddingOptions {
  signal?: AbortSignal;
}

/**
 * Classify whether an error or HTTP status is transient and worth retrying.
 * Only 5xx, AbortError (timeout), and network-level errors are retried.
 * 4xx errors are never retried.
 */
function isTransient(err: unknown, status?: number): boolean {
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (status !== undefined && status >= 500) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ENETUNREACH") ||
      msg.includes("fetch failed")
    ) {
      return true;
    }
  }
  return false;
}

function classifyError(err: unknown, status?: number): EmbeddingError["code"] {
  if (err instanceof DOMException && err.name === "AbortError") return "timeout";
  if (status !== undefined && status >= 500) return "server_error";
  if (err instanceof Error) return "network";
  return "network";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function embeddingBaseUrl(explicitUrl?: string): string | undefined {
  const raw = explicitUrl ?? process.env.EMBEDDING_BASE_URL;
  return raw?.replace(/\/+$/, "");
}

function embeddingApiKey(): string | undefined {
  return process.env.EMBEDDING_API_KEY;
}

export async function generateEmbeddingWithMetadata(
  text: string,
  embeddingUrl?: string,
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  if (!text || text.trim().length === 0 || text.length > 32000) {
    const msg = "Embedding text empty or too long";
    logger.warn(msg, { length: text?.length ?? 0 });
    return {
      embedding: null,
      error: {
        code: "input_invalid",
        message: msg,
        attempts: 0,
      },
    };
  }

  const baseUrl = embeddingBaseUrl(embeddingUrl);
  if (!baseUrl) {
    const msg = "No embedding URL configured";
    logger.warn(msg);
    return {
      embedding: null,
      error: {
        code: "no_embedding_url",
        message: msg,
        attempts: 0,
      },
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = embeddingApiKey();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  let lastError: unknown = null;
  let lastStatus: number | undefined;
  const totalAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, {
        once: true,
      });
    }
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
    const start = Date.now();

    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      lastStatus = response.status;

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);

        // 4xx: don't retry
        if (response.status >= 400 && response.status < 500) {
          const code: EmbeddingError["code"] =
            response.status === 400 || response.status === 422
              ? "input_invalid"
              : response.status === 401 || response.status === 403
                ? "client_error"
                : "client_error";
          const msg = `Embedding provider returned ${response.status}`;
          logger.error("Embedding provider request failed (non-retryable)", {
            status: response.status,
            attempts: attempt,
          });
          return {
            embedding: null,
            error: {
              code,
              message: msg,
              attempts: attempt,
              lastStatus: response.status,
            },
          };
        }

        // 5xx: retry if attempts remain
        if (attempt < totalAttempts) {
          const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 800;
          logger.warn("Embedding request failed, retrying", {
            attempt,
            status: response.status,
            code: "server_error",
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }

        // Final attempt exhausted
        logger.error("Embedding request failed after all attempts", {
          status: response.status,
          attempts: attempt,
        });
        return {
          embedding: null,
          error: {
            code: "server_error",
            message: `Embedding provider returned ${response.status} after ${attempt} attempt(s)`,
            attempts: attempt,
            lastStatus: response.status,
          },
        };
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding?: unknown }>;
      };

      const embedding = json.data?.[0]?.embedding;

      if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
        const msg = "Embedding provider returned malformed embedding";
        logger.error(msg, {
          hasData: !!json.data,
          length: Array.isArray(embedding) ? embedding.length : "not-array",
          expectedLength: EMBEDDING_DIMENSIONS,
          attempts: attempt,
        });
        return {
          embedding: null,
          error: {
            code: "malformed_response",
            message: msg,
            attempts: attempt,
            lastStatus: response.status,
          },
        };
      }

      const latency = Date.now() - start;
      logger.info("Embedding generated", { latencyMs: latency, attempt });

      return { embedding: embedding as number[] };
    } catch (err) {
      lastError = err;

      if (!isTransient(err)) {
        const code = classifyError(err);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Embedding request failed (non-retryable)", {
          error: msg,
          attempts: attempt,
        });
        return {
          embedding: null,
          error: {
            code,
            message: msg,
            attempts: attempt,
            lastStatus,
          },
        };
      }

      if (attempt < totalAttempts) {
        const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 800;
        const code = classifyError(err);
        logger.warn("Embedding request failed, retrying", {
          attempt,
          code,
          error: err instanceof Error ? err.message : String(err),
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }

      // Final attempt exhausted
      const code = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Embedding request failed after all attempts", {
        error: msg,
        code,
        attempts: attempt,
      });
      return {
        embedding: null,
        error: {
          code,
          message: `${msg} after ${attempt} attempt(s)`,
          attempts: attempt,
          lastStatus,
        },
      };
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }

  // Should never reach here, but TypeScript needs it
  const code = classifyError(lastError);
  return {
    embedding: null,
    error: {
      code,
      message: "Unexpected: exhausted all attempts",
      attempts: totalAttempts,
      lastStatus,
    },
  };
}

/**
 * Generate a 768-dimensional embedding vector for the given text.
 * Returns null on any failure (timeout, network, bad response, etc.).
 */
export async function generateEmbedding(
  text: string,
  embeddingUrl?: string,
  options: EmbeddingOptions = {},
): Promise<number[] | null> {
  const result = await generateEmbeddingWithMetadata(text, embeddingUrl, options);
  return result.embedding;
}

export function contentHash(text: string): string {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}
