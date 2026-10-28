import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createReviewedCandidatePromotionRepository } from "./reviewed-candidate-promotion-repository.ts";
import { DREAM_ROUTE_APPLY_CAUSE, insertTierMove } from "./tier-moves.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `tier-moves-insert-${randomUUID()}`;
const entryIds: string[] = [];

afterAll(async () => {
  await pool.query("DELETE FROM tier_moves WHERE entry_id = ANY($1::uuid[])", [
    entryIds,
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = $1", [namespace]);
  await pool.end();
});

interface MoveRow {
  source_table: string;
  from_tier: string | null;
  to_tier: string;
  cause: string;
  routing_run_id: string | null;
}

async function readMove(entryId: string): Promise<MoveRow[]> {
  const { rows } = await pool.query<MoveRow>(
    `SELECT source_table, from_tier, to_tier, cause, routing_run_id
       FROM tier_moves WHERE entry_id = $1`,
    [entryId],
  );
  return rows;
}

function thoughtInput(content: string) {
  return {
    content,
    tags: [],
    createdBy: "tier-moves-insert-test",
    namespace,
    embedding: null,
    contentHash: randomUUID(),
    sourceRefs: "[]",
    promotedFrom: "{}",
  };
}

async function readThought(id: string): Promise<{ source: string; tier: string }> {
  const { rows } = await pool.query<{ source: string; tier: string }>(
    "SELECT source, tier FROM thoughts WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`thought ${id} not found`);
  return row;
}

describe("tier move insert and thought source (live Postgres)", () => {
  it("writes one tier_moves row with every column as given", async () => {
    const entryId = randomUUID();
    const runId = randomUUID();
    entryIds.push(entryId);
    await insertTierMove({
      db: pool,
      entryId,
      sourceTable: "thoughts",
      fromTier: "cold",
      toTier: "warm",
      cause: DREAM_ROUTE_APPLY_CAUSE,
      routingRunId: runId,
    });
    expect(await readMove(entryId)).toEqual([
      {
        source_table: "thoughts",
        from_tier: "cold",
        to_tier: "warm",
        cause: "dream-route-apply",
        routing_run_id: runId,
      },
    ]);
  });

  it("accepts a null routingRunId and a null fromTier", async () => {
    const entryId = randomUUID();
    entryIds.push(entryId);
    await insertTierMove({
      db: pool,
      entryId,
      sourceTable: "decisions",
      fromTier: null,
      toTier: "hot",
      cause: "set-tier",
      routingRunId: null,
    });
    const rows = await readMove(entryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.routing_run_id).toBeNull();
    expect(rows[0]?.from_tier).toBeNull();
  });

  it("insertThought writes the given source and tier", async () => {
    const repo = createReviewedCandidatePromotionRepository(pool);
    const inserted = await repo.insertThought({
      ...thoughtInput("given source and tier"),
      source: "dream-route",
      tier: "hot",
    });
    if (inserted === null) throw new Error("insert returned null");
    expect(await readThought(inserted.id)).toEqual({
      source: "dream-route",
      tier: "hot",
    });
  });

  it("insertThought defaults source and tier when neither is given", async () => {
    const repo = createReviewedCandidatePromotionRepository(pool);
    const inserted = await repo.insertThought(thoughtInput("default source and tier"));
    if (inserted === null) throw new Error("insert returned null");
    expect(await readThought(inserted.id)).toEqual({
      source: "dream-reviewed-candidate",
      tier: "warm",
    });
  });
});
