/**
 * Console capture for tests that assert on what the shared logger printed.
 *
 * These live under scripts/ rather than beside the suites that use them because
 * .oxlintrc.json turns no-console off for scripts/ and for *.test.ts, but not
 * for a non-test module under server/. Capturing a console channel IS the
 * mechanism under test in the tracing outage suites, so the helpers belong in
 * one named place instead of being inlined into every file that needs them.
 */
/**
 * Capture the console channels the shared logger actually writes to.
 *
 * `warn` goes to `console.warn` but `info` goes to `console.LOG`, not
 * `console.info` (the legacy logger's final `else` branch). Hooking
 * `console.info` captures nothing and lets the real line escape to stdout,
 * which is exactly how the first draft of this helper produced a green
 * "one suspend line" assertion against zero captured lines.
 */
export async function captureLogLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const push = (...parts: unknown[]): void => {
    // `String(err)` on an Error yields "Error: <message>", but the SDK logger
    // hands the Error as its own argument, so the interesting text is in a
    // later part rather than the first. Stringify every part, and reach into
    // Error objects explicitly so a leaked message is actually visible here.
    lines.push(
      parts
        .map((part) =>
          part instanceof Error ? `${part.name}: ${part.message}` : String(part),
        )
        .join(" "),
    );
  };
  console.warn = push;
  console.log = push;
  try {
    await run();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return lines;
}

/** Captures only `console.warn`, for assertions about a single warn line. */
export function captureWarnLines(run: () => void): string[] {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]): void => {
    lines.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
  return lines;
}

/** The async twin of `captureWarnLines`. */
export async function captureWarnLinesAsync(
  run: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]): void => {
    lines.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return lines;
}
