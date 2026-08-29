// L5 adapter (issue 864): legacy call form over server/embedding/provider.ts; retired with src/ at L6.
//
// The server/ module reads no environment. Legacy callers here, in scripts/,
// and in tests expect the zero-argument form that reads `EMBEDDING_*` at the
// moment of each call, plus the two module constants they import by name. This
// adapter registers a reader that parses `process.env` on every call, so those
// callers keep the behaviour they had, and computes the two constants at import
// time exactly as the original did.
import {
  setEmbeddingSettingsReader,
  type EmbeddingProviderSettings,
} from "../server/embedding/provider.ts";

function parseIntegerSetting(
  raw: string | undefined,
  fallback: number,
  accept: (value: number) => boolean,
): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Number.isNaN(parsed) || !accept(parsed) ? fallback : parsed;
}

/** Every `EMBEDDING_*` key, parsed the way the original module parsed it. */
export function readEmbeddingEnv(): EmbeddingProviderSettings {
  const restartScript = process.env.EMBEDDING_WATCHDOG_RESTART_SCRIPT;
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  return {
    timeoutMs: parseIntegerSetting(process.env.EMBEDDING_TIMEOUT_MS, 8000, () => true),
    dimensions: parseIntegerSetting(
      process.env.EMBEDDING_DIMENSIONS,
      768,
      (value) => value > 0,
    ),
    model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    watchdog: {
      failureThreshold: parseIntegerSetting(
        process.env.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD,
        2,
        (value) => value > 0,
      ),
      cooldownMs: parseIntegerSetting(
        process.env.EMBEDDING_WATCHDOG_COOLDOWN_MS,
        300000,
        (value) => value >= 0,
      ),
      ...(restartScript === undefined ? {} : { restartScript }),
    },
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

setEmbeddingSettingsReader(readEmbeddingEnv);

/**
 * Vector width, read once at import. Callers import this as a value and a test
 * re-imports this module with a cache-busting query to observe a new value.
 */
export const EMBEDDING_DIMENSIONS = readEmbeddingEnv().dimensions;

/** Provider deployment name, read once at import, as the original was. */
export const EMBEDDING_MODEL = readEmbeddingEnv().model;

export {
  contentHash,
  embeddingApiKey,
  embeddingBaseUrl,
  generateEmbedding,
  generateEmbeddingWithMetadata,
  getEmbeddingProviderDiagnostics,
  setEmbeddingSettingsReader,
  __resetEmbeddingWatchdogForTests,
  __setEmbeddingWatchdogRestartSpawnerForTests,
  type EmbeddingError,
  type EmbeddingOptions,
  type EmbeddingProviderSettings,
  type EmbeddingResult,
} from "../server/embedding/provider.ts";
