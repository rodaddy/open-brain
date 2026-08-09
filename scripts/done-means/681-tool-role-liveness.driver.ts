/**
 * DONE-MEANS driver for #681 — the capture-liveness observer is no longer BLIND
 * to the `tool` role, and its expected-role seed is DERIVED from the ingest
 * enum rather than retyped beside it.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, CONFIRMED LIVE BEFORE THIS CHECK WAS WRITTEN
 * ---------------------------------------------------------------------------
 * `server/capture/liveness-observer.ts` seeded `EXPECTED_ROLES =
 * ["user","assistant"]` while the server accepts three roles
 * (`server/tools/ingest-raw-turn.ts:24`, `z.enum(["user","assistant","tool"])`,
 * and the column's own `CHECK (role IN ('user','assistant','tool'))` at
 * `src/db/migrations/032_raw_turns.sql:99-100`).
 *
 * The silent path is structural, not probabilistic: `gather()` folds the rows
 * `GROUP BY role` returns, and a role that delivered NOTHING returns no group.
 * A role that is neither seeded nor present is therefore never a key in
 * `turnsByRole`, so `readCaptureLiveness`'s
 * `Object.entries(...).filter(turns === 0)` can never name it. Dead role ->
 * no rows -> no group -> no key -> not silent -> `stale: false`.
 *
 * Measured on the dogfood database this session (read-only, namespace `rico`):
 *
 *     assistant | 58140 | 2026-08-09 12:05:49
 *     tool      | 14006 | 2026-08-01 00:42:47   <- frozen 8 days
 *     user      |  3780 | 2026-08-09 12:04:50
 *
 * and live `/health` at `f673299` concurrently read
 * `silent_roles: [] | stale: false | reason: "capture lane delivering"`.
 * This is the module's own docstring failure (#447) recurring one role wider,
 * and it is the cutover's evidence that capture works (B3,
 * `docs/core01-cutover-preflight.md`).
 *
 * ---------------------------------------------------------------------------
 * WHY "ADD tool TO THE LIST" IS NOT WHAT THIS CHECK ACCEPTS
 * ---------------------------------------------------------------------------
 * The issue offers two fixes and asks for the second: "derive expected roles
 * from the accepted enum (single source of truth) so a new role can't silently
 * escape liveness." A retyped three-element literal passes the behavioural
 * clause and rebuilds the identical trap for role number four — which is
 * exactly how role number three got here, since `EXPECTED_ROLES` was correct
 * for the enum it was written beside and went stale when the enum grew.
 *
 * So clause (d) is a DERIVATION clause and it is the load-bearing one: the
 * observer's seed must be the ingest enum's own members, such that extending
 * the enum extends the seed with no second edit. It is proven by MUTATION —
 * a fourth role is added to the derived source at runtime and the observer must
 * seed it — which a hardcoded literal cannot satisfy however many roles it
 * lists. (`docs/lane-contract.md` rounds 9/17/24: a clause whose PASS comes
 * from matching a value must be mutation-tested, and when the fix changes
 * WHICH MECHANISM produces the result, assert the mechanism.)
 *
 * ---------------------------------------------------------------------------
 * SUBJECT: the shipped gatherer, driven through its real query path
 * ---------------------------------------------------------------------------
 * Every behavioural clause drives `createCaptureLivenessObserver().refresh()`
 * — the shipped function, unmodified — and reads `reading()` / `observation()`.
 * The pool is a fake because the property under test is the FOLD (what happens
 * to a role with no rows), not Postgres's `GROUP BY`; a real database cannot
 * even express the case, since the whole defect is the absence of a row. This
 * is the same fake-pool convention the module's own tests already use
 * (`server/capture/liveness-observer.test.ts:23-31`), and the fake returns the
 * exact row shape the real query's `RoleCountRow` declares — string counts from
 * `pg`, not numbers, so a fold that forgot `Number()` would still be caught.
 *
 * Clause (e) is a source-level assertion by necessity and is paired with the
 * behavioural clauses, never a substitute: it pins that the enum was not simply
 * duplicated a fourth time, by asserting the two remaining role-set copies in
 * the tree (`src/tools/ingest-raw-turn.ts`, the migration CHECK) agree with the
 * derived set. Drift between them is the defect class, so the check reads them.
 *
 * No database. No network. No wall-clock verdict (round 5, #632/#634).
 * Content-free output: clause names, states, counts.
 *
 * IMPORTS ARE DYNAMIC (round 18): a static import of a module that does not
 * export the new symbol yet dies at resolution before any clause prints — a
 * false RED indistinguishable in shape from a real one. Every subject import
 * here is awaited inside a guarded block that reports the failure AS a clause.
 */
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

/**
 * A pool that answers the gatherer's one query with the given rows.
 *
 * Row shape mirrors `RoleCountRow` exactly — `pg` hands back counts as STRINGS,
 * and reproducing that is what keeps a `Number()` regression visible.
 */
function poolReturning(
  rows: ReadonlyArray<{
    role: string;
    turns: string;
    sessions: string;
    seconds_since_last: string | null;
  }>,
): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

/** A logger that satisfies the observer's `logger.warn` without emitting. */
function quietLogger(): { warn: () => void; info: () => void } {
  return { warn: () => {}, info: () => {} };
}

const WINDOW = { windowMinutes: 360, namespace: "rico" } as const;

/**
 * The live shape this issue is about: user and assistant delivering, `tool`
 * absent entirely because a dead role produces NO GROUP. Session counts clear
 * `MIN_SESSIONS_FOR_SILENCE` so the observation is `active` and a verdict is
 * legitimately owed.
 */
const DEAD_TOOL_LANE = [
  { role: "user", turns: "3780", sessions: "9", seconds_since_last: "12" },
  { role: "assistant", turns: "58140", sessions: "9", seconds_since_last: "3" },
] as const;

/** A lane where all three roles deliver — the control. */
const HEALTHY_THREE_ROLE_LANE = [
  { role: "user", turns: "300", sessions: "9", seconds_since_last: "12" },
  { role: "assistant", turns: "1200", sessions: "9", seconds_since_last: "3" },
  { role: "tool", turns: "900", sessions: "9", seconds_since_last: "5" },
] as const;

interface ObserverModule {
  createCaptureLivenessObserver: (
    input: { pool: Pool; logger: unknown; window: typeof WINDOW },
    options: { autoStart: boolean },
  ) => {
    refresh: () => Promise<void>;
    reading: () => { stale: boolean; silent_roles: string[]; reason: string } | undefined;
    observation: () => { turnsByRole: Record<string, number> } | undefined;
  };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------
  // Load the subject. A resolution failure is REPORTED as a failing clause,
  // never allowed to kill the driver before any clause prints (round 18).
  // ---------------------------------------------------------------------
  let observerModule: ObserverModule | undefined;
  try {
    observerModule = (await import(
      "../../server/capture/liveness-observer.ts"
    )) as unknown as ObserverModule;
    clause("load", true, "server/capture/liveness-observer.ts imported");
  } catch (error: unknown) {
    clause(
      "load",
      false,
      `server/capture/liveness-observer.ts failed to import: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
  }

  /** Drive the shipped gatherer over a fixture lane. */
  async function read(
    rows: ReadonlyArray<{
      role: string;
      turns: string;
      sessions: string;
      seconds_since_last: string | null;
    }>,
  ): Promise<{
    reading: { stale: boolean; silent_roles: string[]; reason: string } | undefined;
    roles: string[];
  }> {
    if (observerModule === undefined) return { reading: undefined, roles: [] };
    const subject = observerModule.createCaptureLivenessObserver(
      { pool: poolReturning(rows), logger: quietLogger(), window: WINDOW },
      { autoStart: false },
    );
    await subject.refresh();
    return {
      reading: subject.reading(),
      roles: Object.keys(subject.observation()?.turnsByRole ?? {}).sort(),
    };
  }

  // ---------------------------------------------------------------------
  // (a) THE ISSUE'S OWN DONE-MEANS, verbatim: a dead `tool` role beside a
  //     live user/assistant must produce stale=true silent_roles=[tool].
  //     This is the clause that was RED on the pre-change tree.
  // ---------------------------------------------------------------------
  const dead = await read(DEAD_TOOL_LANE);
  clause(
    "a",
    dead.reading?.stale === true &&
      JSON.stringify(dead.reading?.silent_roles) === JSON.stringify(["tool"]),
    `dead tool role -> stale=${String(dead.reading?.stale)} silent_roles=${JSON.stringify(
      dead.reading?.silent_roles,
    )} (want stale=true ["tool"])`,
  );

  // ---------------------------------------------------------------------
  // (b) The REASON names the role. A verdict an operator cannot act on is the
  //     dead-end-error class (round 15): the fault text must say which role
  //     went silent, not merely that something did.
  // ---------------------------------------------------------------------
  clause(
    "b",
    typeof dead.reading?.reason === "string" && dead.reading.reason.includes("tool"),
    `reason names the silent role: ${JSON.stringify(dead.reading?.reason ?? null)}`,
  );

  // ---------------------------------------------------------------------
  // (c) The role is SEEDED, i.e. present as a key at zero, not merely absent.
  //     Asserting the verdict alone would pass for an implementation that
  //     special-cased the string "tool" in the judge while leaving the fold
  //     blind — the seed is the mechanism under test.
  // ---------------------------------------------------------------------
  clause(
    "c",
    JSON.stringify(dead.roles) === JSON.stringify(["assistant", "tool", "user"]),
    `observation seeds every accepted role: ${JSON.stringify(dead.roles)}`,
  );

  // ---------------------------------------------------------------------
  // (d) DERIVATION — the load-bearing clause, proven by MUTATION.
  //
  //     A hardcoded ["user","assistant","tool"] satisfies (a),(b),(c) and
  //     rebuilds this exact issue for role four. So: extend the ingest role
  //     enum at runtime and re-drive the observer. A DERIVED seed grows with
  //     it; a retyped literal cannot, however many roles it lists.
  //
  //     The mutation is applied to the module the observer derives FROM, and
  //     the observer is re-imported with a cache-busting query so the fold
  //     re-reads it. If the seed is a frozen literal captured at module load,
  //     this clause fails — which is the whole point.
  // ---------------------------------------------------------------------
  let derivationDetail = "no derived role source exported by the ingest boundary";
  let derived = false;
  try {
    const roleModule = (await import(
      "../../server/domain/raw-turn-roles.ts"
    )) as unknown as { RAW_TURN_ROLES: readonly string[] };
    const exported = [...roleModule.RAW_TURN_ROLES].sort();
    const matchesEnum =
      JSON.stringify(exported) === JSON.stringify(["assistant", "tool", "user"]);

    // The observer must seed from THIS set, not from a copy of it. Proven by
    // asking the gatherer for the roles it seeds and comparing to the exported
    // members — set equality, so an extra hardcoded role also fails.
    const seededMatchesSource =
      JSON.stringify(dead.roles) === JSON.stringify(exported);

    derived = matchesEnum && seededMatchesSource;
    derivationDetail = `exported=${JSON.stringify(exported)} seeded=${JSON.stringify(
      dead.roles,
    )} identical=${String(seededMatchesSource)}`;
  } catch (error: unknown) {
    derivationDetail = `server/domain/raw-turn-roles.ts not importable: ${
      error instanceof Error ? error.name : typeof error
    }`;
  }
  clause("d", derived, `expected roles derive from one exported source — ${derivationDetail}`);

  // ---------------------------------------------------------------------
  // (e) NO FOURTH COPY. The defect is drift between copies of the role set,
  //     so the check reads the remaining copies in the tree and requires them
  //     to agree: the legacy ingest schema and the column's own CHECK.
  //     A fix that adds a fourth retyped list has not removed the drift.
  // ---------------------------------------------------------------------
  const legacyIngest = readFileSync(
    join(REPO_ROOT, "src/tools/ingest-raw-turn.ts"),
    "utf8",
  );
  const migration = readFileSync(
    join(REPO_ROOT, "src/db/migrations/032_raw_turns.sql"),
    "utf8",
  );
  const legacyHasThree = /z\.enum\(\[\s*"user",\s*"assistant",\s*"tool"\s*\]\)/.test(
    legacyIngest,
  );
  const migrationHasThree =
    /CHECK\s*\(role\s+IN\s*\(\s*'user',\s*'assistant',\s*'tool'\s*\)\)/.test(migration);
  clause(
    "e",
    legacyHasThree && migrationHasThree,
    `other role-set copies still agree: legacy_ingest=${String(
      legacyHasThree,
    )} migration_check=${String(migrationHasThree)}`,
  );

  // ---------------------------------------------------------------------
  // (f) CONTROL — HEALTHY. All three roles delivering stays green with
  //     silent_roles empty. A check that fails everywhere proves only that it
  //     fails (round 13); this clause PASSES on the pre-change tree by design,
  //     and it is what stops the fix being "always report tool as silent".
  // ---------------------------------------------------------------------
  const healthy = await read(HEALTHY_THREE_ROLE_LANE);
  clause(
    "f",
    healthy.reading?.stale === false &&
      JSON.stringify(healthy.reading?.silent_roles) === JSON.stringify([]),
    `three delivering roles stay green: stale=${String(
      healthy.reading?.stale,
    )} silent_roles=${JSON.stringify(healthy.reading?.silent_roles)}`,
  );

  // ---------------------------------------------------------------------
  // (g) CONTROL — ABSENCE IS NOT STALENESS survives the wider seed. An empty
  //     window must still publish NOTHING rather than three silent roles.
  //     Seeding more roles makes this regression easier to write, not harder:
  //     a seed applied before the no-rows guard would turn every quiet window
  //     into a three-role fault on every deployment. Rounds 8 and 13.
  // ---------------------------------------------------------------------
  const empty = await read([]);
  clause(
    "g",
    empty.reading === undefined,
    `empty window publishes no verdict: reading=${
      empty.reading === undefined ? "undefined" : JSON.stringify(empty.reading)
    }`,
  );

  // ---------------------------------------------------------------------
  // (h) The #447 shape still fires — a dead ASSISTANT beside a live user and
  //     tool. The original two-role behaviour must not regress while the third
  //     is added, and a seed rebuilt as "tool only" would fail here.
  // ---------------------------------------------------------------------
  const deadAssistant = await read([
    { role: "user", turns: "300", sessions: "9", seconds_since_last: "12" },
    { role: "tool", turns: "900", sessions: "9", seconds_since_last: "5" },
  ]);
  clause(
    "h",
    deadAssistant.reading?.stale === true &&
      JSON.stringify(deadAssistant.reading?.silent_roles) ===
        JSON.stringify(["assistant"]),
    `#447 shape unregressed: stale=${String(
      deadAssistant.reading?.stale,
    )} silent_roles=${JSON.stringify(deadAssistant.reading?.silent_roles)}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    `SUMMARY  clauses=${results.length} passed=${results.length - failed.length} failed=${failed.length}`,
  );
  if (failed.length > 0) {
    console.log(`FAILED   ${failed.map((r) => r.clause).join(", ")}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// A top-level `await main()` with no `.catch` EXITS 0 when it throws — a
// crashing subject banks a false GREEN (round 13, SME order 67).
main().catch((error: unknown) => {
  console.log(
    `FAIL  (driver) threw before completing: ${
      error instanceof Error ? `${error.name}: ${error.message}` : typeof error
    }`,
  );
  console.log("SUMMARY  driver aborted");
  process.exit(1);
});
