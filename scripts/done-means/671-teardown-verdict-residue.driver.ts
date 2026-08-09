/**
 * Driver for the #671 DONE-MEANS check. Not a test file; invoked by
 * scripts/done-means/671-teardown-verdict-residue.sh, which owns the verdict.
 *
 * WHAT IS BEING PROVEN, AND WHERE THIS CHECK STANDS TO SEE IT
 * -----------------------------------------------------------
 * The defect (#671) is that the scenario gate's TEARDOWN VERDICT read a tally
 * of cleanup CALLS instead of the rows those calls were supposed to remove. The
 * third credentialed #653 verify reported `attempted=6 archived=4
 * already_absent=0 failed=2` and exited 1 on a database that a 12-table residue
 * query had just proven clean: two `archive_entry` calls threw, the composed
 * namespace purge then removed every row, and nothing corrected the count.
 *
 * So this check's vantage has to be: a REAL database (residue is a database
 * fact and cannot be faked), driven through the SHIPPED `runScenarioGate`,
 * `teardownRecords`, `purgeNamespace` and `countNamespaceResidue`, with ONE
 * thing stubbed -- the `archive_entry` call, made to throw a labelled error.
 *
 * WHY THE STUB IS THE ARCHIVE CALL AND NOTHING ELSE
 * -------------------------------------------------
 * The whole issue is the interaction between "a cleanup call threw" and "no
 * rows remain". Reproducing it needs a throwing archive AND a working purge in
 * the same run. On a live deployment that combination happens by accident and
 * only sometimes; here it is deterministic. Everything downstream of the throw
 * -- the tally arithmetic, the purge, the residue reading, the verdict -- is
 * the shipped code path, unmodified.
 *
 * ITS LIMITATION, STATED RATHER THAN IMPLIED (round 22 Tightening). The #655
 * driver's known gap was that a stubbed seam hides defects living in the real
 * seam -- exactly how #666 slipped past #655's green. The same gap applies
 * here: this driver's `archive_entry` is a local throw, NOT the live
 * MCP `archive_entry` tool, so this check CANNOT tell you WHY the live tool
 * throws on memory-kind records. It proves only what it claims -- that a
 * throwing archive plus a successful purge yields a GREEN verdict with the
 * throw's label reported. Establishing the live throw's cause is a separate,
 * credentialed job (#671 says so explicitly: do not absorb it here).
 *
 * Output is one JSON object written to DONE_MEANS_671_OUT. Counts, booleans and
 * this driver's own error labels only -- no row content, no credentials.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runScenarioGate } from "../../eval/open-brain/live/scenario-gate.ts";
import { teardownRecords } from "../../eval/open-brain/live/gate.ts";
import { purgeNamespace } from "../../eval/open-brain/live/namespace-purge.ts";
import type {
  ProviderExecution,
  ScenarioRecord,
  ScenarioTransport,
  TeardownTally,
} from "../../eval/open-brain/live/scenario-types.ts";
import { LiveTransportError } from "../../eval/open-brain/live/transport.ts";
import { runNamespaces, makeRunId } from "../../eval/open-brain/live/config.ts";
import { loadScenarioFixture } from "../../eval/open-brain/live/scenario-fixtures.ts";

const DB_URL = process.env.DONE_MEANS_671_DB_URL;
const OUT_PATH = process.env.DONE_MEANS_671_OUT;
if (!DB_URL || !OUT_PATH) {
  console.error("DONE_MEANS_671_DB_URL and DONE_MEANS_671_OUT are required");
  process.exit(3);
}

const pool = new Pool({ connectionString: DB_URL });

const CREATED_BY = "done-means-671";

/**
 * The residue shape, declared LOCALLY on purpose.
 *
 * `TeardownResidue` is one of the things the fix adds, so importing its type
 * from the product would make this driver unloadable on the pre-fix tree. A
 * static import of a not-yet-existing export dies at module resolution before a
 * single clause prints — a false RED shaped exactly like a real one, reached by
 * the ordinary act of writing a check for something that does not exist yet
 * (docs/lane-contract.md Tightenings round 18). The local declaration keeps the
 * driver loadable on BOTH trees so the RED it produces is the defect and not
 * the import.
 */
interface TeardownResidue {
  checked: boolean;
  rows: number;
  by_table: Record<string, number>;
  unchecked_reason?: string;
}

/**
 * `countNamespaceResidue` is likewise added by the fix, so it is resolved
 * DYNAMICALLY at call time. On the fixed tree this is the shipped counter — the
 * same function the product uses, not a copy that could agree with itself while
 * the product is wrong. On the pre-fix tree the export is absent, and rather
 * than crashing the driver (false RED) this falls back to counting the same
 * tables directly, so the clauses can still report a real verdict.
 *
 * The fallback list is deliberately SHORT and is only ever reached on a tree
 * that has no shipped counter to be authoritative about; it announces itself in
 * the log so a reader never mistakes it for the product's reading.
 */
const FALLBACK_TABLES = [
  "ob_session_lanes",
  "thoughts",
  "decisions",
  "sessions",
] as const;

async function observeResidue(namespace: string): Promise<TeardownResidue> {
  const module = (await import(
    "../../eval/open-brain/live/namespace-purge.ts"
  )) as Record<string, unknown>;
  const shipped = module.countNamespaceResidue as
    | ((pool: Pool, ns: string) => Promise<{
        rows: number;
        rows_by_table: Record<string, number>;
        unreadable_tables: Record<string, string>;
      }>)
    | undefined;

  if (typeof shipped === "function") {
    const seen = await shipped(pool, namespace);
    const unreadable = Object.keys(seen.unreadable_tables);
    return unreadable.length > 0
      ? {
          checked: false,
          rows: seen.rows,
          by_table: seen.rows_by_table,
          unchecked_reason: `unreadable_tables=${unreadable.sort().join(",")}`,
        }
      : { checked: true, rows: seen.rows, by_table: seen.rows_by_table };
  }

  console.log(
    "INFO  countNamespaceResidue is ABSENT from this tree (pre-fix) — falling back to a direct row count so the clauses still get a real reading",
  );
  const byTable: Record<string, number> = {};
  let rows = 0;
  for (const table of FALLBACK_TABLES) {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE namespace = $1`,
      [namespace],
    );
    const count = Number(result.rows[0]?.n ?? 0);
    if (count > 0) {
      byTable[table] = count;
      rows += count;
    }
  }
  return { checked: true, rows, by_table: byTable };
}

/**
 * The label the stubbed archive throws with.
 *
 * Clause (c) is a MUTATION clause: rename this constant and the receipt text
 * must follow. If the receipt still reads the old label, the "label reaches the
 * receipt" claim was being satisfied by something other than the label -- the
 * round-9/17 negative-match family. It deliberately does not appear anywhere in
 * the shell script as a hardcoded literal; the shell reads it from this
 * driver's own JSON output, so the two cannot drift apart into a false green.
 */
const STUB_ARCHIVE_LABEL = "archive_entry:done-means-671-stub-throw";

interface DriverOut {
  /** Which mode this run was in: "throwing_archive" or "residue_control". */
  mode: string;
  /** The label this driver's stub threw with, so the shell need not hardcode it. */
  expected_label: string;
  scenario_count: number;
  /** The gate's own composite verdict. */
  gate_passed: boolean;
  /** The gate's verdict-bearing failure strings. */
  gate_failures: string[];
  /** The gate's NON-verdict diagnostics (#671). */
  gate_diagnostics: string[];
  /** Tally: cleanup calls that threw. Diagnostics only since #671. */
  teardown_failed: number;
  /** Tally: the captured labels of those throws. */
  teardown_failure_labels: string[];
  /** Residue: whether an observation actually ran. */
  residue_checked: boolean;
  /** Residue: rows remaining under this run's namespace. */
  residue_rows: number;
  /** Residue: which tables still hold rows. */
  residue_tables: string[];
  /** Independent confirmation, taken by this driver AFTER the gate returned. */
  independent_residue_rows: number;
}

/**
 * A ScenarioTransport whose database side is entirely real, whose provider side
 * is a local shape, and whose `archive_entry` DELIBERATELY THROWS.
 */
class ThrowingArchiveTransport implements ScenarioTransport {
  purgedRows = 0;
  archiveThrows = 0;

  constructor(
    private readonly namespace: string,
    /**
     * `false` disables the namespace purge, which is clause (b)'s control: with
     * the purge off, the seeded rows genuinely REMAIN, and the gate must FAIL
     * naming the table and count. Announced in the run log, never silent.
     */
    private readonly purgeEnabled: boolean,
  ) {}

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
    // Same column mapping the #655 driver announces: `ob_session_lanes` has no
    // platform/server_id columns, so the fixture's platform lands in `source`
    // and its server_id in `project`. Announced, not silently dropped.
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
    return {
      status: "ok",
      sections: {
        durable_memory: {
          item_count: rows.length,
          items: rows.map((row) => ({ id: row.id, content: row.content })),
        },
      },
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
    return {
      lane: { id: lane.id, current_context_md: lane.current_context_md },
      events: events.rows.map((row) => ({ id: row.id, content: row.content })),
    };
  }

  /**
   * The shipped composition, reproduced with exactly one substitution: the
   * archive call throws. `teardownRecords`, `purgeNamespace` and
   * `countNamespaceResidue` are the real functions.
   */
  async cleanup(
    records: ScenarioRecord[],
    namespace: string,
  ): Promise<{ tally: TeardownTally; residue: TeardownResidue }> {
    const tally = await teardownRecords(records, (record) =>
      this.cleanupRecord(record, namespace),
    );

    if (this.purgeEnabled) {
      const purge = await purgeNamespace(pool, namespace);
      this.purgedRows = purge.deleted;
    } else {
      console.log(
        "INFO  purge DISABLED for this run (clause (b) residue control) — rows are expected to REMAIN",
      );
    }

    // Returned in BOTH shapes on purpose, and this is load-bearing for the RED
    // run rather than defensive habit.
    //
    // The fix changes `cleanup`'s contract from `TeardownTally` to
    // `{ tally, residue }`. A driver returning only the NEW shape hands the
    // PRE-FIX gate an object with no `failed` property; `teardown.failed > 0`
    // reads `undefined > 0`, which is false, and the pre-fix gate then reports
    // PASS — the driver would have accidentally repaired the very defect it
    // exists to expose. Observed on the first RED attempt: `gate passed=true`
    // on unmodified origin/main.
    //
    // Spreading the tally's own fields alongside means the pre-fix gate reads
    // the real `failed` and fails exactly as it does in production, while the
    // fixed gate reads `.tally`/`.residue` and ignores the extras. One driver,
    // an honest reading on both trees.
    const residue = await observeResidue(namespace);
    return { ...tally, tally, residue } as unknown as {
      tally: TeardownTally;
      residue: TeardownResidue;
    };
  }

  private async cleanupRecord(
    record: ScenarioRecord,
    namespace: string,
  ): Promise<"archived" | "already_absent"> {
    if (record.kind === "memory") {
      // THE STUB. On a live deployment this is the MCP `archive_entry` tool,
      // and on the third credentialed #653 verify it threw on exactly these
      // memory-kind records. Throwing a LiveTransportError reproduces the shape
      // the live client raises, so the label capture under test is exercised
      // through its real branch rather than the generic fallback.
      this.archiveThrows += 1;
      throw new LiveTransportError(STUB_ARCHIVE_LABEL, false);
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

async function main(): Promise<void> {
  // "residue_control" is clause (b): the purge is disabled so rows genuinely
  // remain and the gate MUST fail naming them. Announced in the output.
  const mode = process.env.DONE_MEANS_671_MODE === "residue_control"
    ? "residue_control"
    : "throwing_archive";
  const purgeEnabled = mode !== "residue_control";
  console.log(`INFO  mode=${mode} purge_enabled=${purgeEnabled}`);

  const runId = makeRunId({
    prefix: `scenario-donemeans671`,
    randomHex: randomUUID().replaceAll("-", "").slice(0, 12),
    // An operator label in the ambient environment would otherwise change the
    // namespace this check asserts on. Announced, per nothing-is-adjusted-silently.
    env: {},
  });
  const { primary } = runNamespaces(runId);
  console.log(`INFO  driver namespace: ${primary}`);

  const fixture = await loadScenarioFixture(
    "eval/open-brain/fixtures/scenarios-v1.json",
  );
  const transport = new ThrowingArchiveTransport(primary, purgeEnabled);

  const outcome = await runScenarioGate({
    fixture,
    namespace: primary,
    transport,
    commit: "done-means-671",
    generatedAt: new Date().toISOString(),
    runId,
  });

  const receipt = outcome.receipt;
  console.log(
    `INFO  gate passed=${receipt.passed} scenarios=${receipt.scenarios.length} ` +
      `archive_throws=${transport.archiveThrows} purged_rows=${transport.purgedRows}`,
  );
  console.log(`INFO  gate failures: ${JSON.stringify(receipt.failures)}`);
  console.log(
    `INFO  gate diagnostics: ${JSON.stringify((receipt as unknown as Record<string, unknown>).diagnostics ?? null)}`,
  );
  console.log(`INFO  teardown tally: ${JSON.stringify(receipt.teardown)}`);
  console.log(
    `INFO  teardown residue: ${JSON.stringify((receipt as unknown as Record<string, unknown>).teardown_residue ?? null)}`,
  );

  // An INDEPENDENT reading, taken after the gate returned and not through the
  // gate's own report. Round 16/19's rule: the run's self-report is never the
  // proof; a count from outside it is.
  const independent = await observeResidue(primary);

  // Every field the FIX adds to the receipt is read defensively. On the pre-fix
  // tree `diagnostics`, `failure_labels` and `teardown_residue` do not exist, and
  // a hard property access would crash the driver into a false RED rather than
  // letting the clauses report the absence as the real result it is.
  const loose = receipt as unknown as Record<string, unknown>;
  const diagnostics = Array.isArray(loose.diagnostics)
    ? (loose.diagnostics as string[])
    : [];
  const tallyLoose = receipt.teardown as unknown as Record<string, unknown>;
  const failureLabels = Array.isArray(tallyLoose.failure_labels)
    ? (tallyLoose.failure_labels as string[])
    : [];
  const reportedResidue = loose.teardown_residue as TeardownResidue | undefined;

  const out: DriverOut = {
    mode,
    expected_label: STUB_ARCHIVE_LABEL,
    scenario_count: receipt.scenarios.length,
    gate_passed: receipt.passed,
    gate_failures: receipt.failures,
    gate_diagnostics: diagnostics,
    teardown_failed: receipt.teardown.failed,
    teardown_failure_labels: failureLabels,
    // A tree whose gate reports no residue at all is exactly the #671 defect:
    // `checked: false` records that the GATE never observed rows, which is a
    // different fact from "there were none".
    residue_checked: reportedResidue?.checked ?? false,
    residue_rows: reportedResidue?.rows ?? 0,
    residue_tables: Object.keys(reportedResidue?.by_table ?? {}).sort(),
    independent_residue_rows: independent.rows,
  };
  await Bun.write(OUT_PATH!, JSON.stringify(out, null, 2));
  console.log(`INFO  wrote ${OUT_PATH}`);
}

try {
  await main();
} catch (error: unknown) {
  // A top-level await with no catch exits 0 when it throws (Tightening round
  // 13), which would bank a false GREEN for the shell wrapper. Fail loudly.
  console.error(
    `FATAL driver threw: ${error instanceof Error ? error.constructor.name : "unknown"}`,
  );
  console.error(error);
  await pool.end();
  process.exit(4);
}
await pool.end();
