/**
 * Live-Postgres proof that the missing-embedding drain advances past rows that
 * collide on content_hash (issue 1612).
 *
 * Measured 2026-09-28: 9,752 of 11,148 null-embedding sessions rows collide
 * with an existing row's content_hash (issue 1462) and are skipped. With an
 * unordered selection each batch came back almost entirely collisions, the
 * `repaired === 0` stop ended the table, and the repairable rows never got a
 * turn. This suite seeds collisions ordered BEFORE repairable rows, with a
 * batchSize below the collision count, and asserts every repairable row is
 * embedded.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL` and fails hard without it. Run with
 * `npm run test:isolated -- <this file>`; never the dogfood database.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { repairAll } from "./repair-embeddings.ts";
import { selectStale } from "../server/embedding/embedding-repair.ts";
import { getEmbeddingTarget } from "../server/embedding/embedding-targets.ts";
import type { EmbeddingResult } from "../server/embedding/provider.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `repair-cursor-pg-${process.pid}`;
const PROJECT = "p1612";
const COLLISIONS = 5;
const REPAIRABLE = 3;
const BATCH_SIZE = 2;
const ID_PREFIX = randomBytes(4).toString("hex");

async function fakeEmbed(): Promise<EmbeddingResult> {
  return { embedding: Array.from({ length: 768 }, () => 0.01) };
}

/** A uuid whose sort position is `seq` within this run's prefix. */
function orderedId(seq: number): string {
  return `${ID_PREFIX}-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

async function insertSession(
  id: string,
  summary: string,
  contentHash: string | null,
  embedded: boolean,
): Promise<void> {
  const embedding = embedded
    ? `[${Array.from({ length: 768 }, () => 0.02).join(",")}]`
    : null;
  await pool.query(
    `INSERT INTO sessions (id, summary, project, created_by, namespace, content_hash, embedding)
     VALUES ($1, $2, $3, 'test', $4, $5, $6::halfvec)`,
    [id, summary, PROJECT, NAMESPACE, contentHash, embedding],
  );
}

afterAll(async () => {
  await pool.query("DELETE FROM sessions WHERE namespace = $1", [NAMESPACE]);
  await pool.end();
});

describe("repair-embeddings drain advances past content_hash collisions (live Postgres)", () => {
  test("repairable rows ordered after a run of collisions are all embedded", async () => {
    const target = getEmbeddingTarget("sessions");
    const repairableIds: string[] = [];
    let seq = 1;
    for (let i = 0; i < COLLISIONS; i += 1) {
      const summary = `collides ${i}`;
      const takenHash = target.sourceHash({ summary, project: PROJECT });
      // The holder is already embedded, so the missing selection never picks it.
      await insertSession(orderedId(10_000 + i), summary, takenHash, true);
      await insertSession(orderedId(seq), summary, null, false);
      seq += 1;
    }
    for (let i = 0; i < REPAIRABLE; i += 1) {
      const id = orderedId(seq);
      seq += 1;
      await insertSession(id, `repairable ${i}`, null, false);
      repairableIds.push(id);
    }

    const summary = await repairAll(pool, {
      scope: { namespaces: [NAMESPACE] },
      tables: ["sessions"],
      batchSize: BATCH_SIZE,
      embedFn: fakeEmbed,
    });

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM sessions WHERE namespace = $1 AND embedding IS NULL AND id = ANY($2::uuid[])",
      [NAMESPACE, repairableIds],
    );
    console.log(
      `issue 1612: repaired=${summary.repaired} collisions=${summary.contentHashCollisions} stillNull=${rows.length}`,
    );
    expect(rows).toEqual([]);
    expect(summary.repaired).toBe(REPAIRABLE);
    expect(summary.contentHashCollisions).toBe(COLLISIONS);
  });

  test("without afterId the selection is unchanged and carries no ORDER BY", async () => {
    const seen: string[] = [];
    const recorder = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [] };
      },
    };
    await selectStale(recorder as never, "sessions", {
      scope: { namespaces: [NAMESPACE] },
      reasons: ["missing"],
    });
    await selectStale(recorder as never, "sessions", {
      scope: { namespaces: [NAMESPACE] },
      reasons: ["missing"],
      afterId: orderedId(1),
    });
    const [plain, cursor] = seen;
    expect(plain).not.toMatch(/ORDER BY/);
    expect(plain).not.toMatch(/ > \$/);
    expect(cursor).toMatch(/id > \$\d+/);
    expect(cursor).toMatch(/ORDER BY id/);
  });
});
