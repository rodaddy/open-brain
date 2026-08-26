/**
 * ARRIVAL regressions for the four values the composition root injects.
 *
 * `scripts/done-means/750-l2b1-tool-readers-take-config.sh` clause 4 reads
 * `server/main.ts` and proves each value is WRITTEN at the call site. That is a
 * textual assertion, and it stays green for a value that is typed correctly at
 * the root and then dropped on the way down: a registrar that forgets to thread
 * the dependency through, a handler that reads a different field, a fallback
 * that shadows the injected one. Each of those is a silent revert to a default,
 * which is precisely the doubled state the rung exists to end.
 *
 * So these tests assert on the FAR END. Every case registers the real tools
 * through a real `McpServer` over an in-memory transport, injects one value,
 * and observes something the default could not produce:
 *
 *   - `ftsCorpusConfig` -> the SQL text `search_brain` actually sends.
 *   - `recoveryWalPath` -> a JSONL file that exists on disk afterwards.
 *   - `natsRuntimeBoundary` -> the transport `operator_doctor` reports.
 *   - `qmdPath` -> the entry point `search_all` actually spawns.
 *
 * No database is involved: the pool is a fake that records or answers queries,
 * the same shape `search-read-scope.test.ts` and `src/operator-doctor.test.ts`
 * already use.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import type { Role } from "../config.ts";
import { readNatsRuntimeBoundary } from "../../src/nats-runtime.ts";
import { resetOperatorDoctorCache } from "../../src/operator-doctor.ts";
import { registerMemoryTools } from "./index.ts";
import type { MemoryToolDependencies } from "./types.ts";

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  resetOperatorDoctorCache();
});

/**
 * Connect a client to a server carrying the real tools and the given
 * dependencies, authenticated as `role`.
 *
 * The auth info rides on the transport rather than a header, which is how
 * `search-read-scope.test.ts` reaches the handlers' `extra.authInfo`.
 */
async function clientFor(
  dependencies: Omit<MemoryToolDependencies, "pool" | "embedFn" | "logger"> & {
    pool: Pool;
  },
  role: Role,
  clientId: string,
): Promise<Client> {
  const server = new McpServer({ name: "arrival-test", version: "1.0.0" });
  registerMemoryTools(server, {
    embedFn: async () => Array(768).fill(0.01),
    logger: pino({ level: "silent" }),
    ...dependencies,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options_) =>
    send(message, {
      ...options_,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "arrival-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** A pool that records every query and returns no rows. */
function capturingPool(queries: CapturedQuery[]): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Pool;
}

/** @returns The single captured query, failing when the count is not one. */
function onlyQuery(queries: readonly CapturedQuery[]): CapturedQuery {
  expect(queries).toHaveLength(1);
  const query = queries[0];
  if (!query) throw new Error("handler ran no query");
  return query;
}

/** @returns The tool's text content parsed as JSON. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string")
    throw new Error("tool returned no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("ftsCorpusConfig arrives at search_brain's SQL", () => {
  test("an injected corpus default names itself in the emitted tsvector and tsquery", async () => {
    const queries: CapturedQuery[] = [];
    // Admin, because the non-English privilege boundary applies to the
    // EFFECTIVE config regardless of origin; an ordinary role would be denied
    // and never reach the SQL this case is about.
    const client = await clientFor(
      { pool: capturingPool(queries), ftsCorpusConfig: "german" },
      "admin",
      "operator",
    );

    // No fts_config argument: the ONLY way german can reach the SQL is the
    // injected deployment default.
    await client.callTool({
      name: "search_brain",
      arguments: { query: "nadel", search_mode: "keyword" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("to_tsvector('german'");
    expect(query.sql).toContain("plainto_tsquery('german'");
    // The query text stays a parameterized placeholder; only the allowlisted
    // configuration literal is ever interpolated into the SQL.
    expect(query.values[0]).toBe("nadel");
  });

  test("no injected corpus default leaves the indexed english column in force", async () => {
    const queries: CapturedQuery[] = [];
    const client = await clientFor(
      { pool: capturingPool(queries) },
      "admin",
      "operator",
    );

    await client.callTool({
      name: "search_brain",
      arguments: { query: "nadel", search_mode: "keyword" },
    });

    const query = onlyQuery(queries);
    // english is byte-identical to the pre-#341 path: it reads the stored,
    // GIN-indexed column rather than recomputing a tsvector per row.
    expect(query.sql).toContain(".search_vector");
    expect(query.sql).not.toContain("'german'");
  });
});

/**
 * Unique per case, in a directory that exists on every runner.
 *
 * A repo-relative scratch path is a developer-machine assumption: CI has no
 * such directory, so the file could never be written there. Same shape as
 * `src/rotating-file.test.ts`.
 */
let walCounter = 0;
function scratchWalPath(): string {
  walCounter += 1;
  return join(
    mkdtempSync(join(tmpdir(), "ob-arrival-")),
    `arrival-recovery-wal-${walCounter}.jsonl`,
  );
}

describe("recoveryWalPath arrives at the fallback recovery WAL store", () => {
  test("recovery_wal_append writes JSONL at the injected path with no injected store", async () => {
    const walPath = scratchWalPath();
    // No recoveryWalStore: the path is consulted ONLY on the fallback branch of
    // `recoveryWalStoreFor`, which is the branch a composition root that injects
    // a path but not a store takes.
    const client = await clientFor(
      { pool: capturingPool([]), recoveryWalPath: walPath },
      "admin",
      "operator",
    );

    const result = await client.callTool({
      name: "recovery_wal_append",
      arguments: {
        agent: "claude",
        platform: "claude-code",
        server_id: "arrival-host",
        channel_id: "open-brain",
        session_key: "arrival-lane",
        content: "arrival",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(existsSync(walPath)).toBe(true);
    expect(readFileSync(walPath, "utf8")).toContain('"content":"arrival"');
  });

  test("a second registration with a different path writes to that path, not the first", async () => {
    // The fallback is process-lifetime and SHARED, so in a run that registers
    // more than once the first path must not decide where every later caller
    // writes. This is the CI shape: the whole directory runs in one process,
    // and whichever file registered first would otherwise own the fallback.
    const firstPath = scratchWalPath();
    const secondPath = scratchWalPath();

    for (const [walPath, content] of [
      [firstPath, "first-arrival"],
      [secondPath, "second-arrival"],
    ] as const) {
      const client = await clientFor(
        { pool: capturingPool([]), recoveryWalPath: walPath },
        "admin",
        "operator",
      );
      const result = await client.callTool({
        name: "recovery_wal_append",
        arguments: {
          agent: "claude",
          platform: "claude-code",
          server_id: "arrival-host",
          channel_id: "open-brain",
          session_key: "arrival-lane",
          content,
        },
      });
      expect(result.isError).toBeFalsy();
    }

    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
    expect(readFileSync(firstPath, "utf8")).toContain(
      '"content":"first-arrival"',
    );
    expect(readFileSync(secondPath, "utf8")).toContain(
      '"content":"second-arrival"',
    );
  });
});

/**
 * A pool answering the probes `buildOperatorDoctorStatus` runs.
 *
 * `SELECT 1` proves connectivity and `_migrations` returns the applied set;
 * every other probe degrades on an empty result, which is fine here because
 * only the `transport` section is under test.
 */
function doctorPool(): Pool {
  return {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    query: async (query: string | { text: string }) => {
      const sql = typeof query === "string" ? query : query.text;
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as Pool;
}

describe("natsRuntimeBoundary arrives at operator_doctor", () => {
  test("the doctor reports the injected transport, not the one an empty environment produces", async () => {
    // The boundary a nats deployment with the bridge OFF produces: the doctor
    // must report the transport that was REQUESTED alongside the availability
    // actually in force, rather than re-deriving `http` from the ambient
    // environment the test process happens to carry.
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
      OPENBRAIN_NATS_FALLBACK_HTTP: "true",
      OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT: "arrival.test",
    });
    // The doctor memoizes one probe cycle across callers, so a status built by
    // an earlier test would otherwise be served here.
    resetOperatorDoctorCache();
    const client = await clientFor(
      { pool: doctorPool(), natsRuntimeBoundary: boundary },
      "admin",
      "operator",
    );

    const result = await client.callTool({
      name: "operator_doctor",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const transport = payloadOf(result).transport as Record<string, unknown>;
    expect(transport.mode).toBe("nats");
    expect(transport.availability).toBe("not_runtime_available");
  });
});

/**
 * A stub standing in for the qmd entry point, printing one hit as JSON.
 *
 * `searchQmdInternal` runs `bun <qmdPath> search …`, so a script IS the qmd
 * binary as far as the handler is concerned. Writing it under the same
 * `mkdtempSync` root the WAL cases use keeps this runnable on a fresh runner,
 * which a repo-relative scratch path would not be.
 *
 * @returns The absolute path to the stub.
 */
function stubQmdEntryPoint(marker: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "ob-arrival-qmd-")),
    "qmd-stub.ts",
  );
  writeFileSync(
    path,
    `console.log(JSON.stringify([{ path: ${JSON.stringify(marker)}, content: "stub hit", score: 0.9 }]));\n`,
  );
  return path;
}

describe("qmdPath arrives at the search_all qmd arm", () => {
  test("an injected entry point is the one search_all runs", async () => {
    const marker = "arrival/injected-qmd-path.md";
    const client = await clientFor(
      { pool: capturingPool([]), qmdPath: stubQmdEntryPoint(marker) },
      "admin",
      "operator",
    );

    // `sources: "qmd"` isolates the arm: no brain query runs, so every hit in
    // the payload came from the injected entry point and nowhere else.
    const result = await client.callTool({
      name: "search_all",
      arguments: { query: "needle", sources: "qmd" },
    });

    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.qmd_hits).toBe(1);
    const results = payload.results as Array<Record<string, unknown>>;
    // The marker is unforgeable: it exists only inside the stub this case
    // wrote, so observing it proves the injected value reached the spawn.
    expect(results[0]?.path).toBe(marker);
  });

  test("no injected entry point leaves the qmd arm off rather than falling back to the environment", async () => {
    const client = await clientFor(
      { pool: capturingPool([]) },
      "admin",
      "operator",
    );

    const result = await client.callTool({
      name: "search_all",
      arguments: { query: "needle", sources: "qmd" },
    });

    expect(result.isError).toBeFalsy();
    // Zero even on a machine whose QMD_PATH is set and usable: the handler has
    // no ambient read left, so an absent dependency is an absent arm (#825).
    expect(payloadOf(result).qmd_hits).toBe(0);
  });
});
