#!/usr/bin/env bun
// Single-command live recall gate (EVAL-3, issue #324).
//
//   bun run eval:live
//
// Requires opt-in: OPEN_BRAIN_LIVE_EVAL=1 plus base URL + token env vars (see
// eval/open-brain/README.md). One invocation performs: seed a unique throwaway
// namespace, run recall queries through the real Open Brain MCP client, score
// deterministic ranking metrics, apply versioned thresholds, tear down exactly
// this run's records, and exit nonzero below thresholds.
//
// Output is content-free: only ids, namespaces, labels, scores, and statuses.
// No memory bodies, tokens, or secrets are ever printed.

import { randomUUID } from "node:crypto";
import type { LiveEvalConfig } from "../eval/open-brain/live/config.ts";
import { loadLiveConfig, makeRunId } from "../eval/open-brain/live/config.ts";
import { loadLiveFixture } from "../eval/open-brain/live/fixtures.ts";
import { loadThresholds } from "../eval/open-brain/live/metrics.ts";
import type { GateClients } from "../eval/open-brain/live/gate.ts";
import { runLiveGate } from "../eval/open-brain/live/gate.ts";
import type { OpenBrainToolCaller } from "../eval/open-brain/live/transport.ts";
import {
  OpenBrainLiveClient,
  createMcpCaller,
} from "../eval/open-brain/live/transport.ts";

const FIXTURE_PATH = "eval/open-brain/fixtures/live-recall-v1.json";
const THRESHOLDS_PATH = "eval/open-brain/thresholds.json";

/**
 * Factory that connects one MCP caller for a (token, namespace) pair. Injected
 * so the setup lifecycle (below) is unit-testable without a hosted server or the
 * CLI: a fake factory can simulate a successful primary connect and a failing
 * negative connect, proving the primary is closed and no caller leaks.
 */
export type CallerFactory = (opts: {
  baseUrl: string;
  token: string;
  namespace: string;
  timeoutMs: number;
}) => Promise<OpenBrainToolCaller>;

/**
 * Connect the primary and negative callers in order, wrapping them in
 * OpenBrainLiveClients. The negative control is mandatory, so BOTH callers must
 * connect. If the primary connects but the negative connect fails, the
 * successfully-connected primary caller is closed before the error propagates --
 * otherwise a live MCP session (and its pool connection) would leak on every
 * setup failure. The close is best-effort and content-free: a close failure
 * never masks or widens the original connect error and never surfaces a raw
 * remote body.
 *
 * Extracted from main() and exported purely so the lifecycle is exercisable in a
 * unit test; the CLI path just calls it with the real createMcpCaller factory.
 */
export async function setUpGateClients(
  config: LiveEvalConfig,
  factory: CallerFactory = createMcpCaller,
): Promise<GateClients> {
  const primaryCaller = await factory({
    baseUrl: config.baseUrl,
    token: config.primaryToken,
    namespace: config.primaryNamespace,
    timeoutMs: config.timeoutMs,
  });

  let negativeCaller: OpenBrainToolCaller;
  try {
    negativeCaller = await factory({
      baseUrl: config.baseUrl,
      token: config.negativeToken,
      namespace: config.negativeNamespace,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // The primary already holds a live session; close it so a negative-connect
    // failure does not strand it. Swallow the close outcome (content-free) so
    // the original connect error is what the caller sees.
    await primaryCaller.close().catch(() => {});
    throw error;
  }

  return {
    primary: new OpenBrainLiveClient(primaryCaller),
    negative: new OpenBrainLiveClient(negativeCaller),
  };
}

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
    const code = await proc.exited;
    return code === 0 ? output.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const commit = await gitCommit();
  // Unique across repeated runs of the same commit: an explicit operator run id
  // (OPEN_BRAIN_LIVE_EVAL_RUN_ID) wins for reproducibility; otherwise a
  // crypto-random suffix guarantees no collision. PID alone is NOT unique across
  // sequential runs on one host, so it is not used as the sole source.
  const runId = makeRunId({
    prefix: commit.slice(0, 12),
    randomHex: randomUUID().replace(/-/g, "").slice(0, 12),
  });
  const config = loadLiveConfig(runId);
  const fixture = await loadLiveFixture(FIXTURE_PATH);
  const thresholds = await loadThresholds(THRESHOLDS_PATH);
  const generatedAt = new Date().toISOString();

  // Each caller binds its OWN X-Namespace on every request, so the token-sourced
  // global role becomes header-bound to this run's exact namespace. The negative
  // caller is mandatory and binds the distinct negative namespace (optionally a
  // distinct token too), giving a real negative control even when both callers
  // share one bearer token. setUpGateClients closes the primary if the negative
  // connect fails, so a setup failure never strands a live session.
  const clients = await setUpGateClients(config);

  try {
    const outcome = await runLiveGate({
      fixture,
      thresholds,
      config,
      clients,
      commit,
      generatedAt,
    });

    const reportPath = argValue("report");
    if (reportPath) {
      await Bun.write(
        reportPath,
        `${JSON.stringify(outcome.receipt, null, 2)}\n`,
      );
    }

    if (Bun.argv.includes("--json")) {
      console.log(JSON.stringify(outcome.receipt, null, 2));
    } else {
      printReceipt(outcome.receipt);
      if (reportPath) console.log(`\nWrote receipt: ${reportPath}`);
    }

    return outcome.passed ? 0 : 1;
  } finally {
    await clients.primary.close().catch(() => {});
    await clients.negative.close().catch(() => {});
  }
}

function printReceipt(
  receipt: Awaited<ReturnType<typeof runLiveGate>>["receipt"],
): void {
  const verdict = receipt.passed ? "PASS" : "FAIL";
  const lines = [
    `Open Brain live recall gate: ${verdict}`,
    `fixture=${receipt.fixture_id} thresholds=${receipt.thresholds_id} commit=${receipt.commit}`,
    `namespace=${receipt.primary_namespace} (negative=${receipt.negative_namespace})`,
    `seeded primary=${receipt.seeded.primary} negative=${receipt.seeded.negative}`,
    `recall@${receipt.top_k}=${receipt.metrics.recall_at_k} precision@${receipt.top_k}=${receipt.metrics.precision_at_k} mrr=${receipt.metrics.mrr} namespace_leaks=${receipt.metrics.namespace_leaks}`,
    `thresholds recall>=${receipt.thresholds.min_recall_at_k} precision>=${receipt.thresholds.min_precision_at_k} mrr>=${receipt.thresholds.min_mrr} leaks<=${receipt.thresholds.max_namespace_leaks}`,
    `negative-control ran=${receipt.negative_control.ran} denied=${receipt.negative_control.denied} observed_hits=${receipt.negative_control.observed_hit_count} cross_token=${receipt.negative_control.cross_token}`,
    `teardown attempted=${receipt.teardown.attempted} archived=${receipt.teardown.archived} already_absent=${receipt.teardown.already_absent} failed=${receipt.teardown.failed}`,
  ];
  for (const probe of receipt.probes) {
    lines.push(
      `- ${probe.probe_id}: recall=${probe.recall_at_k} precision=${probe.precision_at_k} rr=${probe.reciprocal_rank} leaks=${probe.namespace_leaks}`,
    );
  }
  if (receipt.failures.length > 0) {
    lines.push(`failures: ${receipt.failures.join("; ")}`);
  }
  console.log(lines.join("\n"));
}

// Only auto-run as a CLI. When imported (e.g. by the setup-lifecycle unit test)
// the module must NOT execute main() and touch config/env -- exporting the
// lifecycle helper for test is the reason this guard exists.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Content-free failure: name the error class + message only. The gate never
      // constructs a message containing a memory body or secret.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Live recall gate error: ${message}`);
      process.exitCode = 2;
    });
}
