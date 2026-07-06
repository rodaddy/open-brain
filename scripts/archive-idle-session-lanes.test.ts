import { describe, expect, it } from "bun:test";
import {
  archiveIdleSessionLanes,
  parseArgs,
} from "./archive-idle-session-lanes.ts";

describe("archive-idle-session-lanes args", () => {
  it("defaults to dry-run Discord lanes older than 30 days", () => {
    const args = parseArgs([]);
    expect(args.execute).toBe(false);
    expect(args.source).toBe("discord");
    expect(args.olderThanDays).toBe(30);
    expect(args.limit).toBe(500);
  });

  it("requires a scope when disabling the default source", () => {
    expect(() => parseArgs(["--source", "*"])).toThrow(
      "Refusing broad idle-lane sweep",
    );
  });

  it("accepts an explicit namespace when source filtering is disabled", () => {
    const args = parseArgs(["--source", "*", "--namespace", "nagatha"]);
    expect(args.source).toBeUndefined();
    expect(args.namespace).toBe("nagatha");
  });
});

describe("archiveIdleSessionLanes", () => {
  it("dry-run lists idle candidates without mutating", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("UPDATE ob_session_lanes")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT l.id")) {
          return {
            rows: [
              {
                id: "00000000-0000-0000-0000-000000000001",
                namespace: "nagatha",
                session_key: "discord:guild:channel:nagatha",
                source: "discord",
                last_event_at: "2026-01-01T00:00:00.000Z",
                lane_created_at: "2026-01-01T00:00:00.000Z",
                lane_updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        throw new Error("unexpected query");
      },
    };

    const report = await archiveIdleSessionLanes(db as any, {
      execute: false,
      olderThanDays: 7,
      limit: 100,
      source: "discord",
    });

    expect(report.dry_run).toBe(true);
    expect(report.archived).toBe(0);
    expect(report.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const selectCall = calls[0];
    if (!selectCall) throw new Error("expected select call");
    expect(selectCall.sql).toContain("l.status = 'active'");
    expect(selectCall.sql).toContain("l.ended_at IS NULL");
    expect(selectCall.sql).toContain("l.source = $3");
    expect(selectCall.params).toEqual([7, 100, "discord"]);
  });

  it("execute rechecks idle predicates while archiving selected candidate ids", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("UPDATE ob_session_lanes")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT l.id")) {
          return {
            rows: [
              {
                id: "00000000-0000-0000-0000-000000000001",
                namespace: "nagatha",
                session_key: "discord:guild:channel:nagatha",
                source: "discord",
                last_event_at: "2026-01-01T00:00:00.000Z",
                lane_created_at: "2026-01-01T00:00:00.000Z",
                lane_updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        throw new Error("unexpected query");
      },
    };

    const report = await archiveIdleSessionLanes(db as any, {
      execute: true,
      olderThanDays: 14,
      limit: 10,
      source: "discord",
      sessionKeyPrefix: "discord:",
    });

    expect(report.dry_run).toBe(false);
    expect(report.archived).toBe(1);
    expect(calls).toHaveLength(2);
    const selectCall = calls[0];
    const updateCall = calls[1];
    if (!selectCall || !updateCall) throw new Error("expected select + update");
    expect(selectCall.sql).toContain("l.source = $3");
    expect(selectCall.sql).toContain("l.session_key LIKE $4");
    expect(selectCall.params).toEqual([14, 10, "discord", "discord:%"]);
    expect(updateCall.sql).toContain("status = 'archived'");
    expect(updateCall.sql).toContain("WITH eligible AS");
    expect(updateCall.sql).toContain("LEFT JOIN LATERAL");
    expect(updateCall.sql).toContain("COALESCE(last_event.last_event_at, l.created_at)");
    expect(updateCall.sql).toContain("l.source = $3");
    expect(updateCall.sql).toContain("l.session_key LIKE $4");
    expect(updateCall.sql).toContain("l.id = ANY($5::uuid[])");
    expect(updateCall.params).toEqual([
      14,
      10,
      "discord",
      "discord:%",
      ["00000000-0000-0000-0000-000000000001"],
    ]);
  });

  it("reports zero archived rows when the execute-time recheck no longer matches", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("UPDATE ob_session_lanes")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("SELECT l.id")) {
          return {
            rows: [
              {
                id: "00000000-0000-0000-0000-000000000001",
                namespace: "nagatha",
                session_key: "discord:guild:channel:nagatha",
                source: "discord",
                last_event_at: "2026-01-01T00:00:00.000Z",
                lane_created_at: "2026-01-01T00:00:00.000Z",
                lane_updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        throw new Error("unexpected query");
      },
    };

    const report = await archiveIdleSessionLanes(db as any, {
      execute: true,
      olderThanDays: 14,
      limit: 10,
      source: "discord",
    });

    expect(report.dry_run).toBe(false);
    expect(report.archived).toBe(0);
    expect(calls).toHaveLength(2);
  });
});
