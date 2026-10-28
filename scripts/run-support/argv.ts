/**
 * Argv reading and the console logger shim shared by the `scripts/*-run.ts`
 * operator entrypoints. Issue 841 (duplicate-code census, class B).
 *
 * Eight runners each carried a byte-identical `arg()`/`has()` pair and a
 * near-identical inline logger object. This module is the one home for both.
 * It is deliberately generic -- nothing here knows what a runner does.
 *
 * `process.argv` is read at call time, not snapshotted at import, so a test
 * may set `process.argv` and call these directly.
 */

/**
 * The value following `name` on the command line, or `undefined` when the flag
 * is absent (or is the last token, with nothing after it).
 */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Whether `name` appears on the command line at all. */
export function has(name: string): boolean {
  return process.argv.includes(name);
}

/** Fields a runner attaches to a log line. */
export type LogFields = Record<string, unknown>;

/**
 * The shim shape the maintenance modules accept: `info`/`warn`/`error`, each
 * taking a message and a field bag. Callers whose module type requires only a
 * subset can pass this whole object -- extra methods are structurally fine.
 */
export interface RunLogger {
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}

export interface RunLoggerOptions {
  /**
   * Prepended to every message, per level. Used by the whole-pipeline runner
   * to indent and mark stage output beneath its stage heading. A missing level
   * gets no prefix.
   */
  readonly prefix?: { info?: string; warn?: string; error?: string };
  /**
   * Send `info` to stderr instead of stdout. Runners whose stdout IS the
   * payload (a `--json` dump) need their log lines out of that stream.
   */
  readonly infoToStderr?: boolean;
}

/**
 * A console-backed logger: message first, then the fields as JSON. Absent or
 * empty fields print nothing after the message, which keeps a bare
 * informational line readable in a terminal.
 */
export function createConsoleLogger(options: RunLoggerOptions = {}): RunLogger {
  const { prefix = {}, infoToStderr = false } = options;
  const emit =
    (write: (message: string, extra: string) => void, marker = "") =>
    (message: string, fields?: LogFields): void => {
      const rendered =
        fields && Object.keys(fields).length > 0 ? JSON.stringify(fields) : "";
      write(`${marker}${message}`, rendered);
    };
  return {
    info: emit(
      (m, extra) => (infoToStderr ? console.error(m, extra) : console.log(m, extra)),
      prefix.info,
    ),
    warn: emit((m, extra) => console.warn(m, extra), prefix.warn),
    error: emit((m, extra) => console.error(m, extra), prefix.error),
  };
}
