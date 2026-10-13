import { describe, expect, test } from "vitest";
import type pg from "pg";
import {
  enqueueGraphDerivationJobs,
  type GraphDerivationEnqueuePort,
} from "./graph-derivation-handler.ts";
import type { EnqueueMaintenanceJob, MaintenanceJob } from "./maintenance-job.ts";

const CONTENT_HASH = "a".repeat(64);

function sourceRow(id: string): Record<string, unknown> {
  return {
    id,
    namespace: "shared-kb",
    source_kind: "doc",
    external_id: `ext-${id}`,
    content_hash: CONTENT_HASH,
    revision: 1,
    derived_content_hash: null,
  };
}

function fakePool(rows: Record<string, unknown>[]): Pick<pg.Pool, "query"> {
  return {
    query: (async () => ({
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    })) as unknown as pg.Pool["query"],
  };
}

function job(
  input: EnqueueMaintenanceJob,
  outcome: "created" | "deduped",
): MaintenanceJob {
  const now = new Date();
  return {
    id: `job-${input.idempotencyKey}`,
    kind: input.kind,
    version: input.version,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    state: "queued",
    leaseToken: null,
    leaseUntil: null,
    runAfter: now,
    attempts: 0,
    maxAttempts: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    lastErrorCategory: null,
    terminalAt: null,
    deadLetteredAt: null,
    namespace: "shared-kb",
    provenance: null,
    createdAt: now,
    updatedAt: now,
    enqueueOutcome: outcome,
  };
}

describe("graph derivation enqueue counting", () => {
  test("a deduped insert is excluded from the returned enqueued jobs", async () => {
    const outcomes: ("created" | "deduped")[] = ["created", "deduped"];
    let call = 0;
    const queue: GraphDerivationEnqueuePort = {
      enqueue: async (input) => job(input, outcomes[call++] ?? "created"),
    };

    const result = await enqueueGraphDerivationJobs(
      fakePool([
        sourceRow("11111111-1111-4111-8111-111111111111"),
        sourceRow("22222222-2222-4222-8222-222222222222"),
      ]),
      queue,
      ["shared-kb"],
      { limit: 10 },
    );

    expect(call).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs.every((entry) => entry.enqueueOutcome === "created")).toBe(true);
  });

  test("all-created sources are all counted", async () => {
    const queue: GraphDerivationEnqueuePort = {
      enqueue: async (input) => job(input, "created"),
    };

    const result = await enqueueGraphDerivationJobs(
      fakePool([sourceRow("33333333-3333-4333-8333-333333333333")]),
      queue,
      ["shared-kb"],
      { limit: 10 },
    );

    expect(result.jobs).toHaveLength(1);
  });
});
