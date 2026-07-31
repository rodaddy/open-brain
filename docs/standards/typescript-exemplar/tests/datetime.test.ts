/**
 * Tests for `utils/datetime.ts`.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * The module is four short functions, three of which wrap something the
 * standard library already does. A reader is entitled to ask why it exists and
 * why it is worth testing. The answer is in what each test asserts: every one of
 * them pins a behaviour that the raw `Date` API gets WRONG BY DEFAULT.
 *
 * `new Date(garbage)` does not throw. `date.toString()` reads the host's
 * timezone. `toISOString()` on an Invalid Date throws somewhere far from the
 * parse that created it. Each of those is a real production failure mode that
 * survives review because the code looks correct.
 *
 * So these are not tests of trivial wrappers -- they are the executable
 * statement of which default behaviour this codebase refuses to inherit.
 *
 * @see ../python-exemplar/tests/test_datetime_helpers.py -- same rule, other
 *   language, where it fails loudly instead of quietly.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { elapsedMs, iso, parseIso, utcNow } from "../src/exemplar/utils/datetime.ts";

describe("utcNow", () => {
  test("returns a valid instant", () => {
    const now = utcNow();
    assert.ok(now instanceof Date);
    assert.ok(!Number.isNaN(now.getTime()));
  });

  test("is close to the real clock", () => {
    // A generous window. The assertion is not about precision -- it is that
    // utcNow is wired to the actual clock and not to a frozen or offset value,
    // which is the thing that would break silently if someone "optimized" it.
    const drift = Math.abs(utcNow().getTime() - Date.now());
    assert.ok(drift < 1_000, `utcNow drifted ${String(drift)}ms from Date.now()`);
  });
});

describe("iso", () => {
  test("serializes with an explicit Z", () => {
    assert.equal(iso(new Date(0)), "1970-01-01T00:00:00.000Z");
  });

  test("does not depend on the host timezone", () => {
    // The whole point of the module. `toString()` on this same value renders
    // differently in New York and in a UTC container; `iso()` must not.
    const instant = new Date(Date.UTC(2026, 6, 30, 12, 0, 0));
    assert.equal(iso(instant), "2026-07-30T12:00:00.000Z");
    assert.ok(iso(instant).endsWith("Z"));
  });

  test("throws on Invalid Date instead of writing a bad string", () => {
    // Without this guard, `toISOString()` throws too -- but from wherever the
    // value is finally serialized, which may be a database write in a different
    // module hours of debugging away from the parse that produced it.
    assert.throws(() => iso(new Date("nonsense")), RangeError);
  });

  test("the throw names the action to take", () => {
    // An error that says only what went wrong makes the reader guess what to
    // do. STANDARDS-typescript.md requires the action.
    assert.throws(
      () => iso(new Date("nonsense")),
      (error: unknown) =>
        error instanceof RangeError && /ACTION REQUIRED/.test(error.message),
    );
  });
});

describe("parseIso", () => {
  test("round-trips with iso", () => {
    const original = "2026-07-30T12:34:56.789Z";
    assert.equal(iso(parseIso(original)), original);
  });

  test("accepts an explicit non-UTC offset and normalizes it", () => {
    // Same instant, written from a different offset. Normalizing to UTC on the
    // way in is what makes stored timestamps comparable at all.
    assert.equal(
      iso(parseIso("2026-07-30T08:00:00-04:00")),
      "2026-07-30T12:00:00.000Z",
    );
  });

  test("REJECTS garbage rather than returning Invalid Date", () => {
    // THE test in this file. `new Date("not a date")` returns Invalid Date and
    // does not throw -- so arithmetic yields NaN, comparisons quietly return
    // false, and the failure surfaces somewhere else entirely. This is the
    // boundary that stops it.
    assert.throws(() => parseIso("not a date"), RangeError);
    assert.throws(() => parseIso(""), RangeError);
  });

  test("the raw API this replaces really does fail silently", () => {
    // Asserted explicitly so the reason for the wrapper cannot be argued away
    // by someone who does not believe the premise.
    const raw = new Date("not a date");
    assert.ok(
      Number.isNaN(raw.getTime()),
      "premise: new Date(garbage) is Invalid Date",
    );
    assert.doesNotThrow(() => new Date("not a date"), "premise: and it does NOT throw");
  });
});

describe("elapsedMs", () => {
  test("measures a known gap", () => {
    const from = new Date(1_000);
    const to = new Date(3_500);
    assert.equal(elapsedMs(from, to), 2_500);
  });

  test("is negative when the order is reversed", () => {
    // Not clamped to zero. A negative elapsed time means the caller's clock
    // assumption is wrong, and hiding that behind a 0 turns a detectable bug
    // into an inexplicable metric.
    assert.equal(elapsedMs(new Date(3_500), new Date(1_000)), -2_500);
  });

  test("returns whole milliseconds", () => {
    const result = elapsedMs(new Date(0), new Date(1));
    assert.ok(Number.isInteger(result));
  });

  test("defaults the second argument to now", () => {
    const elapsed = elapsedMs(new Date(Date.now() - 50));
    assert.ok(
      elapsed >= 40 && elapsed < 5_000,
      `unexpected elapsed: ${String(elapsed)}`,
    );
  });
});
