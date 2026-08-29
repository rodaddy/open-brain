// L5 adapter (issue 864): legacy call form over server/logging/legacy-logger.ts; retired with src/ at L6.
//
// The moved module reads no environment. Every value it used to take from
// `process.env` now arrives through a settings reader, and this adapter is
// what registers the reader that parses the environment exactly as the
// original module did — same keys, same precedence, same defaults — so every
// legacy `src/` caller, script and test keeps its behaviour unchanged.
//
// The reader is a function, not a snapshot: three of the original reads
// happened lazily inside function bodies, and the suites around this module
// set the environment of a spawned child after import.
import { setLegacyLoggerSettingsReader } from "../server/logging/legacy-logger-settings.ts";

setLegacyLoggerSettingsReader(() => ({
  logLevel: process.env.LOG_LEVEL,
  hostName: process.env.HOSTNAME?.trim() || process.env.HOST?.trim(),
  logFile: process.env.LOG_FILE,
  logMaxBytes: process.env.LOG_MAX_BYTES,
  logMaxFiles: process.env.LOG_MAX_FILES,
  serviceName: process.env.SERVICE_NAME,
  workerName: process.env.OPEN_BRAIN_WORKER_NAME,
}));

export * from "../server/logging/legacy-logger.ts";
