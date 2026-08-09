import { resolve } from "node:path";
import { Pool } from "pg";
import { summarizeChildStderr } from "../../../src/child-stderr.ts";
import type { LiveEvalConfig } from "./config.ts";
import { labelTeardownError, teardownRecords } from "./gate.ts";
import { countNamespaceResidue, purgeNamespace } from "./namespace-purge.ts";
import type {
  ProviderExecution,
  ProviderReceipt,
  ScenarioRecord,
  ScenarioTransport,
  TeardownResidue,
  TeardownTally,
} from "./scenario-types.ts";
import {
  LiveTransportError,
  OpenBrainLiveClient,
  type OpenBrainToolCaller,
} from "./transport.ts";

const PROVIDER_CWD = resolve(import.meta.dir, "../../../python/openbrain-memory");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseProviderOutput(
  text: string,
  exitCode: number,
  stderr = "",
): ProviderExecution {
  // Summarized once and attached to every exit from this function, so a
  // provider failure never presents as a bare exit code (issue #583).
  const diagnostics = summarizeChildStderr(stderr);
  const fail = (label: string): LiveTransportError =>
    new LiveTransportError(label, false, {
      errorClass: diagnostics.error_class,
      stderrFirstLine: diagnostics.stderr_first_line,
    });

  if (exitCode === 0 && text.trim() === "") {
    return { exitCode, result: {}, ...diagnostics };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("openbrain-memory:malformed-output");
  }
  const output = asRecord(parsed);
  const receipt = asRecord(output?.receipt);
  if (!receipt && exitCode === 0) {
    return { exitCode, result: asRecord(output?.result) ?? {}, ...diagnostics };
  }
  if (!receipt) {
    throw fail("openbrain-memory:missing-receipt");
  }
  const required = {
    operation: receipt.operation,
    status: receipt.status,
    durable: receipt.durable,
    direct_attempted: receipt.direct_attempted,
    fallback_attempted: receipt.fallback_attempted,
  };
  if (
    typeof required.operation !== "string" ||
    typeof required.status !== "string" ||
    typeof required.durable !== "boolean" ||
    typeof required.direct_attempted !== "boolean" ||
    typeof required.fallback_attempted !== "boolean"
  ) {
    throw fail("openbrain-memory:invalid-receipt");
  }
  const ignored = receipt.ignored_optional_request_keys;
  const providerReceipt: ProviderReceipt = {
    operation: required.operation,
    status: required.status,
    durable: required.durable,
    direct_attempted: required.direct_attempted,
    fallback_attempted: required.fallback_attempted,
    ignored_optional_request_keys: Array.isArray(ignored)
      ? ignored.filter((item): item is string => typeof item === "string")
      : undefined,
  };
  return {
    exitCode,
    receipt: providerReceipt,
    result: asRecord(output?.result) ?? {},
  };
}

export class LiveScenarioTransport implements ScenarioTransport {
  private readonly client: OpenBrainLiveClient;
  private readonly pool: Pool;

  constructor(
    caller: OpenBrainToolCaller,
    private readonly config: LiveEvalConfig,
    pool: Pool = new Pool(),
  ) {
    this.client = new OpenBrainLiveClient(caller);
    this.pool = pool;
  }

  async executeProvider(
    request: Record<string, unknown>,
  ): Promise<ProviderExecution> {
    const proc = Bun.spawn(["uv", "run", "openbrain-memory"], {
      cwd: PROVIDER_CWD,
      env: {
        ...process.env,
        OPENBRAIN_BASE_URL: this.config.baseUrl,
        OPENBRAIN_TOKEN: this.config.primaryToken,
        OPENBRAIN_NAMESPACE: this.config.primaryNamespace,
        OPENBRAIN_PROJECT: this.config.project,
        // This transport ALWAYS derives a per-run `eval-live-recall-*`
        // namespace (config.ts runNamespaces) that no token grants by default,
        // so it always needs the X-Namespace header. Since #657 the provider's
        // delegation is opt-in and default OFF, and without this flag
        // session_start binds the token's own namespace and refuses the
        // configured one (#666, #662's error text). A component that derives
        // foreign namespaces owns the delegation request — ledger item 30.1
        // puts the intent here, in code with its reason, rather than in
        // live-eval.env where every future credential assembly must remember
        // it. The token must still be admin/ob-admin; the server role-gates
        // the header regardless of this flag.
        OPENBRAIN_DELEGATE_NAMESPACE: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return parseProviderOutput(stdout, await proc.exited, stderr);
  }

  async logMemory(opts: {
    table: "thoughts" | "decisions";
    content: string;
    tags: string[];
    namespace: string;
  }): Promise<{ id: string }> {
    return this.client.logMemory(opts);
  }

  async contextPack(opts: {
    scope: Parameters<OpenBrainLiveClient["contextPack"]>[0]["scope"];
    query: string;
    budgetMaxTokens: number;
  }): Promise<{
    status: string;
    sections: Record<string, unknown>;
    budget: Record<string, unknown>;
  }> {
    return this.client.contextPack({
      scope: opts.scope,
      query: opts.query,
      requestedSections: ["durable_memory"],
      budgetMaxTokens: opts.budgetMaxTokens,
    });
  }

  sessionContext(opts: {
    sessionKey: string;
    namespace: string;
  }): Promise<Record<string, unknown>> {
    return this.client.structuredTool("session_context", {
      session_key: opts.sessionKey,
      namespace: opts.namespace,
      include_events: true,
      event_limit: 50,
    });
  }

  /**
   * Record teardown, then the namespace purge.
   *
   * The record pass is unchanged and stays first: it removes each seeded row by
   * exact id, which is the precise, reviewable operation and the one that
   * produces the tally the receipt reports.
   *
   * The purge that follows exists because record teardown, run perfectly,
   * still cannot remove a NAMESPACE (issue #655). Two independent reasons, both
   * measured in the dogfood database on 2026-08-08 rather than inferred:
   *
   *   - `archive_entry` is a SOFT delete (src/tools/archive-entry.ts:54). It
   *     sets `archived_at` and the row stays. Since a namespace in this schema
   *     is not a registry row — it exists exactly as long as some row carries
   *     it — an archived row keeps its namespace alive permanently. 21
   *     `eval-live-recall-*` namespaces held nothing but archived rows.
   *   - When the archive call THROWS, the tally counts `failed` and the row is
   *     left fully LIVE. Six `eval-live-recall-scenario-*` namespaces were in
   *     that state, from a receipt reading `attempted=1 archived=0
   *     already_absent=0 failed=1`.
   *
   * So this is an ADDITION, not a replacement, and it is not the "broad
   * namespace sweep" `cleanupRecord` below rules out: it targets one namespace
   * this process generated from a per-invocation crypto nonce, and
   * `purgeNamespace` refuses — before executing anything — any name outside the
   * eval prefix. That narrow shape is what `docs/issue-graph.md` ledger item 20
   * permits, and nothing wider.
   *
   * A purge failure is reported in the tally rather than thrown: the receipt is
   * the artifact an operator reads after a bad run, and a throw here would
   * discard the record tally that explains what did get cleaned. Silently
   * swallowing it would rebuild the exact defect #655 is about.
   *
   * THEN THE RESIDUE READING (issue #671). The tally above counts CALLS, and a
   * call that threw is not the same fact as a row that remains. On the third
   * credentialed #653 verify the two `archive_entry` throws pushed `failed=2`
   * while the purge that followed removed every row; the gate read the tally and
   * exited 1 on a clean database. So after everything has run, this asks the
   * database what is actually left, and THAT is what the gate's verdict reads.
   * The tally stays -- demoted to diagnostics, with the throw labels now
   * captured (`teardownRecords`) instead of discarded into a bare catch.
   */
  async cleanup(
    records: ScenarioRecord[],
    namespace: string,
  ): Promise<{ tally: TeardownTally; residue: TeardownResidue }> {
    const unique = Array.from(
      new Map(records.map((record) => [`${record.kind}:${record.id}`, record])).values(),
    );
    const order: Record<ScenarioRecord["kind"], number> = {
      event: 0,
      memory: 1,
      lane: 2,
    };
    unique.sort((a, b) => order[a.kind] - order[b.kind]);
    const tally = await teardownRecords(unique, (record) =>
      this.cleanupRecord(record, namespace),
    );

    try {
      const purge = await purgeNamespace(this.pool, namespace);
      const failedTables = Object.keys(purge.failed_tables);
      if (failedTables.length > 0) {
        tally.failed += failedTables.length;
        // The purge's per-table failures are content-free class names already;
        // labelling them by table keeps the diagnostic actionable rather than a
        // bare increment (#671).
        for (const [table, reason] of Object.entries(purge.failed_tables)) {
          tally.failure_labels.push(`purge:${table}:${reason}`);
        }
      }
    } catch (error: unknown) {
      // A refusal or a connection failure. Counted AND labelled, never hidden.
      tally.failed += 1;
      tally.failure_labels.push(`purge:${labelTeardownError(error)}`);
    }

    let residue: TeardownResidue;
    try {
      const observed = await countNamespaceResidue(this.pool, namespace);
      const unreadable = Object.keys(observed.unreadable_tables);
      residue =
        unreadable.length > 0
          ? {
              // A partial reading cannot support a clean verdict: the rows we
              // failed to count are exactly where residue would hide.
              checked: false,
              rows: observed.rows,
              by_table: observed.rows_by_table,
              unchecked_reason: `unreadable_tables=${unreadable.sort().join(",")}`,
            }
          : {
              checked: true,
              rows: observed.rows,
              by_table: observed.rows_by_table,
            };
    } catch (error: unknown) {
      residue = {
        checked: false,
        rows: 0,
        by_table: {},
        unchecked_reason: `residue_query_failed:${labelTeardownError(error)}`,
      };
    }

    return { tally, residue };
  }

  /**
   * Clean one exact record. Durable memory/session rows use archive_entry. The
   * public tool surface has no archive operation for session events or lanes, so
   * those two lifecycle rows are deleted by exact id plus namespace (and lane or
   * session-key identity), never by a broad namespace/query sweep.
   */
  private async cleanupRecord(
    record: ScenarioRecord,
    namespace: string,
  ): Promise<"archived" | "already_absent"> {
    if (record.kind === "memory") {
      return this.client.archive({ table: record.table, id: record.id });
    }
    const result =
      record.kind === "event"
        ? await this.pool.query(
            `DELETE FROM ob_session_events AS event
             USING ob_session_lanes AS lane
             WHERE event.id = $1 AND event.lane_id = $2
               AND lane.id = event.lane_id AND lane.namespace = $3
             RETURNING event.id`,
            [record.id, record.lane_id, namespace],
          )
        : await this.pool.query(
            `DELETE FROM ob_session_lanes
             WHERE id = $1 AND namespace = $2 AND session_key = $3
             RETURNING id`,
            [record.id, namespace, record.session_key],
          );
    return (result.rowCount ?? 0) > 0 ? "archived" : "already_absent";
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.pool.end();
  }
}
