import { describe, expect, it } from "bun:test";
import { registerCitationRecall } from "../citation-recall.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";
import type { AuthInfo } from "../../types.ts";

const EVENT_ID = "2f9a936b-1dc5-4fd0-8efb-d9778a68fc4d";
const BEFORE_ID = "16e2dfdf-e343-4e03-88c2-93b43a12f9ec";
const AFTER_ID = "c8f64cd3-13c8-43f5-a228-4ba1dc5ae06e";

type MockCitationEvent = {
  id: string;
  lane_id: string;
  session_key: string;
  event_type: string;
  content: string;
  source: string | null;
  transcript_ref: string | null;
  transcript: string | null;
  occurred_at: string | null;
  created_at: string;
  created_by: string;
};

const TARGET: MockCitationEvent = {
  id: EVENT_ID,
  lane_id: "lane-288",
  session_key: "capture:288",
  event_type: "decision",
  content: "Store a durable transcript citation with each memory.",
  source: "rico",
  transcript_ref: "collab/open-brain/conversations/288",
  transcript: "Rico: the fact needs its original exchange.",
  occurred_at: "2026-07-13T11:59:00Z",
  created_at: "2026-07-13T12:00:00Z",
  created_by: "skippy",
};

function citationPool(target = TARGET) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("JOIN ob_session_lanes")) return { rows: [target] };
      if (sql.includes("ORDER BY") && sql.includes("DESC")) {
        return {
          rows: [
            {
              ...TARGET,
              id: BEFORE_ID,
              transcript: "Skippy: cite the original discussion.",
              created_at: "2026-07-13T11:58:00Z",
            },
          ],
        };
      }
      return {
        rows: [
          {
            ...TARGET,
            id: AFTER_ID,
            transcript: "Rico: include adjacent context too.",
            created_at: "2026-07-13T12:01:00Z",
          },
        ],
      };
    },
  };
  return { pool, calls };
}

describe("citation_recall", () => {
  it("returns a stored citation and bounded neighboring transcript exchanges", async () => {
    const { pool, calls } = citationPool();
    const auth: AuthInfo = { role: "readonly", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerCitationRecall,
      pool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "citation_recall",
        arguments: { event_id: EVENT_ID, max_transcript_chars: 100 },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toEqual({
        event_id: EVENT_ID,
        fact: TARGET.content,
        citation: {
          status: "stored",
          conversation_ref: TARGET.transcript_ref,
          speaker: "rico",
          date: "2026-07-13T11:59:00.000Z",
          transcript: TARGET.transcript,
          transcript_length: TARGET.transcript!.length,
          transcript_truncated: false,
        },
        context: {
          before: [
            expect.objectContaining({ event_id: BEFORE_ID, speaker: "rico" }),
          ],
          after: [
            expect.objectContaining({ event_id: AFTER_ID, speaker: "rico" }),
          ],
          expandable: false,
        },
      });
      expect(calls[0]?.params).toEqual(["skippy", EVENT_ID]);
      expect(calls[1]?.params).toEqual([
        TARGET.lane_id,
        TARGET.transcript_ref,
        EVENT_ID,
        3,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("uses source occurrence order and database-owned microsecond target values", async () => {
    const target = {
      ...TARGET,
      // The source event may arrive late; created_at must not decide its place.
      occurred_at: "2026-07-13T11:59:00.123456Z",
      created_at: "2026-07-13T12:10:00.000000Z",
    };
    const { pool, calls } = citationPool(target);
    const auth: AuthInfo = { role: "readonly", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerCitationRecall,
      pool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "citation_recall",
        arguments: { event_id: EVENT_ID },
      });

      expect(result.isError).toBeFalsy();
      const beforeSql = calls[1]?.sql ?? "";
      expect(beforeSql).toContain(
        "JOIN ob_session_events target ON target.id = $3::uuid",
      );
      expect(beforeSql).toContain(
        "candidate.occurred_at, candidate.created_at",
      );
      expect(beforeSql).not.toContain("\n  occurred_at");
      expect(beforeSql).toContain(
        "candidate.occurred_at, candidate.created_at) DESC, candidate.created_at DESC, candidate.id DESC",
      );
      expect(beforeSql).toContain(
        "COALESCE(candidate.occurred_at, candidate.created_at)",
      );
      expect(beforeSql).toContain("target.occurred_at, target.created_at");
      expect(beforeSql).not.toContain("$3::timestamptz");
      expect(calls[1]?.params).toEqual([
        target.lane_id,
        target.transcript_ref,
        EVENT_ID,
        3,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("marks context expandable only when truncation or unseen neighbors exist", async () => {
    const { pool } = citationPool();
    const auth: AuthInfo = { role: "readonly", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerCitationRecall,
      pool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "citation_recall",
        arguments: { event_id: EVENT_ID, context_limit: 0 },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({
        context: { before: [], after: [], expandable: true },
      });
    } finally {
      await cleanup();
    }
  });

  it("reports source_not_stored for a readable legacy memory", async () => {
    const { pool } = citationPool({
      ...TARGET,
      transcript_ref: null,
      transcript: null,
      occurred_at: null,
    });
    const auth: AuthInfo = { role: "readonly", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerCitationRecall,
      pool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "citation_recall",
        arguments: { event_id: EVENT_ID },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({
        fact: TARGET.content,
        citation: { status: "source_not_stored", conversation_ref: null },
        context: { before: [], after: [], expandable: false },
      });
    } finally {
      await cleanup();
    }
  });

  it("enforces the requested namespace before querying citation evidence", async () => {
    const { pool, calls } = citationPool();
    const auth: AuthInfo = { role: "agent", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerCitationRecall,
      pool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "citation_recall",
        arguments: { event_id: EVENT_ID, namespace: "other-agent" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
