import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The recall fixture FILE is well-formed, or this fails.
 *
 * This is the structural half of the fixture suite, split out in session42
 * because the corpus half cannot run in CI. It asserts everything that can be
 * decided from `fixtures.json` alone -- shape, uniqueness, grading, spread,
 * uuid syntax -- and touches no database at all: no `Pool`, no
 * `requireRecallCorpusUrl`, no libpq vars. So it runs everywhere, including
 * CI, where the dogfood corpus `open_brain_local_20260724` does not exist.
 *
 * The live-row assertions -- every expected and forbidden id names a real row,
 * and each forbidden row sits outside its fixture's namespace -- live in
 * `fixtures.pg.test.ts`, which needs the corpus and guards for it at the call
 * site. Nothing was dropped in the split; every check lives in exactly one of
 * the two files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The tables a fixture may name. */
const ALLOWED_TABLES = new Set([
  "thoughts",
  "decisions",
  "sessions",
  "relationships",
  "projects",
  "ob_session_events",
]);

interface FixtureRef {
  readonly source_type: string;
  readonly id: string;
  readonly label?: number;
}

interface Fixture {
  readonly id: string;
  readonly query: string;
  readonly namespace: string;
  readonly expected: readonly FixtureRef[];
  readonly forbidden?: readonly FixtureRef[];
  readonly isolation?: boolean;
  readonly note: string;
}

interface FixtureFile {
  readonly version: number;
  readonly fixtures: readonly Fixture[];
}

const FIXTURES_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json");
const doc = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as FixtureFile;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Every ref in the file, deduplicated, as `table` + `id` pairs. */
function allRefs(): FixtureRef[] {
  const seen = new Map<string, FixtureRef>();
  for (const fixture of doc.fixtures) {
    for (const ref of [...fixture.expected, ...(fixture.forbidden ?? [])]) {
      seen.set(`${ref.source_type}:${ref.id}`, ref);
    }
  }
  return [...seen.values()];
}

describe("recall fixture set", () => {
  it("declares version 1 and at least twelve fixtures", () => {
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.fixtures)).toBe(true);
    expect(doc.fixtures.length).toBeGreaterThanOrEqual(12);
  });

  it("gives every fixture a unique id, a query, a namespace and a note", () => {
    const ids = new Set<string>();
    for (const fixture of doc.fixtures) {
      expect(typeof fixture.id).toBe("string");
      expect(fixture.id.length).toBeGreaterThan(0);
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);
      expect(fixture.query.trim().length).toBeGreaterThan(0);
      expect(fixture.namespace.trim().length).toBeGreaterThan(0);
      expect(fixture.note.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives a positive fixture at least one expected row and a graded label", () => {
    for (const fixture of doc.fixtures.filter((f) => f.isolation !== true)) {
      expect(fixture.expected.length).toBeGreaterThanOrEqual(1);
      for (const ref of fixture.expected) {
        expect(typeof ref.source_type).toBe("string");
        expect([0, 1, 2]).toContain(ref.label);
      }
      // A positive fixture must name an actual answer, not only near-misses.
      expect(fixture.expected.some((r) => r.label === 2)).toBe(true);
    }
  });

  it("includes at least one isolation fixture, empty-expected with a forbidden row", () => {
    const isolation = doc.fixtures.filter((f) => f.isolation === true);
    expect(isolation.length).toBeGreaterThanOrEqual(1);
    for (const fixture of isolation) {
      expect(fixture.expected).toEqual([]);
      expect(fixture.forbidden?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("spreads across at least three source types and two namespaces", () => {
    const types = new Set(allRefs().map((r) => r.source_type));
    const namespaces = new Set(doc.fixtures.map((f) => f.namespace));
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect(namespaces.size).toBeGreaterThanOrEqual(2);
  });

  it("names only known tables and well-formed uuids", () => {
    for (const ref of allRefs()) {
      expect(ALLOWED_TABLES.has(ref.source_type)).toBe(true);
      expect(UUID_PATTERN.test(ref.id)).toBe(true);
    }
  });
});
