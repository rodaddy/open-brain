/**
 * A logger for tests that do not assert on log output.
 *
 * The tracing entry points require a logger from their composition root and
 * refuse to default one (#860): a fallback would be a second logger for the
 * process, which is the state that rung removes. Tests still need SOMETHING to
 * pass, and a per-file anonymous object repeated across call sites is how the
 * two methods drift apart. So the silent one lives here, once.
 *
 * A test that asserts on a log line uses its own recorder instead — this one
 * deliberately keeps nothing, so an assertion against it cannot pass by
 * accident.
 */
import type { TracingLogger } from "./trace-types.ts";

/** A logger that accepts every line and retains none. */
export function silentTracingLogger(): TracingLogger {
  return { info: () => {}, warn: () => {} };
}
