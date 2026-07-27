/**
 * Live-Postgres coverage for promote_entry, the dream mutator that copies a row
 * ACROSS a namespace boundary.
 *
 * The focused suite is 125 lines and covers two cases against a fake pool. The
 * behaviour that decides whether promotion is safe lives in SQL that a fake
 * cannot execute:
 *
 *  1. dry_run inserts NOTHING. Unlike set_tier, promote_entry takes a real
 *     `dry_run` parameter at the MCP boundary, so this is a server-side
 *     guarantee rather than a client-side convention -- and it is the
 *     guarantee the whole DreamEngine dry-run-by-default posture rests on.
 *     Asserting the report says `dry_run: true` is not the proof; counting
 *     rows in the target namespace afterwards is.
 *  2. Nomination metadata keys are actually STRIPPED from the promoted copy.
 *     `promotionSelectExpression` composes jsonb `- 'key'` operators into a
 *     SQL string; a mock can only assert the string. Whether Postgres removes
 *     the keys decides whether a promoted row re-nominates itself on the next
 *     promoter sweep, which is an endless re-scan/re-promote loop.
 *  3. Provenance persists to the `promoted_from` jsonb column and is readable
 *     back as structured data -- the audit trail for every shared-kb row.
 *  4. Duplicate detection by content_hash runs against real rows, returns
 *     `status: "duplicate"`, and inserts no second copy.
 *  5. The source row is left intact: promotion is a COPY, and a regression to
 *     a move would silently drain agent namespaces.
 *  6. Frozen-namespace and same-namespace rejections are enforced, and the
 *     kill switch blocks apply mode while leaving dry-run available.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerPromoteEntry } from "../promote-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const CREATED_BY = "dream-promote-entry-pg-test";
const SOURCE_NS = "dream-promote-source-ns";
const TARGET_NS = "dream-promote-target-ns";

// promote_entry requires admin, ob-admin, or promoter. `promoter` is the role
// the automated sweep actually runs as, so it is the one used here.
const promoterAuth: AuthInfo = {
  role: "promoter",
  clientId: "promoter-client",
};

dbDescribe("promote_entry (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanup();
  });

  afterEach(async () => {
    delete process.env.OPENBRAIN_PROMOTION_KILL_SWITCH;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    // Promoted copies inherit created_by from the source, so this deletes the
    // copies as well as the originals.
    for (const table of ["thoughts", "decisions"]) {
      await pool.query(`DELETE FROM ${table} WHERE created_by = $1`, [
        CREATED_BY,
      ]);
    }
  }

  async function seedThought(opts: {
    namespace: string;
    content: string;
    contentHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash, extracted_metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [
        opts.content,
        CREATED_BY,
        opts.namespace,
        opts.contentHash ?? null,
        JSON.stringify(opts.metadata ?? {}),
      ],
    );
    return rows[0].id as string;
  }

  async function countIn(namespace: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1 AND created_by = $2`,
      [namespace, CREATED_BY],
    );
    return rows[0].n as number;
  }

  async function callPromote(auth: AuthInfo, args: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: async () => null };
    registerPromoteEntry(server, deps);

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
        name: "promote_entry",
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

  it("dry_run reports a planned promotion and inserts nothing", async () => {
    // The DreamEngine safety guarantee, proven by row count rather than by the
    // report's own claim about itself.
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "dry-run-me",
      contentHash: "hash-dry-run",
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: true,
    });

    expect(result.isError).toBeFalsy();
    const report = parse(result);
    expect(report.status).toBe("dry_run");
    expect(report.dry_run).toBe(true);
    expect(report.would_insert).toBe(true);

    // The assertion that matters: nothing landed in the target namespace.
    expect(await countIn(TARGET_NS)).toBe(0);
    expect(await countIn(SOURCE_NS)).toBe(1);
  });

  it("apply mode inserts one copy and leaves the source row intact", async () => {
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "promote-me",
      contentHash: "hash-apply",
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      reason: "worth sharing",
      dry_run: false,
    });

    const report = parse(result);
    expect(report.status).toBe("promoted");
    expect(report.new_id).toBeTruthy();
    expect(report.new_id).not.toBe(id);

    expect(await countIn(TARGET_NS)).toBe(1);

    // Promotion is a COPY. A regression to a move would silently drain the
    // agent namespace it promoted from.
    expect(await countIn(SOURCE_NS)).toBe(1);

    const { rows } = await pool.query(
      `SELECT content, namespace FROM thoughts WHERE id = $1`,
      [report.new_id],
    );
    expect(rows[0].content).toBe("promote-me");
    expect(rows[0].namespace).toBe(TARGET_NS);
  });

  it("strips nomination metadata keys from the promoted copy", async () => {
    // A promoted row that still carries `share_candidate` re-nominates itself
    // on the next namespace-wide promoter sweep: an endless re-scan and
    // re-promote loop. The stripping is built as a jsonb `- 'key'` chain in a
    // SQL string, so only real execution shows whether it works.
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "strip-me",
      contentHash: "hash-strip",
      metadata: {
        share_candidate: true,
        candidate_type: "insight",
        candidate_reason: "looked useful",
        evidence_refs: ["a", "b"],
        // A key that must SURVIVE: stripping too much is as wrong as
        // stripping too little, and only a preserved key proves the
        // difference between a targeted strip and a blanket wipe.
        repo: "open-brain",
      },
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: false,
    });

    const report = parse(result);
    const { rows } = await pool.query(
      `SELECT extracted_metadata FROM thoughts WHERE id = $1`,
      [report.new_id],
    );
    const meta = rows[0].extracted_metadata ?? {};

    expect(meta.share_candidate).toBeUndefined();
    expect(meta.candidate_type).toBeUndefined();
    expect(meta.candidate_reason).toBeUndefined();
    expect(meta.evidence_refs).toBeUndefined();
    expect(meta.repo).toBe("open-brain");

    // And the SOURCE row keeps its nomination keys: stripping applies to the
    // copy only.
    const { rows: src } = await pool.query(
      `SELECT extracted_metadata FROM thoughts WHERE id = $1`,
      [id],
    );
    expect(src[0].extracted_metadata.share_candidate).toBe(true);
  });

  it("persists provenance to the promoted_from column", async () => {
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "provenance-me",
      contentHash: "hash-prov",
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      reason: "audit trail",
      dry_run: false,
    });

    const report = parse(result);
    const { rows } = await pool.query(
      `SELECT promoted_from FROM thoughts WHERE id = $1`,
      [report.new_id],
    );
    const provenance = rows[0].promoted_from;

    // Read back as structured jsonb, not as a string: the column is written
    // with an explicit ::jsonb cast and a regression to a text column would
    // still "store" it while breaking every downstream provenance query.
    expect(provenance.source_id).toBe(id);
    expect(provenance.source_table).toBe("thoughts");
    expect(provenance.source_namespace).toBe(SOURCE_NS);
    expect(provenance.target_namespace).toBe(TARGET_NS);
    expect(provenance.promotion_reason).toBe("audit trail");
    expect(provenance.promoted_at).toBeTruthy();
  });

  it("detects a duplicate by content_hash and inserts no second copy", async () => {
    const sharedHash = "hash-duplicate";
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "dupe-source",
      contentHash: sharedHash,
    });
    // A row already in the target namespace carrying the same content hash.
    await seedThought({
      namespace: TARGET_NS,
      content: "dupe-existing",
      contentHash: sharedHash,
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: false,
    });

    const report = parse(result);
    expect(report.status).toBe("duplicate");
    expect(report.existing_id).toBeTruthy();

    // Still exactly the one pre-existing row.
    expect(await countIn(TARGET_NS)).toBe(1);
  });

  it("refuses to promote an entry into its own namespace", async () => {
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "same-ns",
      contentHash: "hash-same",
    });

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: SOURCE_NS,
      dry_run: false,
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("already in namespace");
    expect(await countIn(SOURCE_NS)).toBe(1);
  });

  it("refuses to promote an archived source row", async () => {
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "archived-source",
      contentHash: "hash-archived",
    });
    await pool.query(`UPDATE thoughts SET archived_at = now() WHERE id = $1`, [
      id,
    ]);

    const result = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: false,
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("not found or archived");
    expect(await countIn(TARGET_NS)).toBe(0);
  });

  it("blocks apply mode behind the kill switch while leaving dry_run available", async () => {
    // The operator escape hatch. Both halves matter: a kill switch that also
    // disabled planning would break dream runs entirely rather than just
    // stopping writes.
    const id = await seedThought({
      namespace: SOURCE_NS,
      content: "kill-switch",
      contentHash: "hash-kill",
    });

    process.env.OPENBRAIN_PROMOTION_KILL_SWITCH = "1";

    const applied = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: false,
    });
    expect(applied.isError).toBe(true);
    expect((applied.content as any)[0].text).toContain("KILL_SWITCH");
    expect(await countIn(TARGET_NS)).toBe(0);

    const planned = await callPromote(promoterAuth, {
      table: "thoughts",
      id,
      target_namespace: TARGET_NS,
      dry_run: true,
    });
    expect(planned.isError).toBeFalsy();
    expect(parse(planned).status).toBe("dry_run");
    expect(await countIn(TARGET_NS)).toBe(0);
  });
});
