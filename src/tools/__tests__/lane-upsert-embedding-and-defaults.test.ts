/**
 * Unit coverage for lane_upsert embedding behavior and field defaulting.
 *
 * Split out of lane-upsert.test.ts by subject. Mock pool only, no database.
 */
import { describe, it, expect } from "bun:test";
import { createMockEmbed } from "./test-helpers.ts";
import {
  createThrowingEmbed,
  firstText,
  setupToolClient,
  type ObAuthInfo,
} from "./lane-upsert-test-helpers.ts";

async function case1() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-noembed",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "bare-lane" },
    });

    const parsed = JSON.parse(firstText(result));
    expect(parsed.embedded).toBe(false);
  } finally {
    await cleanup();
  }
}

async function case2() {
  let embedCalled = false;
  const embedFn = async (text: string) => {
    embedCalled = true;
    expect(text).toContain("my topic");
    return Array(768).fill(0.1);
  };
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-topic",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth, embedFn);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "topic-lane", topic: "my topic" },
    });

    expect(embedCalled).toBe(true);
    const parsed = JSON.parse(firstText(result));
    expect(parsed.embedded).toBe(true);
  } finally {
    await cleanup();
  }
}

async function case3() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-nullembed",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(
    mockPool,
    auth,
    createMockEmbed(null),
  );

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: {
        session_key: "null-embed-lane",
        current_context_md: "some context",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.embedded).toBe(false);
  } finally {
    await cleanup();
  }
}

async function case4() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-embedfail",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(
    mockPool,
    auth,
    createThrowingEmbed(new Error("embedding provider timeout")),
  );

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: {
        session_key: "embed-crash-lane",
        current_context_md: "context that triggers embed failure",
      },
    });

    // Should succeed with embedded=false, NOT crash
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.embedded).toBe(false);
  } finally {
    await cleanup();
  }
}

async function case5() {
  const mockPool = {
    query: async () => {
      throw new Error("connection refused");
    },
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "db-fail-lane" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("connection refused");
    expect(firstText(result)).toContain("Database error");
  } finally {
    await cleanup();
  }
}

async function case6() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-nometa",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "no-meta-lane" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.id).toBe("uuid-nometa");
  } finally {
    await cleanup();
  }
}

async function case7() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-clear",
          is_new: false,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "clear-test", agent: "" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.id).toBe("uuid-clear");
    expect(parsed.status).toBe("active");
  } finally {
    await cleanup();
  }
}

async function case8() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-preserve",
          is_new: false,
          status: "wrapped",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "status-preserve", topic: "updated topic" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    // DB returned "wrapped" proving status was preserved (not overwritten to "active")
    expect(parsed.status).toBe("wrapped");
  } finally {
    await cleanup();
  }
}

async function case9() {
  // Regression for lane_upsert_db_error: omitting status previously bound an
  // explicit NULL into the NOT NULL status column, so creating a NEW lane
  // failed the constraint. The INSERT value must default to 'active' while
  // the ON CONFLICT path keeps a nullable status to preserve existing rows.
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const mockPool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            id: "uuid-new",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      };
    },
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "bilby" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "new-lane-no-status" },
    });

    expect(result.isError).toBeFalsy();
    // $3 (ON CONFLICT / status-preserve source) stays NULL on omission.
    expect(capturedParams[2]).toBeNull();
    // $24 (INSERT VALUES status) defaults to 'active' so the NOT NULL
    // column is satisfied for brand-new lanes.
    expect(capturedParams[23]).toBe("active");
    // ended_at must key off $3 (nullable), NOT EXCLUDED.status, otherwise a
    // status-omitted update would reactivate a wrapped/archived lane. The
    // ended_at clause is the segment after the embedding_model update line.
    const endedAtClause = capturedSql.slice(capturedSql.indexOf("ended_at ="));
    // $3 is cast to ::text so Postgres can infer the param type (it is no
    // longer bound into a typed column position).
    expect(endedAtClause).toContain("$3::text = 'active'");
    expect(endedAtClause).not.toContain("EXCLUDED.status");
  } finally {
    await cleanup();
  }
}

async function case10() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-min",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "minimal" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.session_key).toBe("minimal");
    expect(parsed.namespace).toBe("skippy");
    expect(parsed.is_new).toBe(true);
    expect(parsed.embedded).toBe(false);
  } finally {
    await cleanup();
  }
}

describe("lane_upsert embedding and defaults", () => {
  // ── EMBEDDING PATHS ──

  it("skips embedding when no context or topic provided", case1);

  it("embeds from topic when current_context_md is absent", case2);

  it("returns null embedding when embedFn returns null (graceful degradation)", case3);

  it("continues without embedding when embedFn throws (error resilience)", case4);

  // ── DATABASE ERROR PATH ──

  it("returns isError=true with message when DB query throws", case5);

  // ── METADATA HANDLING ──

  it("succeeds with default metadata when not provided", case6);

  // ── EXPLICIT FIELD CLEARING ──

  it("succeeds when agent is empty string (explicit clear)", case7);

  // ── STATUS PRESERVATION ──

  it("preserves existing status when status param is omitted", case8);

  it(
    "inserts status 'active' for a new lane when status is omitted (NOT NULL regression)",
    case9,
  );

  // ── MINIMAL CALL ──

  it("succeeds with only the required session_key", case10);
});
