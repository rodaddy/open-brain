import type {
  LiveGateReceipt,
  LiveScorecard,
  LiveThresholds,
  NegativeControlProof,
  SeededRecord,
} from "./types.ts";
import type { LiveEvalConfig } from "./config.ts";
import type { TeardownTally } from "./gate.ts";

// The pure verdict/receipt phase of the live recall gate.
//
// Split out of gate.ts (issue 752) so `runLiveGate` stays under the repo
// complexity and function-length rule values. This half touches no client and
// performs no I/O: it takes the facts the run already established -- what was
// seeded, what was scored, whether the isolation proof denied, what teardown
// tallied -- and composes the composite verdict plus the receipt.
//
// Every predicate and every failure string below is a verbatim lift out of the
// original function body, in the original order, so no verdict, metric, or
// receipt field changes.
//
// These are internal helpers of the gate module. gate.ts does NOT re-export
// them, so no import specifier anywhere in the repo moves.

/**
 * The composite gate failure list. A metrics-only pass is never enough: the
 * isolation proof must have denied, and teardown must have stranded nothing.
 */
export function collectGateFailures(opts: {
  scorecard: LiveScorecard;
  negativeControl: NegativeControlProof;
  teardownTally: TeardownTally;
}): string[] {
  const { scorecard, negativeControl, teardownTally } = opts;
  const gateFailures = [...scorecard.failures];

  if (!negativeControl.ran) {
    gateFailures.push(
      `negative-control proof did not run: ${negativeControl.failure ?? "unknown"}`,
    );
  } else if (!negativeControl.denied) {
    gateFailures.push(
      `negative-control not denied: ${negativeControl.failure ?? "isolation not proven"}`,
    );
  }

  if (teardownTally.failed !== 0) {
    gateFailures.push(
      `teardown failed to archive ${teardownTally.failed} of ${teardownTally.attempted} seeded records`,
    );
  }

  return gateFailures;
}

/**
 * Build the run receipt. Pure assembly over facts the run already established;
 * the composite `passed` verdict is supplied by the caller so the receipt and
 * the returned outcome can never disagree.
 */
export function buildGateReceipt(opts: {
  scorecard: LiveScorecard;
  thresholds: LiveThresholds;
  config: LiveEvalConfig;
  fixtureId: string;
  commit: string;
  generatedAt: string;
  seeded: SeededRecord[];
  negativeControl: NegativeControlProof;
  teardownTally: TeardownTally;
  gateFailures: string[];
  passed: boolean;
}): LiveGateReceipt {
  const {
    scorecard,
    thresholds,
    config,
    fixtureId,
    commit,
    generatedAt,
    seeded,
    negativeControl,
    teardownTally,
    gateFailures,
    passed,
  } = opts;

  const primarySeeded = seeded.filter((r) => r.namespace_role === "primary").length;
  const negativeSeeded = seeded.filter((r) => r.namespace_role === "negative").length;

  return {
    schema: "openbrain.live_recall_gate.v1",
    generated_at: generatedAt,
    commit,
    fixture_id: fixtureId,
    thresholds_id: thresholds.thresholds_id,
    top_k: thresholds.top_k,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    seeded: { primary: primarySeeded, negative: negativeSeeded },
    metrics: {
      recall_at_k: scorecard.recall_at_k,
      precision_at_k: scorecard.precision_at_k,
      mrr: scorecard.mrr,
      namespace_leaks: scorecard.namespace_leaks,
    },
    thresholds: thresholds.thresholds,
    probes: scorecard.probes.map((p) => ({
      probe_id: p.probe_id,
      recall_at_k: p.recall_at_k,
      precision_at_k: p.precision_at_k,
      reciprocal_rank: p.reciprocal_rank,
      namespace_leaks: p.namespace_leaks,
    })),
    negative_control: {
      ran: negativeControl.ran,
      denied: negativeControl.denied,
      observed_hit_count: negativeControl.observed_hit_count,
      cross_token: negativeControl.cross_token,
      failure: negativeControl.failure,
    },
    passed,
    failures: gateFailures,
    teardown: teardownTally,
  };
}
