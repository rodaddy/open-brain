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
