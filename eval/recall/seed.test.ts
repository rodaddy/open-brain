import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  closeManifest,
  createRunSchema,
  recordFixtureResult,
  recordManifest,
  runIdentity,
  teardownRunSchema,
  type FixtureResult,
  type ManifestEntry,
} from "./seed.ts";

type SeedPool = Parameters<typeof createRunSchema>[0];

const RESERVED_RUN_NUMBERS = [1, 2, 3, 4] as const;
const VALID_RUN_NUMBERS = [5, 6, 999] as const;
const MANIFEST: ManifestEntry = {
  fixturesSha256: "sha",
  fixtureCount: 1,
  note: "test",
};
const RESULT: FixtureResult = {
  fixtureId: "fixture",
  firstRelevantRank: 1,
  returnedCount: 1,
  isolationBreach: false,
  detail: "test",
};

function poolThatRejectsMutation(queries: string[]): SeedPool {
  return {
    query: async (query: string) => {
      queries.push(query);
      throw new Error("unexpected SQL mutation reached fake database");
    },
  } as unknown as SeedPool;
}

function poolThatRecordsMutation(queries: string[]): SeedPool {
  return {
    query: async (query: string) => {
      queries.push(query);
      return {};
    },
  } as unknown as SeedPool;
}

void describe("recall run identity", () => {
  test("rejects every reserved run number", () => {
    for (const runNumber of RESERVED_RUN_NUMBERS) {
      assert.throws(
        () => runIdentity(runNumber),
        new RegExp(
          `^Error: reserved_run_number: ${String(runNumber)} belongs to an earlier run$`,
        ),
      );
    }
  });

  test("preserves malformed and out-of-range rejection", () => {
    for (const runNumber of [0, -1, 1.5, 1000, Number.NaN]) {
      assert.throws(() => runIdentity(runNumber), /invalid_run_number/);
    }
  });

  test("keeps legitimate run numbers usable", async () => {
    for (const runNumber of VALID_RUN_NUMBERS) {
      const identity = runIdentity(runNumber);
      assert.equal(identity.runId, String(runNumber).padStart(3, "0"));
      assert.equal(identity.schemaName, `dream_run_${identity.runId}`);
      const queries: string[] = [];
      await teardownRunSchema(poolThatRecordsMutation(queries), identity);
      assert.deepEqual(queries, [
        `DROP SCHEMA IF EXISTS dream_run_${identity.runId} CASCADE`,
      ]);
    }
  });

  test("rejects forged reserved identities before every SQL mutation boundary", async () => {
    const identity = { runId: "001", schemaName: "dream_run_001" };
    const queries: string[] = [];
    const pool = poolThatRejectsMutation(queries);
    const calls = [
      () => createRunSchema(pool, identity),
      () => recordManifest(pool, identity, MANIFEST),
      () => closeManifest(pool, identity),
      () => recordFixtureResult(pool, identity, RESULT),
      () => teardownRunSchema(pool, identity),
    ];

    for (const call of calls) {
      await assert.rejects(call, /reserved_run_id/);
      assert.equal(queries.length, 0);
    }
  });

  test("preserves malformed identity rejection at the teardown boundary", async () => {
    const queries: string[] = [];
    const pool = poolThatRejectsMutation(queries);
    await assert.rejects(
      teardownRunSchema(pool, {
        runId: "01",
        schemaName: "dream_run_01",
      }),
      /invalid_run_id/,
    );
    assert.equal(queries.length, 0);
    await assert.rejects(
      teardownRunSchema(pool, {
        runId: "005",
        schemaName: "not_dream_run_005",
      }),
      /invalid_run_id/,
    );
    assert.equal(queries.length, 0);
  });
});
