#!/usr/bin/env bun
// Single-command live COMPLETE CONTEXT PACK gate (EVAL-3, issue #330).
//
//   bun run eval/open-brain/live/complete-pack-cli.ts
//   bun run eval/open-brain/live/complete-pack-cli.ts --json
//   bun run eval/open-brain/live/complete-pack-cli.ts --report <path>
//   bun run eval/open-brain/live/complete-pack-cli.ts --budget-tokens 8000
//
// Requires opt-in: OPEN_BRAIN_LIVE_EVAL=1 plus base URL + token env vars (see
// eval/open-brain/README.md). One invocation seeds a unique throwaway namespace
// with the sealed synthetic corpus, calls the real `agent_context_pack` tool
// requesting all nine sections under one whole-pack budget, verifies the five
// functional properties (presence-or-defined-empty, exact-scope isolation,
// citation truth, serialized budget, per-section contribution), tears down
// exactly this run's records, and exits nonzero on any failed property.
//
// Output is content-free: only section names, ids, namespaces, labels, counts,
// and statuses. No memory bodies, tokens, or secrets are ever printed.

import { randomUUID } from "node:crypto";
import { loadLiveConfig, makeRunId } from "./config.ts";
import { loadCompletePackFixture } from "./complete-pack-fixtures.ts";
import { runCompletePackGate } from "./complete-pack-gate.ts";
import type { CompletePackGateClients } from "./complete-pack-gate.ts";
import { setUpCompletePackClients } from "./complete-pack-setup.ts";

const FIXTURE_PATH = "eval/open-brain/fixtures/complete-pack-v1.json";
// Whole-pack budget large enough to admit the seeded durable_memory recall and
// its citations while still exercising the serialized-budget accounting. It is
// an eval knob (overridable with --budget-tokens), not a production threshold,
// so it lives here rather than in thresholds.json (which versions the
// recall-quality gate, not this pack-assembly gate).
const DEFAULT_BUDGET_MAX_TOKENS = 6000;

// A fixed synthetic active scope for the pack build. The namespace is the per-run
// throwaway namespace (bound inside the gate); these coordinates address a lane
// that does not exist for the fresh scope, so durable_lane_context and the
// RAM-only sections land in their defined-empty states -- exactly the shape the
// gate verifies as present-or-defined-empty.
const PACK_SCOPE = {
  agent: "complete-pack-eval",
  platform: "eval",
  server_id: "open-brain-complete-pack",
  channel_id: "complete-pack-v1",
  session_key: "eval:complete-pack:v1",
} as const;

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
  const runId = makeRunId({
    prefix: commit.slice(0, 12),
    randomHex: randomUUID().replace(/-/g, "").slice(0, 12),
  });
  const config = loadLiveConfig(runId);
  const fixture = await loadCompletePackFixture(FIXTURE_PATH);
  const generatedAt = new Date().toISOString();

  const budgetRaw = argValue("budget-tokens");
  let budgetMaxTokens = DEFAULT_BUDGET_MAX_TOKENS;
  if (budgetRaw !== undefined) {
    const parsed = Number.parseInt(budgetRaw, 10);
    if (Number.isNaN(parsed) || parsed < 100) {
      throw new Error("--budget-tokens must be an integer >= 100");
    }
    budgetMaxTokens = parsed;
  }

  const clients: CompletePackGateClients =
    await setUpCompletePackClients(config);

  try {
    const outcome = await runCompletePackGate({
      fixture,
      config,
      clients,
      budgetMaxTokens,
      scope: PACK_SCOPE,
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
  receipt: Awaited<ReturnType<typeof runCompletePackGate>>["receipt"],
): void {
  const verdict = receipt.passed ? "PASS" : "FAIL";
  const lines = [
    `Open Brain complete context pack gate: ${verdict}`,
    `fixture=${receipt.fixture_id} commit=${receipt.commit}`,
    `namespace=${receipt.primary_namespace} (negative=${receipt.negative_namespace})`,
    `seeded primary=${receipt.seeded.primary} negative=${receipt.seeded.negative}`,
    `budget serialized=${receipt.budget.serialized_sections_chars}/${receipt.budget.content_char_limit ?? "none"} within=${receipt.budget.within_budget} allocation_order_complete=${receipt.budget.allocation_order_complete}`,
    `citations total=${receipt.citations.citations_total} emitted_item_citations=${receipt.citations.emitted_item_citations} dangling=${receipt.citations.dangling_citations} uncited=${receipt.citations.uncited_items} bijective=${receipt.citations.bijective}`,
    `isolation exact_scope_denied=${receipt.isolation.exact_scope_denied} namespace_leaks=${receipt.isolation.namespace_leaks} expected_recall_present=${receipt.isolation.expected_recall_present}`,
    `teardown attempted=${receipt.teardown.attempted} archived=${receipt.teardown.archived} already_absent=${receipt.teardown.already_absent} failed=${receipt.teardown.failed}`,
  ];
  for (const section of receipt.sections) {
    const ok = section.defined_empty || section.has_items ? "ok" : "FAIL";
    lines.push(
      `- ${section.section}: present=${section.present} items=${section.item_count} disposition=${section.disposition} chars=${section.serialized_chars} ${ok}`,
    );
  }
  if (receipt.failures.length > 0) {
    lines.push(`failures: ${receipt.failures.join("; ")}`);
  }
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Complete context pack gate error: ${message}`);
      process.exitCode = 2;
    });
}
