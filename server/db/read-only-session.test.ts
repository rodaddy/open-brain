/**
 * `openReadOnlySession` drives a fake pool, so the deadline, the opening
 * statements, and the unsafe-release path are provable without a database
 * (issue 1209).
 */
import { describe, expect, test } from "vitest";
import type { Pool } from "pg";
import { openReadOnlySession } from "./read-only-session.ts";

type Recorded = { text: unknown; values?: unknown[] };

function fakeClient(options: {
  statements: Recorded[];
  releases: unknown[];
  failOn?: string;
}) {
  return {
    query: async (config: { text: string; values?: unknown[] }) => {
      options.statements.push({ text: config.text, values: config.values });
      if (options.failOn !== undefined && config.text === options.failOn) {
        throw new Error("statement blew up");
      }
      return { rows: [] };
    },
    release: (error?: unknown) => options.releases.push(error),
  };
}

function fakePool(connect: () => Promise<unknown>): Pool {
  return { connect } as unknown as Pool;
}

/** The message a promise rejected with, or a marker when it resolved instead. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "did not reject";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Resolve `value` after `delayMs`, so a late-arriving client can be observed. */
function after<T>(delayMs: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
}

describe("openReadOnlySession", () => {
  test("opens READ ONLY first, then the statement timeout", async () => {
    const statements: Recorded[] = [];
    const releases: unknown[] = [];
    const client = fakeClient({ statements, releases });

    const session = await openReadOnlySession({
      pool: fakePool(async () => client),
      maxLatencyMs: 5_000,
    });

    expect(statements[0]?.text).toBe("BEGIN READ ONLY");
    expect(statements[1]?.text).toBe(
      "SELECT set_config('statement_timeout', $1, true)",
    );
    await session.commit();
    expect(statements[2]?.text).toBe("COMMIT");
    session.release();
    expect(releases).toEqual([undefined]);
  });

  test("a failing statement marks the client unsafe and skips ROLLBACK", async () => {
    const statements: Recorded[] = [];
    const releases: unknown[] = [];
    const client = fakeClient({ statements, releases, failOn: "SELECT 1" });

    const session = await openReadOnlySession({
      pool: fakePool(async () => client),
      maxLatencyMs: 5_000,
    });

    expect(await rejectionMessage(session.query("SELECT 1"))).toBe("statement blew up");
    await session.rollback();
    expect(statements.map((s) => s.text)).not.toContain("ROLLBACK");

    session.release();
    expect(releases).toHaveLength(1);
    expect((releases[0] as Error).message).toBe("statement blew up");
  });

  test("a client arriving after the deadline is released, not leaked", async () => {
    const statements: Recorded[] = [];
    const releases: unknown[] = [];
    const client = fakeClient({ statements, releases });

    const open = openReadOnlySession({
      pool: fakePool(async () => await after(60, client)),
      maxLatencyMs: 10,
    });

    expect(await rejectionMessage(open)).toBe(
      "durable lane context latency budget exhausted",
    );
    await after(120, undefined);
    expect(releases).toEqual([undefined]);
    expect(statements).toHaveLength(0);
  });
});
