import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chunkText } from "./chunking.ts";
import { logger } from "../../src/logger.ts";
import type { EmbeddingConfigGroup } from "../config/src-readers.ts";
import {
  classifyError,
  classifyHttpFailure,
  classifyThrownFailure,
  decodeEmbeddingResponse,
} from "./provider-attempt.ts";

/**
 * Every environment-derived value this module used to read from `process.env`.
 *
 * The four watchdog and provider fields reuse `EmbeddingConfigGroup`
 * (`server/config/src-readers.ts`) unchanged — `timeoutMs`, `dimensions`,
 * `model`, and the nested `watchdog` group carrying `failureThreshold`,
 * `cooldownMs`, and the optional `restartScript`. The two transport fields
 * mirror `config.transport.embeddingBaseUrl` and `config.transport.embeddingApiKey`
 * (`server/config.ts:251-252`), which are the same `readonly string | undefined`
 * there.
 */
export interface EmbeddingProviderSettings extends EmbeddingConfigGroup {
  /** `config.transport.embeddingBaseUrl` — absent means nothing is configured. */
  readonly baseUrl?: string;
  /** `config.transport.embeddingApiKey` — absent means no Authorization header. */
  readonly apiKey?: string;
}

/**
 * The values this module answers with before any caller registers a reader.
 *
 * These are exactly what the former `process.env` reads computed when every
 * `EMBEDDING_*` key was absent: timeout 8000 ms, 768 dimensions, model
 * `gemini-embedding-001`, watchdog failure threshold 2, watchdog cooldown
 * 300000 ms, no restart script, no base URL, and no API key.
 */
const DEFAULT_SETTINGS: EmbeddingProviderSettings = {
  timeoutMs: 8000,
  dimensions: 768,
  model: "gemini-embedding-001",
  watchdog: {
    failureThreshold: 2,
    cooldownMs: 300000,
  },
};

let readSettings: () => EmbeddingProviderSettings = () => DEFAULT_SETTINGS;

/**
 * Register the function this module calls for every environment-derived value.
 *
 * A READER rather than a snapshot, because every former read happened inside a
 * function body at the moment it was needed: a caller that changes its own
 * source between two calls changes the answer, exactly as flipping
 * `process.env` between two calls did. Returns the reader it replaced so a
 * caller can restore it. Replacement is announced and never refused — the
 * `src/` adapter registers at import and `server/main.ts` registers afterwards,
 * so in the server runtime main's reader is the one that answers.
 */
export function setEmbeddingSettingsReader(
  read: () => EmbeddingProviderSettings,
): () => EmbeddingProviderSettings {
  const previous = readSettings;
  readSettings = read;
  logger.debug("embedding_settings_reader_replaced", {});
  return previous;
}

/**
 * Embedding model identifier. Used to call the provider and stored in
 * embedding_model columns so we can track which model produced each vector.
 * A reader rather than a constant: the value now arrives from the registered
 * settings reader, which may answer differently between two calls.
 */
export function embeddingModel(): string {
  return readSettings().model;
}

/** Vector width the provider is asked for and the response is checked against. */
export function embeddingDimensions(): number {
  return readSettings().dimensions;
}

const MAX_RETRIES = 2;
const WATCHDOG_RESTARTABLE_CODES = new Set<EmbeddingError["code"]>([
  "timeout",
  "network",
  "server_error",
]);

let lastFailureCode: EmbeddingError["code"] | null = null;
let consecutiveRestartableFailures = 0;
let lastWatchdogRestartAt = 0;
let watchdogRestartInFlight = false;
let restartProcessSpawner = (restartScript: string): ChildProcess =>
  spawn(restartScript, {
    detached: true,
    stdio: "ignore",
  });

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
  usageDetails?: Record<string, number>;
}

export interface EmbeddingOptions {
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function watchdogFailureThreshold(): number {
  return readSettings().watchdog.failureThreshold;
}

function watchdogCooldownMs(): number {
  return readSettings().watchdog.cooldownMs;
}

function resetWatchdogFailures(): void {
  lastFailureCode = null;
  consecutiveRestartableFailures = 0;
}

function recordWatchdogFailure(error: EmbeddingError): void {
  if (!WATCHDOG_RESTARTABLE_CODES.has(error.code)) {
    resetWatchdogFailures();
    return;
  }

  lastFailureCode = error.code;
  consecutiveRestartableFailures += 1;

  logger.warn("embedding_watchdog_failure_recorded", {
    code: error.code,
    consecutiveFailures: consecutiveRestartableFailures,
    threshold: watchdogFailureThreshold(),
  });

  if (consecutiveRestartableFailures >= watchdogFailureThreshold()) {
    triggerEmbeddingWatchdogRestart(error.code);
  }
}

function triggerEmbeddingWatchdogRestart(code: EmbeddingError["code"]): void {
  const restartScript = readSettings().watchdog.restartScript;
  if (!restartScript) return;

  const now = Date.now();
  const cooldownMs = watchdogCooldownMs();
  if (watchdogRestartInFlight) {
    logger.warn("embedding_watchdog_restart_skipped", {
      code,
      reason: "restart_in_flight",
    });
    return;
  }
  if (now - lastWatchdogRestartAt < cooldownMs) {
    logger.warn("embedding_watchdog_restart_skipped", {
      code,
      reason: "cooldown",
      cooldownMs,
    });
    return;
  }

  watchdogRestartInFlight = true;

  logger.error("embedding_watchdog_restart_triggered", {
    code,
    restartScript,
  });

  let child: ChildProcess;
  try {
    child = restartProcessSpawner(restartScript);
  } catch (err) {
    watchdogRestartInFlight = false;
    logger.error("embedding_watchdog_restart_failed", {
      error: err instanceof Error ? err.message : String(err),
      restartScript,
    });
    return;
  }

  child.once("error", (err) => {
    watchdogRestartInFlight = false;
    logger.error("embedding_watchdog_restart_failed", {
      error: err.message,
      restartScript,
    });
  });

  child.once("spawn", () => {
    child.unref();
  });

  child.once("close", (exitCode) => {
    watchdogRestartInFlight = false;
    if (exitCode !== 0) {
      logger.error("embedding_watchdog_restart_failed", {
        exitCode,
        restartScript,
      });
      return;
    }

    lastWatchdogRestartAt = Date.now();
    resetWatchdogFailures();
    logger.warn("embedding_watchdog_restart_completed", {
      restartScript,
    });
  });
}

export function __resetEmbeddingWatchdogForTests(): void {
  resetWatchdogFailures();
  lastWatchdogRestartAt = 0;
  watchdogRestartInFlight = false;
  restartProcessSpawner = (restartScript: string): ChildProcess =>
    spawn(restartScript, {
      detached: true,
      stdio: "ignore",
    });
}

export function __setEmbeddingWatchdogRestartSpawnerForTests(
  spawner: typeof restartProcessSpawner,
): void {
  restartProcessSpawner = spawner;
}

export function getEmbeddingProviderDiagnostics(): {
  configured: boolean;
  model: string;
  dimensions: number;
  last_failure_code: EmbeddingError["code"] | null;
  consecutive_restartable_failures: number;
  restart_configured: boolean;
  restart_in_flight: boolean;
  last_restart_at: string | null;
} {
  return {
    configured: Boolean(embeddingBaseUrl()),
    model: embeddingModel(),
    dimensions: embeddingDimensions(),
    last_failure_code: lastFailureCode,
    consecutive_restartable_failures: consecutiveRestartableFailures,
    restart_configured: Boolean(readSettings().watchdog.restartScript),
    restart_in_flight: watchdogRestartInFlight,
    last_restart_at:
      lastWatchdogRestartAt > 0 ? new Date(lastWatchdogRestartAt).toISOString() : null,
  };
}

function embeddingFailure(error: EmbeddingError): EmbeddingResult {
  recordWatchdogFailure(error);
  return { embedding: null, error };
}

export function embeddingBaseUrl(explicitUrl?: string): string | undefined {
  const raw = explicitUrl ?? readSettings().baseUrl;
  return raw?.replace(/\/+$/, "");
}

export function embeddingApiKey(): string | undefined {
  return readSettings().apiKey;
}

/**
 * Longest text sent to the provider in ONE request.
 *
 * A REQUEST-SHAPING number, not an acceptance rule. Text longer than this is
 * embedded in segments and combined; nothing is refused and nothing is cut.
 *
 * WHAT THIS REPLACES, and why the old number described nothing. The previous
 * `text.length > 32000` branch returned {embedding: null} for the WHOLE input,
 * so a caller stored a row no semantic search could ever reach. Measured
 * 2026-07-30 against the embedder actually configured here
 * (embeddinggemma-300m-8bit at EMBEDDING_BASE_URL, .env:24): the server accepts
 * 64,000 characters and answers HTTP 200 with a valid 768-dim vector, so 32,000
 * was not its limit. Two upstream modules (distiller.ts, distill-exchange.ts)
 * cut their own content citing that number as a hard provider constraint.
 *
 * WHY SEGMENT AT ALL, since the server accepts long input. The same measurement
 * embedded `<filler> + <distinct tail>` at increasing filler lengths and
 * compared the two vectors: cosine rose 0.79 (8k) -> 0.96 (16k) -> 0.995 (30k)
 * -> exactly 1.000000000 (60k). At 60,000 the tail stops changing the vector at
 * all -- the server truncates internally and still returns 200. Below that the
 * tail is not lost but is increasingly diluted. Segmenting keeps every part of
 * the text at full weight in its own vector instead of drowned in one.
 */
const EMBEDDING_SEGMENT_CHARS = 6000;

/**
 * Overlap between adjacent segments, in characters.
 *
 * 20% of a segment. A claim that straddles a seam appears whole in both
 * neighbours, so it is embedded in context at least once rather than split
 * across two vectors that each hold half of it. Matches the ratio
 * src/chunking.ts already uses for its own defaults (200 of 2000).
 */
const EMBEDDING_SEGMENT_OVERLAP = 1200;

/**
 * Combine segment vectors into the one vector stored for the whole text.
 *
 * Length-weighted so a 6,000-char segment is not outvoted by a 400-char
 * remainder, then L2-normalised because these vectors are compared by cosine
 * distance, which assumes unit length.
 */
function combineEmbeddings(
  segments: readonly { embedding: number[]; weight: number }[],
): number[] {
  const dimensions = embeddingDimensions();
  const summed: number[] = Array.from({ length: dimensions }, () => 0);
  let totalWeight = 0;
  for (const segment of segments) {
    totalWeight += segment.weight;
    for (let i = 0; i < dimensions; i++) {
      summed[i] = (summed[i] ?? 0) + (segment.embedding[i] ?? 0) * segment.weight;
    }
  }
  if (totalWeight > 0) {
    for (let i = 0; i < dimensions; i++) {
      summed[i] = (summed[i] ?? 0) / totalWeight;
    }
  }
  let norm = 0;
  for (const value of summed) norm += value * value;
  norm = Math.sqrt(norm);
  // A zero vector has no direction to normalise. Returning it unchanged is
  // correct -- it is what the provider produced, and inventing a direction
  // would silently place the row somewhere in the space it does not belong.
  if (norm === 0) return summed;
  return summed.map((value) => value / norm);
}

export async function generateEmbeddingWithMetadata(
  text: string,
  embeddingUrl?: string,
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  if (!text || text.trim().length === 0) {
    const msg = "Embedding text empty";
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

  // LONG TEXT IS EMBEDDED, NOT REFUSED AND NOT CUT. chunkText splits on
  // sentence boundaries with overlap, so no segment begins mid-sentence and
  // the seam between two segments appears in both.
  if (text.length > EMBEDDING_SEGMENT_CHARS) {
    return embedSegmented(text, embeddingUrl, options);
  }

  return embedOnce(text, embeddingUrl, options);
}

/** Embed text too long for one request, as overlapping segments combined. */
async function embedSegmented(
  text: string,
  embeddingUrl?: string,
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  const segments = chunkText(text, EMBEDDING_SEGMENT_CHARS, EMBEDDING_SEGMENT_OVERLAP);
  logger.info("embedding_segmented", {
    length: text.length,
    segments: segments.length,
  });
  const embedded: { embedding: number[]; weight: number }[] = [];
  const usageDetails: Record<string, number> = {};
  for (const segment of segments) {
    const result = await embedOnce(segment.text, embeddingUrl, options);
    // One failed segment fails the whole embedding. Combining the survivors
    // would return a vector silently representing only PART of the text --
    // a wrong answer wearing the shape of a right one, which is the failure
    // mode this whole change exists to remove.
    if (result.embedding === null) {
      logger.error("embedding_segment_failed", {
        segment_index: segment.index,
        segments: segments.length,
        length: text.length,
        code: result.error?.code ?? "unknown",
      });
      return result;
    }
    embedded.push({
      embedding: result.embedding,
      weight: segment.text.length,
    });
    for (const [key, value] of Object.entries(result.usageDetails ?? {})) {
      usageDetails[key] = (usageDetails[key] ?? 0) + value;
    }
  }
  return {
    embedding: combineEmbeddings(embedded),
    ...(Object.keys(usageDetails).length === 0 ? {} : { usageDetails }),
  };
}

/** Everything one request needs, fixed before the first attempt is made. */
interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly expectedDimensions: number;
}

/**
 * Resolve the URL, headers, and body once for a request.
 *
 * The settings reader is consulted here rather than per attempt, which is where
 * the module constants were read before: the width asked for and the width the
 * answer is checked against must be the same number even if the reader answers
 * differently mid-flight.
 */
function prepareRequest(
  text: string,
  embeddingUrl?: string,
):
  | { error: EmbeddingError; value?: undefined }
  | { error?: undefined; value: PreparedRequest } {
  const baseUrl = embeddingBaseUrl(embeddingUrl);
  if (!baseUrl) {
    const message = "No embedding URL configured";
    logger.warn(message);
    return { error: { code: "no_embedding_url", message, attempts: 0 } };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = embeddingApiKey();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const expectedDimensions = embeddingDimensions();
  return {
    value: {
      url: `${baseUrl}/embeddings`,
      headers,
      body: JSON.stringify({
        model: embeddingModel(),
        input: text,
        dimensions: expectedDimensions,
      }),
      expectedDimensions,
    },
  };
}

/** Retry, stop with an error, or hand back a usable result. */
type AttemptResolution =
  | {
      readonly retry: true;
      readonly delayMs: number;
      readonly error?: undefined;
      readonly result?: undefined;
    }
  | {
      readonly retry: false;
      readonly error: EmbeddingError;
      readonly result?: undefined;
    }
  | {
      readonly retry: false;
      readonly error?: undefined;
      readonly result: EmbeddingResult;
    };

/**
 * Make ONE provider call, with its own abort wiring and timeout.
 *
 * The timeout is read per attempt, exactly where the former
 * `EMBEDDING_TIMEOUT_MS` constant was consulted in the loop body.
 */
async function runOneAttempt(input: {
  readonly request: PreparedRequest;
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly lastStatus?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly outcome: AttemptResolution;
  readonly status?: number;
  readonly thrown?: unknown;
}> {
  const { request, attempt, totalAttempts, lastStatus, signal } = input;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), readSettings().timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        outcome: classifyHttpFailure({
          status: response.status,
          attempt,
          totalAttempts,
        }),
        status: response.status,
        thrown: new Error(`HTTP ${response.status}`),
      };
    }

    const decoded = await decodeEmbeddingResponse({
      response,
      expectedDimensions: request.expectedDimensions,
      attempt,
    });
    if (decoded.error) {
      return {
        outcome: { retry: false, error: decoded.error },
        status: response.status,
      };
    }

    logger.info("Embedding generated", { latencyMs: Date.now() - start, attempt });
    return {
      outcome: { retry: false, result: decoded.result },
      status: response.status,
    };
  } catch (err) {
    return {
      outcome: classifyThrownFailure({
        err,
        attempt,
        totalAttempts,
        ...(lastStatus === undefined ? {} : { lastStatus }),
      }),
      thrown: err,
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function embedOnce(
  text: string,
  embeddingUrl?: string,
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  const request = prepareRequest(text, embeddingUrl);
  if (request.error) {
    return { embedding: null, error: request.error };
  }

  let lastError: unknown = null;
  let lastStatus: number | undefined;
  const totalAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const attempted = await runOneAttempt({
      request: request.value,
      attempt,
      totalAttempts,
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    lastStatus = attempted.status ?? lastStatus;
    lastError = attempted.thrown ?? lastError;

    if (attempted.outcome.retry) {
      await sleep(attempted.outcome.delayMs);
      continue;
    }
    if (attempted.outcome.error) {
      return embeddingFailure(attempted.outcome.error);
    }
    resetWatchdogFailures();
    return attempted.outcome.result;
  }

  // Should never reach here, but TypeScript needs it
  const code = classifyError(lastError);
  return embeddingFailure({
    code,
    message: "Unexpected: exhausted all attempts",
    attempts: totalAttempts,
    lastStatus,
  });
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
