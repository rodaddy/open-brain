/**
 * The engine's fusion, transcribed -- plus the one curation term arm C adds.
 *
 * WHY A TRANSCRIPTION AT ALL. `accumulateRrf`, `fusedScore` and `rrfMerge` are
 * private to `server/tools/search-engine.ts`, and issue 1412 State 6 may not
 * change a source file to measure it. Arms B and C therefore call the engine
 * once per ARM (`vector` and `keyword`, at the hybrid over-fetch depth) and
 * fuse the two candidate lists here.
 *
 * WHY THAT IS SAFE. A local scorer that silently diverged from the engine would
 * turn every reported delta into a measurement of the divergence, and it would
 * look exactly like a finding. So `verifyLocalFusionMatchesEngine` in
 * `curation.ts` fuses the un-curated arms and asserts the result is identical
 * to the engine's own `hybrid` output before any curated number is believed.
 * The transcription is checked, not trusted.
 *
 * ARM C IS THE ONLY DIFFERENCE. `curationInFusion` is the whole of it; with it
 * false, this file is the engine.
 */
import {
  HYBRID_CORROBORATION_BONUS,
  HYBRID_RRF_K,
  TABLE_WEIGHT,
  TIER_BOOST,
} from "../../server/tools/search-constants.ts";
import { USEFULNESS_WEIGHT } from "../../server/tools/search-engine-types.ts";

/** A row's identity for set comparison: wire label and id together. */
export function refKey(sourceLabel: string, id: string): string {
  return `${sourceLabel}:${id}`;
}

/** A minimal view of a returned row: what fusion and scoring need. */
export interface RankedRow {
  readonly key: string;
  readonly source_type: string;
  readonly id: string;
  readonly tier: string | null;
  readonly created_at: string;
  readonly usefulness: number;
  readonly lexical_coverage?: number;
  readonly query_lexeme_count?: number;
}

/** Narrow the engine's row to what this script fuses on. */
export function toRankedRow(row: {
  source_type: string;
  id: string;
  tier?: string | null;
  created_at: string;
  usefulness?: number | string | null;
  lexical_coverage?: number;
  query_lexeme_count?: number;
}): RankedRow {
  const raw = row.usefulness;
  const usefulness = typeof raw === "number" ? raw : Number(raw ?? 0.5);
  return {
    key: refKey(row.source_type, row.id),
    source_type: row.source_type,
    id: row.id,
    tier: row.tier ?? null,
    created_at: row.created_at,
    usefulness: Number.isFinite(usefulness) ? usefulness : 0.5,
    lexical_coverage: row.lexical_coverage,
    query_lexeme_count: row.query_lexeme_count,
  };
}

/**
 * Recency decay, transcribed from `recencyFactor` in the engine
 * (`server/tools/search-engine.ts:165-170`), which is private to that module.
 */
function recencyFactor(createdAt: string, nowMs: number): number {
  const ms = new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return 1;
  const ageDays = (nowMs - ms) / 86_400_000;
  return 1 / (1 + Math.max(0, ageDays) * 0.001);
}

/**
 * The engine's post-fusion score, plus an OPTIONAL curation term (arm C).
 *
 * The unmodified half is `fusedScore` verbatim. Arm C multiplies by
 * `1 + USEFULNESS_WEIGHT * (usefulness - 0.5) * 2`, which is 1.0 at the neutral
 * 0.5 fallback, 1.135 at the curated high, and 0.865 at the curated low, using
 * the weight the vector arm already uses so the term's authority matches the
 * one curation signal the system already trusts. Chosen because it is neutral
 * at the fallback: a corpus where nothing is curated scores IDENTICALLY to
 * today, so arm C is a pure addition and not a silent reweighting of the rest.
 *
 * @param row - The candidate.
 * @param rrf - Its summed reciprocal-rank contribution.
 * @param curationInFusion - True for arm C; false reproduces the engine.
 * @returns The fused score, floored at zero exactly as the engine floors it.
 */
export function fusedScore(
  row: RankedRow,
  rrf: number,
  curationInFusion: boolean,
  nowMs = Date.now(),
): number {
  const base =
    (rrf + (TIER_BOOST[(row.tier ?? "warm") as keyof typeof TIER_BOOST] ?? 0)) *
    (TABLE_WEIGHT[row.source_type] ?? 1) *
    recencyFactor(row.created_at, nowMs);
  const curation = curationInFusion
    ? 1 + USEFULNESS_WEIGHT * (row.usefulness - 0.5) * 2
    : 1;
  return Math.max(0, base * curation);
}

interface LocalCandidate {
  readonly row: RankedRow;
  readonly rrf: number;
  readonly rawScore: number;
  readonly preference: number;
}

function compareLocalCandidates(left: LocalCandidate, right: LocalCandidate): number {
  const relevance = right.rawScore - left.rawScore;
  if (relevance !== 0) return relevance;
  const preference = right.preference - left.preference;
  if (preference !== 0) return preference;
  if (left.row.source_type < right.row.source_type) return -1;
  if (left.row.source_type > right.row.source_type) return 1;
  if (left.row.id < right.row.id) return -1;
  if (left.row.id > right.row.id) return 1;
  return 0;
}

function localArmContribution(
  row: RankedRow,
  index: number,
  arm: "vector" | "lexical",
): number {
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
    throw new Error(`Invalid hybrid lexical coverage metadata for ${row.key}`);
  }
  return reciprocalRank;
}

/**
 * Sum direct ordinal votes and the fixed cross-arm corroboration bonus, then
 * apply the engine's preference and identity tie-breaks.
 *
 * @param vectorRows - The vector arm's candidates, best first.
 * @param ftsRows - The lexical arm's candidates, best first.
 * @param limit - How many fused rows to return.
 * @param curationInFusion - True for arm C.
 * @returns The fused keys, best first.
 */
export function fuseLocally(
  vectorRows: readonly RankedRow[],
  ftsRows: readonly RankedRow[],
  limit: number,
  curationInFusion: boolean,
): readonly string[] {
  const scored = new Map<
    string,
    {
      row: RankedRow;
      rrf: number;
      presentInVector: boolean;
      presentInLexical: boolean;
    }
  >();
  for (const [arm, rows] of [
    ["vector", vectorRows],
    ["lexical", ftsRows],
  ] as const) {
    rows.forEach((row, index) => {
      const contribution = localArmContribution(row, index, arm);
      const existing = scored.get(row.key);
      if (existing) {
        existing.rrf += contribution;
        if (arm === "vector") existing.presentInVector = true;
        else existing.presentInLexical = true;
        return;
      }
      scored.set(row.key, {
        row,
        rrf: contribution,
        presentInVector: arm === "vector",
        presentInLexical: arm === "lexical",
      });
    });
  }
  const nowMs = Date.now();
  return Array.from(scored.values())
    .map((candidate) => {
      const corroboration =
        candidate.presentInVector && candidate.presentInLexical
          ? HYBRID_CORROBORATION_BONUS
          : 0;
      const rawScore = candidate.rrf + corroboration;
      return {
        ...candidate,
        rawScore,
        preference: fusedScore(candidate.row, rawScore, curationInFusion, nowMs),
      };
    })
    .sort(compareLocalCandidates)
    .slice(0, limit)
    .map((entry) => entry.row.key);
}
