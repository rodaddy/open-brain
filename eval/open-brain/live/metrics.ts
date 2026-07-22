import { z } from "zod";
import type {
  LiveFixture,
  LiveProbe,
  LiveScorecard,
  LiveThresholds,
  ProbeMetric,
} from "./types.ts";

// Deterministic ranking metrics for the live recall gate. Given a probe's
// ranked list of retrieved fixture ids (top-k, best first), these produce
// Recall@K, Precision@K, MRR, and a namespace-leak count with no randomness
// and no dependence on wall-clock or embedding scores. Identical inputs always
// produce identical outputs, which is what makes the gate reproducible.

const thresholdsSchema: z.ZodType<LiveThresholds> = z.object({
  schema_version: z.literal(1),
  thresholds_id: z.string().min(1),
  applies_to_fixture_id: z.string().min(1),
  top_k: z.number().int().min(1),
  thresholds: z.object({
    min_recall_at_k: z.number().min(0).max(1),
    min_precision_at_k: z.number().min(0).max(1),
    min_mrr: z.number().min(0).max(1),
    max_namespace_leaks: z.number().int().min(0),
  }),
  notes: z.string().optional(),
});

export function parseThresholds(raw: unknown): LiveThresholds {
  return thresholdsSchema.parse(raw);
}

export async function loadThresholds(path: string): Promise<LiveThresholds> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read thresholds ${path}: ${message}`);
  }
  try {
    return parseThresholds(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid thresholds ${path}: ${message}`);
  }
}

/** Fixture-local ids that count as relevant (graded > 0) for a probe. */
export function relevantIdsFor(probe: LiveProbe): string[] {
  return probe.relevant.filter((r) => r.grade > 0).map((r) => r.id);
}

/**
 * Recall@K: fraction of relevant items that appear in the top-k retrieved list.
 * By convention a probe with no relevant items has perfect recall (1).
 */
export function recallAtK(
  retrievedTopK: string[],
  relevantIds: string[],
): number {
  if (relevantIds.length === 0) return 1;
  const retrieved = new Set(retrievedTopK);
  const hits = relevantIds.filter((id) => retrieved.has(id)).length;
  return hits / relevantIds.length;
}

/**
 * Precision@K: fraction of the top-k retrieved list that is relevant, using k
 * as the denominator (standard Precision@K). An empty retrieved list is 1 when
 * nothing was relevant, else 0.
 */
export function precisionAtK(
  retrievedTopK: string[],
  relevantIds: string[],
  k: number,
): number {
  if (relevantIds.length === 0) {
    return retrievedTopK.length === 0 ? 1 : 0;
  }
  if (k <= 0) return 0;
  const relevant = new Set(relevantIds);
  const hits = retrievedTopK
    .slice(0, k)
    .filter((id) => relevant.has(id)).length;
  return hits / k;
}

/**
 * Reciprocal rank of the first relevant hit in the ranked list (1-indexed).
 * 0 when no relevant item is retrieved.
 */
export function reciprocalRank(
  retrievedRanked: string[],
  relevantIds: string[],
): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < retrievedRanked.length; i++) {
    const id = retrievedRanked[i];
    if (id !== undefined && relevant.has(id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Count forbidden (out-of-namespace) ids that leaked into the retrieved list. */
export function namespaceLeaks(
  retrieved: string[],
  forbiddenIds: string[],
): number {
  if (forbiddenIds.length === 0) return 0;
  const forbidden = new Set(forbiddenIds);
  return retrieved.filter((id) => forbidden.has(id)).length;
}

/** Score one probe against its ranked, top-k-truncated retrieved id list. */
export function scoreProbeMetric(
  probe: LiveProbe,
  retrievedRanked: string[],
  topK: number,
): ProbeMetric {
  const relevantIds = relevantIdsFor(probe);
  const topK_ids = retrievedRanked.slice(0, topK);
  return {
    probe_id: probe.id,
    recall_at_k: recallAtK(topK_ids, relevantIds),
    precision_at_k: precisionAtK(topK_ids, relevantIds, topK),
    reciprocal_rank: reciprocalRank(retrievedRanked, relevantIds),
    // Leak check runs over the FULL retrieved list, not just top-k: any
    // out-of-namespace record surfacing at all is an isolation breach.
    namespace_leaks: namespaceLeaks(retrievedRanked, probe.forbidden_ids),
    retrieved_count: retrievedRanked.length,
    relevant_count: relevantIds.length,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Aggregate per-probe metrics into a scorecard and apply versioned thresholds.
 * `retrievedByProbe` maps probe id -> the ranked fixture-id list observed for
 * that probe. A missing probe is scored as an empty retrieval (worst case).
 */
export function buildScorecard(
  fixture: LiveFixture,
  thresholds: LiveThresholds,
  retrievedByProbe: Record<string, string[]>,
): LiveScorecard {
  const topK = thresholds.top_k;
  const probeMetrics = fixture.probes.map((probe) =>
    scoreProbeMetric(probe, retrievedByProbe[probe.id] ?? [], topK),
  );

  const recall = round(mean(probeMetrics.map((p) => p.recall_at_k)));
  const precision = round(mean(probeMetrics.map((p) => p.precision_at_k)));
  const mrr = round(mean(probeMetrics.map((p) => p.reciprocal_rank)));
  const leaks = probeMetrics.reduce((sum, p) => sum + p.namespace_leaks, 0);

  const t = thresholds.thresholds;
  const failures: string[] = [];
  if (recall < t.min_recall_at_k) {
    failures.push(`recall_at_k ${recall} below threshold ${t.min_recall_at_k}`);
  }
  if (precision < t.min_precision_at_k) {
    failures.push(
      `precision_at_k ${precision} below threshold ${t.min_precision_at_k}`,
    );
  }
  if (mrr < t.min_mrr) {
    failures.push(`mrr ${mrr} below threshold ${t.min_mrr}`);
  }
  if (leaks > t.max_namespace_leaks) {
    failures.push(
      `namespace_leaks ${leaks} above threshold ${t.max_namespace_leaks}`,
    );
  }

  return {
    fixture_id: fixture.fixture_id,
    thresholds_id: thresholds.thresholds_id,
    top_k: topK,
    probes_total: probeMetrics.length,
    recall_at_k: recall,
    precision_at_k: precision,
    mrr,
    namespace_leaks: leaks,
    passed: failures.length === 0,
    failures,
    probes: probeMetrics.map((p) => ({
      ...p,
      recall_at_k: round(p.recall_at_k),
      precision_at_k: round(p.precision_at_k),
      reciprocal_rank: round(p.reciprocal_rank),
    })),
  };
}
