/**
 * Test-only logger sink.
 *
 * Design authority: `_DOCS/STANDARDS-testing.md` -- a test asserts behavior, not
 * log noise, and a boundary test must not write to the real rotation chain.
 * Transport code logs on every path; this keeps those emissions structured and
 * discardable without weakening the production Pino envelope.
 */
import pino, { type Logger } from "pino";
import { Writable } from "node:stream";

/** A real Pino logger whose output is discarded. */
export function silentLogger(): Logger {
  return pino(
    { level: "silent" },
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}
