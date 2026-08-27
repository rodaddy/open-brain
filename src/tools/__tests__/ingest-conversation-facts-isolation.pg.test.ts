/**
 * Live-Postgres ISOLATION AND CONCURRENCY coverage for
 * ingest_conversation_facts (#340), exercised at the PUBLIC MCP tool boundary
 * against a real schema, the real source-registry approval gate, and the real
 * seven-coordinate lane predicate.
 *
 * The write-path proofs live in the sibling
 * ingest-conversation-facts.pg.test.ts; the fixtures and the database-touching
 * helpers both files share live in ingest-conversation-facts-test-helpers.ts.
 *
 * This suite REQUIRES a real test database. Absent the connection string
 * requireTestDatabaseUrl throws test_database_required and the run fails loudly
 * rather than reporting a skip that reads as a pass at the exit code.
 *
 * Proofs (all at the public callTool boundary, asserting responses + rows):
 *  1. Namespace/scope isolation is non-vacuous: the owning namespace succeeds;
 *     a foreign-namespace argument is denied and writes nothing; a wrong-scope
 *     assertion against a real lane is denied and writes nothing.
 *  2. Concurrent distinct-locator merges serialize: every merged disposition
 *     maps to retained unique evidence, with no lost update.
 *  3. A raw transcript body supplied as a top-level key is rejected at the schema
 *     boundary and writes nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  createIngestHarness,
  firstRow,
  FOREIGN_NS,
  OWNER_NS,
  OWNER_SCOPE,
  OWNER_SOURCE_REF,
  ownerAuth,
} from "./ingest-conversation-facts-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const h = createIngestHarness(pool);

// Each proof is a named module-scope function so the describe body stays a
// short registration list rather than one long function.

async function proveNamespaceAndScopeIsolation(): Promise<void> {
  await h.seedOwnerFixtures();

  // (a) Owning success: baseline that the fixtures are ingestable at all, so
  // the denials below are genuine boundary rejections, not a broken setup.
  await h.withTool(ownerAuth, async (client) => {
    const body = h.parse(
      await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          namespace: OWNER_NS,
          scope: OWNER_SCOPE,
          source_ref: OWNER_SOURCE_REF,
          facts: [{ event_type: "fact", content: "Owned success fact." }],
        },
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(1);
  });
  expect(await h.eventCount(h.ownerLaneId)).toBe(1);

  // (b) Foreign-namespace denial: the same owner token targets a namespace it
  // does not own. The write is denied server-side and nothing is persisted.
  await h.withTool(ownerAuth, async (client) => {
    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: FOREIGN_NS,
        scope: OWNER_SCOPE,
        source_ref: OWNER_SOURCE_REF,
        facts: [{ event_type: "fact", content: "Foreign attempt." }],
      },
    });
    expect(result.isError).toBe(true);
    expect(h.parse(result).error).toBe("namespace_denied");
  });
  // No lane/event was created in the foreign namespace.
  const { rows: foreignLanes } = await pool.query(
    "SELECT count(*)::int AS c FROM ob_session_lanes WHERE namespace = $1",
    [FOREIGN_NS],
  );
  expect(firstRow(foreignLanes).c).toBe(0);

  // (c) Wrong-scope denial: a real, owned lane exists, but the asserted scope
  // uses a different channel_id, so no lane matches the seven-coordinate
  // predicate. The call is denied and writes nothing new.
  await h.withTool(ownerAuth, async (client) => {
    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: OWNER_NS,
        scope: { ...OWNER_SCOPE, channel_id: "wrong-channel" },
        source_ref: OWNER_SOURCE_REF,
        facts: [{ event_type: "fact", content: "Wrong-scope attempt." }],
      },
    });
    expect(result.isError).toBe(true);
    expect(h.parse(result).error).toBe("scope_validation");
  });
  // Still exactly the one owned-success row; the wrong-scope call added nothing.
  expect(await h.eventCount(h.ownerLaneId)).toBe(1);
}

async function proveConcurrentMergesSerialize(): Promise<void> {
  await h.seedOwnerFixtures();
  const sharedContent = "Concurrently re-cited distilled statement.";

  // Seed the single duplicate row once (locator anchor-0). Every concurrent
  // call below hits the content-duplicate merge branch on THIS row.
  let storedId = "";
  await h.withTool(ownerAuth, async (client) => {
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
              source_locator: "anchor-0",
            },
          ],
        },
      }),
    );
    expect(first.ingested).toBe(1);
    storedId = firstRow(first.events as Array<Record<string, unknown>>)
      .event_id as string;
  });

  // Fire N concurrent calls, each identical content with a DISTINCT locator.
  // N is bounded and well under MAX_ADDITIONAL_EVIDENCE (32), so every merge
  // must succeed and be retained — none may hit the evidence_not_stored bound.
  const N = 8;
  const locators = Array.from({ length: N }, (_, i) => `anchor-c${i + 1}`);

  // Each concurrent caller gets its own MCP client/connection over the shared
  // real pool, so the N calls race through independent transactions exactly as
  // distinct callers would. withTool owns connect/close; the promise resolves
  // with the parsed receipt for that caller.
  const results = await Promise.all(
    locators.map(
      (locator) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          h.withTool(ownerAuth, async (client) => {
            const body = h.parse(
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
                      source_locator: locator,
                    },
                  ],
                },
              }),
            );
            resolve(body);
          }).catch(reject);
        }),
    ),
  );

  // No call may false-succeed or error: each is a caller-visible ok receipt
  // with exactly one duplicate unit (identical content, no new row).
  const dispositions: string[] = [];
  for (const body of results) {
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(0);
    expect(body.duplicates).toBe(1);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(firstRow(events).event_id).toBe(storedId);
    dispositions.push(firstRow(events).disposition as string);
  }

  // Under the bound, EVERY concurrent distinct-locator call must report a
  // real merge — never a benign plain-duplicate that silently dropped its
  // evidence, and never evidence_not_stored (we are well below the cap).
  const mergedLocators = locators.filter(
    (_, i) => dispositions[i] === "duplicate_evidence_merged",
  );
  expect(dispositions.every((d) => d === "duplicate_evidence_merged")).toBe(true);

  // No second row was ever written: identical content stayed a single row.
  expect(await h.eventCount(h.ownerLaneId)).toBe(1);

  // The lost-update proof: read the FINAL stored evidence. Every locator that
  // a caller reported as merged must be present exactly once — a lost update
  // would leave a merged disposition whose locator is missing from metadata.
  const { rows } = await pool.query(
    `SELECT metadata->'additional_evidence' AS evidence,
            metadata->>'source_locator' AS primary_locator
       FROM ob_session_events WHERE id = $1`,
    [storedId],
  );
  const evidence = firstRow(rows).evidence as Array<Record<string, unknown>>;
  expect(Array.isArray(evidence)).toBe(true);
  // Primary locator (anchor-0) is on the row itself, not in additional_evidence.
  expect(firstRow(rows).primary_locator).toBe("anchor-0");

  const storedLocators = evidence.map((e) => e.source_locator as string);
  // Each retained locator appears exactly once (no duplication, no loss).
  expect(new Set(storedLocators).size).toBe(storedLocators.length);
  // Every caller-reported merge is retained in the final metadata: the count
  // of merged dispositions equals the count of retained distinct locators,
  // and each merged locator is present. This fails on the pre-lock behavior,
  // where concurrent overwrites drop merges while still reporting success.
  for (const locator of mergedLocators) {
    expect(storedLocators).toContain(locator);
  }
  expect(storedLocators.length).toBe(mergedLocators.length);
  expect(storedLocators.length).toBe(N);

  // Content never leaks into any evidence pointer.
  expect(JSON.stringify(evidence)).not.toContain(sharedContent);
}

async function proveRawTranscriptRejected(): Promise<void> {
  await h.seedOwnerFixtures();
  await h.withTool(ownerAuth, async (client) => {
    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: OWNER_NS,
        scope: OWNER_SCOPE,
        source_ref: OWNER_SOURCE_REF,
        facts: [{ event_type: "fact", content: "distilled fact" }],
        transcript: "user: hi\nassistant: hello\n... full raw transcript ...",
      },
    });
    // Caller-visible rejection at the schema boundary; the raw body is not
    // echoed back in the error.
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain("transcript");
    expect(text).not.toContain("assistant: hello");
  });
  // Zero events persisted: the handler never ran a write.
  expect(await h.eventCount(h.ownerLaneId)).toBe(0);
}

describe("ingest_conversation_facts isolation and concurrency (live Postgres)", () => {
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
    "keeps namespace/scope isolation non-vacuous: owning success, foreign-namespace and wrong-scope denials write nothing",
    proveNamespaceAndScopeIsolation,
  );

  it(
    "serializes concurrent distinct-locator merges: every merged disposition maps to retained unique evidence, no lost update",
    proveConcurrentMergesSerialize,
  );

  it(
    "rejects a raw transcript public-schema body and writes nothing",
    proveRawTranscriptRejected,
  );
});
