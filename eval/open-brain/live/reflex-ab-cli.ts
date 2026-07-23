#!/usr/bin/env bun
// Single-command live REFLEX A/B suppression gate (REFLEX-4, issue #335).
//
//   bun run eval/open-brain/live/reflex-ab-cli.ts
//   bun run eval/open-brain/live/reflex-ab-cli.ts --json
//   bun run eval/open-brain/live/reflex-ab-cli.ts --report <path>
//   bun run eval/open-brain/live/reflex-ab-cli.ts --budget-tokens 8000
//
// Requires opt-in: OPEN_BRAIN_LIVE_EVAL=1 plus base URL + token env vars (see
// eval/open-brain/README.md). One invocation seeds a unique throwaway namespace
// with the sealed synthetic corpus, calls the real `agent_reflex_pointers` tool
// TWICE over the same seeded evidence (suppression OFF then ON), compares the two
// arms (suppression enabled must return demonstrably fewer already-known items
// with zero redundant resurfacing while preserving net-new evidence), proves
// cross-namespace denial, tears down exactly this run's records, and exits
// nonzero on any failed property.
//
// Output is content-free: only ids, namespaces, labels, counts, and statuses.
// No memory bodies, tokens, or secrets are ever printed.

import { randomUUID } from "node:crypto";
import { loadLiveConfig, makeRunId } from "./config.ts";
import { loadReflexAbFixture } from "./reflex-ab-fixtures.ts";
import { runReflexAbGate } from "./reflex-ab-gate.ts";
import type { ReflexAbGateClients } from "./reflex-ab-gate.ts";
import { setUpReflexAbClients } from "./reflex-ab-setup.ts";
import type { ReflexArmVerdict } from "./reflex-ab-types.ts";

const FIXTURE_PATH = "eval/open-brain/fixtures/reflex-ab-v1.json";
// Whole-pack budget large enough to admit every seeded pointer plus its
// citations on the OFF arm while still exercising the serialized-budget
// accounting. It is an eval knob (overridable with --budget-tokens), not a
// production threshold, so it lives here rather than in thresholds.json.
const DEFAULT_BUDGET_MAX_TOKENS = 6000;

// A fixed synthetic active scope for the reflex build. The namespace is the
// per-run throwaway namespace (bound inside the gate); these coordinates address
// a lane that does not exist for the fresh scope, exactly like the complete-pack
// gate.
const REFLEX_SCOPE = {
  agent: "reflex-ab-eval",
  platform: "eval",
  server_id: "open-brain-reflex-ab",
  channel_id: "reflex-ab-v1",
  session_key: "eval:reflex-ab:v1",
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
  const fixture = await loadReflexAbFixture(FIXTURE_PATH);
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

  const clients: ReflexAbGateClients = await setUpReflexAbClients(config);

  try {
    const outcome = await runReflexAbGate({
      fixture,
      config,
      clients,
      budgetMaxTokens,
      scope: REFLEX_SCOPE,
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

function armLine(v: ReflexArmVerdict): string {
  return (
    `- arm=${v.arm} pointers=${v.pointer_count} net_new_present=${v.net_new_present} ` +
    `net_new_missing=${v.net_new_missing} redundant_resurfacing=${v.redundant_resurfacing} ` +
    `leaks=${v.namespace_leaks} bijective=${v.citations_bijective} body_free=${v.body_free} ` +
    `client_owned=${v.placement_client_owned} within_budget=${v.budget.within_budget} ` +
    `alloc_order_complete=${v.budget.allocation_order_complete} ` +
    `serialized=${v.budget.serialized_pointers_chars}/${v.budget.content_char_limit ?? "none"}`
  );
}

function printReceipt(
  receipt: Awaited<ReturnType<typeof runReflexAbGate>>["receipt"],
): void {
  const verdict = receipt.passed ? "PASS" : "FAIL";
  const lines = [
    `Open Brain reflex A/B suppression gate: ${verdict}`,
    `fixture=${receipt.fixture_id} commit=${receipt.commit}`,
    `namespace=${receipt.primary_namespace} (negative=${receipt.negative_namespace})`,
    `seeded primary=${receipt.seeded.primary} negative=${receipt.seeded.negative} prior_known=${receipt.seeded.prior_known} net_new=${receipt.seeded.net_new}`,
    armLine(receipt.arm_off),
    armLine(receipt.arm_on),
    `comparison known_off=${receipt.comparison.known_resurfaced_off} known_on=${receipt.comparison.known_resurfaced_on} suppressed_delta=${receipt.comparison.known_suppressed_delta} fewer_when_enabled=${receipt.comparison.fewer_known_when_enabled} net_new_preserved=${receipt.comparison.net_new_preserved} preserved_on_both=${receipt.comparison.net_new_preserved_on_both}`,
    `negative_control ran=${receipt.negative_control.ran} denied=${receipt.negative_control.denied} observed_hit_count=${receipt.negative_control.observed_hit_count} cross_token=${receipt.negative_control.cross_token}${receipt.negative_control.failure ? ` failure=${receipt.negative_control.failure}` : ""}`,
    `teardown attempted=${receipt.teardown.attempted} archived=${receipt.teardown.archived} already_absent=${receipt.teardown.already_absent} failed=${receipt.teardown.failed}`,
  ];
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
      console.error(`Reflex A/B suppression gate error: ${message}`);
      process.exitCode = 2;
    });
}
