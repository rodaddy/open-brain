/**
 * Live-Postgres coverage for decompose_entry, the dream mutator that splits an
 * oversized entry into replacement thoughts.
 *
 * The focused suite is the strongest of the dream mocks (9 cases) and already
 * covers apply-gating, permission refusal, and mid-batch rollback against fake
 * pools. This suite does not repeat that. It covers the parts the database
 * decides:
 *
 *  1. Dry-run by default writes nothing. The tool refuses `dry_run=false`
 *     without `apply_mode=write_replacements`, so the default path is proven
 *     by counting rows rather than by reading the plan's own claim.
 *  2. Apply mode actually inserts the planned replacements, and they are
 *     readable back with the chunk_index, tags, and provenance the plan
 *     promised.
 *  3. `ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL`
 *     names a PARTIAL unique index. If that index does not exist with exactly
 *     that predicate, Postgres raises "no unique or exclusion constraint
 *     matching the ON CONFLICT specification" at runtime -- a failure a fake
 *     pool can never surface, because the fake is what decides the outcome.
 *     Re-applying the same decomposition proves the conflict target resolves
 *     and that duplicates are skipped rather than duplicated.
 *  4. Intra-batch duplicate chunks (two identical chunks in ONE apply) are
 *     classified separately from pre-existing ones. Both land in the same
 *     transaction, so only a real transaction distinguishes them.
 *  5. Replacements are written into the SOURCE row's namespace, not the
 *     caller's -- and the source row itself is left intact. Decomposition
 *     proposes replacements; it does not archive what it decomposed.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerDecomposeEntry } from "../decompose-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const CREATED_BY = "dream-decompose-pg-test";
const OWNER_NS = "dream-decompose-owner-ns";

// Replacements are written with created_by = auth.clientId, so the client id is
// the suite tag; that is what makes the written rows findable in cleanup.
const ownerAuth: AuthInfo = {
  role: "admin",
  clientId: CREATED_BY,
};

// max_chunk_chars has a floor of 500 in the schema, so the source content must
// comfortably exceed that to yield several chunks.
const CHUNK_CHARS = 500;

function longContent(marker: string, chunks: number): string {
  // Distinct, non-repeating text so each chunk hashes differently unless a
  // test deliberately wants a collision.
  let out = "";
  for (let i = 0; i < chunks * 10; i++) {
    out += `${marker} sentence ${i} with enough words to take up room. `;
  }
  return out;
}

dbDescribe("decompose_entry (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM thoughts WHERE created_by = $1`, [
      CREATED_BY,
    ]);
  }

  async function seedThought(content: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace)
       VALUES ($1, $2, $3) RETURNING id`,
      [content, CREATED_BY, OWNER_NS],
    );
    return rows[0].id as string;
  }

  /** Replacement rows only -- the ones this tool wrote, not the source. */
  async function readReplacements(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `SELECT id, content, namespace, chunk_index, tags, source, promoted_from
         FROM thoughts
        WHERE created_by = $1 AND source = 'dreamengine-decomposition'
        ORDER BY chunk_index`,
      [CREATED_BY],
    );
    return rows;
  }

  async function callDecompose(auth: AuthInfo, args: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      // A deterministic embedding: the tool stores it as an opaque bound param,
      // and requiring a live embedding endpoint would make this suite flaky for
      // reasons unrelated to what it proves.
      embedFn: async () => Array(768).fill(0.01),
    };
    registerDecomposeEntry(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      return await client.callTool({
        name: "decompose_entry",
        arguments: args,
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function parse(result: any): any {
    return JSON.parse((result.content as any)[0].text);
  }

  it("plans without writing when dry_run is left at its default", async () => {
    const id = await seedThought(longContent("plan-only", 4));

    const result = await callDecompose(ownerAuth, {
      table: "thoughts",
      id,
      max_chunk_chars: CHUNK_CHARS,
    });

    expect(result.isError).toBeFalsy();
    const plan = parse(result);
    expect(plan.proposed_replacements.length).toBeGreaterThan(1);

    // The plan claims it wrote nothing; this is what proves it.
    expect(await readReplacements()).toHaveLength(0);
  });

  it("refuses dry_run=false without the explicit apply mode and writes nothing", async () => {
    const id = await seedThought(longContent("no-apply-mode", 4));

    const result = await callDecompose(ownerAuth, {
      table: "thoughts",
      id,
      max_chunk_chars: CHUNK_CHARS,
      dry_run: false,
    });

    expect(result.isError).toBe(true);
    expect(await readReplacements()).toHaveLength(0);
  });

  it("writes the planned replacements when apply mode is named explicitly", async () => {
    const id = await seedThought(longContent("apply-me", 4));

    const planned = parse(
      await callDecompose(ownerAuth, {
        table: "thoughts",
        id,
        max_chunk_chars: CHUNK_CHARS,
      }),
    );
    const expectedCount = planned.proposed_replacements.length;
    expect(expectedCount).toBeGreaterThan(1);

    const applied = parse(
      await callDecompose(ownerAuth, {
        table: "thoughts",
        id,
        max_chunk_chars: CHUNK_CHARS,
        dry_run: false,
        apply_mode: "write_replacements",
      }),
    );

    // written + intra-batch duplicates accounts for every proposed chunk.
    //
    // Not `written_count === expectedCount`: with a non-zero overlap the
    // chunker emits windows that repeat earlier text, so several proposals
    // hash identically and are deduped within the batch. That is correct
    // behaviour, and asserting the accounting identity states it precisely
    // instead of encoding a chunk count that depends on the overlap default.
    expect(
      applied.apply_summary.written_count +
        applied.apply_summary.intra_batch_duplicate_count,
    ).toBe(expectedCount);
    expect(applied.apply_summary.written_count).toBeGreaterThan(0);

    const rows = await readReplacements();
    expect(rows).toHaveLength(applied.apply_summary.written_count);

    // Written into the SOURCE row's namespace and tagged as decomposition
    // output, each carrying its own chunk_index and provenance. The indexes
    // are checked for presence and strict ascent rather than equality with
    // the row's position: deduped chunks leave gaps in the sequence, so
    // requiring 0..n would assert the absence of dedup.
    let previousIndex = -1;
    for (const row of rows) {
      expect(row.namespace).toBe(OWNER_NS);
      expect(row.source).toBe("dreamengine-decomposition");
      expect(typeof row.chunk_index).toBe("number");
      expect(row.chunk_index as number).toBeGreaterThan(previousIndex);
      previousIndex = row.chunk_index as number;
      expect(row.promoted_from).toBeTruthy();
    }

    // The source row is untouched: decomposition proposes replacements, it
    // does not archive or delete what it decomposed.
    const { rows: src } = await pool.query(
      `SELECT archived_at, content FROM thoughts WHERE id = $1`,
      [id],
    );
    expect(src[0].archived_at).toBeNull();
    expect(src[0].content).toContain("apply-me");
  });

  it("resolves the ON CONFLICT target and skips pre-existing duplicates on re-apply", async () => {
    // The INSERT names `ON CONFLICT (content_hash, namespace) WHERE
    // content_hash IS NOT NULL`, which requires a PARTIAL unique index with
    // exactly that predicate. If the index is missing or its predicate
    // differs, Postgres raises "no unique or exclusion constraint matching the
    // ON CONFLICT specification" -- and a fake pool cannot raise it, because
    // the fake decides the outcome itself.
    const id = await seedThought(longContent("re-apply", 4));

    const first = parse(
      await callDecompose(ownerAuth, {
        table: "thoughts",
        id,
        max_chunk_chars: CHUNK_CHARS,
        dry_run: false,
        apply_mode: "write_replacements",
      }),
    );
    expect(first.apply_summary.written_count).toBeGreaterThan(1);
    const afterFirst = (await readReplacements()).length;
    expect(afterFirst).toBe(first.apply_summary.written_count);

    // Same source, same chunking: every chunk hashes to a row that now exists.
    const second = parse(
      await callDecompose(ownerAuth, {
        table: "thoughts",
        id,
        max_chunk_chars: CHUNK_CHARS,
        dry_run: false,
        apply_mode: "write_replacements",
      }),
    );

    expect(second.apply_summary.written_count).toBe(0);

    // Every proposal is now accounted for as a duplicate of something already
    // stored. The count is compared to the number of PROPOSALS, not to the
    // number of stored rows: chunks that were intra-batch repeats during the
    // first apply now match the row that first apply wrote, so on re-apply
    // they are pre-existing duplicates too.
    expect(second.apply_summary.preexisting_duplicate_count).toBe(
      second.proposed_replacements.length,
    );

    // No second copy: the conflict was absorbed, not inserted.
    expect(await readReplacements()).toHaveLength(afterFirst);
  });

  it("classifies duplicate chunks from the same apply batch as intra-batch", async () => {
    // Repeating identical text makes several chunks hash the same WITHIN one
    // apply. Those are deduped in-process against writtenIdsByHash rather than
    // by the database, because inside one transaction the earlier insert is
    // visible to the later statement -- a distinction only a real transaction
    // can make.
    const repeated = "identical chunk body. ".repeat(300);
    const id = await seedThought(repeated);

    const applied = parse(
      await callDecompose(ownerAuth, {
        table: "thoughts",
        id,
        max_chunk_chars: CHUNK_CHARS,
        overlap_chars: 0,
        dry_run: false,
        apply_mode: "write_replacements",
      }),
    );

    // At least one chunk was recognised as a repeat of another chunk in the
    // same batch, and the stored rows match what was reported as written.
    expect(applied.apply_summary.intra_batch_duplicate_count).toBeGreaterThan(
      0,
    );
    expect(await readReplacements()).toHaveLength(
      applied.apply_summary.written_count,
    );
  });
});
