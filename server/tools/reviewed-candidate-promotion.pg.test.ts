/**
 * Live-Postgres proof for the explicit reviewed-candidate promotion seam.
 *
 * The discriminating property is the boundary between a human grade and a
 * durable thought: a candidate with only REM's machine guess must stay out,
 * while a candidate after the real batch grade may be previewed and then
 * written exactly once. The tool is exercised through MCP so auth, namespace,
 * dry-run, and the write are tested together.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it. The
 * isolated runner supplies that URL and drops the database afterward.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createReviewedCandidatePromotionRepository } from "../db/reviewed-candidate-promotion-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import {
  submitGradeBatch,
  ungradeCandidate,
} from "../domain/candidate-review/batch-grade.ts";
import {
  promoteReviewedCandidate,
  ReviewedCandidateNotFoundError,
} from "../domain/reviewed-candidate-promotion.ts";
import { normalizedContentHash } from "../embedding/provider.ts";
import { registerReviewedCandidatePromotionTool } from "./reviewed-candidate-promotion.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

// Allowance for the setup hook below (issue 1518). The self-hosted CI runner
// ran it past vitest's 10000 ms hook default on 2026-09-25: file times 16555
// and 16603 ms (run 7126, jobs 17305 and 17306, two runners), and again in
// run 7058 job 17136. Locally the whole file takes 291, 302 and 301 ms. Pg
// files run serially (vitest.config.ts), so this is not a concurrent suite;
// the slow statement is not yet identified. 30000 is well past the runner tail.
const SETUP_ALLOWANCE_MS = 30_000;

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `reviewed-candidate-pg-${process.pid}-${randomUUID()}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;
const CANDIDATE_CONTENT =
  "The reviewed candidate becomes durable only through an explicit human promotion.";
const SOURCE_TURN_ID = randomUUID();

interface CallOutcome {
  isError: boolean;
  body: Record<string, unknown>;
}

async function callPromotion(
  namespace: string,
  args: Record<string, unknown>,
  role = "agent",
): Promise<CallOutcome> {
  const server = new McpServer({ name: "reviewed-candidate-test", version: "1.0.0" });
  registerReviewedCandidatePromotionTool(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "reviewed-candidate-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "promote_reviewed_candidate",
      arguments: args,
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { text };
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

async function countThoughts(
  namespace: string,
  content = CANDIDATE_CONTENT,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM thoughts
      WHERE namespace = $1 AND content = $2 AND archived_at IS NULL`,
    [namespace, content],
  );
  return rows[0].count;
}

/**
 * Observe the real PostgreSQL ordering without a wall-clock sleep.
 *
 * The revocation transaction owns the candidate row lock before promotion
 * starts. With the row lock in the repository, promotion's candidate SELECT
 * must be visible as a transaction lock wait; before that fix it completed and
 * returned the stale promoted row. The candidate-read flag is the other
 * outcome, so the assertion distinguishes the two implementations without
 * guessing from elapsed time.
 */
async function waitForCandidateReadOrLock(
  backendPid: number,
  candidateReadComplete: () => boolean,
): Promise<"candidate-read" | "row-lock-wait"> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (candidateReadComplete()) return "candidate-read";
    const { rows } = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid],
    );
    if (candidateReadComplete()) return "candidate-read";
    if (rows[0]?.wait_event_type === "Lock") return "row-lock-wait";
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `promotion backend ${backendPid} did not read or wait on the candidate row`,
  );
}

/** Prove a revocation-first transaction cannot be bypassed by promotion. */
async function expectRevocationRaceIsSerialized(): Promise<void> {
  // Start the revocation transaction first and leave its candidate row lock
  // held. The promotion query must wait for that lock and then see the
  // cleared review; a plain SELECT would return the stale promoted snapshot
  // and insert a thought after the revocation commits.
  const raceContent = `${CANDIDATE_CONTENT} Revocation wins this race ${randomUUID()}.`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO candidate_memory
       (namespace, candidate_type, content, content_hash, source_turn_ids,
        model, authority_tier)
     VALUES ($1, 'fact', $2, $3, $4::uuid[], 'fixture-distiller', 'observed')
     RETURNING id`,
    [NAMESPACE, raceContent, normalizedContentHash(raceContent), [SOURCE_TURN_ID]],
  );
  const raceCandidateId = inserted.rows[0]?.id;
  if (!raceCandidateId)
    throw new Error("revocation race candidate insert returned no id");
  await submitGradeBatch(pool, {
    namespace: NAMESPACE,
    gradedBy: "human-reviewer-race",
    grades: [{ candidateId: raceCandidateId, action: "promoted" }],
  });

  const revocation = await pool.connect();
  let promotion: Promise<unknown> | undefined;
  try {
    await revocation.query("BEGIN");
    expect(
      await ungradeCandidate(revocation, {
        namespace: NAMESPACE,
        id: raceCandidateId,
      }),
    ).toMatchObject({ id: raceCandidateId });

    let resolveBackend!: (pid: number) => void;
    const backendReady = new Promise<number>((resolve) => {
      resolveBackend = resolve;
    });
    let candidateReadComplete = false;
    promotion = withTransaction({
      pool,
      run: async (tx) => {
        const delegate = createReviewedCandidatePromotionRepository(tx);
        const repository = {
          ...delegate,
          async findHumanPromotedCandidate(input: {
            candidateId: string;
            namespace: string;
          }) {
            const pid = await tx.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            );
            const candidateQuery = delegate.findHumanPromotedCandidate(input);
            resolveBackend(Number(pid.rows[0]?.pid));
            const candidate = await candidateQuery;
            candidateReadComplete = true;
            return candidate;
          },
        };
        return promoteReviewedCandidate(repository, {
          candidateId: raceCandidateId,
          namespace: NAMESPACE,
          promotedBy: NAMESPACE,
          dryRun: false,
        });
      },
    });

    const observation = await waitForCandidateReadOrLock(
      await backendReady,
      () => candidateReadComplete,
    );
    await revocation.query("COMMIT");

    let promotionError: unknown;
    try {
      await promotion;
    } catch (error) {
      promotionError = error;
    }
    expect(observation).toBe("row-lock-wait");
    expect(promotionError).toBeInstanceOf(ReviewedCandidateNotFoundError);
    expect(await countThoughts(NAMESPACE, raceContent)).toBe(0);
  } finally {
    if (promotion) await promotion.catch(() => undefined);
    revocation.release();
  }
}

let candidateId = "";
let machineOnlyCandidateId = "";
let foreignCandidateId = "";

beforeAll(async () => {
  const inserted = await pool.query(
    `INSERT INTO candidate_memory
       (namespace, candidate_type, content, content_hash, source_turn_ids, model,
        authority_tier)
     VALUES ($1, 'fact', $2, $3, $4::uuid[], 'fixture-distiller', 'observed')
     RETURNING id`,
    [
      NAMESPACE,
      CANDIDATE_CONTENT,
      normalizedContentHash(CANDIDATE_CONTENT),
      [SOURCE_TURN_ID],
    ],
  );
  candidateId = inserted.rows[0].id;

  const machineOnly = await pool.query(
    `INSERT INTO candidate_memory
     (namespace, candidate_type, content, content_hash, source_turn_ids,
        model, authority_tier, machine_grade, machine_grade_model)
     VALUES ($1, 'fact', $2, $3, $4::uuid[], 'fixture-distiller', 'observed',
             'promoted', 'fixture-rem')
     RETURNING id`,
    [
      NAMESPACE,
      `${CANDIDATE_CONTENT} Machine judgment alone is insufficient.`,
      normalizedContentHash(
        `${CANDIDATE_CONTENT} Machine judgment alone is insufficient.`,
      ),
      [SOURCE_TURN_ID],
    ],
  );
  machineOnlyCandidateId = machineOnly.rows[0].id;

  const foreign = await pool.query(
    `INSERT INTO candidate_memory
       (namespace, candidate_type, content, content_hash, source_turn_ids,
        model, authority_tier)
     VALUES ($1, 'fact', $2, $3, $4::uuid[], 'fixture-distiller', 'observed')
     RETURNING id`,
    [
      OTHER_NAMESPACE,
      `${CANDIDATE_CONTENT} Foreign namespace must remain invisible.`,
      normalizedContentHash(
        `${CANDIDATE_CONTENT} Foreign namespace must remain invisible.`,
      ),
      [SOURCE_TURN_ID],
    ],
  );
  foreignCandidateId = foreign.rows[0].id;

  await submitGradeBatch(pool, {
    namespace: NAMESPACE,
    gradedBy: "human-reviewer-fixture",
    grades: [{ candidateId, action: "promoted" }],
  });
}, SETUP_ALLOWANCE_MS);

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [NAMESPACE]);
  await pool.query(`DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
});

describe("promote_reviewed_candidate (live Postgres)", () => {
  test("defaults to a dry-run after a human grade and writes nothing", async () => {
    expect(await countThoughts(NAMESPACE)).toBe(0);
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: candidateId,
    });
    expect(isError).toBe(false);
    expect(body.status).toBe("dry_run");
    expect(body.dry_run).toBe(true);
    expect(body.would_insert).toBe(true);
    expect(await countThoughts(NAMESPACE)).toBe(0);
  });

  test("requires review_action=promoted, never REM's machine grade", async () => {
    const before = await countThoughts(NAMESPACE);
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: machineOnlyCandidateId,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("human-promoted");
    expect(await countThoughts(NAMESPACE)).toBe(before);
  });

  test("explicit apply writes a thought with candidate provenance", async () => {
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: candidateId,
      dry_run: false,
    });
    expect(isError).toBe(false);
    expect(body.status).toBe("promoted");
    expect(body.is_new).toBe(true);

    const { rows } = await pool.query(
      `SELECT id, source, created_by, content_hash, tags, source_refs, promoted_from
         FROM thoughts
        WHERE namespace = $1 AND content = $2 AND archived_at IS NULL`,
      [NAMESPACE, CANDIDATE_CONTENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("dream-reviewed-candidate");
    expect(rows[0].created_by).toBe(NAMESPACE);
    expect(rows[0].content_hash).toBe(normalizedContentHash(CANDIDATE_CONTENT));
    expect(rows[0].tags).toEqual(["dream-reviewed-candidate", "candidate-type:fact"]);
    expect(rows[0].source_refs).toEqual([
      {
        kind: "candidate_memory",
        candidate_id: candidateId,
        namespace: NAMESPACE,
        source_turn_ids: [SOURCE_TURN_ID],
      },
    ]);
    expect(rows[0].promoted_from).toMatchObject({
      source: "dream-reviewed-candidate",
      candidate_id: candidateId,
      candidate_type: "fact",
      reviewed_by: "human-reviewer-fixture",
      review_action: "promoted",
    });
  });

  test("repeating apply is idempotent and does not create a second thought", async () => {
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: candidateId,
      dry_run: false,
    });
    expect(isError).toBe(false);
    expect(body.status).toBe("duplicate");
    expect(body.is_new).toBe(false);
    expect(await countThoughts(NAMESPACE)).toBe(1);
    await expectRevocationRaceIsSerialized();
  });

  test("a foreign namespace candidate is refused without probing its content", async () => {
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: foreignCandidateId,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(body.text).toBe("Candidate not found or not human-promoted");
  });

  test("an agent cannot retarget the write into another namespace", async () => {
    const { isError, body } = await callPromotion(NAMESPACE, {
      candidate_id: foreignCandidateId,
      namespace: OTHER_NAMESPACE,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("cannot write to namespace");
  });
});
