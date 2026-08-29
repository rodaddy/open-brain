/**
 * Live-Postgres tests for parent+chunk entry storage.
 *
 * The property under test is the one the operator asked for on 2026-07-30:
 * EVERYTHING IS VECTORIZED and nothing is refused or shortened. A long entry
 * must land as a parent row holding the COMPLETE text with its own vector,
 * plus chunk rows that each carry their own vector and point back at it.
 *
 * REQUIRES the test database, and fails hard without it (operator ruling
 * 2026-08-27, issue #878): a suite that skips itself reports a false green.
 * `bun run test:isolated` supplies it.
 *
 * The embedding PROVIDER is stubbed with a deterministic vector so the test
 * does not depend on a live MLX endpoint; the splitting, the inserts, the
 * parent linkage, and the stored text all run against real Postgres.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { EMBEDDING_DIMENSIONS, contentHash } from "../../src/embedding.ts";
import { writeEntryChunks } from "./chunk-write.ts";
import { toSql } from "pgvector/pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";

// Per-process namespace so concurrent CI runs cannot collide. The `check` job
// runs against a SHARED, persistent Postgres on the runner (unlike the
// ephemeral per-run container in `db-integration`), and `push` + `pull_request`
// fire two runs at once. With a static namespace, one run's afterEach
// `DELETE ... WHERE namespace = $1` deletes another run's parent row mid
// chunk-insert -> `thoughts_parent_id_fkey` violation and a stalled statement
// (observed as a 5s timeout in run 30691948496). `process.pid` isolates each
// run, matching the durable-lane and guidance-repo-facts live tests.
const NS = `ns-chunk-write-test-${process.pid}`;
const CREATED_BY = "chunk-write-test";

const stubEmbed = async (): Promise<number[]> => Array(EMBEDDING_DIMENSIONS).fill(0.01);

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

beforeAll(async () => {
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [NS]);
});

async function insertParent(content: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash)
     VALUES ($1, '{}', 'test', $2, $3, $4, $5)
     RETURNING id`,
    [content, CREATED_BY, NS, toSql(await stubEmbed()), contentHash(content)],
  );
  return rows[0].id as string;
}

describe("parent + chunk entry storage (live Postgres)", () => {
  it("stores the parent's COMPLETE text, however long", async () => {
    // 51,283 is the longest turn actually captured in the live dogfood clone
    // (open_brain_local_20260724, ob_raw_turns, measured 2026-07-30).
    const content = "A long operator explanation of the system. ".repeat(1250);
    expect(content.length).toBeGreaterThan(51_283);

    const parentId = await insertParent(content);
    await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: stubEmbed,
    });

    const { rows } = await pool.query(`SELECT content FROM thoughts WHERE id = $1`, [
      parentId,
    ]);
    // Not shortened, not marked, not summarised: byte-identical.
    expect(rows[0].content).toBe(content);
    expect((rows[0].content as string).length).toBe(content.length);
  });

  it("gives every chunk its own vector and a link to the parent", async () => {
    const content = "Sentence about the migration plan. ".repeat(400);
    const parentId = await insertParent(content);

    const result = await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: stubEmbed,
    });

    expect(result.written).toBeGreaterThan(1);
    expect(result.unembedded).toBe(0);

    const { rows } = await pool.query(
      `SELECT chunk_index, embedding IS NOT NULL AS has_vector
       FROM thoughts
       WHERE parent_id = $1 AND namespace = $2
       ORDER BY chunk_index`,
      [parentId, NS],
    );

    expect(rows.length).toBe(result.written);
    // EVERYTHING IS VECTORIZED -- no chunk row without a vector.
    expect(rows.every((row) => row.has_vector === true)).toBe(true);

    // chunk_index is the chunk's POSITION IN THE SOURCE TEXT, so it is strictly
    // increasing but NOT necessarily contiguous: repeated text in a long entry
    // collides on (content_hash, namespace) and the duplicate row is refused,
    // leaving its index unused. That is honest -- the text is present under the
    // earlier identical row -- and renumbering would claim the gap never
    // existed. Read paths reassemble with ORDER BY chunk_index, which gaps do
    // not disturb.
    const indexes = rows.map((row) => row.chunk_index as number);
    expect(indexes[0]).toBe(0);
    const strictlyIncreasing = indexes.every(
      (value, i, all) => i === 0 || value > (all[i - 1] ?? Number.NEGATIVE_INFINITY),
    );
    expect(strictlyIncreasing).toBe(true);
  });

  it("keeps text that only appears in the middle of a long entry", async () => {
    // The failure this guards: an end-cut loses the middle and the tail. Both
    // must be retrievable from some chunk.
    const marker = "ZEBRAMARMALADEVOLCANO";
    const filler = "Routine maintenance narration. ".repeat(300);
    const content = `${filler}${marker}${filler}`;

    const parentId = await insertParent(content);
    await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: stubEmbed,
    });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS hits
       FROM thoughts
       WHERE parent_id = $1 AND namespace = $2 AND content LIKE $3`,
      [parentId, NS, `%${marker}%`],
    );
    expect(rows[0].hits).toBeGreaterThan(0);
  });
});

describe("chunk write duplicate and fallback handling (live Postgres)", () => {
  it("reports repeated chunks as duplicates rather than as written rows", async () => {
    // Long entries with repeated text (log dumps, retried tool output) produce
    // byte-identical chunks. The row is refused by the content_hash unique
    // index -- correctly, the text is already stored -- and must be counted as
    // a duplicate, not silently inflate the written count.
    const content = "Identical repeated sentence. ".repeat(500);
    const parentId = await insertParent(content);

    const result = await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: stubEmbed,
    });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM thoughts WHERE parent_id = $1`,
      [parentId],
    );
    // written is what actually landed; duplicates account for the remainder.
    expect(rows[0].n).toBe(result.written);
    expect(result.duplicates).toBeGreaterThan(0);
  });

  it("does not split a short entry, whose own vector already covers it", async () => {
    const content = "A short thought.";
    const parentId = await insertParent(content);

    const result = await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: stubEmbed,
    });

    expect(result.written).toBe(0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM thoughts WHERE parent_id = $1`,
      [parentId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("still stores chunk text when the embedding provider fails", async () => {
    // Losing the vector is recoverable by a repair pass; losing the text is not.
    const content = "Sentence that will fail to embed. ".repeat(300);
    const parentId = await insertParent(content);

    const result = await writeEntryChunks(pool, {
      table: "thoughts",
      parentId,
      namespace: NS,
      createdBy: CREATED_BY,
      content,
      embedFn: async () => {
        throw new Error("provider down");
      },
    });

    expect(result.written).toBeGreaterThan(0);
    expect(result.unembedded).toBe(result.written);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
       FROM thoughts
       WHERE parent_id = $1 AND embedding IS NULL`,
      [parentId],
    );
    // Text present, vector absent and countable -- a repair pass can find it.
    expect(rows[0].n).toBe(result.written);
  });
});
