/**
 * Shared reader and comparator for the recorded server parity fixtures.
 *
 * WHY THIS IS ITS OWN MODULE. `contracts/server-tool-parity.test.ts` grew both
 * of these inline, and the real-SDK protocol proof
 * (`server/application/sdk-protocol.pg.test.ts`) needs the SAME meaning of
 * "matches the recorded shape" -- otherwise the two suites can agree that a
 * response is correct while disagreeing about what correct means, which is the
 * failure a second hand-written comparator always eventually produces.
 * `_DOCS/STANDARDS-testing.md` says it directly: do not reimplement production
 * or checking logic inside a test, because a copy only proves it agrees with
 * itself.
 *
 * The placeholder vocabulary (`<uuid>`, `<iso-date>`, `<non-empty-string>`) is
 * part of the recorded contract, not a convenience: the fixtures freeze SHAPE
 * plus the values that are genuinely stable, and deliberately do not freeze
 * server-generated ids or timestamps.
 */

export interface FixtureStep {
  tool: string;
  arguments: Record<string, unknown>;
  capture?: Record<string, string>;
  expectation: {
    is_error: boolean;
    text?: string;
    json?: unknown;
  };
}

export interface ServerFixture {
  id: string;
  description: string;
  capability: string;
  providers: Array<"current-src" | "server-rewrite-scaffold">;
  auth: {
    role: string;
    client_id: string;
    namespace_source?: string;
  };
  steps: FixtureStep[];
}

/** Read one recorded server fixture by its `id` (the filename stem). */
export async function loadServerFixture(id: string): Promise<ServerFixture> {
  const url = new URL(`./server/${id}.fixture.json`, import.meta.url);
  return (await Bun.file(url).json()) as ServerFixture;
}

/**
 * Substitute `{{placeholder}}` tokens (and any other literal replacements)
 * through a recorded value.
 *
 * Replacement is by literal string, so a caller can also map a fixture's
 * recorded literal (`"parity/lifecycle"`) onto the value this run actually used.
 */
export function replacePlaceholders(
  value: unknown,
  replacements: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return Object.entries(replacements).reduce(
      (result, [placeholder, replacement]) => result.replaceAll(placeholder, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replacePlaceholders(item, replacements),
      ]),
    );
  }
  return value;
}

/**
 * Assert an observed response against a recorded expectation.
 *
 * Objects are compared key-by-key over the RECORDED keys only, so a fixture
 * asserts the shape it froze without failing on an unrelated additive field.
 * Arrays are length-exact. This is byte-for-byte the semantics
 * `contracts/server-tool-parity.test.ts` has always used.
 */
export function expectObserved(actual: unknown, expected: unknown): void {
  if (expected === "<uuid>") {
    expectTrue(
      typeof actual === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          actual,
        ),
      `expected a uuid, received ${JSON.stringify(actual)}`,
    );
    return;
  }
  if (expected === "<iso-date>") {
    expectTrue(
      typeof actual === "string" && !Number.isNaN(Date.parse(actual)),
      `expected an ISO date, received ${JSON.stringify(actual)}`,
    );
    return;
  }
  if (expected === "<non-empty-string>") {
    expectTrue(
      typeof actual === "string" && actual.length > 0,
      `expected a non-empty string, received ${JSON.stringify(actual)}`,
    );
    return;
  }
  if (Array.isArray(expected)) {
    expectTrue(
      Array.isArray(actual),
      `expected an array, received ${JSON.stringify(actual)}`,
    );
    const observedArray = actual as unknown[];
    expectTrue(
      observedArray.length === expected.length,
      `expected ${expected.length} items, received ${observedArray.length}`,
    );
    expected.forEach((item, index) => expectObserved(observedArray[index], item));
    return;
  }
  if (expected && typeof expected === "object") {
    expectTrue(
      Boolean(actual) && typeof actual === "object" && !Array.isArray(actual),
      `expected an object, received ${JSON.stringify(actual)}`,
    );
    for (const [key, value] of Object.entries(expected)) {
      expectObserved((actual as Record<string, unknown>)[key], value);
    }
    return;
  }
  expectTrue(
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

/** Substitute placeholders into the recorded expectation, then compare. */
export function expectRecordedShape(
  actual: unknown,
  expected: unknown,
  replacements: Record<string, string> = {},
): void {
  expectObserved(actual, replacePlaceholders(expected, replacements));
}

/**
 * Throw on a failed comparison.
 *
 * Deliberately a plain throw rather than a `bun:test` `expect`, so this module
 * stays importable by non-test code and carries no test-runner dependency. A
 * thrown error fails the calling test exactly the same way.
 */
function expectTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(`fixture shape mismatch: ${message}`);
}
