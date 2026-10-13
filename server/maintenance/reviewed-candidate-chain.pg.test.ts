/**
 * Live-Postgres proof for the release-1425 raw-turn-to-reviewed-memory chain.
 *
 * This intentionally uses a deterministic injected distiller and embedding
 * function. It proves the server-owned wiring and custody boundary in an
 * isolated database; it makes no claim about the quality of a real model.
 *
 * The chain exercised here is the acceptance boundary:
 *
 *   ingest_raw_turn -> runDistillSweep -> human grade -> dry-run promotion
 *   -> explicit apply -> durable thought provenance and idempotence
 *
 * A second namespace runs the same capture/distill/grade path so the final
 * negative proves the promotion tool cannot cross the auth-derived namespace.
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; the isolated runner supplies it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import type { NamedDistillModel } from "../domain/distiller.ts";
import { submitGradeBatch } from "../domain/candidate-review/batch-grade.ts";
import { normalizedContentHash } from "../embedding/provider.ts";
import { runDistillSweep } from "./distill-handler.ts";
import { registerIngestRawTurnTool } from "../tools/ingest-raw-turn.ts";
import { registerReviewedCandidatePromotionTool } from "../tools/reviewed-candidate-promotion.ts";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../tools/shared-namespace-fixture.ts";
import { executeSearch } from "../tools/search-engine.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `reviewed-chain-pg-${process.pid}-${randomUUID()}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;
const CONTENT =
  "The release acceptance path preserves a reviewed fact as durable memory.";

/** A deterministic fixture boundary; real model quality is outside this proof. */
const fixtureDistiller: NamedDistillModel = {
  name: "release-1425-fixture-distiller/v1",
  extract: async ({ current }) => ({
    candidates: [
      {
        candidate_type: "fact",
        content: current.content,
        source_turn_ids: [current.id],
        uncertain: false,
      },
    ],
  }),
};

const fixtureEmbed = async () => ({ embedding: Array(768).fill(0.01) });

/**
 * Issue 1469 gap G1 fixture: a distinct reviewed candidate whose promotion is
 * exercised through search, so the dry-run negative is not consumed by the
 * provenance test above.
 */
const RETRIEVAL_CONTENT =
  "Weekly grimsby telemetry rollups reconcile against the ledger snapshot.";
const RETRIEVAL_QUERY = "grimsby telemetry rollups ledger snapshot";

/**
 * A zero query vector carries no similarity signal, so this proves retrieval
 * through the lexical arm of hybrid search; same stub as
 * recall-coverage.pg.test.ts.
 */
const searchDependencies = {
  pool,
  embedFn: async () => Array.from({ length: 768 }, () => 0),
  logger: pino({ level: "silent" }),
  sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
};

/** The same engine the MCP search tool calls; no mocks below the boundary. */
async function searchIds(namespace: string): Promise<string[]> {
  const rows = await executeSearch(
    searchDependencies,
    ["thoughts"],
    RETRIEVAL_QUERY,
    10,
    "hybrid",
    undefined,
    0,
    namespace,
  );
  return rows.map((row) => row.id);
}

/** Resolve hit ids to content so the dry-run negative names the row it rejects. */
async function contentsFor(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{ content: string }>(
    `SELECT content FROM thoughts WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map((row) => row.content);
}

interface ToolResult {
  isError: boolean;
  body: Record<string, unknown>;
}

interface TestClient {
  client: Client;
  close: () => Promise<void>;
}

async function clientFor(namespace: string): Promise<TestClient> {
  const server = new McpServer({ name: "reviewed-chain-test", version: "1.0.0" });
  const dependencies = {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  };
  registerIngestRawTurnTool(server, dependencies);
  registerReviewedCandidatePromotionTool(server, dependencies);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "reviewed-chain-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { isError: result.isError === true, body };
}

async function candidateFor(namespace: string, turnUuid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM candidate_memory c
       JOIN ob_raw_turns t ON t.id = ANY(c.source_turn_ids)
      WHERE c.namespace = $1 AND t.turn_uuid = $2
      ORDER BY c.created_at DESC
      LIMIT 1`,
    [namespace, turnUuid],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no candidate for raw turn ${turnUuid}`);
  return id;
}

async function rawTurnId(namespace: string, turnUuid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM ob_raw_turns WHERE namespace = $1 AND turn_uuid = $2`,
    [namespace, turnUuid],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no raw turn ${turnUuid}`);
  return id;
}

async function liveThoughtCount(namespace: string, content: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM thoughts
      WHERE namespace = $1 AND content = $2 AND archived_at IS NULL`,
    [namespace, content],
  );
  return rows[0]?.count ?? 0;
}

function primary(): Client {
  if (!primaryClient) throw new Error("primary test client is not connected");
  return primaryClient.client;
}

async function expectPromotedThought(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, source, created_by, content_hash, tags, source_refs, promoted_from
       FROM thoughts
      WHERE namespace = $1 AND content = $2 AND archived_at IS NULL`,
    [NAMESPACE, CONTENT],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe("dream-reviewed-candidate");
  expect(rows[0].created_by).toBe(NAMESPACE);
  expect(rows[0].content_hash).toBe(normalizedContentHash(CONTENT));
  expect(rows[0].tags).toEqual(["dream-reviewed-candidate", "candidate-type:fact"]);
  expect(rows[0].source_refs).toEqual([
    {
      kind: "candidate_memory",
      candidate_id: candidateId,
      namespace: NAMESPACE,
      source_turn_ids: [sourceTurnId],
    },
  ]);
  expect(rows[0].promoted_from).toMatchObject({
    source: "dream-reviewed-candidate",
    candidate_id: candidateId,
    candidate_type: "fact",
    source_turn_ids: [sourceTurnId],
    reviewed_by: "human-reviewer-release",
    review_action: "promoted",
  });
}

/** Ingest one turn, distill it, and human-promote the candidate it produced. */
async function reviewedCandidate(
  testClient: TestClient,
  namespace: string,
  content: string,
): Promise<string> {
  const turnUuid = randomUUID();
  const ingested = await callJson(testClient.client, "ingest_raw_turn", {
    turns: [
      {
        turn_uuid: turnUuid,
        session_ref: `${namespace}-retrieval-session`,
        turn_index: 0,
        role: "user",
        is_human_prompt: true,
        content,
        runtime: "release-1425-fixture",
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  expect(ingested.isError).toBe(false);
  const sweep = await runDistillSweep({
    pool,
    logger: pino({ level: "silent" }),
    namespace,
    maxSessions: 5,
    model: fixtureDistiller,
    embedFn: fixtureEmbed,
  });
  expect(sweep.candidates_written).toBeGreaterThanOrEqual(1);
  const id = await candidateFor(namespace, turnUuid);
  await submitGradeBatch(pool, {
    namespace,
    gradedBy: "human-reviewer-release",
    grades: [{ candidateId: id, action: "promoted" }],
  });
  return id;
}

let candidateId = "";
let retrievalCandidateId = "";
let foreignCandidateId = "";
let sourceTurnId = "";
let foreignClient: TestClient | undefined;
let primaryClient: TestClient | undefined;

beforeAll(async () => {
  primaryClient = await clientFor(NAMESPACE);
  foreignClient = await clientFor(OTHER_NAMESPACE);

  const turnUuid = randomUUID();
  const ingested = await callJson(primaryClient.client, "ingest_raw_turn", {
    // Omitted deliberately: the server must use the auth-derived namespace.
    turns: [
      {
        turn_uuid: turnUuid,
        session_ref: `${NAMESPACE}-session`,
        turn_index: 0,
        role: "user",
        is_human_prompt: true,
        content: CONTENT,
        runtime: "release-1425-fixture",
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  expect(ingested.isError).toBe(false);
  expect(ingested.body.ingested).toBe(1);
  sourceTurnId = await rawTurnId(NAMESPACE, turnUuid);

  const sweep = await runDistillSweep({
    pool,
    logger: pino({ level: "silent" }),
    namespace: NAMESPACE,
    maxSessions: 1,
    model: fixtureDistiller,
    embedFn: fixtureEmbed,
  });
  expect(sweep).toMatchObject({
    units: 1,
    turns_stamped: 1,
    candidates_extracted: 1,
    candidates_written: 1,
    candidates_duplicate: 0,
    embeddings_missing: 0,
  });
  candidateId = await candidateFor(NAMESPACE, turnUuid);

  const raw = await pool.query<{ distilled_at: Date | null }>(
    `SELECT distilled_at FROM ob_raw_turns WHERE id = $1`,
    [sourceTurnId],
  );
  expect(raw.rows[0]?.distilled_at).not.toBeNull();

  await submitGradeBatch(pool, {
    namespace: NAMESPACE,
    gradedBy: "human-reviewer-release",
    grades: [{ candidateId, action: "promoted" }],
  });

  retrievalCandidateId = await reviewedCandidate(
    primaryClient,
    NAMESPACE,
    RETRIEVAL_CONTENT,
  );

  const foreignTurnUuid = randomUUID();
  const foreignIngested = await callJson(foreignClient.client, "ingest_raw_turn", {
    turns: [
      {
        turn_uuid: foreignTurnUuid,
        session_ref: `${OTHER_NAMESPACE}-session`,
        turn_index: 0,
        role: "user",
        is_human_prompt: true,
        content: `${CONTENT} Foreign namespace copy.`,
        runtime: "release-1425-fixture",
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  expect(foreignIngested.isError).toBe(false);
  expect(foreignIngested.body.ingested).toBe(1);
  const foreignSweep = await runDistillSweep({
    pool,
    logger: pino({ level: "silent" }),
    namespace: OTHER_NAMESPACE,
    maxSessions: 1,
    model: fixtureDistiller,
    embedFn: fixtureEmbed,
  });
  expect(foreignSweep.candidates_written).toBe(1);
  foreignCandidateId = await candidateFor(OTHER_NAMESPACE, foreignTurnUuid);
  await submitGradeBatch(pool, {
    namespace: OTHER_NAMESPACE,
    gradedBy: "human-reviewer-release-foreign",
    grades: [{ candidateId: foreignCandidateId, action: "promoted" }],
  });
}, 60_000);

afterAll(async () => {
  if (primaryClient) await primaryClient.close();
  if (foreignClient) await foreignClient.close();
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.query(`DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.query(`DELETE FROM ob_raw_turns WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
}, 60_000);

describe("raw turn to reviewed durable memory (live Postgres)", () => {
  test("defaults to dry-run, then applies with provenance exactly once", async () => {
    expect(await liveThoughtCount(NAMESPACE, CONTENT)).toBe(0);

    const dryRun = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: candidateId,
    });
    expect(dryRun.isError).toBe(false);
    expect(dryRun.body).toMatchObject({
      status: "dry_run",
      candidate_id: candidateId,
      candidate_type: "fact",
      namespace: NAMESPACE,
      dry_run: true,
      would_insert: true,
      is_new: false,
    });
    expect(await liveThoughtCount(NAMESPACE, CONTENT)).toBe(0);

    const applied = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: candidateId,
      dry_run: false,
    });
    expect(applied.isError).toBe(false);
    expect(applied.body).toMatchObject({
      status: "promoted",
      candidate_id: candidateId,
      candidate_type: "fact",
      namespace: NAMESPACE,
      dry_run: false,
      would_insert: true,
      is_new: true,
    });
    expect(typeof applied.body.thought_id).toBe("string");

    await expectPromotedThought();

    const repeated = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: candidateId,
      dry_run: false,
    });
    expect(repeated.isError).toBe(false);
    expect(repeated.body).toMatchObject({
      status: "duplicate",
      candidate_id: candidateId,
      is_new: false,
      dry_run: false,
    });
    expect(await liveThoughtCount(NAMESPACE, CONTENT)).toBe(1);
  });

  test("a dry run stays unsearchable and an applied promotion is retrievable in its namespace only", async () => {
    const dryRun = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: retrievalCandidateId,
    });
    expect(dryRun.isError).toBe(false);
    expect(dryRun.body).toMatchObject({ status: "dry_run", dry_run: true });
    expect(await liveThoughtCount(NAMESPACE, RETRIEVAL_CONTENT)).toBe(0);
    const beforeApply = await searchIds(NAMESPACE);
    expect(await contentsFor(beforeApply)).not.toContain(RETRIEVAL_CONTENT);

    const applied = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: retrievalCandidateId,
      dry_run: false,
    });
    expect(applied.isError).toBe(false);
    expect(applied.body).toMatchObject({ status: "promoted", is_new: true });
    const thoughtId = applied.body.thought_id as string;
    expect(typeof thoughtId).toBe("string");

    expect(await searchIds(NAMESPACE)).toContain(thoughtId);
    expect(await searchIds(OTHER_NAMESPACE)).not.toContain(thoughtId);
  });

  test("a completed distill sweep is idempotent and a foreign reviewed candidate stays hidden", async () => {
    const repeatedSweep = await runDistillSweep({
      pool,
      logger: pino({ level: "silent" }),
      namespace: NAMESPACE,
      maxSessions: 1,
      model: fixtureDistiller,
      embedFn: fixtureEmbed,
    });
    expect(repeatedSweep).toMatchObject({
      units: 0,
      turns_stamped: 0,
      candidates_extracted: 0,
      candidates_written: 0,
    });

    const foreign = await callJson(primary(), "promote_reviewed_candidate", {
      candidate_id: foreignCandidateId,
      dry_run: false,
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.body.text).toBe("Candidate not found or not human-promoted");
    expect(
      await liveThoughtCount(NAMESPACE, `${CONTENT} Foreign namespace copy.`),
    ).toBe(0);
  });
});
