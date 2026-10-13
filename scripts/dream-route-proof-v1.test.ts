import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import type { JevConfig, JevFetch } from "../server/integrations/jev.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import { buildRouteClassifierSet } from "../server/domain/dream-route/questions.ts";
import {
  MAX_PAID_ATTEMPTS,
  createPaidAttemptGuard,
  executeRecords,
} from "./dream-route-proof-v1.ts";
import { testScratchBase } from "./test-support/scratch-dir.ts";

const scratch = `${testScratchBase()}/dream-route-proof-v1`;
let sequence = 0;

function ledgerPath(label: string): string {
  mkdirSync(scratch, { recursive: true });
  sequence += 1;
  return `${scratch}/v1-ledger-test-${process.pid}-${sequence}-${label}.jsonl`;
}

function okResponse(inputTokens = 12): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: inputTokens, output_tokens: 3 },
    }),
    { status: 200, headers: { "x-typesafe-request-id": "req-safe" } },
  );
}

async function okFetch(): Promise<Response> {
  return okResponse();
}

describe("V1 paid-attempt ledger", () => {
  test("blocks attempt N+1 before the underlying fetch", async () => {
    const path = ledgerPath("cap");
    let calls = 0;
    const guarded = createPaidAttemptGuard(
      path,
      async () => {
        calls += 1;
        return okResponse();
      },
      2,
    );
    await guarded.fetch("https://example.invalid", {});
    await guarded.fetch("https://example.invalid", {});
    await expect(guarded.fetch("https://example.invalid", {})).rejects.toThrow(/cap/i);
    expect(calls).toBe(2);
    guarded.close();
    unlinkSync(path);
  });

  test("reserves concurrent calls synchronously", async () => {
    const path = ledgerPath("concurrent");
    const guarded = createPaidAttemptGuard(path, okFetch, 2);
    await Promise.all([
      guarded.fetch("https://example.invalid", {}),
      guarded.fetch("https://example.invalid", {}),
    ]);
    expect(guarded.totals().attempts).toBe(2);
    guarded.close();
    unlinkSync(path);
  });

  test("transport failure consumes an attempt and latches stop", async () => {
    const path = ledgerPath("transport");
    let calls = 0;
    const guarded = createPaidAttemptGuard(path, async () => {
      calls += 1;
      throw new Error("network detail must not be logged");
    });
    await expect(guarded.fetch("https://example.invalid", {})).rejects.toThrow();
    await expect(guarded.fetch("https://example.invalid", {})).rejects.toThrow(
      /stopped/i,
    );
    expect(guarded.totals()).toMatchObject({ attempts: 1, stopped: true });
    expect(calls).toBe(1);
    guarded.close();
    unlinkSync(path);
  });

  test("malformed usage latches stop", async () => {
    const path = ledgerPath("usage");
    const guarded = createPaidAttemptGuard(path, async () => okResponse(64_001));
    await expect(guarded.fetch("https://example.invalid", {})).rejects.toThrow(
      /usage/i,
    );
    expect(guarded.totals()).toMatchObject({ attempts: 1, stopped: true });
    guarded.close();
    unlinkSync(path);
  });

  test("null response body latches stop", async () => {
    const path = ledgerPath("null-body");
    const guarded = createPaidAttemptGuard(
      path,
      async () => new Response("null", { status: 200 }),
    );
    await expect(guarded.fetch("https://example.invalid", {})).rejects.toThrow(
      /usage/i,
    );
    expect(guarded.totals()).toMatchObject({ attempts: 1, stopped: true });
    guarded.close();
    unlinkSync(path);
  });

  test("existing ledger refuses restart", () => {
    const path = ledgerPath("existing");
    writeFileSync(path, "already exists\n");
    expect(() => createPaidAttemptGuard(path, okFetch)).toThrow(/exists/i);
    unlinkSync(path);
  });

  test("ledger contains safe usage metadata without request text", async () => {
    const path = ledgerPath("safe");
    const guarded = createPaidAttemptGuard(path, async () => okResponse(17));
    await guarded.fetch("https://example.invalid", {
      body: JSON.stringify({ state: "SECRET REQUEST TEXT" }),
    });
    guarded.close();
    const ledger = readFileSync(path, "utf8");
    expect(ledger).toContain("req-safe");
    expect(ledger).toContain("jev-1.13.0");
    expect(ledger).toContain("17");
    expect(ledger).not.toContain("SECRET REQUEST TEXT");
    expect(MAX_PAID_ATTEMPTS).toBe(100);
    unlinkSync(path);
  });
});

describe("V1 executeRecords failure reporting", () => {
  test("surfaces the Jev failure reason, not just the record count", async () => {
    const classifierSet = buildRouteClassifierSet(loadMatrix(DEFAULT_MATRIX_PATH));
    const config: JevConfig = {
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://jev.invalid/v1",
      model: "jev-test",
      timeoutMs: 1_000,
      maxRequestBytes: 64_000,
      maxStateQuestionBytes: 32_000,
    };
    // A 200 whose answers map is short of the batch mappings is exactly what
    // validateJevBatchResponse rejects with failure_code
    // incomplete_classifier_answers.
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {},
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200 },
      )) as unknown as JevFetch;

    await expect(
      executeRecords({
        records: [{ key: "cand-1", content: "ITEM: a labelled record" }],
        expectedKeys: ["cand-1"],
        classifierSet,
        config,
        fetchFn,
        inFlight: 1,
      }),
    ).rejects.toThrow(
      /incomplete_classifier_answers|Jev returned incomplete classifier answers/,
    );
  });
});

// The readings checks need the copy database open_brain_local_play_route_proof,
// so they live in scripts/dream-route-proof-v1-readings.ts (issue 1586).

describe("V1 --set option", () => {
  test("an unknown question set is refused with exit 2", () => {
    const proof = fileURLToPath(new URL("./dream-route-proof-v1.ts", import.meta.url));
    const run = spawnSync(
      process.execPath,
      [proof, "--schema", "dream_run_012", "--backend", "fake", "--set", "v3"],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--set takes v1 or v2");
  });
});
