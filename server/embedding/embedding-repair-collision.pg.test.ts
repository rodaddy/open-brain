/**
 * Live-Postgres proof that one content_hash collision does not abort an
 * embedding repair batch (issue 1462).
 *
 * The guarded UPDATE writes the row's FRESH content_hash. When another session
 * in the same namespace already holds that hash, the unique index
 * `idx_sessions_content_hash` rejects the write with SQLSTATE 23505. Only a
 * real database raises that, so this suite seeds real rows.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL` and fails hard without it (issue
 * #878). Run with `npm run test:isolated -- <this file>`; never the dogfood
 * database.
 */
import { afterAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { repairStaleBatch } from "./embedding-repair.ts";
import { getEmbeddingTarget } from "./embedding-targets.ts";
import type { EmbeddingResult } from "../embedding/provider.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `repair-collision-pg-${process.pid}`;

async function fakeEmbed(): Promise<EmbeddingResult> {
  return { embedding: Array.from({ length: 768 }, () => 0.01) };
}

async function insertSession(
  summary: string,
  contentHash: string | null,
  embedded: boolean,
): Promise<string> {
  const embedding = embedded
    ? `[${Array.from({ length: 768 }, () => 0.02).join(",")}]`
    : null;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (summary, project, created_by, namespace, content_hash, embedding)
     VALUES ($1, 'p1462', 'test', $2, $3, $4::halfvec)
     RETURNING id`,
    [summary, NAMESPACE, contentHash, embedding],
  );
  const [row] = rows;
  if (!row) throw new Error("session insert returned no row");
  return row.id;
}

async function embeddingState(
  id: string,
): Promise<{ embedded: boolean; hash: string | null }> {
  const { rows } = await pool.query<{ embedded: boolean; content_hash: string | null }>(
    "SELECT embedding IS NOT NULL AS embedded, content_hash FROM sessions WHERE id = $1",
    [id],
  );
  const [row] = rows;
  if (!row) throw new Error(`session ${id} not found`);
  return { embedded: row.embedded, hash: row.content_hash };
}

afterAll(async () => {
  await pool.query("DELETE FROM sessions WHERE namespace = $1", [NAMESPACE]);
  await pool.end();
});

describe("embedding repair content_hash collision (live Postgres)", () => {
  test("a content_hash collision skips its row and repairs the rest of the batch", async () => {
    const target = getEmbeddingTarget("sessions");
    const takenHash = target.sourceHash({ summary: "collides", project: "p1462" });
    // The existing row already holds the hash row B will compute.
    await insertSession("collides", takenHash, true);
    const a = await insertSession("row a", null, false);
    const b = await insertSession("collides", null, false);
    const c = await insertSession("row c", null, false);

    const summary = await repairStaleBatch(pool, "sessions", fakeEmbed, {
      scope: { namespaces: [NAMESPACE] },
      reasons: ["missing"],
      limit: 10,
    });

    expect((await embeddingState(a)).embedded).toBe(true);
    expect((await embeddingState(c)).embedded).toBe(true);
    expect(await embeddingState(b)).toEqual({ embedded: false, hash: null });
    expect(summary.selected).toBe(3);
    expect(summary.repaired).toBe(2);
    expect(summary.contentHashCollisions).toBe(1);
    expect(summary.results.find((r) => r.id === b)?.status).toBe(
      "content_hash_collision",
    );
  });
});
