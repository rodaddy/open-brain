/**
 * Settings the legacy logger used to read straight from `process.env`.
 *
 * The module under `server/` may not read the environment, so each former
 * `process.env` read becomes a field here and arrives through a registered
 * reader (issue 864, rule M13a). A reader rather than a snapshot because the
 * original read three of these values lazily, inside function bodies, and the
 * suites around it mutate the environment of a spawned child after import.
 */
export interface LegacyLoggerSettings {
  /** `LOG_LEVEL` — initial minimum level; an unknown value falls back to info. */
  readonly logLevel: string | undefined;
  /** `HOSTNAME`, then `HOST` — host label, before `os.hostname()` is tried. */
  readonly hostName: string | undefined;
  /** `LOG_FILE` — absolute path enabling the rotating file sink. */
  readonly logFile: string | undefined;
  /** `LOG_MAX_BYTES` — rotate threshold in bytes. */
  readonly logMaxBytes: string | undefined;
  /** `LOG_MAX_FILES` — rotated files retained beyond the active file. */
  readonly logMaxFiles: string | undefined;
  /** `SERVICE_NAME` — service label; empty falls back to `open-brain`. */
  readonly serviceName: string | undefined;
  /** `OPEN_BRAIN_WORKER_NAME` — suffixes the service label and the log path. */
  readonly workerName: string | undefined;
}

/** Reader shape: every former env read calls this at its original moment. */
export type LegacyLoggerSettingsReader = () => LegacyLoggerSettings;

/**
 * Env-absent defaults.
 *
 * Registered before anything else, so a script or a test that imports a
 * `server/` module directly — without going through the `src/logger.ts`
 * adapter or `server/main.ts` — logs exactly as it did when no relevant
 * variable was set: level `info`, service `open-brain`, no file sink.
 */
const ABSENT: LegacyLoggerSettings = {
  logLevel: undefined,
  hostName: undefined,
  logFile: undefined,
  logMaxBytes: undefined,
  logMaxFiles: undefined,
  serviceName: undefined,
  workerName: undefined,
};

let reader: LegacyLoggerSettingsReader = () => ABSENT;

/**
 * Install the reader supplying the legacy logger's former env values.
 *
 * @param read Called at each of the original read moments, never cached here.
 * @returns The reader previously installed, so a caller can restore it.
 */
export function setLegacyLoggerSettingsReader(
  read: LegacyLoggerSettingsReader,
): LegacyLoggerSettingsReader {
  const previous = reader;
  reader = read;
  return previous;
}

/** The settings currently in effect, read at the caller's moment. */
export function readLegacyLoggerSettings(): LegacyLoggerSettings {
  return reader();
}
