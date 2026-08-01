import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.ts";
import { isHarnessNoise, registerIngestRawTurn } from "../ingest-raw-turn.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// isHarnessNoise is pure, so its coverage runs everywhere. The ingest path
// itself needs a real database (namespace predicate, ON CONFLICT, jsonb
// round-trip) and is gated on OPENBRAIN_TEST_DATABASE_URL like 025/027/032.
describe("harness noise filter", () => {
  it("drops runtime scaffolding that is not dialogue", () => {
    // Measured across 515 transcripts: these are the exact strings that repeat
    // hundreds of times with no author and no decision content.
    for (const noise of [
      "[Request interrupted by user]",
      "[Request interrupted by user for tool use]",
      "<local-command-caveat>Caveat: the messages below...</local-command-caveat>",
      "<command-name>/exit</command-name>",
      "<bash-stdout>(Bash completed with no output)</bash-stdout>",
      "Continue from where you left off.",
      "   ",
      "",
    ]) {
      expect(isHarnessNoise(noise)).toBe(true);
    }
  });

  it("keeps real dialogue, including talk ABOUT the markers", () => {
    // A shape filter must not swallow a turn that merely mentions the markers,
    // or the conversation where we diagnosed them would itself be lost.
    for (const real of [
      "yeah, that's right. We should not be ingesting them at all.",
      "why does [Request interrupted by user] appear 270 times?",
      "run <bash-input> through the filter and tell me what happens",
      "no",
    ]) {
      expect(isHarnessNoise(real)).toBe(false);
    }
  });
});

// Assembled at runtime so no credential-shaped literal exists in the source
// tree; the secret scanner correctly refuses a realistic-looking fixture.
const FAKE_TOKEN = ["sk", "live", "abcd1234efgh5678ijkl"].join("-");

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("ingest_raw_turn (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const nsAlice = "test-ingest-alice";
  const nsBob = "test-ingest-bob";

  const alice: AuthInfo = {
    role: "agent",
    clientId: nsAlice,
    namespaceSource: "token",
  };

  const bob: AuthInfo = {
    role: "agent",
    clientId: nsBob,
    namespaceSource: "token",
  };

  // Minimal MCP server double: capture the registered handler and call it the
  // way the real server would.
  type Handler = (
    args: Record<string, unknown>,
    extra: { authInfo?: AuthInfo },
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  let handler: Handler;

  const server = {
    registerTool(_name: string, _schema: unknown, fn: Handler) {
      handler = fn;
    },
  } as unknown as Parameters<typeof registerIngestRawTurn>[0];

  async function ingest(
    turns: Array<Record<string, unknown>>,
    auth: AuthInfo = alice,
    namespace?: string,
  ): Promise<Record<string, unknown>> {
    const res = await handler(namespace ? { turns, namespace } : { turns }, {
      authInfo: auth,
    });
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  }

  function turn(overrides: Record<string, unknown> = {}) {
    return {
      turn_uuid: "t-1",
      turn_index: 0,
      role: "user",
      content: "hello",
      ...overrides,
    };
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM ob_raw_turns WHERE namespace = ANY($1)", [
      [nsAlice, nsBob],
    ]);
  }

  beforeAll(async () => {
    await runMigrations(pool);
    registerIngestRawTurn(server, { pool } as unknown as ToolDeps);
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("ingests both sides of a conversation", async () => {
    // The whole point: the assistant half was never captured before.
    const result = await ingest([
      turn({ turn_uuid: "u-1", role: "user", content: "what broke?" }),
      turn({
        turn_uuid: "a-1",
        role: "assistant",
        content: "the writer only read user records",
        turn_index: 1,
      }),
      turn({
        turn_uuid: "t-1",
        role: "tool",
        content: 'Q: ship it? A: "yes"',
        turn_index: 2,
      }),
    ]);

    expect(result.ingested).toBe(3);

    const { rows } = await pool.query(
      "SELECT role FROM ob_raw_turns WHERE namespace = $1 ORDER BY turn_index",
      [nsAlice],
    );
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("makes a replayed batch a no-op instead of duplicating", async () => {
    const batch = [turn({ turn_uuid: "dup-1" }), turn({ turn_uuid: "dup-2" })];
    const first = await ingest(batch);
    const second = await ingest(batch);

    expect(first.ingested).toBe(2);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it("filters harness noise without failing the batch", async () => {
    const result = await ingest([
      turn({ turn_uuid: "keep-1", content: "a real decision" }),
      turn({ turn_uuid: "drop-1", content: "[Request interrupted by user]" }),
      turn({
        turn_uuid: "drop-2",
        content: "<command-name>/exit</command-name>",
      }),
    ]);

    expect(result.ingested).toBe(1);
    expect(result.filtered).toBe(2);
  });

  it("redacts the value but keeps the statement", async () => {
    // A turn is NEVER dropped for containing a credential; fail-closed was
    // explicitly rejected.
    await ingest([
      turn({
        turn_uuid: "secret-1",
        content: `set AUTH_TOKEN_ADMIN=${FAKE_TOKEN} and retry`,
      }),
    ]);

    const { rows } = await pool.query(
      "SELECT content, redaction_applied FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = 'secret-1'",
      [nsAlice],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain(FAKE_TOKEN);
    expect(rows[0].content).toContain("AUTH_TOKEN_ADMIN");
    expect(rows[0].content).toContain("retry");
    expect(rows[0].redaction_applied).toEqual(["secret_value"]);
  });

  it("stores structured provenance and the reply chain", async () => {
    await ingest([
      turn({
        turn_uuid: "prov-1",
        parent_turn_uuid: "root-0",
        logical_parent_turn_uuid: "pre-compact-0",
        prompt_id: "p-1",
        session_ref: "sess-1",
        repo: "open-brain",
        git_branch: "feat/380",
        is_human_prompt: true,
        runtime: "claude-code",
        token_estimate: 42,
        occurred_at: "2026-07-25T18:00:00Z",
        metadata: { model: "claude-opus-5", effort: "high" },
      }),
    ]);

    const { rows } = await pool.query(
      `SELECT parent_turn_uuid, logical_parent_turn_uuid, prompt_id, repo,
              git_branch, is_human_prompt, runtime, token_estimate,
              occurred_at, valid_at, metadata
         FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = 'prov-1'`,
      [nsAlice],
    );
    const row = rows[0];
    expect(row.parent_turn_uuid).toBe("root-0");
    expect(row.logical_parent_turn_uuid).toBe("pre-compact-0");
    expect(row.repo).toBe("open-brain");
    expect(row.is_human_prompt).toBe(true);
    expect(row.token_estimate).toBe(42);
    expect(row.metadata.model).toBe("claude-opus-5");
    // valid_at mirrors occurred_at: the turn became true when it happened.
    expect(row.valid_at).toEqual(row.occurred_at);
  });

  it("refuses to write outside the caller's namespace", async () => {
    const res = await handler(
      { turns: [turn({ turn_uuid: "cross-1" })], namespace: nsBob },
      { authInfo: alice },
    );
    expect(res.isError).toBe(true);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM ob_raw_turns WHERE namespace = $1",
      [nsBob],
    );
    expect(rows[0].n).toBe(0);
  });

  it("computes session_seq per namespace, never across the boundary", async () => {
    // session_ref is client-supplied and NOT unique across namespaces (the only
    // uniqueness is (namespace, turn_uuid), migration 032). Two namespaces can
    // legitimately carry the same session_ref. The post-insert session_seq
    // recompute must partition within a namespace: a write in one namespace
    // must never renumber another namespace's rows by folding its occurred_at
    // values into their ordering.
    const shared = "shared-session-ref";

    // Bob writes two turns whose occurred_at straddle Alice's later write.
    await ingest(
      [
        turn({
          turn_uuid: "bob-1",
          session_ref: shared,
          occurred_at: "2026-07-25T10:00:00Z",
        }),
        turn({
          turn_uuid: "bob-2",
          session_ref: shared,
          occurred_at: "2026-07-25T12:00:00Z",
          turn_index: 1,
        }),
      ],
      bob,
      nsBob,
    );

    async function seq(
      namespace: string,
      uuid: string,
    ): Promise<number | null> {
      const { rows } = await pool.query(
        "SELECT session_seq FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = $2",
        [namespace, uuid],
      );
      return rows[0]?.session_seq ?? null;
    }

    // Bob's own two-turn session is numbered 0, 1 by occurred_at.
    expect(await seq(nsBob, "bob-1")).toBe(0);
    expect(await seq(nsBob, "bob-2")).toBe(1);

    // Alice now writes a turn on the SAME session_ref whose occurred_at falls
    // BETWEEN Bob's two. If the recompute ignored namespace, it would insert
    // Alice's row into Bob's ordering and push bob-2 from seq 1 to seq 2.
    await ingest([
      turn({
        turn_uuid: "alice-1",
        session_ref: shared,
        occurred_at: "2026-07-25T11:00:00Z",
      }),
    ]);

    // Bob's sequence is untouched by Alice's write.
    expect(await seq(nsBob, "bob-1")).toBe(0);
    expect(await seq(nsBob, "bob-2")).toBe(1);
    // Alice's own session is numbered independently, from zero.
    expect(await seq(nsAlice, "alice-1")).toBe(0);
  });

  it("repairs a NULL session_seq on an ordinary duplicate replay (F5)", async () => {
    // The recompute is derived from the whole validated payload, not only from
    // the INSERT's RETURNING rows. So a session left with session_seq = NULL --
    // e.g. by a prior call whose recompute failed transiently -- is repaired by
    // an ordinary replay of the same turn_uuids, even though that replay inserts
    // zero new rows. Keying the recompute off RETURNING alone would skip it.
    const sref = "repair-session";
    await ingest([
      turn({
        turn_uuid: "rep-1",
        session_ref: sref,
        occurred_at: "2026-07-25T09:00:00Z",
      }),
      turn({
        turn_uuid: "rep-2",
        session_ref: sref,
        occurred_at: "2026-07-25T09:05:00Z",
        turn_index: 1,
      }),
    ]);

    // Simulate a prior transient recompute failure: blank the seq back to NULL.
    await pool.query(
      "UPDATE ob_raw_turns SET session_seq = NULL WHERE namespace = $1 AND session_ref = $2",
      [nsAlice, sref],
    );
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM ob_raw_turns WHERE namespace = $1 AND session_ref = $2 AND session_seq IS NULL",
      [nsAlice, sref],
    );
    expect(before.rows[0].n).toBe(2);

    // Replay the identical batch: zero new rows insert (ON CONFLICT DO NOTHING),
    // but the recompute still runs for the payload's session_ref and re-numbers.
    const replay = await ingest([
      turn({
        turn_uuid: "rep-1",
        session_ref: sref,
        occurred_at: "2026-07-25T09:00:00Z",
      }),
      turn({
        turn_uuid: "rep-2",
        session_ref: sref,
        occurred_at: "2026-07-25T09:05:00Z",
        turn_index: 1,
      }),
    ]);
    expect(replay.ingested).toBe(0);
    expect(replay.duplicates).toBe(2);

    const after = await pool.query(
      "SELECT turn_uuid, session_seq FROM ob_raw_turns WHERE namespace = $1 AND session_ref = $2 ORDER BY session_seq",
      [nsAlice, sref],
    );
    expect(after.rows.map((r) => r.session_seq)).toEqual([0, 1]);
    expect(after.rows.map((r) => r.turn_uuid)).toEqual(["rep-1", "rep-2"]);
  });

  it("denies an unauthenticated caller", async () => {
    const res = await handler({ turns: [turn()] }, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toBe("auth_denied");
  });

  it("reports a batch that was entirely noise without erroring", async () => {
    const result = await ingest([
      turn({ turn_uuid: "n-1", content: "[Request interrupted by user]" }),
    ]);
    expect(result.ingested).toBe(0);
    expect(result.filtered).toBe(1);
  });
});
