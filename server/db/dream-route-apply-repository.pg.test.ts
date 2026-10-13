import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import type { WouldApply } from "../domain/dream-route/run-core.ts";
import type { CandidateSnapshot } from "../domain/dream-route/types.ts";
import {
  applyRoutedDecision,
  type ApplyOutcome,
} from "./dream-route-apply-repository.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespaces: string[] = [];
const runIds: string[] = [];

afterAll(async () => {
  await pool.query("DELETE FROM tier_moves WHERE routing_run_id = ANY($1::uuid[])", [
    runIds,
  ]);
  await pool.query(
    `DELETE FROM ob_session_events WHERE lane_id IN
       (SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[]))`,
    [namespaces],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.query("DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.end();
});

function fixture(): { candidate: CandidateSnapshot; runId: string } {
  const namespace = `dream-apply-${randomUUID()}`;
  const runId = randomUUID();
  namespaces.push(namespace);
  runIds.push(runId);
  const candidate: CandidateSnapshot = {
    id: randomUUID(),
    namespace,
    candidate_type: "rule",
    content: `routed content ${randomUUID()}`,
    content_hash: randomUUID(),
    operator_text: null,
    unit_kind: "turn",
    anchor_kind: null,
    first_said_at: null,
    last_said_at: null,
    source_turn_ids: ["turn-1", "turn-2"],
  };
  return { candidate, runId };
}

async function apply(
  f: { candidate: CandidateSnapshot; runId: string },
  action: WouldApply["action"],
): Promise<ApplyOutcome> {
  const client = await pool.connect();
  try {
    return await applyRoutedDecision({ client, ...f, action });
  } finally {
    client.release();
  }
}

async function count(sql: string, param: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, [param]);
  return rows[0]?.n ?? -1;
}

/** The metadata the context-pack reader filters on, plus the provenance ids. */
function ruleMetadata(f: { candidate: CandidateSnapshot; runId: string }) {
  return {
    memory_lifecycle_action: "promote",
    candidate_type: "process_rule",
    candidate_scope: { key: `dream-route:rule:${f.candidate.content_hash}` },
    candidate_id: f.candidate.id,
    routing_run_id: f.runId,
  };
}

async function readMoves(runId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    "SELECT entry_id, source_table, cause FROM tier_moves WHERE routing_run_id = $1",
    [runId],
  );
  return rows;
}

const movesFor = (runId: string) =>
  count("SELECT count(*)::int AS n FROM tier_moves WHERE routing_run_id = $1", runId);
const thoughtsIn = (ns: string) =>
  count("SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1", ns);
const lanesIn = (ns: string) =>
  count("SELECT count(*)::int AS n FROM ob_session_lanes WHERE namespace = $1", ns);
const eventsIn = (ns: string) =>
  count(
    `SELECT count(*)::int AS n FROM ob_session_events e
       JOIN ob_session_lanes l ON l.id = e.lane_id WHERE l.namespace = $1`,
    ns,
  );

/** Varied values so a copied vector cannot match by coincidence. */
const EMBEDDING = `[${Array.from({ length: 768 }, (_, i) => ((i % 7) / 8).toString()).join(",")}]`;

/** Stores the fixture candidate with an embedding, as the route slice returns it. */
async function seedCandidate(candidate: CandidateSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO candidate_memory (id, namespace, candidate_type, content,
       content_hash, source_turn_ids, embedding)
     VALUES ($1, $2, 'fact', $3, $4, ARRAY[$5::uuid], $6::halfvec)`,
    [
      candidate.id,
      candidate.namespace,
      candidate.content,
      candidate.content_hash,
      randomUUID(),
      EMBEDDING,
    ],
  );
}

/** The entry's embedding and its candidate's, both as text. */
async function embeddings(
  table: "thoughts" | "ob_session_events",
  entryId: string | null,
  candidate: CandidateSnapshot,
) {
  const { rows } = await pool.query<{ entry: string | null; candidate: string | null }>(
    `SELECT (SELECT embedding::text FROM ${table} WHERE id = $1) AS entry,
            (SELECT embedding::text FROM candidate_memory WHERE id = $2) AS candidate`,
    [entryId, candidate.id],
  );
  return rows[0];
}

const EMBEDDING_CASES = [
  ["thought", "thoughts"],
  ["rule_event", "ob_session_events"],
] as const;

/** Applies one routed decision and checks the entry reused the candidate's vector. */
async function embeddingCopied(
  action: WouldApply["action"],
  table: "thoughts" | "ob_session_events",
): Promise<void> {
  const f = fixture();
  await seedCandidate(f.candidate);
  const got = await embeddings(table, (await apply(f, action)).entryId, f.candidate);
  expect(got?.candidate).not.toBeNull();
  expect(got?.entry).toBe(got?.candidate);
}

describe("public DREAM apply repository (live Postgres)", () => {
  it.each(EMBEDDING_CASES)(
    "a routed %s carries its candidate's embedding",
    embeddingCopied,
  );

  it("thought path writes one thought and one tier move", async () => {
    const f = fixture();
    const result = await apply(f, "thought");
    expect(result.outcome).toBe("thought");
    const { rows } = await pool.query(
      `SELECT source, tier, promoted_from, source_refs FROM thoughts WHERE id = $1`,
      [result.entryId],
    );
    expect(rows[0]).toMatchObject({
      source: "dream-route",
      tier: "warm",
      promoted_from: {
        source: "dream-route",
        candidate_id: f.candidate.id,
        routing_run_id: f.runId,
      },
      source_refs: ["turn-1", "turn-2"],
    });
    expect(await readMoves(f.runId)).toEqual([
      {
        entry_id: result.entryId,
        source_table: "thoughts",
        cause: "dream-route-apply",
      },
    ]);
  });

  it("a second thought apply is skipped_existing and adds no row", async () => {
    const f = fixture();
    await apply(f, "thought");
    const again = await apply(f, "thought");
    expect(again).toEqual({ outcome: "skipped_existing", entryId: null });
    expect(await thoughtsIn(f.candidate.namespace)).toBe(1);
    expect(await movesFor(f.runId)).toBe(1);
  });

  it("rule path creates the lane and one promote event the reader selects", async () => {
    const f = fixture();
    const result = await apply(f, "rule_event");
    expect(result.outcome).toBe("rule_event");
    expect(await lanesIn(f.candidate.namespace)).toBe(1);
    const { rows } = await pool.query(
      `SELECT event_type, source, importance, content_hash, metadata
         FROM ob_session_events WHERE id = $1`,
      [result.entryId],
    );
    expect(rows[0]).toMatchObject({
      event_type: "decision",
      source: "dream-route",
      importance: "warm",
      content_hash: f.candidate.content_hash,
      metadata: ruleMetadata(f),
    });
    expect(await readMoves(f.runId)).toEqual([
      {
        entry_id: result.entryId,
        source_table: "ob_session_events",
        cause: "dream-route-apply",
      },
    ]);
  });

  it("a second rule apply dedupes on the same lane", async () => {
    const f = fixture();
    await apply(f, "rule_event");
    const again = await apply(f, "rule_event");
    expect(again).toEqual({ outcome: "skipped_existing", entryId: null });
    expect(await lanesIn(f.candidate.namespace)).toBe(1);
    expect(await eventsIn(f.candidate.namespace)).toBe(1);
    expect(await movesFor(f.runId)).toBe(1);
  });

  it("none and reinforce write nothing", async () => {
    const f = fixture();
    for (const action of ["none", "reinforce"] as const) {
      expect(await apply(f, action)).toEqual({ outcome: "not_applied", entryId: null });
    }
    expect(await thoughtsIn(f.candidate.namespace)).toBe(0);
    expect(await lanesIn(f.candidate.namespace)).toBe(0);
    expect(await movesFor(f.runId)).toBe(0);
  });

  it("a rollback of the caller's transaction leaves no rows", async () => {
    const f = fixture();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyRoutedDecision({ client, ...f, action: "thought" });
      await applyRoutedDecision({ client, ...f, action: "rule_event" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await thoughtsIn(f.candidate.namespace)).toBe(0);
    expect(await lanesIn(f.candidate.namespace)).toBe(0);
    expect(await eventsIn(f.candidate.namespace)).toBe(0);
    expect(await movesFor(f.runId)).toBe(0);
  });
});
