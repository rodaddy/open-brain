/**
 * Async-scoped log context — the TypeScript equivalent of Loguru's
 * `contextualize()`.
 *
 * A `correlation_id` that has to be threaded through call signatures by hand
 * gets dropped somewhere, and the five log points for one operation then have
 * no field tying them together. `AsyncLocalStorage` carries the context across
 * `await` boundaries instead, so every line emitted inside `withContext()`
 * inherits it without any call site passing it.
 *
 * Implements the shared observability envelope in
 * `_DOCS/CODING_STANDARDS.md` (`## Observability`). No dependency: Node and Bun
 * both ship `AsyncLocalStorage`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { setLogContextReader } from "../logger.ts";

/**
 * Fields inherited by every log line emitted inside a `withContext()` scope.
 *
 * `correlation_id` is the only required member: it is what makes an operation's
 * entry, exit, failure, degraded, and guard lines queryable as one unit. Extra
 * fields are merged in and behave the same way.
 */
export interface LogContext {
  correlation_id: string;
  [key: string]: unknown;
}

const STORE = new AsyncLocalStorage<LogContext>();

// Importing this module opts the logger into async-scoped envelope fields.
// Registration rather than a static import the other way, because the logger is
// the dependency here and a two-way static import would be circular.
setLogContextReader(() => STORE.getStore());

/**
 * Run `fn` with `fields` attached to every log line it emits, including lines
 * emitted after an `await`.
 *
 * Nested scopes merge rather than replace, so an inner scope can add a
 * `lane_id` without discarding the outer `correlation_id`. An inner field of
 * the same name wins.
 *
 * @param fields Context to attach. A nested call may omit `correlation_id`,
 *   inheriting the enclosing scope's value.
 * @param fn Work to run inside the scope.
 * @returns Whatever `fn` returns.
 */
export function withContext<T>(
  fields: Partial<LogContext> & Record<string, unknown>,
  fn: () => T,
): T {
  const parent = STORE.getStore();
  const merged = { ...parent, ...fields } as LogContext;
  return STORE.run(merged, fn);
}

/**
 * Current context, or `undefined` outside any `withContext()` scope.
 *
 * Callers should not normally need this — the logger reads it automatically.
 * It is exported for the rare case of forwarding a correlation id across a
 * process or transport boundary, where it cannot be inherited.
 */
export function currentContext(): LogContext | undefined {
  return STORE.getStore();
}

/**
 * Correlation id of the current scope, or `undefined` outside one.
 */
export function currentCorrelationId(): string | undefined {
  return STORE.getStore()?.correlation_id;
}
