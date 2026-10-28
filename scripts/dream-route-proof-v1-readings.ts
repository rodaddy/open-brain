// Opt-in readings checks for the dream-route proof V1 (issue 1586).
//
// What it proves: the fake-backend proof run against the real labelled matrix
// (schema dream_run_012) writes every case's answers to its readings file, for
// the V1 question set and for --set v2 (singleton arm only).
//
// It is opt-in and read-only against the operator-only copy database
// open_brain_local_play_route_proof, which an isolated test database cannot
// reproduce, so it lives outside the Vitest suite. It refuses (exit 2) when
// DB_NAME names any other database. Run it with the DB_* vars pointing at the
// copy:
//
//   DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=dana \
//   DB_NAME=open_brain_local_play_route_proof \
//   /opt/homebrew/opt/node@24/bin/node scripts/dream-route-proof-v1-readings.ts
//
// scripts/done-means/1469-dream-route-proof-v1.sh runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { testScratchBase } from "./test-support/scratch-dir.ts";

const COPY_DB = "open_brain_local_play_route_proof";

function checkV1Readings(): void {
  const scratchBase = `${testScratchBase()}/dream-route-proof-v1/readings`;
  mkdirSync(scratchBase, { recursive: true });
  const proof = fileURLToPath(new URL("./dream-route-proof-v1.ts", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [proof, "--schema", "dream_run_012", "--backend", "fake"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENBRAIN_TEST_SCRATCH_DIR: scratchBase,
      },
    },
  );
  if (run.status !== 0) {
    throw new Error(`fake proof exited ${String(run.status)}: ${run.stderr}`);
  }
  const path = `${scratchBase}/dream-route-proof-v1/dream_run_012-fake.readings.json`;
  const readings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  assert.equal(readings.length, 35);
  assert.deepEqual(Object.keys(readings[0] as object).sort(), [
    "batch_answers",
    "batch_dest",
    "candidate_id",
    "dest_match",
    "differing_keys",
    "golden_dest",
    "golden_match",
    "golden_yn",
    "singleton_answers",
    "singleton_dest",
    "stable",
  ]);
  const first = readings[0] as {
    singleton_answers: Record<string, unknown>;
    batch_answers: Record<string, unknown>;
    golden_yn: Record<string, boolean>;
  };
  assert.deepEqual(Object.keys(first.singleton_answers).sort(), [
    "dest",
    "drove_decision",
    "restates",
    "yn_correction",
    "yn_decision",
    "yn_fact",
    "yn_rule",
    "yn_steering",
  ]);
  assert.equal(Object.keys(first.batch_answers).length, 8);
  assert.ok("probabilities" in (first.singleton_answers.dest as object));
  assert.equal(Object.keys(first.golden_yn).length, 5);
  assert.ok(run.stdout.includes("READINGS 35 cases"));
}

function checkV2Readings(): void {
  const scratchBase = `${testScratchBase()}/dream-route-proof-v1/readings-v2`;
  mkdirSync(scratchBase, { recursive: true });
  const proof = fileURLToPath(new URL("./dream-route-proof-v1.ts", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [proof, "--schema", "dream_run_012", "--backend", "fake", "--set", "v2"],
    {
      encoding: "utf8",
      env: { ...process.env, OPENBRAIN_TEST_SCRATCH_DIR: scratchBase },
    },
  );
  if (run.status !== 0) {
    throw new Error(`fake v2 proof exited ${String(run.status)}: ${run.stderr}`);
  }
  const path = `${scratchBase}/dream-route-proof-v1/dream_run_012-v2-fake.readings.json`;
  const readings = JSON.parse(readFileSync(path, "utf8")) as {
    singleton_answers: Record<string, { probabilities?: Record<string, number> }>;
  }[];
  assert.equal(readings.length, 35);
  const first = readings[0] as (typeof readings)[number];
  assert.deepEqual(Object.keys(first.singleton_answers).sort(), [
    "anything_lasting",
    "destination",
    "drove_decision",
  ]);
  assert.ok("none" in (first.singleton_answers.destination?.probabilities ?? {}));
  assert.ok(run.stdout.includes("ADJUSTED: --set v2"));
  assert.ok(run.stdout.includes("false_commit="));
}

function runCheck(label: string, check: () => void): boolean {
  try {
    check();
    console.log(`PASS ${label}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${label}: ${message}`);
    return false;
  }
}

function main(): void {
  const dbName = process.env.DB_NAME;
  if (dbName !== COPY_DB) {
    process.stderr.write(
      `REFUSED dream-route-proof-v1-readings talks only to the copy database ${COPY_DB}; DB_NAME was ${String(dbName)}\n`,
    );
    process.exit(2);
  }
  const v1 = runCheck("v1 readings", checkV1Readings);
  const v2 = runCheck("v2 readings", checkV2Readings);
  process.exit(v1 && v2 ? 0 : 1);
}

main();
