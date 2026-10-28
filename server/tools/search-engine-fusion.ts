/** Coverage-aware reciprocal-rank fusion for the hybrid retrieval engine. */
import {
  HYBRID_CORROBORATION_BONUS,
  HYBRID_RRF_K,
  TABLE_WEIGHT,
  TIER_BOOST,
  type Tier,
} from "./search-constants.ts";
import { rowEvidence, rowIdsEvidence, type SearchRow } from "./search-engine-types.ts";
import { traceRetrievalSpanSync } from "../observability/langfuse-tracing.ts";

type RrfArm = "vector" | "lexical";

/** @internal One arm's exact reciprocal-rank vote. */
export function rrfArmContribution(row: SearchRow, index: number, arm: RrfArm): number {
  const reciprocalRank = 1 / (HYBRID_RRF_K + index + 1);
  if (arm === "vector") return reciprocalRank;
  const covered = row.lexical_coverage;
  const total = row.query_lexeme_count;
  if (
    !Number.isInteger(covered) ||
    !Number.isInteger(total) ||
    covered === undefined ||
    total === undefined ||
    covered < 1 ||
    total < covered
  ) {
    throw new Error(
      `Invalid hybrid lexical coverage metadata for ${row.source_type}:${row.id}`,
    );
  }
  return reciprocalRank;
}

/** Gentle recency decay applied after fusion. */
function recencyFactor(createdAt: string, nowMs: number): number {
  const ms = new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return 1;
  const ageDays = (nowMs - ms) / 86_400_000;
  return 1 / (1 + Math.max(0, ageDays) * 0.001);
}

/** Preference score used only after an exact raw fusion-score tie. */
function fusedScore(row: SearchRow, rrf: number, nowMs: number): number {
  return Math.max(
    0,
    (rrf + TIER_BOOST[(row.tier ?? "warm") as Tier]) *
      (TABLE_WEIGHT[row.source_type] ?? 1) *
      recencyFactor(row.created_at, nowMs),
  );
}

interface RankedCandidate {
  readonly row: SearchRow;
  rrf: number;
  presentInVector: boolean;
  presentInLexical: boolean;
}

interface ScoredCandidate extends RankedCandidate {
  readonly rawScore: number;
  readonly preference: number;
}

/** Sum unweighted direct ordinal votes from both arms, keyed by record. */
function accumulateRrf(
  vectorRows: readonly SearchRow[],
  ftsRows: readonly SearchRow[],
): Map<string, RankedCandidate> {
  const scored = new Map<string, RankedCandidate>();
  for (const [arm, rows] of [
    ["vector", vectorRows],
    ["lexical", ftsRows],
  ] as const) {
    rows.forEach((row, index) => {
      const key = `${row.source_type}:${row.id}`;
      const contribution = rrfArmContribution(row, index, arm);
      const existing = scored.get(key);
      if (existing) {
        existing.rrf += contribution;
        if (arm === "vector") existing.presentInVector = true;
        else existing.presentInLexical = true;
        return;
      }
      scored.set(key, {
        row,
        rrf: contribution,
        presentInVector: arm === "vector",
        presentInLexical: arm === "lexical",
      });
    });
  }
  return scored;
}

function compareIdentity(left: SearchRow, right: SearchRow): number {
  if (left.source_type < right.source_type) return -1;
  if (left.source_type > right.source_type) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  const relevance = right.rawScore - left.rawScore;
  if (relevance !== 0) return relevance;
  const preference = right.preference - left.preference;
  if (preference !== 0) return preference;
  return compareIdentity(left.row, right.row);
}

/**
 * Sum direct ordinal votes and one fixed cross-arm corroboration bonus.
 * Metadata preference breaks only exact raw-score ties, followed by stable
 * source/id identity.
 */
export function rrfMerge(
  vectorRows: readonly SearchRow[],
  ftsRows: readonly SearchRow[],
  limit: number,
): SearchRow[] {
  let ranked: ScoredCandidate[] = [];
  return traceRetrievalSpanSync({
    name: "retrieval.rank_rrf",
    input: {
      limit,
      vector: rowIdsEvidence(vectorRows),
      keyword: rowIdsEvidence(ftsRows),
    },
    metadata: { stage: "scoring_ranking", filter_names: ["rrf_limit"] },
    run: () => {
      const nowMs = Date.now();
      ranked = Array.from(accumulateRrf(vectorRows, ftsRows).values())
        .map((candidate) => {
          const corroboration =
            candidate.presentInVector && candidate.presentInLexical
              ? HYBRID_CORROBORATION_BONUS
              : 0;
          const rawScore = candidate.rrf + corroboration;
          return {
            ...candidate,
            rawScore,
            preference: fusedScore(candidate.row, rawScore, nowMs),
          };
        })
        .sort(compareCandidates);
      return ranked.slice(0, limit).map(({ row }) => row);
    },
    output: (selected) => {
      const selectedKeys = new Set(
        selected.map((row) => `${row.source_type}:${row.id}`),
      );
      return {
        candidate_count: ranked.length,
        selected_count: selected.length,
        candidates: ranked.map(({ row, preference }) => ({
          ...rowEvidence(row),
          rrf_score: preference,
          chosen: selectedKeys.has(`${row.source_type}:${row.id}`),
          filtered_by: selectedKeys.has(`${row.source_type}:${row.id}`)
            ? null
            : "rrf_limit",
        })),
      };
    },
  });
}
