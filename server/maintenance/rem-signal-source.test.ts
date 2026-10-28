import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRemSignalSource } from "./rem-signal-source.ts";

describe("REM production signal source", () => {
  it("combines the rolling MCP rate, OS bytes, and global durable facts", async () => {
    let nowMs = 1_000;
    const completedAt = new Date("2026-09-14T12:00:00.000Z");
    const query = vi.fn().mockResolvedValue({
      rows: [{ light_backlog: "7", last_rem_completed_at: completedAt }],
    });
    const source = createRemSignalSource({ query } as unknown as pg.Pool, {
      now: () => nowMs,
      freeMemory: () => 4_096,
    });

    source.observeMcpRequest();
    nowMs = 2_000;
    source.observeMcpRequest();

    await expect(source.read()).resolves.toEqual({
      nowMs: 2_000,
      schedulerStartedAtMs: 1_000,
      lastRemCompletedAtMs: completedAt.getTime(),
      requestsPerMinute: 2,
      headroomBytes: 4_096,
      lightBacklog: 7,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toHaveLength(1);

    nowMs += 60_001;
    await expect(source.read()).resolves.toMatchObject({ requestsPerMinute: 0 });
  });
});
