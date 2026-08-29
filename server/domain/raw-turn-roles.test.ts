/**
 * Drift tests for the raw-turn role set (#681).
 *
 * The serving tree derives from `RAW_TURN_ROLES`, so those consumers cannot
 * drift. Two copies remain that CANNOT be folded into it — the legacy tree's
 * own schema and the column's applied `CHECK` constraint (a shipped migration
 * is immutable history, never edited) — and this file is what keeps them from
 * silently disagreeing.
 *
 * That is exactly the failure #681 was: a literal that was correct when written
 * and went stale when the enum grew, with nothing checking. Three copies that
 * agree because something ASSERTS they agree is a different world from three
 * copies that agree because nobody has changed one yet.
 *
 * These read the files as text on purpose. Importing the legacy schema would
 * couple the two trees in the direction this repo has been separating, and the
 * migration is SQL that no import can reach at all.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_LIVE_ROLES, RAW_TURN_ROLES } from "./raw-turn-roles.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("raw turn role set", () => {
  it("is the three roles the column accepts", () => {
    expect([...RAW_TURN_ROLES]).toEqual(["user", "assistant", "tool"]);
  });

  it("agrees with the legacy tree's ingest schema", () => {
    // The legacy tree keeps its own copy because the two trees are deliberately
    // separate (core01 serves one, the local dogfood service the other). It may
    // not drift from this one: a turn accepted by one and rejected by the other
    // is a capture loss that depends on which host received it.
    const legacy = read("server/capture/ingest-raw-turn.ts");
    const match = legacy.match(/role:\s*z\.enum\(\[([^\]]*)\]\)/);
    expect(match).not.toBeNull();
    const roles = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, ""))
      .filter((part) => part.length > 0);
    expect(roles).toEqual([...RAW_TURN_ROLES]);
  });

  it("expects only live roles for liveness, and they are all accepted", () => {
    // #685: the accept set and the live-expected set answer different
    // questions, and seeding liveness from the accept set demanded `tool` --
    // a role no live producer emits by design -- which returned 503 from
    // /health and rolled back every deploy.
    //
    // The subset assertion is what keeps #681 fixed. A live role that is not
    // an accepted role is a contradiction (the observer would demand a turn
    // the boundary rejects), and a role added to ingest still cannot escape
    // liveness silently, because adding it here is a deliberate edit to a
    // declared set rather than a literal drifting beside an enum.
    expect([...EXPECTED_LIVE_ROLES]).toEqual(["user", "assistant"]);
    for (const role of EXPECTED_LIVE_ROLES) {
      expect(RAW_TURN_ROLES).toContain(role);
    }
    // Strict subset: if these ever match, the distinction has collapsed and
    // the defect is back.
    expect(EXPECTED_LIVE_ROLES.length).toBeLessThan(RAW_TURN_ROLES.length);
  });

  it("agrees with the applied CHECK constraint on ob_raw_turns.role", () => {
    // The column is the ultimate authority: a role this set admits and the
    // constraint rejects is a write that fails at the database, and a role the
    // constraint admits but this set omits is a role the liveness observer goes
    // blind to — which is #681 itself.
    const migration = read("src/db/migrations/032_raw_turns.sql");
    const match = migration.match(/CHECK\s*\(role\s+IN\s*\(([^)]*)\)\)/);
    expect(match).not.toBeNull();
    const roles = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^'|'$/g, ""))
      .filter((part) => part.length > 0);
    expect(roles).toEqual([...RAW_TURN_ROLES]);
  });
});
