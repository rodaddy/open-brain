/**
 * Live-Postgres functional coverage for ingest_conversation_facts (#340),
 * exercised at the PUBLIC MCP tool boundary against a real schema, the real
 * source-registry approval gate, the real seven-coordinate lane predicate, and a
 * real all-or-nothing write transaction.
 *
 * The focused suite (ingest-conversation-facts.test.ts) proves the contract
 * against fake pools; this suite proves the same caller-visible responses AND
 * the persisted outcomes against real SQL, closing the gap where a fake pool
 * could mask a wrong predicate, a non-atomic transaction, or a receipt that does
 * not match the stored row.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention); skips when
 * unset so a DB-less CI job passes while the db-integration job runs it against
 * Postgres.
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
 *  4. Namespace/scope isolation is non-vacuous: the owning namespace succeeds;
 *     a foreign-namespace argument is denied and writes nothing; a wrong-scope
 *     assertion against a real lane is denied and writes nothing.
 *  5. A raw transcript body supplied as a top-level key is rejected at the schema
 *     boundary and writes nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerIngestConversationFacts } from "../ingest-conversation-facts.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

// Every row this suite creates is namespaced under one of these two isolation
// namespaces so cleanup deletes exactly what the suite owns and nothing else.
// The owning namespace is where the approved source + scoped lane live; the
// foreign namespace is used only to prove cross-namespace denial.
const OWNER_NS = "lane340-owner-ns";
const FOREIGN_NS = "lane340-foreign-ns";

// The exact seven-coordinate scope (six coordinates + namespace) the owning lane
// is bound to. Matches the shape the tool's lane predicate asserts.
const OWNER_SCOPE = {
  agent: "assistant",
  platform: "discord",
  server_id: "guild-340",
  channel_id: "chan-340",
  thread_id: null as string | null,
  session_key: "sess-340",
};

const OWNER_SOURCE_EXTERNAL_ID = "conv:room-340";
const OWNER_SOURCE_REF = {
  source_kind: "conversation" as const,
  external_id: OWNER_SOURCE_EXTERNAL_ID,
};

// A token-scoped agent whose own namespace is OWNER_NS. This is the happy-path
// writer: it may write its own namespace and is denied any foreign one.
const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

// Deterministic embeddings so no live embedding endpoint is required; the tool
// treats an embed result as opaque and stores it as a bound param.
const stubEmbed = async (): Promise<number[]> => Array(768).fill(0.01);

// A sentinel content string the test-owned trigger raises on, used only to force
// a deterministic mid-batch failure in proof (3).
const TRIGGER_SENTINEL = "LANE340_TRIGGER_ROLLBACK_SENTINEL";

dbDescribe("ingest_conversation_facts (live Postgres)", () => {
  let pool: Pool;
  let ownerLaneId: string;
  let ownerSourceId: string;

  function parse(result: unknown): Record<string, unknown> {
    const content = (result as { content: Array<{ text: string }> }).content;
    return JSON.parse(content[0]!.text);
  }

  // Stand up a public MCP client wired to the real pool for a given auth. This is
  // the same public-boundary harness the fake suite uses, so tests assert the
  // caller-visible callTool response, never internal SQL or call order.
  async function withTool(
    auth: AuthInfo,
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as never,
      embedFn: stubEmbed as never,
    };
    registerIngestConversationFacts(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  // Count durable events in a lane whose content matches, so a test can prove
  // exactly how many rows a call persisted (or that it persisted none).
  async function eventCount(laneId: string): Promise<number> {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS c FROM ob_session_events WHERE lane_id = $1",
      [laneId],
    );
    return rows[0]!.c as number;
  }

  async function cleanupData(): Promise<void> {
    // Events cascade from lanes, but delete explicitly for clarity. Order:
    // events → lanes → sources, all scoped to the suite's two namespaces.
    await pool.query(
      `DELETE FROM ob_session_events
        WHERE lane_id IN (
          SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[])
        )`,
      [[OWNER_NS, FOREIGN_NS]],
    );
    await pool.query(
      "DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])",
      [[OWNER_NS, FOREIGN_NS]],
    );
    await pool.query(
      "DELETE FROM ob_sources WHERE namespace = ANY($1::text[])",
      [[OWNER_NS, FOREIGN_NS]],
    );
  }

  // Seed the owning approved+active conversation source and the exact-scope lane
  // fresh, returning their ids. Called before each proof so no prior state leaks.
  async function seedOwnerFixtures(): Promise<void> {
    const { rows: srcRows } = await pool.query(
      `INSERT INTO ob_sources
         (namespace, source_kind, external_id, approval_state, approved_by,
          approved_at, lifecycle_state, sync_state, created_by)
       VALUES ($1, 'conversation', $2, 'approved', 'admin', now(),
               'active', 'synced', 'admin')
       RETURNING id`,
      [OWNER_NS, OWNER_SOURCE_EXTERNAL_ID],
    );
    ownerSourceId = String(srcRows[0]!.id);

    const { rows: laneRows } = await pool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, agent, source, channel_id, thread_id,
          metadata, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7::jsonb, 'admin')
       RETURNING id`,
      [
        OWNER_SCOPE.session_key,
        OWNER_NS,
        OWNER_SCOPE.agent,
        OWNER_SCOPE.platform,
        OWNER_SCOPE.channel_id,
        OWNER_SCOPE.thread_id,
        JSON.stringify({ server_id: OWNER_SCOPE.server_id }),
      ],
    );
    ownerLaneId = String(laneRows[0]!.id);
  }

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanupData();
  });

  afterAll(async () => {
    await cleanupData();
    await pool.end();
  });

  afterEach(async () => {
    // Remove any test-owned trigger a proof installed, then clear suite data so
    // each proof starts from a clean, freshly-seeded fixture.
    await pool.query(
      "DROP TRIGGER IF EXISTS lane340_rollback_trigger ON ob_session_events",
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS lane340_rollback_trigger_fn() CASCADE",
    );
    await cleanupData();
  });

  it("ingests an approved-source fact through real SQL and the receipt matches the stored row", async () => {
    await seedOwnerFixtures();
    await withTool(ownerAuth, async (client) => {
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
      const body = parse(result);
      expect(body.ok).toBe(true);
      expect(body.ingested).toBe(1);
      expect(body.duplicates).toBe(0);
      expect(body.lane_id).toBe(ownerLaneId);
      expect(body.source_id).toBe(ownerSourceId);
      expect(body.writer_identity).toBe(OWNER_NS);
      // The receipt never echoes the distilled content.
      expect(JSON.stringify(body)).not.toContain("We chose Postgres");

      const events = body.events as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      const eventId = events[0]!.event_id as string;
      expect(events[0]!.disposition).toBe("stored");

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
      const row = rows[0]!;
      expect(String(row.lane_id)).toBe(ownerLaneId);
      expect(row.event_type).toBe("decision");
      expect(row.content).toBe("We chose Postgres.");
      expect(row.importance).toBe("warm");
      expect(row.conv).toBe("true");
      expect(String(row.meta_source_id)).toBe(ownerSourceId);
      expect(row.writer).toBe(OWNER_NS);

      // Exactly one durable row landed for this call.
      expect(await eventCount(ownerLaneId)).toBe(1);
    });
  });

  it("merges bounded evidence for identical content with a new locator, and the stored metadata matches the receipt", async () => {
    await seedOwnerFixtures();
    const sharedContent = "Identical distilled statement.";
    await withTool(ownerAuth, async (client) => {
      // First write: stores the row with locator anchor-A.
      const first = parse(
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
      const storedId = (first.events as Array<Record<string, unknown>>)[0]!
        .event_id as string;

      // Second write: identical content, a NEW locator anchor-B. This is a
      // content-duplicate that carries new structural evidence.
      const second = parse(
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
      expect(secondEvents[0]!.disposition).toBe("duplicate_evidence_merged");
      // The merge targets the SAME stored row, not a new one.
      expect(secondEvents[0]!.event_id).toBe(storedId);

      // No second durable row was written: identical content did not double-write.
      expect(await eventCount(ownerLaneId)).toBe(1);

      // The stored row now carries the new locator as bounded structural
      // evidence, exactly as the receipt reported.
      const { rows } = await pool.query(
        `SELECT metadata->'additional_evidence' AS evidence
           FROM ob_session_events WHERE id = $1`,
        [storedId],
      );
      const evidence = rows[0]!.evidence as Array<Record<string, unknown>>;
      expect(Array.isArray(evidence)).toBe(true);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.source_locator).toBe("anchor-B");
      expect(evidence[0]!.event_type).toBe("fact");
      // Content is never written into the evidence pointer.
      expect(JSON.stringify(evidence)).not.toContain(sharedContent);
    });
  });

  it("rolls back the whole batch on a deterministic mid-batch failure: zero events persist", async () => {
    await seedOwnerFixtures();

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

    expect(await eventCount(ownerLaneId)).toBe(0);

    await withTool(ownerAuth, async (client) => {
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
      const body = parse(result);
      expect(body.error).toBe("retryable_outage");
      expect(body.ingested).toBeUndefined();
      // The raised message never leaks into the response.
      expect(JSON.stringify(result)).not.toContain("deterministic mid-batch");
    });

    // All-or-nothing: the first unit's insert was rolled back with the failing
    // second, so ZERO events from that call persist.
    expect(await eventCount(ownerLaneId)).toBe(0);
  });

  it("keeps namespace/scope isolation non-vacuous: owning success, foreign-namespace and wrong-scope denials write nothing", async () => {
    await seedOwnerFixtures();

    // (a) Owning success: baseline that the fixtures are ingestable at all, so
    // the denials below are genuine boundary rejections, not a broken setup.
    await withTool(ownerAuth, async (client) => {
      const body = parse(
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
    expect(await eventCount(ownerLaneId)).toBe(1);

    // (b) Foreign-namespace denial: the same owner token targets a namespace it
    // does not own. The write is denied server-side and nothing is persisted.
    await withTool(ownerAuth, async (client) => {
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
      expect(parse(result).error).toBe("namespace_denied");
    });
    // No lane/event was created in the foreign namespace.
    const { rows: foreignLanes } = await pool.query(
      "SELECT count(*)::int AS c FROM ob_session_lanes WHERE namespace = $1",
      [FOREIGN_NS],
    );
    expect(foreignLanes[0]!.c).toBe(0);

    // (c) Wrong-scope denial: a real, owned lane exists, but the asserted scope
    // uses a different channel_id, so no lane matches the seven-coordinate
    // predicate. The call is denied and writes nothing new.
    await withTool(ownerAuth, async (client) => {
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
      expect(parse(result).error).toBe("scope_validation");
    });
    // Still exactly the one owned-success row; the wrong-scope call added nothing.
    expect(await eventCount(ownerLaneId)).toBe(1);
  });

  it("serializes concurrent distinct-locator merges: every merged disposition maps to retained unique evidence, no lost update", async () => {
    await seedOwnerFixtures();
    const sharedContent = "Concurrently re-cited distilled statement.";

    // Seed the single duplicate row once (locator anchor-0). Every concurrent
    // call below hits the content-duplicate merge branch on THIS row.
    let storedId = "";
    await withTool(ownerAuth, async (client) => {
      const first = parse(
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
      storedId = (first.events as Array<Record<string, unknown>>)[0]!
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
            withTool(ownerAuth, async (client) => {
              const body = parse(
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
      expect(events[0]!.event_id).toBe(storedId);
      dispositions.push(events[0]!.disposition as string);
    }

    // Under the bound, EVERY concurrent distinct-locator call must report a
    // real merge — never a benign plain-duplicate that silently dropped its
    // evidence, and never evidence_not_stored (we are well below the cap).
    const mergedLocators = locators.filter(
      (_, i) => dispositions[i] === "duplicate_evidence_merged",
    );
    expect(dispositions.every((d) => d === "duplicate_evidence_merged")).toBe(
      true,
    );

    // No second row was ever written: identical content stayed a single row.
    expect(await eventCount(ownerLaneId)).toBe(1);

    // The lost-update proof: read the FINAL stored evidence. Every locator that
    // a caller reported as merged must be present exactly once — a lost update
    // would leave a merged disposition whose locator is missing from metadata.
    const { rows } = await pool.query(
      `SELECT metadata->'additional_evidence' AS evidence,
              metadata->>'source_locator' AS primary_locator
         FROM ob_session_events WHERE id = $1`,
      [storedId],
    );
    const evidence = rows[0]!.evidence as Array<Record<string, unknown>>;
    expect(Array.isArray(evidence)).toBe(true);
    // Primary locator (anchor-0) is on the row itself, not in additional_evidence.
    expect(rows[0]!.primary_locator).toBe("anchor-0");

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
  });

  it("rejects a raw transcript public-schema body and writes nothing", async () => {
    await seedOwnerFixtures();
    await withTool(ownerAuth, async (client) => {
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
    expect(await eventCount(ownerLaneId)).toBe(0);
  });
});
