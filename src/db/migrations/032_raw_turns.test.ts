import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { runMigrations } from "../migrate.ts";

// Live-Postgres coverage for migration 032 (Issue #380, INGEST-1). Proves the
// raw-turn table's structural guarantees against a real database rather than
// asserting SQL shape: exact-duplicate rejection, the reply chain, the
// undistilled work queue, the namespace boundary, and that 'tool' is an
// accepted role (measured 2026-07-25: AskUserQuestion answers arrive as
// tool_result blocks and carry the densest decision content in the corpus, so
// excluding them would rebuild the exact blindness full-send exists to fix).
//
// REQUIRES OPENBRAIN_TEST_DATABASE_URL and fails hard without it (operator
// ruling 2026-08-27, issue #878). It must point at an isolated test database,
// never the dogfood one. `bun run test:isolated` sets it.

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const nsAlice = "test-raw-alice";
const nsBob = "test-raw-bob";
const namespaces = [nsAlice, nsBob];

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = ANY($1)", [
    namespaces,
  ]);
}

interface TurnOverrides {
  turn_uuid?: string;
  parent_turn_uuid?: string | null;
  logical_parent_turn_uuid?: string | null;
  session_ref?: string | null;
  prompt_id?: string | null;
  role?: string;
  content?: string;
  content_hash?: string;
  turn_index?: number;
  is_human_prompt?: boolean;
  occurred_at?: string | null;
  valid_at?: string | null;
  invalid_at?: string | null;
  expired_at?: string | null;
  metadata?: unknown;
}

async function insert(
  namespace: string,
  overrides: TurnOverrides = {},
): Promise<number> {
  const row = {
    turn_uuid: "uuid-a",
    parent_turn_uuid: null,
    logical_parent_turn_uuid: null,
    session_ref: null,
    prompt_id: null,
    role: "user",
    content: "hello",
    content_hash: "hash-a",
    turn_index: 0,
    is_human_prompt: false,
    occurred_at: null,
    valid_at: null,
    invalid_at: null,
    expired_at: null,
    metadata: undefined,
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO ob_raw_turns
       (namespace, turn_uuid, parent_turn_uuid, logical_parent_turn_uuid,
        session_ref, prompt_id, role, content,
        content_hash, turn_index, is_human_prompt, occurred_at,
        valid_at, invalid_at, expired_at, created_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'test',
             COALESCE($16::jsonb, '{}'::jsonb))
     ON CONFLICT DO NOTHING`,
    [
      namespace,
      row.turn_uuid,
      row.parent_turn_uuid,
      row.logical_parent_turn_uuid,
      row.session_ref,
      row.prompt_id,
      row.role,
      row.content,
      row.content_hash,
      row.turn_index,
      row.is_human_prompt,
      row.occurred_at,
      row.valid_at,
      row.invalid_at,
      row.expired_at,
      row.metadata === undefined ? null : JSON.stringify(row.metadata),
    ],
  );
  return result.rowCount ?? 0;
}

beforeAll(async () => {
  await runMigrations(pool);
  await cleanup();
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

// The describes below split by SUBJECT over one shared module-scope fixture:
// the role contract, turn identity, the conversation thread, and the
// retention/provenance columns. They seed the same table through the same
// `insert` helper, so the fixture is module-scope rather than duplicated.
describe("032 raw turns role contract (live Postgres)", () => {
  it("accepts user, assistant, and tool roles", async () => {
    for (const role of ["user", "assistant", "tool"]) {
      expect(await insert(nsAlice, { turn_uuid: `uuid-${role}`, role })).toBe(
        1,
      );
    }
  });

  it("rejects a role outside the contract", async () => {
    await expect(
      insert(nsAlice, { turn_uuid: "uuid-sys", role: "system" }),
    ).rejects.toThrow();
  });
});

describe("032 raw turns identity (live Postgres)", () => {
  it("never stores an exact duplicate turn twice", async () => {
    // Resuming or forking a session makes the runtime copy prior history into
    // a new transcript. That re-send must conflict and be ignored.
    expect(await insert(nsAlice, { turn_uuid: "uuid-dupe" })).toBe(1);
    expect(await insert(nsAlice, { turn_uuid: "uuid-dupe" })).toBe(0);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = $2",
      [nsAlice, "uuid-dupe"],
    );
    expect(rows[0].n).toBe(1);
  });

  it("dedupes on turn identity even when the copy differs in session or lane", async () => {
    // The forked copy legitimately carries a different session_ref; identity is
    // the turn's own id, so it still conflicts.
    expect(await insert(nsAlice, { turn_uuid: "uuid-fork" })).toBe(1);
    const second = await pool.query(
      `INSERT INTO ob_raw_turns
         (namespace, turn_uuid, role, content, content_hash, turn_index, created_by, session_ref)
       VALUES ($1,'uuid-fork','user','hello','hash-a',0,'test','other-session')
       ON CONFLICT DO NOTHING`,
      [nsAlice],
    );
    expect(second.rowCount ?? 0).toBe(0);
  });

  it("keeps the same turn id in different namespaces separate", async () => {
    expect(await insert(nsAlice, { turn_uuid: "uuid-shared" })).toBe(1);
    expect(await insert(nsBob, { turn_uuid: "uuid-shared" })).toBe(1);
  });

  it("allows distinct turns that share identical content", async () => {
    // Content is NOT the identity key: two real turns may repeat a phrase, and
    // each keeps its own place in the reply chain.
    expect(
      await insert(nsAlice, {
        turn_uuid: "uuid-1",
        content: "yes",
        content_hash: "h",
      }),
    ).toBe(1);
    expect(
      await insert(nsAlice, {
        turn_uuid: "uuid-2",
        content: "yes",
        content_hash: "h",
        parent_turn_uuid: "uuid-1",
      }),
    ).toBe(1);
  });
});

describe("032 raw turns conversation thread (live Postgres)", () => {
  it("reconstructs the reply chain from parent links", async () => {
    await insert(nsAlice, { turn_uuid: "root", prompt_id: "p1" });
    await insert(nsAlice, {
      turn_uuid: "child",
      parent_turn_uuid: "root",
      prompt_id: "p1",
      role: "assistant",
    });

    const { rows } = await pool.query(
      "SELECT turn_uuid FROM ob_raw_turns WHERE namespace = $1 AND parent_turn_uuid = $2",
      [nsAlice, "root"],
    );
    expect(rows.map((r) => r.turn_uuid)).toEqual(["child"]);
  });

  it("groups every record produced by one human prompt", async () => {
    await insert(nsAlice, {
      turn_uuid: "h1",
      prompt_id: "p9",
      is_human_prompt: true,
    });
    await insert(nsAlice, {
      turn_uuid: "a1",
      prompt_id: "p9",
      role: "assistant",
    });
    await insert(nsAlice, { turn_uuid: "t1", prompt_id: "p9", role: "tool" });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE is_human_prompt)::int AS humans
         FROM ob_raw_turns WHERE namespace = $1 AND prompt_id = $2`,
      [nsAlice, "p9"],
    );
    expect(rows[0].n).toBe(3);
    // Exactly one declared human authorship per prompt group.
    expect(rows[0].humans).toBe(1);
  });

  it("orders a batched replay by when the turn happened, not when it landed", async () => {
    await insert(nsAlice, {
      turn_uuid: "late-write",
      occurred_at: "2026-07-25T09:00:00Z",
      content: "first",
    });
    await insert(nsAlice, {
      turn_uuid: "early-write",
      occurred_at: "2026-07-25T08:00:00Z",
      content: "zeroth",
    });

    const { rows } = await pool.query(
      `SELECT content FROM ob_raw_turns
        WHERE namespace = $1 AND occurred_at IS NOT NULL
        ORDER BY occurred_at`,
      [nsAlice],
    );
    expect(rows.map((r) => r.content)).toEqual(["zeroth", "first"]);
  });

  it("walks one conversation across a compaction and session boundary", async () => {
    // The runtime already emits this link and nothing was reading it: at a
    // compact, parentUuid is NULL but logicalParentUuid points at the last turn
    // before the reset. Two sessions, one thread.
    await insert(nsAlice, {
      turn_uuid: "pre-compact",
      session_ref: "session-1",
      content: "before the reset",
    });
    await insert(nsAlice, {
      turn_uuid: "post-compact",
      session_ref: "session-2",
      parent_turn_uuid: null,
      logical_parent_turn_uuid: "pre-compact",
      content: "after the reset",
    });

    const { rows } = await pool.query(
      `WITH RECURSIVE thread AS (
         SELECT turn_uuid, logical_parent_turn_uuid, content, session_ref
           FROM ob_raw_turns
          WHERE namespace = $1 AND turn_uuid = 'post-compact'
         UNION ALL
         SELECT t.turn_uuid, t.logical_parent_turn_uuid, t.content, t.session_ref
           FROM ob_raw_turns t
           JOIN thread ON t.turn_uuid = thread.logical_parent_turn_uuid
          WHERE t.namespace = $1
       )
       SELECT content, session_ref FROM thread`,
      [nsAlice],
    );

    // The walk crosses the session boundary the plain reply chain cannot.
    expect(rows.map((r) => r.content)).toEqual([
      "after the reset",
      "before the reset",
    ]);
    expect(new Set(rows.map((r) => r.session_ref))).toEqual(
      new Set(["session-1", "session-2"]),
    );
  });
});

describe("032 raw turns retention and provenance (live Postgres)", () => {
  it("measures the believed-a-dead-fact window from invalid_at vs expired_at", async () => {
    // Bi-temporal, borrowed from Graphiti: world-time vs knowledge-time. The
    // fact stopped being true at 12:52; we found out at 12:53. The gap is the
    // drift metric, and it is only expressible because both are stored.
    await insert(nsAlice, {
      turn_uuid: "retracted",
      valid_at: "2026-07-25T16:40:00Z",
      invalid_at: "2026-07-25T16:52:00Z",
      expired_at: "2026-07-25T16:53:00Z",
    });

    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (expired_at - invalid_at))::int AS drift_seconds
         FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = 'retracted'`,
      [nsAlice],
    );
    expect(rows[0].drift_seconds).toBe(60);
  });

  it("retracts a turn without destroying it", async () => {
    // NEVER DELETE. A retraction marks when the claim stopped being true; the
    // row and its content remain queryable.
    await insert(nsAlice, { turn_uuid: "wrong", content: "the cap is 2047" });
    await pool.query(
      `UPDATE ob_raw_turns SET invalid_at = now(), expired_at = now(),
              retention_tier = 'unused'
        WHERE namespace = $1 AND turn_uuid = 'wrong'`,
      [nsAlice],
    );

    const { rows } = await pool.query(
      "SELECT content, retention_tier FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = 'wrong'",
      [nsAlice],
    );
    expect(rows[0].content).toBe("the cap is 2047");
    expect(rows[0].retention_tier).toBe("unused");
  });

  it("rejects a retention tier outside live/unused/cold", async () => {
    await expect(
      pool.query(
        `INSERT INTO ob_raw_turns
           (namespace, turn_uuid, role, content, content_hash, turn_index, created_by, retention_tier)
         VALUES ($1,'bad-tier','user','x','h',0,'test','deleted')`,
        [nsAlice],
      ),
    ).rejects.toThrow();
  });

  it("keeps retired turns out of the sweep queue", async () => {
    // A cold-archived turn must never be re-distilled: its content has moved to
    // hard storage and only the index row remains.
    await insert(nsAlice, { turn_uuid: "archived" });
    await pool.query(
      "UPDATE ob_raw_turns SET retention_tier = 'cold' WHERE namespace = $1 AND turn_uuid = 'archived'",
      [nsAlice],
    );

    const { rows } = await pool.query(
      `SELECT turn_uuid FROM ob_raw_turns
        WHERE namespace = $1 AND distilled_at IS NULL AND retention_tier = 'live'`,
      [nsAlice],
    );
    expect(rows).toEqual([]);
  });

  it("exposes undistilled turns as the sweep work queue", async () => {
    await insert(nsAlice, { turn_uuid: "pending" });
    await insert(nsAlice, { turn_uuid: "done" });
    await pool.query(
      "UPDATE ob_raw_turns SET distilled_at = now() WHERE namespace = $1 AND turn_uuid = $2",
      [nsAlice, "done"],
    );

    const { rows } = await pool.query(
      `SELECT turn_uuid FROM ob_raw_turns
        WHERE namespace = $1 AND distilled_at IS NULL ORDER BY created_at`,
      [nsAlice],
    );
    expect(rows.map((r) => r.turn_uuid)).toEqual(["pending"]);
  });

  it("stores structured provenance in metadata without touching content", async () => {
    // Structured payloads stay out of `content` so embedding and FTS never lex
    // JSON punctuation and key names as if they were dialogue.
    await insert(nsAlice, {
      turn_uuid: "uuid-meta",
      content: "Q: ship it? A: yes",
      metadata: {
        model: "claude-opus-5",
        effort: "high",
        usage: { input_tokens: 10 },
      },
    });

    const { rows } = await pool.query(
      "SELECT content, metadata FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = $2",
      [nsAlice, "uuid-meta"],
    );
    expect(rows[0].content).toBe("Q: ship it? A: yes");
    expect(rows[0].metadata.model).toBe("claude-opus-5");
    expect(rows[0].metadata.usage.input_tokens).toBe(10);
  });

  it("defaults redaction_applied to an empty list", async () => {
    // Records WHICH rule fired, never the removed value.
    await insert(nsAlice, { turn_uuid: "uuid-redact" });
    const { rows } = await pool.query(
      "SELECT redaction_applied FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = $2",
      [nsAlice, "uuid-redact"],
    );
    expect(rows[0].redaction_applied).toEqual([]);
  });
});
