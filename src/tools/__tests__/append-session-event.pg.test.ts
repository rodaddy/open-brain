/**
 * Live-Postgres coverage for append_session_event's create_if_missing path.
 *
 * Mock pools cannot execute ON CONFLICT, real UNIQUE constraints, or genuine
 * concurrent inserts, so the create_if_missing race and the scope-isolation
 * guarantee the contract depends on (consumed by rtech-hermes#276) are proven
 * here against a real pool.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878): `requireTestDatabaseUrl()` throws
 * `test_database_required` at module scope, so the run goes down loudly rather
 * than reporting `0 pass, N skip` and exiting 0. It must point at an isolated
 * test database, never the dogfood database.
 *
 *   bun run test:isolated src/tools/__tests__/append-session-event.pg.test.ts
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppendSessionEvent } from "../append-session-event.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed } from "./test-helpers.ts";
import { EMBEDDING_MODEL, contentHash } from "../../embedding.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const ns = "test-append-live";
const otherNs = "test-append-live-other";

async function callAppend(
  args: Record<string, unknown>,
  auth: AuthInfo = { role: "agent", clientId: ns },
  embedFn = createMockEmbed(null),
) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: pool as unknown as ToolDeps["pool"],
    embedFn,
  };
  registerAppendSessionEvent(server, deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const original = ct.send.bind(ct);
  ct.send = (m: unknown, o?: Record<string, unknown>) =>
    original(m as never, { ...o, authInfo: auth as never });
  const client = new Client({ name: "tc", version: "1.0.0" });
  await server.connect(st);
  await client.connect(ct);
  const res = await client.callTool({
    name: "append_session_event",
    arguments: args,
  });
  await client.close();
  await server.close();
  return res;
}

async function cleanupNs() {
  // Events cascade from lanes; delete by namespace-scoped lane ids.
  await pool.query(
    `DELETE FROM ob_session_events WHERE lane_id IN
       (SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[]))`,
    [[ns, otherNs]],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])", [
    [ns, otherNs],
  ]);
}

/**
 * The MCP result's `content` is a union; every assertion here reads the first
 * text part and parses it. Narrowing once keeps the test bodies free of casts.
 */
function parseToolText(content: unknown): Record<string, unknown> {
  const parts = content as Array<{ text: string }>;
  const first = parts[0];
  if (first === undefined) {
    throw new Error("tool result carried no content parts");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

afterAll(async () => {
  await pool.end();
});

async function liveCase1() {
  await cleanupNs();
  try {
    const first = await callAppend({
      session_key: "live-first",
      create_if_missing: true,
      agent: "nagatha",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-1",
      event_type: "fact",
      content: "first scoped event",
    });
    expect(first.isError).toBeFalsy();
    const p1 = parseToolText(first.content);
    expect(p1.lane_created).toBe(true);

    const second = await callAppend({
      session_key: "live-first",
      create_if_missing: true,
      agent: "nagatha",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-1",
      event_type: "fact",
      content: "second scoped event",
    });
    expect(second.isError).toBeFalsy();
    const p2 = parseToolText(second.content);
    expect(p2.lane_created).toBe(false);
    expect(p2.lane_id).toBe(p1.lane_id);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
      [ns, "live-first"],
    );
    expect(rows[0].n).toBe(1);
  } finally {
    await cleanupNs();
  }
}

async function liveCase2() {
  await cleanupNs();
  try {
    const mk = (content: string) =>
      callAppend({
        session_key: "live-race",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content,
      });
    const [a, b] = await Promise.all([mk("racer A"), mk("racer B")]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    const pa = parseToolText(a.content);
    const pb = parseToolText(b.content);
    // Exactly one call reports it created the lane; both resolve to the same lane.
    expect(Number(pa.lane_created) + Number(pb.lane_created)).toBe(1);
    expect(pa.lane_id).toBe(pb.lane_id);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
      [ns, "live-race"],
    );
    expect(rows[0].n).toBe(1);
  } finally {
    await cleanupNs();
  }
}

async function liveCase3() {
  await cleanupNs();
  try {
    const res = await callAppend(
      {
        session_key: "live-embedded-lane",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        project: "rtech-hermes",
        topic: "Nagatha Discord scoped memory",
        event_type: "fact",
        content: "first embedded scoped event",
      },
      { role: "agent", clientId: ns },
      createMockEmbed(Array(768).fill(0.1)),
    );
    expect(res.isError).toBeFalsy();
    const parsed = parseToolText(res.content);
    expect(parsed.lane_created).toBe(true);

    const { rows } = await pool.query(
      `SELECT content_hash, embedded_at, embedding_model, embedding IS NOT NULL AS has_embedding
         FROM ob_session_lanes
        WHERE namespace=$1 AND session_key=$2`,
      [ns, "live-embedded-lane"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe(
      contentHash("live-embedded-lane|Nagatha Discord scoped memory"),
    );
    expect(rows[0].embedded_at).not.toBeNull();
    expect(rows[0].embedding_model).toBe(EMBEDDING_MODEL);
    expect(rows[0].has_embedding).toBe(true);
  } finally {
    await cleanupNs();
  }
}

async function liveCase4() {
  await cleanupNs();
  try {
    const args = {
      session_key: "live-shared-topic",
      namespace: ns,
      create_if_missing: true,
      agent: "nagatha",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-1",
      project: "rtech-hermes",
      topic: "Shared operational context",
      event_type: "fact",
      content: "namespace A first event",
    };
    const first = await callAppend(
      args,
      { role: "admin", clientId: ns },
      createMockEmbed(Array(768).fill(0.1)),
    );
    expect(first.isError).toBeFalsy();

    const second = await callAppend(
      {
        ...args,
        namespace: otherNs,
        content: "namespace B first event",
      },
      { role: "admin", clientId: ns },
      createMockEmbed(Array(768).fill(0.2)),
    );
    expect(second.isError).toBeFalsy();

    const expectedHash = contentHash("live-shared-topic|Shared operational context");
    const { rows } = await pool.query(
      `SELECT namespace, content_hash
         FROM ob_session_lanes
        WHERE namespace = ANY($1::text[]) AND session_key=$2
        ORDER BY namespace`,
      [[ns, otherNs], "live-shared-topic"],
    );
    expect(rows).toEqual([
      { namespace: ns, content_hash: expectedHash },
      { namespace: otherNs, content_hash: expectedHash },
    ]);
  } finally {
    await cleanupNs();
  }
}

async function liveCase5() {
  await cleanupNs();
  try {
    const base = {
      create_if_missing: true,
      agent: "shared-session-finalizer",
      platform: "local-runtime",
      project: "rtech-audit",
      topic: "Shared development session memory",
      event_type: "handoff",
    };
    const first = await callAppend({
      ...base,
      session_key: "dev:rTech-audit",
      content: "mixed-case project session",
    });
    expect(first.isError).toBeFalsy();

    const second = await callAppend({
      ...base,
      session_key: "dev:rtech-audit",
      content: "lower-case project session",
    });
    expect(second.isError).toBeFalsy();

    const { rows } = await pool.query(
      `SELECT session_key, content_hash
         FROM ob_session_lanes
        WHERE namespace=$1 AND session_key = ANY($2::text[])
        ORDER BY session_key`,
      [ns, ["dev:rTech-audit", "dev:rtech-audit"]],
    );
    expect(rows).toHaveLength(2);
    const expectedHash = contentHash(
      "dev:rTech-audit|Shared development session memory",
    );
    expect(expectedHash).toBe(
      contentHash("dev:rtech-audit|Shared development session memory"),
    );
    expect(rows.map((row) => row.session_key).sort()).toEqual(
      ["dev:rTech-audit", "dev:rtech-audit"].sort(),
    );
    expect(rows.map((row) => row.content_hash)).toEqual([expectedHash, expectedHash]);
  } finally {
    await cleanupNs();
  }
}

async function liveCase6() {
  await cleanupNs();
  try {
    await pool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, agent, source, channel_id, thread_id, metadata, created_by)
       VALUES ($1, $2, 'active', $3, NULL, NULL, NULL, '{}'::jsonb, $4)`,
      ["dev:open-brain", ns, "shared", ns],
    );

    const attached = await callAppend({
      session_key: "dev:open-brain",
      namespace: ns,
      agent: "shared",
      platform: "development",
      server_id: "local",
      channel_id: "open-brain",
      event_type: "fact",
      content: "Existing lane receives its first exact local scope.",
    });
    expect(attached.isError).toBeFalsy();

    const { rows } = await pool.query(
      `SELECT agent, source, channel_id, thread_id, metadata->>'server_id' AS server_id
         FROM ob_session_lanes
        WHERE namespace = $1 AND session_key = $2`,
      [ns, "dev:open-brain"],
    );
    expect(rows).toEqual([
      {
        agent: "shared",
        source: "development",
        channel_id: "open-brain",
        thread_id: null,
        server_id: "local",
      },
    ]);

    const conflict = await callAppend({
      session_key: "dev:open-brain",
      namespace: ns,
      agent: "shared",
      platform: "development",
      server_id: "local",
      channel_id: "other-channel",
      event_type: "fact",
      content: "A conflicting channel must not reuse the attached lane.",
    });
    expect(conflict.isError).toBe(true);
    expect(parseToolText(conflict.content)).toMatchObject({
      error: "scope_validation",
      conflicts: ["channel_id"],
    });
  } finally {
    await cleanupNs();
  }
}

async function liveCase7() {
  await cleanupNs();
  try {
    await callAppend({
      session_key: "live-conflict",
      create_if_missing: true,
      agent: "nagatha",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-1",
      event_type: "fact",
      content: "owns channel-1",
    });
    const conflict = await callAppend({
      session_key: "live-conflict",
      create_if_missing: true,
      agent: "nagatha",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-2",
      event_type: "fact",
      content: "must not spill into channel-2",
    });
    expect(conflict.isError).toBe(true);
    const parsed = parseToolText(conflict.content);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.conflicts).toEqual(["channel_id"]);
  } finally {
    await cleanupNs();
  }
}

async function liveCase8() {
  await cleanupNs();
  try {
    const res = await callAppend(
      {
        session_key: "live-cross-ns",
        namespace: "some-other-namespace",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "should never be written",
      },
      { role: "agent", clientId: ns },
    );
    expect(res.isError).toBe(true);
    const parsed = parseToolText(res.content);
    expect(parsed.error).toBe("auth_denied");
    // No lane may have been created in the foreign namespace.
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1",
      ["some-other-namespace"],
    );
    expect(rows[0].n).toBe(0);
  } finally {
    await cleanupNs();
  }
}

describe("append_session_event create_if_missing (live Postgres)", () => {
  it(
    "creates the lane on first write and reuses it idempotently on the second",
    liveCase1,
  );
  it("creates exactly one lane under a genuine concurrent first-write race", liveCase2);
  it("embeds first-write lane topic/project metadata on the real lane row", liveCase3);
  it("allows identical first-write lane hashes in separate namespaces", liveCase4);
  it("allows case-distinct session keys with the same normalized lane hash", liveCase5);
  it(
    "persists previously unasserted exact scope on an existing lane and then fails closed",
    liveCase6,
  );
  it(
    "denies a scoped append that conflicts with the real stored lane scope",
    liveCase7,
  );
  it("denies cross-namespace create_if_missing for a non-global token", liveCase8);
});
