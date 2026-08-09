/**
 * Driver for the #655 DONE-MEANS check. Not a test file; invoked by
 * scripts/done-means/655-eval-teardown.sh, which owns the verdict.
 *
 * WHY THE TRANSPORT IS LOCAL AND THE DATABASE IS REAL
 * ---------------------------------------------------
 * The defect is RESIDUE in Postgres, so the database half must be real: rows
 * are seeded through actual SQL into a fresh migrated database, and the leak is
 * measured by querying that database afterwards.
 *
 * The MCP/provider half is driven through a local `ScenarioTransport`
 * implementation rather than a live deployment, for a reason that is about
 * correctness and not convenience. `LiveScenarioTransport` needs an admin or
 * ob-admin bearer token with X-Namespace delegation authority. Since the
 * neutrality scrub (PR #645) the repo `.env` carries empty placeholders, so
 * those values live only in the environment of whatever process is serving a
 * deployment — and a done-means check that reached into a running process to
 * harvest them would be doing exactly what the #578 gate header forbids. Making
 * the check depend on operator credentials would also mean it could not run in
 * CI or on a fresh clone, i.e. it would be a check nobody runs.
 *
 * What matters is that NOTHING under test is faked. `runScenarioGate`,
 * `teardownRecords`, the record-ordering, the namespace purge and its prefix
 * guard are all the shipped code. The transport supplies the two things a
 * deployment would otherwise supply — a seeded row and a session context —
 * writing both to the real database with real SQL, so the residue this check
 * measures is residue the shipped teardown either removed or did not.
 *
 * The transport records WHEN cleanup was invoked relative to when the scenario
 * read its record back. That ordering is what clause (c) needs and is not
 * observable from the receipt: a purge that ran too early would make the
 * scenario's own seed unfindable and could turn a broken run green.
 *
 * Output is one JSON object written to DONE_MEANS_655_OUT. Counts and booleans
 * only — no row content, no namespaces beyond the ones this run generated, no
 * credentials.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runScenarioGate } from "../../eval/open-brain/live/scenario-gate.ts";
import { teardownRecords } from "../../eval/open-brain/live/gate.ts";
import {
  assertPurgeableNamespace,
  purgeNamespace,
} from "../../eval/open-brain/live/namespace-purge.ts";
import type {
  ProviderExecution,
  ScenarioRecord,
  ScenarioTransport,
  TeardownTally,
} from "../../eval/open-brain/live/scenario-types.ts";
import { runNamespaces, makeRunId } from "../../eval/open-brain/live/config.ts";
import { loadScenarioFixture } from "../../eval/open-brain/live/scenario-fixtures.ts";

const DB_URL = process.env.DONE_MEANS_655_DB_URL;
const OUT_PATH = process.env.DONE_MEANS_655_OUT;
if (!DB_URL || !OUT_PATH) {
  console.error("DONE_MEANS_655_DB_URL and DONE_MEANS_655_OUT are required");
  process.exit(3);
}

const pool = new Pool({ connectionString: DB_URL });

/**
 * `created_by` is NOT NULL with no default on every table this driver writes,
 * so it must be supplied explicitly. A constant naming this check makes any row
 * that somehow outlives the throwaway database immediately attributable.
 */
const CREATED_BY = "done-means-655";

/**
 * Names the guard MUST refuse. The first two are the cases a naive
 * `namespace.includes("eval-live-recall-")` check waves through, which is why
 * they are here and not just an obviously-unrelated name.
 */
const MUST_REFUSE = [
  "rico", // an operator's real namespace
  "shared-kb", // the shared knowledge base
  "eval-live-recall-", // the bare prefix — no run ever produces it
  "not-eval-live-recall-abc123", // merely CONTAINS the prefix
  "eval-live-recal-abc123", // one character off
  "", // empty
];

interface DriverOut {
  scenario_count: number;
  scenario_assertions_passed: boolean;
  evidence_readable_before_teardown: boolean;
  teardown_failed: number;
  namespace_purged_rows: number;
  guard_cases: number;
  guard_refusals: number;
  guard_rows_touched_on_refusal: number;
  guard_allows_own_namespace: boolean;
}

/**
 * A ScenarioTransport backed by the real database for everything that leaves
 * residue, and by local shapes for the provider subprocess a deployment would
 * run. Cleanup delegates to the SHIPPED `teardownRecords` plus the SHIPPED
 * `purgeNamespace` — the code under test — rather than re-deriving either.
 */
class DriverTransport implements ScenarioTransport {
  /** Set when a scenario reads its own seeded row back successfully. */
  evidenceReadBack = false;
  /** Set the moment cleanup is first entered, so ordering is observable. */
  cleanupEntered = false;
  purgedRows = 0;

  constructor(private readonly namespace: string) {}

  /**
   * The provider subprocess a deployment would spawn. A capture writes a lane
   * and an event with real SQL so both become residue this check can measure.
   */
  async executeProvider(
    request: Record<string, unknown>,
  ): Promise<ProviderExecution> {
    const scope = request.scope as Record<string, unknown> | undefined;
    const sessionKey = String(scope?.session_key ?? "");
    const operation = String(request.operation ?? "capture");

    const laneId = await this.upsertLane(sessionKey, request);
    const result: Record<string, unknown> = { lane_id: laneId };

    if (operation === "checkpoint") {
      const sessionId = randomUUID();
      await pool.query(
        `INSERT INTO sessions (id, namespace, summary, created_by) VALUES ($1, $2, $3, $4)`,
        [sessionId, this.namespace, String(request.summary ?? ""), CREATED_BY],
      );
      await pool.query(
        `UPDATE ob_session_lanes SET current_context_md = $1 WHERE id = $2`,
        [String(request.summary ?? ""), laneId],
      );
      result.session_id = sessionId;
    } else {
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO ob_session_events (id, lane_id, event_type, content, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          eventId,
          laneId,
          String(request.event_type ?? "decision"),
          String(request.content ?? ""),
          CREATED_BY,
        ],
      );
      result.event_id = eventId;
    }

    return {
      exitCode: 0,
      receipt: {
        operation,
        status: "saved",
        durable: true,
        direct_attempted: true,
        fallback_attempted: false,
      },
      result,
    };
  }

  private async upsertLane(
    sessionKey: string,
    request: Record<string, unknown>,
  ): Promise<string> {
    const existing = await pool.query(
      `SELECT id FROM ob_session_lanes WHERE namespace = $1 AND session_key = $2`,
      [this.namespace, sessionKey],
    );
    if (existing.rows.length > 0) return existing.rows[0].id as string;
    const scope = request.scope as Record<string, unknown> | undefined;
    const laneId = randomUUID();
    // `ob_session_lanes` has no `platform`/`server_id` columns — the fixture's
    // scope carries them for the provider, and the lane table records `source`
    // instead. Announced rather than silently dropped: the fixture's
    // platform/server_id are folded into `source`, and `project` carries the
    // fixture's server_id, so nothing the fixture supplies is discarded.
    await pool.query(
      `INSERT INTO ob_session_lanes (id, namespace, session_key, agent, source, project, channel_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        laneId,
        this.namespace,
        sessionKey,
        String(scope?.agent ?? "scenario-eval"),
        String(scope?.platform ?? "eval"),
        String(scope?.server_id ?? "open-brain-scenarios"),
        String(scope?.channel_id ?? "driver"),
        CREATED_BY,
      ],
    );
    return laneId;
  }

  /** Seeds a real durable-memory row — the one that leaked in production. */
  async logMemory(opts: {
    table: "thoughts" | "decisions";
    content: string;
    tags: string[];
    namespace: string;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    if (opts.table === "thoughts") {
      await pool.query(
        `INSERT INTO thoughts (id, namespace, content, tags, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [id, opts.namespace, opts.content, opts.tags, CREATED_BY],
      );
    } else {
      await pool.query(
        `INSERT INTO decisions (id, namespace, title, rationale, tags, created_by)
         VALUES ($1, $2, $3, $3, $4, $5)`,
        [id, opts.namespace, opts.content, opts.tags, CREATED_BY],
      );
    }
    return { id };
  }

  /**
   * Reads the seeded row back out of the real database. This is the evidence
   * read: if teardown ran first, the row would be gone and `found` would be
   * false, which is precisely what clause (c) is watching for.
   */
  async contextPack(opts: {
    scope: { namespace: string };
    query: string;
    budgetMaxTokens: number;
  }): Promise<{
    status: string;
    sections: Record<string, unknown>;
    budget: Record<string, unknown>;
  }> {
    const { rows } = await pool.query(
      `SELECT id, content FROM thoughts WHERE namespace = $1 AND archived_at IS NULL`,
      [opts.scope.namespace],
    );
    if (rows.length > 0) this.evidenceReadBack = true;
    const sections = {
      durable_memory: {
        item_count: rows.length,
        items: rows.map((row) => ({ id: row.id, content: row.content })),
      },
    };
    return {
      status: "ok",
      sections,
      budget: { whole_pack: { content_char_limit: 100_000 } },
    };
  }

  async sessionContext(opts: {
    sessionKey: string;
    namespace: string;
  }): Promise<Record<string, unknown>> {
    const laneRows = await pool.query(
      `SELECT id, current_context_md FROM ob_session_lanes
       WHERE namespace = $1 AND session_key = $2`,
      [opts.namespace, opts.sessionKey],
    );
    if (laneRows.rows.length === 0) return { lane: null, events: [] };
    const lane = laneRows.rows[0];
    const events = await pool.query(
      `SELECT id, content FROM ob_session_events WHERE lane_id = $1 ORDER BY created_at`,
      [lane.id],
    );
    if (events.rows.length > 0) this.evidenceReadBack = true;
    return {
      lane: { id: lane.id, current_context_md: lane.current_context_md },
      events: events.rows.map((row) => ({ id: row.id, content: row.content })),
    };
  }

  /**
   * The code under test. Record teardown first (the existing design), then the
   * namespace purge (the #655 delta). Both are the shipped functions.
   */
  async cleanup(
    records: ScenarioRecord[],
    namespace: string,
  ): Promise<TeardownTally> {
    this.cleanupEntered = true;
    const tally = await teardownRecords(records, (record) =>
      this.cleanupRecord(record, namespace),
    );
    // DONE_MEANS_655_SKIP_PURGE reproduces the pre-fix world exactly: record
    // teardown runs, the namespace purge does not. It exists so the RED
    // transcript can be regenerated at any time WITHOUT deleting the fix, and
    // so anyone can confirm this check still discriminates rather than taking
    // a green run on faith (docs/lane-contract.md Tightenings round 13: "a
    // control clause that passes PRE-fix is the signal the check
    // discriminates"). It is read only by this driver, never by shipped code.
    if (process.env.DONE_MEANS_655_SKIP_PURGE === "1") {
      console.log(
        "INFO  DONE_MEANS_655_SKIP_PURGE=1 — namespace purge deliberately SKIPPED (pre-fix reproduction)",
      );
      return tally;
    }
    const purge = await purgeNamespace(pool, namespace);
    this.purgedRows = purge.deleted;
    return tally;
  }

  private async cleanupRecord(
    record: ScenarioRecord,
    namespace: string,
  ): Promise<"archived" | "already_absent"> {
    if (record.kind === "memory") {
      // Mirrors archive_entry's SOFT delete exactly (src/tools/archive-entry.ts:54).
      // Reproducing the soft-delete faithfully is the whole point: if this
      // driver hard-deleted here, the check could pass without the purge
      // existing and would prove nothing.
      const result = await pool.query(
        `UPDATE ${record.table} SET archived_at = NOW()
         WHERE id = $1 AND archived_at IS NULL AND namespace = $2 RETURNING id`,
        [record.id, namespace],
      );
      return (result.rowCount ?? 0) > 0 ? "archived" : "already_absent";
    }
    const result =
      record.kind === "event"
        ? await pool.query(
            `DELETE FROM ob_session_events AS event USING ob_session_lanes AS lane
             WHERE event.id = $1 AND event.lane_id = $2
               AND lane.id = event.lane_id AND lane.namespace = $3 RETURNING event.id`,
            [record.id, record.lane_id, namespace],
          )
        : await pool.query(
            `DELETE FROM ob_session_lanes
             WHERE id = $1 AND namespace = $2 AND session_key = $3 RETURNING id`,
            [record.id, namespace, record.session_key],
          );
    return (result.rowCount ?? 0) > 0 ? "archived" : "already_absent";
  }

  async close(): Promise<void> {}
}

/**
 * Clause (b): fire the guard at names it must refuse, and PROVE the refusal was
 * not merely an exception raised after the deletes had already run. Each
 * refused name gets a canary row planted under it first; if the row survives,
 * the refusal happened before any mutation.
 */
async function proveGuard(): Promise<{
  cases: number;
  refusals: number;
  rowsTouched: number;
  allowsOwn: boolean;
}> {
  let refusals = 0;
  let rowsTouched = 0;

  for (const name of MUST_REFUSE) {
    const canaryId = randomUUID();
    let planted = false;
    if (name.length > 0) {
      await pool.query(
        `INSERT INTO thoughts (id, namespace, content, tags, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [canaryId, name, "done-means-655 guard canary", ["done-means-655"], CREATED_BY],
      );
      planted = true;
    }

    try {
      await purgeNamespace(pool, name);
    } catch {
      refusals += 1;
    }

    if (planted) {
      const survived = await pool.query(
        `SELECT 1 FROM thoughts WHERE id = $1`,
        [canaryId],
      );
      if ((survived.rowCount ?? 0) === 0) rowsTouched += 1;
      // The canary is this driver's own row, planted seconds ago in a throwaway
      // database this check created and drops. Removing it here keeps the
      // clause (a) count honest.
      await pool.query(`DELETE FROM thoughts WHERE id = $1`, [canaryId]);
    }
  }

  // The positive case: a real per-run namespace must still be accepted, or the
  // guard is just a refusal machine and its refusals mean nothing.
  let allowsOwn = false;
  try {
    assertPurgeableNamespace(
      runNamespaces(makeRunId({ prefix: "guard-positive", randomHex: "abc123" })).primary,
    );
    allowsOwn = true;
  } catch {
    allowsOwn = false;
  }

  return { cases: MUST_REFUSE.length, refusals, rowsTouched, allowsOwn };
}

async function main(): Promise<void> {
  const runId = makeRunId({
    prefix: "scenario-donemeans655",
    randomHex: randomUUID().replaceAll("-", "").slice(0, 12),
    // An operator label in the ambient environment would otherwise be picked up
    // and change the namespace this check asserts on. Announced, per the
    // nothing-is-adjusted-silently rule.
    env: {},
  });
  const { primary } = runNamespaces(runId);
  console.log(`INFO  driver namespace: ${primary}`);

  const fixture = await loadScenarioFixture(
    "eval/open-brain/fixtures/scenarios-v1.json",
  );
  const transport = new DriverTransport(primary);

  const outcome = await runScenarioGate({
    fixture,
    namespace: primary,
    transport,
    commit: "done-means-655",
    generatedAt: new Date().toISOString(),
    runId,
  });

  console.log(
    `INFO  gate passed=${outcome.passed} scenarios=${outcome.receipt.scenarios.length} ` +
      `teardown=${JSON.stringify(outcome.receipt.teardown)} purged_rows=${transport.purgedRows}`,
  );
  for (const verdict of outcome.receipt.scenarios) {
    console.log(
      `INFO  scenario ${verdict.scenario_id}: passed=${verdict.passed}` +
        (verdict.failures.length > 0 ? ` failures=${verdict.failures.join(",")}` : ""),
    );
  }

  const guard = await proveGuard();
  console.log(
    `INFO  guard: ${guard.refusals}/${guard.cases} refused, ` +
      `rows_touched_on_refusal=${guard.rowsTouched}, allows_own=${guard.allowsOwn}`,
  );

  const out: DriverOut = {
    scenario_count: outcome.receipt.scenarios.length,
    scenario_assertions_passed: outcome.passed,
    evidence_readable_before_teardown: transport.evidenceReadBack,
    teardown_failed: outcome.receipt.teardown.failed,
    namespace_purged_rows: transport.purgedRows,
    guard_cases: guard.cases,
    guard_refusals: guard.refusals,
    guard_rows_touched_on_refusal: guard.rowsTouched,
    guard_allows_own_namespace: guard.allowsOwn,
  };
  await Bun.write(OUT_PATH as string, `${JSON.stringify(out, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(
      `driver error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 4;
  })
  .finally(() => pool.end());
