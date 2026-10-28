/**
 * The modern scoped shared fallback, pinned against the fixture's row ids.
 *
 * Issue 841 cut 1 moved `executeSearchWithScopedSharedFallback` onto the modern
 * engine in its injected-dependency shape, and this suite proved the transplant
 * by running the legacy executors alongside it and comparing ids. Those
 * executors are retired in issue 841 cut 3, so the expectations the parity run
 * established now live in the fixture as data
 * ({@link EXPECTED_TOPPED_UP_IDS}, {@link EXPECTED_NO_TOPUP_IDS}) and this
 * suite pins the modern engine against them directly. Same branch, same ids,
 * one implementation to ask.
 *
 * THE BRANCH THAT MATTERS. The engine runs the caller's scope and the shared
 * namespace in parallel, then decides whether the legacy namespace has anything
 * to add. The decision reads the SHARED count, not the primary one: a scope full
 * of private rows must not suppress a top-up for a shared namespace that is
 * nearly empty. The fixture makes the primary arm rich and the shared arm thin —
 * three primary rows against one shared row, under a `fallbackMinResults` of
 * three — so an implementation that gated on the wrong count returns a visibly
 * different id list.
 *
 * THE OTHER SIDE OF THE GATE. `scopedFallbackApplies` also has to be able to say
 * no. The second arm drives the same fixture with the top-up disabled, and
 * asserts the legacy row is absent — otherwise a fallback that fired
 * unconditionally would pass the first arm and nothing would catch it.
 *
 * HOW THE FIXTURE DRIVES IT. The stub pool answers on the namespace parameter
 * rather than on SQL text, so the fixture is a statement about namespaces and
 * does not break when the engine's query changes shape.
 */
import { describe, expect, test } from "vitest";
import type { Logger } from "pino";
import type { Pool } from "pg";
import { executeSearchWithScopedSharedFallback } from "./search-engine.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import type { SearchDependencies, SearchRow } from "./search-engine-types.ts";
import {
  EXPECTED_NO_TOPUP_IDS,
  EXPECTED_TOPPED_UP_IDS,
  LEGACY_ROW_ID,
  LEGACY_SHARED,
  PHYSICAL_SHARED,
  PRIVATE_NAMESPACE,
  SCOPE,
  fixturePool,
} from "./search-engine-fallback.fixture.ts";

const SHARED_NAMES: SharedNamespaceConfig = {
  canonicalSharedNamespace: PHYSICAL_SHARED,
  allowLegacySharedWrites: false,
  sharedNamespace: PHYSICAL_SHARED,
  physicalSharedNamespace: PHYSICAL_SHARED,
  legacySharedNamespace: LEGACY_SHARED,
  legacyFallbackEnabled: true,
  fallbackMinResults: 3,
};

const silentLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function ids(rows: SearchRow[]): string[] {
  return rows.map((result) => result.id);
}

/** Run the modern scoped fallback over the fixture with the given names. */
async function modernIds(
  names: SharedNamespaceConfig = SHARED_NAMES,
): Promise<string[]> {
  const dependencies: SearchDependencies = {
    pool: fixturePool() as unknown as Pool,
    embedFn: async () => null,
    logger: silentLogger,
    sharedNamespaceNames: names,
  };
  return ids(
    await executeSearchWithScopedSharedFallback({
      dependencies,
      tables: ["thoughts"],
      query: "parity fixture",
      limit: 5,
      mode: "keyword",
      offset: 0,
      namespace: SCOPE,
    }),
  );
}

describe("the modern scoped shared fallback", () => {
  test("the thin-shared branch tops up from the legacy namespace", async () => {
    const modern = await modernIds();
    // The primary scope's three rows, plus the one legacy row the thin shared
    // arm licensed. A gate that read the primary count would stop at three.
    expect(modern).toContain(LEGACY_ROW_ID);
    expect(modern).toHaveLength(4);
  });

  test("the merged ids are exactly what the fixture expects", async () => {
    expect(await modernIds()).toEqual(EXPECTED_TOPPED_UP_IDS);
  });

  test("the private namespace's own rows survive the top-up", async () => {
    const modern = await modernIds();
    expect(
      modern.filter((id) => id.startsWith("1") || id.startsWith("2")),
    ).toHaveLength(2);
    expect(PRIVATE_NAMESPACE).toBe("dana-private");
  });

  test("no top-up when scopedFallbackApplies says no", async () => {
    const modern = await modernIds({
      ...SHARED_NAMES,
      legacyFallbackEnabled: false,
    });
    expect(modern).toEqual(EXPECTED_NO_TOPUP_IDS);
    expect(modern).not.toContain(LEGACY_ROW_ID);
  });
});
