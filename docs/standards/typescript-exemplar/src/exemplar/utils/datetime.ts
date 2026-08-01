/**
 * Time helpers -- the sanctioned replacements for ad-hoc `Date` handling.
 *
 * WHY THIS MODULE EXISTS AT ALL, GIVEN JS HAS `Date`
 *
 * The Python side bans `datetime.now()` because it returns a NAIVE datetime --
 * correct in value, wrong in type, so it passes review and throws on the first
 * comparison with an aware one. JavaScript has the opposite problem and it is
 * quieter: `new Date()` is always an absolute instant, so nothing ever throws,
 * but every method that reads it (`getHours`, `toString`, `toLocaleDateString`)
 * silently applies the HOST machine's timezone.
 *
 * So the JS failure is not a crash, it is a wrong answer: the same code
 * produces different output on a laptop in New York and a container in UTC, and
 * both look right to whoever wrote them.
 *
 * The rule that follows: an instant is a `Date`, a serialized instant is
 * ALWAYS ISO-8601 with an explicit offset, and no formatting ever depends on
 * where the process happens to run.
 *
 * @see _DOCS/STANDARDS-python.md ## Timezone-aware datetimes only -- the same
 *   rule, stated for the language where it fails loudly instead of quietly.
 */

/**
 * The current instant.
 *
 * A one-line wrapper over `new Date()`, and it earns its place: it is the seam
 * where a test injects a fixed clock, and a codebase that calls `new Date()`
 * directly in fifty places has no such seam. It also gives the rule a name to
 * point at.
 *
 * @returns The current instant.
 */
export function utcNow(): Date {
  return new Date();
}

/**
 * Serialize an instant to ISO-8601 with an explicit `Z`.
 *
 * The canonical string form for storage, APIs, and logs. Always UTC, always
 * with the offset, so it round-trips without the reader having to know a
 * convention.
 *
 * Never `toString()` (host timezone, unparseable format) and never
 * `toLocaleString()` (host timezone AND host locale).
 *
 * @param value - The instant to serialize.
 * @returns e.g. `"2026-07-30T21:14:07.123Z"`.
 * @throws {RangeError} If the date is Invalid Date -- surfacing the bad value
 *   here rather than writing the string "Invalid Date" into a database column.
 *
 * @example
 * ```ts
 * iso(new Date(0));  // "1970-01-01T00:00:00.000Z"
 * ```
 */
export function iso(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(
      "iso() received an Invalid Date. ACTION REQUIRED: check the parse that " +
        "produced it -- `new Date(badString)` yields Invalid Date rather than throwing.",
    );
  }
  return value.toISOString();
}

/**
 * Parse an ISO-8601 string into an instant, rejecting anything malformed.
 *
 * `new Date(string)` NEVER throws. Given nonsense it returns Invalid Date,
 * which then propagates: arithmetic yields NaN, `toISOString()` throws far from
 * the parse, and a comparison quietly returns false. This is the boundary
 * function that stops that at the door.
 *
 * @param value - Candidate ISO-8601 string.
 * @returns The parsed instant.
 * @throws {RangeError} If the string does not parse.
 *
 * @example
 * ```ts
 * parseIso("2026-07-30T00:00:00Z");   // Date
 * parseIso("not a date");             // throws RangeError
 * ```
 */
export function parseIso(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(
      `parseIso() could not parse ${JSON.stringify(value)}. ` +
        "ACTION REQUIRED: the value must be ISO-8601, e.g. 2026-07-30T12:00:00Z.",
    );
  }
  return parsed;
}

/**
 * Whole milliseconds between two instants.
 *
 * Integer rather than float: sub-millisecond precision is noise across a
 * network, and float milliseconds invite averages that imply accuracy the
 * measurement never had.
 *
 * @param from - The earlier instant.
 * @param to - The later instant. Defaults to now.
 * @returns Elapsed milliseconds, negative if `to` precedes `from`.
 */
export function elapsedMs(from: Date, to: Date = utcNow()): number {
  return Math.round(to.getTime() - from.getTime());
}
