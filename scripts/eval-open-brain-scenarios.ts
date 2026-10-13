#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadLiveConfig, makeRunId } from "../eval/open-brain/live/config.ts";
import { loadScenarioFixture } from "../eval/open-brain/live/scenario-fixtures.ts";
import { runScenarioGate } from "../eval/open-brain/live/scenario-gate.ts";
import { LiveScenarioTransport } from "../eval/open-brain/live/scenario-transport.ts";
import { createMcpCaller } from "../eval/open-brain/live/transport.ts";

const DEFAULT_FIXTURE_PATH = "eval/open-brain/fixtures/scenarios-v1.json";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function gitCommit(): Promise<string> {
  try {
    // execFileSync rather than a hand-rolled promise wrapper: this is a
    // bounded one-line capture, and its only failure mode is already handled
    // by the catch below. A non-zero exit THROWS here where it previously
    // returned a non-zero code, and the catch turns both into "unknown", so
    // the observable behavior is unchanged.
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function printReceipt(
  receipt: Awaited<ReturnType<typeof runScenarioGate>>["receipt"],
): void {
  const lines = [
    `Open Brain scenario gate: ${receipt.passed ? "PASS" : "FAIL"}`,
    `fixture=${receipt.fixture_id} commit=${receipt.commit}`,
    `namespace=${receipt.namespace}`,
    `teardown attempted=${receipt.teardown.attempted} archived=${receipt.teardown.archived} already_absent=${receipt.teardown.already_absent} failed=${receipt.teardown.failed}`,
  ];
  for (const scenario of receipt.scenarios) {
    lines.push(
      `- ${scenario.scenario_id}: kind=${scenario.kind} status=${scenario.passed ? "pass" : "fail"}`,
    );
    if (scenario.failures.length > 0) {
      lines.push(`  failures=${scenario.failures.join(",")}`);
    }
  }
  if (receipt.failures.length > 0) {
    lines.push(`failures: ${receipt.failures.join(";")}`);
  }
  console.log(lines.join("\n"));
}

async function main(): Promise<number> {
  const commit = await gitCommit();
  const runId = makeRunId({
    prefix: `scenario-${commit.slice(0, 12)}`,
    randomHex: randomUUID().replaceAll("-", "").slice(0, 12),
  });
  const config = loadLiveConfig(runId);
  const fixture = await loadScenarioFixture(
    argValue("fixture") ?? DEFAULT_FIXTURE_PATH,
  );
  const caller = await createMcpCaller({
    baseUrl: config.baseUrl,
    token: config.primaryToken,
    namespace: config.primaryNamespace,
    timeoutMs: config.timeoutMs,
  });
  const transport = new LiveScenarioTransport(caller, config);

  try {
    const outcome = await runScenarioGate({
      fixture,
      namespace: config.primaryNamespace,
      transport,
      commit,
      generatedAt: new Date().toISOString(),
      runId,
    });
    const reportPath = argValue("report");
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(outcome.receipt, null, 2)}\n`);
    }
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(outcome.receipt, null, 2));
    } else {
      printReceipt(outcome.receipt);
      if (reportPath) console.log(`\nWrote receipt: ${reportPath}`);
    }
    return outcome.passed ? 0 : 1;
  } finally {
    await transport.close().catch(() => {});
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Scenario gate error: ${message}`);
      process.exitCode = 2;
    });
}
