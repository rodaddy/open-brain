import { isSensitiveKey } from "../security/secret-patterns.ts";
import { redactForLog } from "./legacy-logger-redaction.ts";
import { getFileSink, getHostName, getServiceName } from "./legacy-logger-identity.ts";
import { readLegacyLoggerSettings } from "./legacy-logger-settings.ts";

export { redactForLog } from "./legacy-logger-redaction.ts";
export { deriveWorkerLogPath } from "./legacy-logger-identity.ts";
export {
  setLegacyLoggerSettingsReader,
  readLegacyLoggerSettings,
  type LegacyLoggerSettings,
  type LegacyLoggerSettingsReader,
} from "./legacy-logger-settings.ts";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function resolveLevel(): LogLevel {
  const configured = (readLegacyLoggerSettings().logLevel ?? "info").toLowerCase();
  if (configured in LOG_LEVELS) return configured as LogLevel;
  return "info";
}

/**
 * Active minimum level. Mutable, not a module-load constant.
 *
 * A frozen level means the only way to raise verbosity during an incident is a
 * restart — which destroys the in-flight state being investigated, and is the
 * one moment the logs matter most. `setLogLevel` lets an operator turn debug on
 * against a running process (the dogfood default is `debug`; production runs
 * `info` or `warn`).
 *
 * Initialized on FIRST USE rather than at module load (issue 864): the value
 * used to come from a module-scope environment read, and deferring it to the
 * first `getEffectiveLevel()` call preserves the single read while giving the
 * adapter and `server/main.ts` their chance to register a settings reader
 * during import. `setLogLevel` before any emission still wins, because it
 * assigns the resolved slot directly.
 */
let minLevel: LogLevel | undefined;

function getEffectiveLevel(): LogLevel {
  minLevel ??= resolveLevel();
  return minLevel;
}

/**
 * Monotonic token identifying the most recent `setLogLevel` decision.
 *
 * Exists so a call can tell "my temporary widened value is still installed"
 * from "a nested call chose a value that happens to equal it" — see the restore
 * in `setLogLevel`. Wraps harmlessly: only equality against a captured value is
 * ever tested, never ordering.
 */
let levelGeneration = 0;

/**
 * Raise or lower the active log level at runtime.
 *
 * @param level One of debug, info, warn, error. An unknown value is rejected
 *   rather than silently coerced, because silently staying at the old level
 *   during an incident looks identical to the setting having worked.
 * @returns The level now in effect.
 * @throws {Error} If `level` is not a known level.
 */
export function setLogLevel(level: string): LogLevel {
  const next = level.trim().toLowerCase();
  if (!(next in LOG_LEVELS)) {
    throw new Error(
      `unknown log level ${JSON.stringify(level)}; expected one of ${Object.keys(LOG_LEVELS).join(", ")}`,
    );
  }
  const previous = getEffectiveLevel();
  const target = next as LogLevel;
  // Claim a generation for this call. The restore below must fire only if
  // nothing else assigned `minLevel` in the meantime, and "did anyone assign"
  // is not answerable by comparing VALUES: a nested sink that deliberately
  // sets exactly the widened level is indistinguishable from the widened level
  // never having been touched. Review proved it -- a nested `setLogLevel`
  // during a `debug -> error` transition asked for `debug`, was told `debug`,
  // and the process ended at `error`. An identity token has no such collision.
  const generation = ++levelGeneration;
  // Announce through whichever gate is more permissive, so the transition is
  // never filtered by the change itself. Emitting after the swap loses the line
  // when lowering verbosity (`info` -> `warn` hides its own `info` notice), and
  // emitting before it loses the line when raising from a level that already
  // suppressed `info` (`error` -> `debug`). Widening for this one line makes
  // "when did the level change?" answerable from the log in both directions.
  const widened = LOG_LEVELS[previous] < LOG_LEVELS[target] ? previous : target;
  minLevel = widened;
  try {
    log("info", "log_level_changed", { from: previous, to: target });
  } finally {
    // `finally`, not a plain assignment: the widened gate above is a temporary
    // state that exists only for the announce line, and `log` can throw for
    // real -- the file sink write fails on a full or unwritable disk. Without this,
    // a throw leaves minLevel stuck at the WIDENED value while the caller sees
    // an error and reasonably concludes nothing changed. That inverts the
    // intent on the one path this function exists for: an operator raising
    // verbosity mid-incident, on the box whose disk just filled, would silently
    // get debug-volume logging from a call that reported failure.
    //
    // Conditional, because the widened window runs registered sinks
    // synchronously and one of them can reenter this function -- an
    // auto-escalate-on-error sink is exactly the documented extension point. An
    // unconditional restore silently reverted that nested change AND the nested
    // call returned its own target as though it had taken effect. A later
    // decision wins.
    //
    // Keyed on the generation, not on the value: a nested call bumps
    // `levelGeneration`, so "someone else already decided" is detected even
    // when they decided on the level this call had temporarily installed.
    if (levelGeneration === generation) minLevel = target;
  }
  // `minLevel`, not `target`: the returned value must be what is actually in
  // effect, or a reentrant change is reported as the caller's own.
  return getEffectiveLevel();
}

/** The level currently in effect. */
export function getLogLevel(): LogLevel {
  return getEffectiveLevel();
}

/**
 * Async-scoped context reader, installed by `observability/context.ts`.
 *
 * Set through a registration function rather than imported directly: the
 * observability wrappers import this module, so a static import back the other
 * way would be circular. It stays undefined until something opts in, which keeps
 * the logger usable on its own (scripts, tests, early boot) with no context
 * machinery loaded.
 */
type ContextReader = () => Record<string, unknown> | undefined;
let contextReader: ContextReader | undefined;

/**
 * Register the reader supplying async-scoped envelope fields.
 *
 * Called once by `observability/context.ts`. Not part of the call-site surface.
 */
export function setLogContextReader(reader: ContextReader): void {
  contextReader = reader;
}

/**
 * Additional sinks receiving every emitted entry as a structured object.
 *
 * Exists so a consumer can observe emitted lines without depending on global
 * `console` state — which tests must not do, since Bun runs all test files in
 * one process and a suite that swaps `console.error` without restoring it would
 * otherwise silently break unrelated assertions.
 *
 * Also the extension point for a genuine second destination later (a metrics
 * counter, an in-process ring buffer for `operator-doctor`) without touching
 * the call sites.
 */
type ExtraSink = (entry: Record<string, unknown>) => void;
const extraSinks = new Set<ExtraSink>();

/**
 * Subscribe to every emitted log entry.
 *
 * @param sink Called with each entry after the envelope is applied.
 * @returns An unsubscribe function. Callers must call it, or the sink leaks.
 */
export function addLogSink(sink: ExtraSink): () => void {
  extraSinks.add(sink);
  return () => {
    extraSinks.delete(sink);
  };
}

function contextFields(): Record<string, unknown> {
  if (!contextReader) return {};
  // DELIBERATE FAIL-OPEN, and the one place in this codebase where an unlogged
  // catch is correct: this runs *inside* the log path, so reporting the failure
  // through the logger would recurse. A broken context reader must degrade the
  // line to "no correlation id" rather than prevent the line from being written
  // at all — losing the whole line is strictly worse than losing one field.
  try {
    return contextReader() ?? {};
  } catch {
    return {};
  }
}

/**
 * A single emitted line.
 *
 * `timestamp`, `level`, `message`, `service`, `host`, and `correlation_id` are
 * the shared envelope. The first five are always present and are stamped here,
 * never passed by a caller; `correlation_id` appears whenever the line was
 * emitted inside a `withContext()` scope.
 *
 * `service` and `host` are the only two fields that become Loki labels
 * (`_DOCS/CODING_STANDARDS.md`, `## Observability`) — everything else stays in
 * the body, because Loki builds one index stream per unique label combination
 * and a high-cardinality label produces unbounded streams.
 *
 * `message` is a stable event name (`lane_scope_miss`), never a sentence — event
 * names are what Loki filters on.
 */
interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  service: string;
  host: string;
  [key: string]: unknown;
}

/**
 * Map one value the replacer visited into something JSON can carry.
 *
 * Hoisted out of the replacer (issue 864) so each stays under the complexity
 * rule; the branches, their order, and their outputs are unchanged. Values are
 * handled rather than dropped: `bigint` becomes its digits, a cycle becomes
 * `"[Circular]"`, a function or symbol becomes its type name.
 *
 * @param ancestors Mutated in place — an object value is pushed so a later
 *   visit to it on the same branch is recognized as circular.
 */
function tameValue(value: unknown, ancestors: object[]): unknown {
  if (typeof value === "string") return redactForLog(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (typeof value === "object" && value !== null) {
    if (ancestors.includes(value)) return "[Circular]";
    ancestors.push(value);
  }
  return value;
}

/**
 * Serialize one entry without ever throwing, redacting every string it emits.
 *
 * Two review findings meet here, and both were reproduced.
 *
 * **It must not throw.** Every other step in `log()` is deliberately fail-open --
 * `contextFields()` catches a throwing reader, the file sink is guarded, each
 * extra sink is guarded -- but the bare `JSON.stringify(entry)` was not. A
 * cycle, a `BigInt`, or a throwing `toJSON` in any caller field or context field
 * lost the line on all four destinations *and* threw into arbitrary application
 * code. The consequences went well past logging: `withLogging` replaced the real
 * error with a serializer error on its failure path, `withFallback` threw
 * instead of returning its fallback, and worst, at `debug` the entry line threw
 * before `fn` was ever called -- so **raising the log level silently stopped
 * work from running**. That is the exact scenario `setLogLevel` exists for.
 * `src/audit-log.ts` already defends itself against "a cycle, a BigInt
 * anywhere"; the shared envelope every emitter routes through did not.
 *
 * **It must redact the whole entry, not one contributor.** `redactForLog` was
 * applied only to `error_name`/`error_message`/`error_stack`, so the identical
 * DSN went out redacted in `error_message` and in clear in a caller field on the
 * same line. Redacting at the envelope also covers `contextFields()` output,
 * which nothing covered before.
 *
 * Values are handled rather than dropped: `bigint` becomes its digits, a cycle
 * becomes `"[Circular]"`, a throwing getter becomes `"[Unserializable]"`. Losing
 * one field is acceptable; losing the line during an incident is not.
 */
function serializeEntry(entry: LogEntry, level: LogLevel, message: string): string {
  // Ancestors along the CURRENT branch, not every object ever visited. A value
  // is circular when it is its own ancestor; a `WeakSet` that only ever grows
  // cannot express that, and review proved the consequence -- `{a: shared, b:
  // shared}` with one plain non-circular object referenced twice serialized as
  // `{"a":{"id":"abc"},"b":"[Circular]"}`, silently dropping real data. Sharing
  // one `config`/`job`/`namespace` object across two fields is ordinary, so the
  // false positive was the common case, not the edge case.
  //
  // `this` is the object currently being serialized, which `JSON.stringify`
  // binds on each replacer call. Walking up from it gives the true ancestor
  // chain, so the set shrinks again as serialization unwinds.
  const ancestors: object[] = [];
  try {
    return JSON.stringify(entry, function replacer(this: unknown, key, value) {
      // Drop any ancestors we have finished with: everything after `this`.
      const holderIndex = ancestors.indexOf(this as object);
      if (holderIndex !== -1) ancestors.length = holderIndex + 1;

      // The key decides before the value's own shape does. `redactForLog`
      // recognizes secrets by their text, which cannot work for an arbitrary
      // passphrase or an opaque rotated token; the field it arrived under is
      // the only signal. This is the only place the key is in scope, which is
      // exactly why the gap existed.
      if (isSensitiveKey(key) && value !== null && value !== undefined) {
        return "[REDACTED]";
      }

      return tameValue(value, ancestors);
    });
  } catch {
    // A throwing `toJSON`, or anything else the replacer could not tame. Emit
    // the envelope alone so the line still lands and says why it is thin.
    try {
      return JSON.stringify({
        level,
        message: redactForLog(message),
        timestamp: new Date().toISOString(),
        service: getServiceName(),
        host: getHostName(),
        log_serialize_failed: true,
      });
    } catch {
      // Envelope-only serialization cannot realistically fail; if it somehow
      // does, a hand-built string still beats losing the line.
      return `{"level":"${level}","message":"log_serialize_failed","service":"${getServiceName()}","host":"${getHostName()}"}`;
    }
  }
}

function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[getEffectiveLevel()]) return;

  // Envelope fields are owned here and stamped last so a caller cannot
  // accidentally shadow them with a same-named field: callers that spell
  // `service` or `correlation_id` differently per repo are how one query
  // surface becomes several.
  const entry: LogEntry = {
    ...extra,
    // Context spreads BEFORE the envelope, not after. It used to spread last,
    // which meant a context reader returning `service`, `host`, or `level`
    // silently overrode the fields this block claims to own -- and `service`
    // and `host` are the only two that become Loki labels, so one mislabelled
    // reader splits the query surface with nothing in the output saying so.
    // Context supplies correlation fields; it does not get to rename the
    // service.
    ...contextFields(),
    level,
    message,
    timestamp: new Date().toISOString(),
    service: getServiceName(),
    host: getHostName(),
  };
  const output = serializeEntry(entry, level, message);
  // Sinks receive the SERIALIZED-then-parsed entry, not the raw object. Review
  // found that redacting only inside `serializeEntry` left every extra sink
  // reading the unredacted original -- so a credential-bearing caller field went
  // out in clear to any observer while the file and console saw `[REDACTED]`.
  // Round-tripping guarantees all three destinations see byte-identical data,
  // and it is the same object shape sinks already expected.
  let delivered: LogEntry = entry;
  try {
    delivered = JSON.parse(output) as LogEntry;
  } catch {
    // serializeEntry never returns invalid JSON, but a sink getting the raw
    // entry is still better than no line at all.
  }
  // NOT wrapped in try/catch, deliberately. An earlier revision guarded this,
  // reasoning that a full disk must not take the line down with it. The
  // reasoning was right and the guard was redundant: `createRotatingFileSink`
  // documents "Never throws on write" and already wraps its `appendFileSync` in
  // a try/catch that re-syncs and continues (`rotating-file.ts`). A review lane
  // caught that the guard had no test which failed when it was reverted; the
  // reason it could not be tested is that the throw it caught cannot occur.
  // Keeping a guard for an impossible case makes the next reader believe this
  // sink is a throwing one.
  getFileSink()?.write(output);
  // Snapshot, not the live Set. `Set` iteration observes mutation, so a sink
  // that re-subscribes itself during an emit lands back at the tail and is
  // reached again by the same loop -- one log line drove a sink 50,001 times in
  // review before a circuit breaker stopped it. It is inside the per-sink
  // catch, so it surfaces as a silent hang rather than an error. A snapshot
  // also makes "a sink added mid-emit does not receive the in-flight line"
  // defined rather than incidental.
  for (const sink of Array.from(extraSinks)) {
    // A misbehaving observer must not silence the line for everyone else, and
    // reporting through the logger from inside the logger would recurse.
    try {
      sink(delivered);
    } catch (error) {
      // Deliberate fail-open on the delivery (see contextFields()), but not a
      // silent one. A sink that throws on every line -- a forwarder whose
      // endpoint is gone -- was previously invisible forever: the process kept
      // logging, the observer received nothing, and nothing anywhere said so.
      // stderr is the one channel that cannot recurse back into here.
      reportSinkThrow(error);
    }
  }
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else if (level === "debug") {
    console.debug(output);
  } else {
    console.log(output);
  }
}

/**
 * Report a throwing extra sink on stderr, which cannot recurse into `log()`.
 *
 * One line per distinct failure, not per occurrence: a sink whose endpoint is
 * down throws on every line, and a report per line would multiply the very
 * traffic that is failing. The first of each kind is emitted and the rest are
 * counted, so a persistent failure costs one line plus a periodic tally.
 */
const sinkThrowCounts = new Map<string, number>();
const SINK_THROW_REPORT_EVERY = 1000;

/**
 * The name and message a thrown sink value reports under.
 *
 * Hoisted out of `reportSinkThrow` (issue 864) so both stay under the
 * complexity rule. A non-`Error` throw falls back to its `typeof` and its
 * string form, exactly as before.
 */
function describeSinkThrow(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  const err = error instanceof Error ? error : undefined;
  return {
    name: err?.name ?? typeof error,
    message: err?.message ?? String(error),
  };
}

function reportSinkThrow(error: unknown): void {
  try {
    const described = describeSinkThrow(error);
    const kind = `${described.name}: ${described.message}`;
    const seen = (sinkThrowCounts.get(kind) ?? 0) + 1;
    sinkThrowCounts.set(kind, seen);
    if (seen !== 1 && seen % SINK_THROW_REPORT_EVERY !== 0) return;
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "log_sink_threw",
        service: getServiceName(),
        host: getHostName(),
        occurrences: seen,
        error_name: redactForLog(described.name),
        error_message: redactForLog(described.message),
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    // stderr is gone too. There is no fourth channel, and throwing here would
    // let a broken observer take down the caller that merely logged a line.
  }
}

export const logger = {
  info: (message: string, extra?: Record<string, unknown>) =>
    log("info", message, extra),
  warn: (message: string, extra?: Record<string, unknown>) =>
    log("warn", message, extra),
  error: (message: string, extra?: Record<string, unknown>) =>
    log("error", message, extra),
  debug: (message: string, extra?: Record<string, unknown>) =>
    log("debug", message, extra),
};
