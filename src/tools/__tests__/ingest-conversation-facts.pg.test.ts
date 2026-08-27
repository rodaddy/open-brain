/**
 * Live-Postgres functional coverage for the ingest_conversation_facts WRITE
 * PATH (#340), exercised at the PUBLIC MCP tool boundary against a real schema,
 * the real source-registry approval gate, the real seven-coordinate lane
 * predicate, and a real all-or-nothing write transaction.
 *
 * The focused suite (ingest-conversation-facts.test.ts) proves the contract
 * against fake pools; this suite proves the same caller-visible responses AND
 * the persisted outcomes against real SQL, closing the gap where a fake pool
 * could mask a wrong predicate, a non-atomic transaction, or a receipt that does
 * not match the stored row.
 *
 * The isolation and concurrency proofs live in the sibling
 * ingest-conversation-facts-isolation.pg.test.ts; the fixtures and the
 * database-touching helpers both files share live in
 * ingest-conversation-facts-test-helpers.ts.
 *
 * This suite REQUIRES a real test database. Absent the connection string
 * requireTestDatabaseUrl throws test_database_required and the run fails loudly
 * rather than reporting a skip that reads as a pass at the exit code.
 *
 * Proofs (all at the public callTool boundary, asserting responses + rows):
 *  1. An approved+active conversation source and the exact seven-coordinate lane
 *     ingest a fact through real SQL; the receipt's event id matches the stored
 *     ob_session_events row (right lane, right type, right content).
 *  2. Identical content with a NEW source_locator merges bounded structural
 *     evidence onto the existing row (or returns the explicit disposition); the
 *     stored metadata matches the receipt and no second row is written.
 *  3. A deterministic mid-batch failure (a test-owned BEFORE INSERT trigger that
 *     raises on a sentinel unit) rolls the whole transaction back: zero events
 *     from that call persist and the caller sees a retryable error. The trigger
 *     is removed in cleanup.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  createIngestHarness,
  firstRow,
  OWNER_NS,
  OWNER_SCOPE,
  OWNER_SOURCE_REF,
  ownerAuth,
  TRIGGER_SENTINEL,
} from "./ingest-conversation-facts-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const h = createIngestHarness(pool);

// Each proof is a named module-scope function so the describe body stays a
// short registration list rather than one long function.

async function proveReceiptMatchesStoredRow(): Promise<void> {
  await h.seedOwnerFixtures();
  await h.withTool(ownerAuth, async (client) => {
    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: OWNER_NS,
        scope: OWNER_SCOPE,
        source_ref: OWNER_SOURCE_REF,
        facts: [{ event_type: "decision", content: "We chose Postgres." }],
      },
    });
    expect(result.isError).toBeFalsy();
    const body = h.parse(result);
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.lane_id).toBe(h.ownerLaneId);
    expect(body.source_id).toBe(h.ownerSourceId);
    expect(body.writer_identity).toBe(OWNER_NS);
    // The receipt never echoes the distilled content.
    expect(JSON.stringify(body)).not.toContain("We chose Postgres");

    const events = body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    const eventId = firstRow(events).event_id as string;
    expect(firstRow(events).disposition).toBe("stored");

    // The stored row is exactly what the receipt claims: right id, lane, type,
    // content, and conversation-ingest provenance.
    const { rows } = await pool.query(
      `SELECT lane_id, event_type, content, importance,
              metadata->>'conversation_ingest' AS conv,
              metadata->>'source_id' AS meta_source_id,
              metadata->'_openbrain'->'writer'->>'client_id' AS writer
         FROM ob_session_events WHERE id = $1`,
      [eventId],
    );
    expect(rows).toHaveLength(1);
    const row = firstRow(rows);
    expect(String(row.lane_id)).toBe(h.ownerLaneId);
    expect(row.event_type).toBe("decision");
    expect(row.content).toBe("We chose Postgres.");
    expect(row.importance).toBe("warm");
    expect(row.conv).toBe("true");
    expect(String(row.meta_source_id)).toBe(h.ownerSourceId);
    expect(row.writer).toBe(OWNER_NS);

    // Exactly one durable row landed for this call.
    expect(await h.eventCount(h.ownerLaneId)).toBe(1);
  });
}

async function proveEvidenceMergeOnNewLocator(): Promise<void> {
  await h.seedOwnerFixtures();
  const sharedContent = "Identical distilled statement.";
  await h.withTool(ownerAuth, async (client) => {
    // First write: stores the row with locator anchor-A.
    const first = h.parse(
      await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          namespace: OWNER_NS,
          scope: OWNER_SCOPE,
          source_ref: OWNER_SOURCE_REF,
          facts: [
            {
              event_type: "fact",
              content: sharedContent,
              source_locator: "anchor-A",
            },
          ],
        },
      }),
    );
    expect(first.ingested).toBe(1);
    const storedId = firstRow(first.events as Array<Record<string, unknown>>)
      .event_id as string;

    // Second write: identical content, a NEW locator anchor-B. This is a
    // content-duplicate that carries new structural evidence.
    const second = h.parse(
      await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          namespace: OWNER_NS,
          scope: OWNER_SCOPE,
          source_ref: OWNER_SOURCE_REF,
          facts: [
            {
              event_type: "fact",
              content: sharedContent,
              source_locator: "anchor-B",
            },
          ],
        },
      }),
    );
    expect(second.isError).toBeFalsy();
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.evidence_merged).toBe(1);
    expect(second.evidence_not_stored).toBe(0);
    const secondEvents = second.events as Array<Record<string, unknown>>;
    expect(firstRow(secondEvents).disposition).toBe("duplicate_evidence_merged");
    // The merge targets the SAME stored row, not a new one.
    expect(firstRow(secondEvents).event_id).toBe(storedId);

    // No second durable row was written: identical content did not double-write.
    expect(await h.eventCount(h.ownerLaneId)).toBe(1);

    // The stored row now carries the new locator as bounded structural
    // evidence, exactly as the receipt reported.
    const { rows } = await pool.query(
      `SELECT metadata->'additional_evidence' AS evidence
         FROM ob_session_events WHERE id = $1`,
      [storedId],
    );
    const evidence = firstRow(rows).evidence as Array<Record<string, unknown>>;
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence).toHaveLength(1);
    expect(firstRow(evidence).source_locator).toBe("anchor-B");
    expect(firstRow(evidence).event_type).toBe("fact");
    // Content is never written into the evidence pointer.
    expect(JSON.stringify(evidence)).not.toContain(sharedContent);
  });
}

async function proveMidBatchFailureRollsBack(): Promise<void> {
  await h.seedOwnerFixtures();

  // Test-owned deterministic failure: a BEFORE INSERT trigger that raises only
  // when a unit carries the sentinel content. Installed here and removed in the
  // afterEach cleanup. This makes the SECOND unit of a two-unit batch fail
  // inside the transaction with no reliance on timing or concurrency.
  await pool.query(`
    CREATE FUNCTION lane340_rollback_trigger_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.content = '${TRIGGER_SENTINEL}' THEN
        RAISE EXCEPTION 'lane340 deterministic mid-batch failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    CREATE TRIGGER lane340_rollback_trigger
      BEFORE INSERT ON ob_session_events
      FOR EACH ROW EXECUTE FUNCTION lane340_rollback_trigger_fn();
  `);

  expect(await h.eventCount(h.ownerLaneId)).toBe(0);

  await h.withTool(ownerAuth, async (client) => {
    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: OWNER_NS,
        scope: OWNER_SCOPE,
        source_ref: OWNER_SOURCE_REF,
        facts: [
          { event_type: "fact", content: "First unit that would commit." },
          { event_type: "fact", content: TRIGGER_SENTINEL },
        ],
      },
    });
    // Caller-visible failure, not a benign or partial success.
    expect(result.isError).toBe(true);
    const body = h.parse(result);
    expect(body.error).toBe("retryable_outage");
    expect(body.ingested).toBeUndefined();
    // The raised message never leaks into the response.
    expect(JSON.stringify(result)).not.toContain("deterministic mid-batch");
  });

  // All-or-nothing: the first unit's insert was rolled back with the failing
  // second, so ZERO events from that call persist.
  expect(await h.eventCount(h.ownerLaneId)).toBe(0);
}

describe("ingest_conversation_facts write path (live Postgres)", () => {
  beforeAll(async () => {
    await h.migrateAndClean();
  });

  afterAll(async () => {
    await h.cleanAndEnd();
  });

  afterEach(async () => {
    await h.dropTriggerAndClean();
  });

  it(
    "ingests an approved-source fact through real SQL and the receipt matches the stored row",
    proveReceiptMatchesStoredRow,
  );

  it(
    "merges bounded evidence for identical content with a new locator, and the stored metadata matches the receipt",
    proveEvidenceMergeOnNewLocator,
  );

  it(
    "rolls back the whole batch on a deterministic mid-batch failure: zero events persist",
    proveMidBatchFailureRollsBack,
  );
});
