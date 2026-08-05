#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { loadLiveConfig, makeRunId } from "../eval/open-brain/live/config.ts";
import { loadScenarioFixture } from "../eval/open-brain/live/scenario-fixtures.ts";
import { runScenarioGate } from "../eval/open-brain/live/scenario-gate.ts";
import { LiveScenarioTransport } from "../eval/open-brain/live/scenario-transport.ts";
import { createMcpCaller } from "../eval/open-brain/live/transport.ts";

const DEFAULT_FIXTURE_PATH = "eval/open-brain/fixtures/scenarios-v1.json";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = Bun.argv.indexOf(`--${name}`);
  const next = index >= 0 ? Bun.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function gitCommit(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? output.trim() : "unknown";
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
      await Bun.write(reportPath, `${JSON.stringify(outcome.receipt, null, 2)}\n`);
    }
    if (Bun.argv.includes("--json")) {
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
