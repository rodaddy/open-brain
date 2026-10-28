import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Drift tests for the raw-turn role set (#681).
 *
 * The serving tree derives from `RAW_TURN_ROLES`, so those consumers cannot
 * drift. One copy remains that CANNOT be folded into it — the column's applied
 * `CHECK` constraint (a shipped migration is immutable history, never edited)
 * — and this file is what keeps it from silently disagreeing. The legacy
 * tree's schema was the second copy until issue 1212 deleted it with the dead
 * capture registrar; the tools-tier enum derives from RAW_TURN_ROLES and needs
 * no pin.
 *
 * That is exactly the failure #681 was: a literal that was correct when written
 * and went stale when the enum grew, with nothing checking. Three copies that
 * agree because something ASSERTS they agree is a different world from three
 * copies that agree because nobody has changed one yet.
 *
 * This reads the migration as text on purpose: it is SQL that no import can
 * reach at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_LIVE_ROLES, RAW_TURN_ROLES } from "./raw-turn-roles.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("raw turn role set", () => {
  it("is the three roles the column accepts", () => {
    expect([...RAW_TURN_ROLES]).toEqual(["user", "assistant", "tool"]);
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
    const migration = read("server/db/migrations/032_raw_turns.sql");
    const match = migration.match(/CHECK\s*\(role\s+IN\s*\(([^)]*)\)\)/);
    expect(match).not.toBeNull();
    const roles = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^'|'$/g, ""))
      .filter((part) => part.length > 0);
    expect(roles).toEqual([...RAW_TURN_ROLES]);
  });
});
