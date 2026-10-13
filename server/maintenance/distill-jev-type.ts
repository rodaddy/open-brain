import {
  buildJevBatchPlan,
  executeJevBatchPlan,
  type JevConfig,
  type JevFetch,
} from "../integrations/jev.ts";
import {
  CANON_CONFLICT_CLASSIFIER_SET,
  DISTILL_TYPE_CLASSIFIER_SET,
  JEV_CANON_CONFLICT_RUBRIC_VERSION,
  JEV_DISTILL_TYPE_RUBRIC_VERSION,
} from "../integrations/jev-question-sets.ts";
import {
  CANDIDATE_TYPES,
  type CandidateType,
  type PreparedCandidate,
} from "../domain/distiller.ts";
import {
  createContextPackRepository,
  type ContextPackQuerySurface,
} from "../db/context-pack-repository.ts";
import {
  loadGuidanceSection,
  type GuidanceSectionName,
} from "../tools/context-pack-guidance.ts";

/**
 * Issue 1618 B1 confidence policy. Both numbers are guesses until the plan's
 * B1 L2 measurement (`_plans/1618-jev-open-brain.md`) sets them.
 */
export const DISTILL_JEV_FLOOR = 0.5;
export const DISTILL_JEV_BAR = 0.9;

function isCandidateType(value: string): value is CandidateType {
  return (CANDIDATE_TYPES as readonly string[]).includes(value);
}

/**
 * Ask Jev the candidate_type question for every candidate of one distill batch.
 * It may only TYPE a candidate, never drop one: output length and order always
 * equal the input's, and any Jev failure (including an out-of-set answer)
 * returns every candidate unchanged.
 */
export async function retypeCandidatesWithJev(input: {
  candidates: readonly PreparedCandidate[];
  config: JevConfig;
  fetchFn?: JevFetch;
  logger: {
    info(event: string, fields: Record<string, string | number>): void;
    warn(event: string, fields: Record<string, string | number>): void;
  };
}): Promise<PreparedCandidate[]> {
  const { candidates } = input;
  if (!input.config.enabled || candidates.length === 0) return [...candidates];

  let choices: Array<{ type: CandidateType; confidence: number }>;
  try {
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: candidates.map((candidate, index) => ({
        key: String(index),
        content: candidate.content,
      })),
      classifierSet: DISTILL_TYPE_CLASSIFIER_SET,
      limits: input.config,
    });
    const result = await executeJevBatchPlan(input.config, plan, input.fetchFn);
    choices = candidates.map((_candidate, index) => {
      const answer = result.answers.get(String(index))?.candidate_type;
      if (answer?.type !== "choice" || !isCandidateType(answer.choice)) {
        throw new Error("Jev returned an invalid distill candidate type");
      }
      return { type: answer.choice, confidence: answer.confidence };
    });
  } catch (error) {
    input.logger.warn("distill_jev_type_failed", {
      candidate_count: candidates.length,
      error_category: error instanceof Error ? error.name : typeof error,
    });
    return [...candidates];
  }

  let replaced = 0;
  let flagged = 0;
  let kept = 0;
  const out = candidates.map((candidate, index): PreparedCandidate => {
    const choice = choices[index];
    if (!choice) return candidate;
    const { type: t, confidence: c } = choice;
    const r = candidate.candidate_type;
    if (c >= DISTILL_JEV_BAR) {
      if (t !== r) replaced++;
      return { ...candidate, candidate_type: t };
    }
    const note = `jev typed ${t} at ${c}, rule said ${r}`;
    const uncertainty_reason = candidate.uncertainty_reason
      ? `${candidate.uncertainty_reason}; ${note}`
      : note;
    flagged++;
    if (c >= DISTILL_JEV_FLOOR) {
      if (t !== r) replaced++;
      return { ...candidate, candidate_type: t, uncertain: true, uncertainty_reason };
    }
    kept++;
    return { ...candidate, candidate_type: r, uncertain: true, uncertainty_reason };
  });
  input.logger.info("distill_jev_type_applied", {
    candidate_count: candidates.length,
    replaced,
    flagged,
    kept,
    rubric: JEV_DISTILL_TYPE_RUBRIC_VERSION,
  });
  return out;
}

export type CanonEntry = {
  scopeKey: string;
  content: string;
  section: GuidanceSectionName;
};

type CanonLogger = {
  warn(event: string, fields: Record<string, string | number>): void;
};

/** Reshape guidance items into keyed canon entries, announcing any keyless skip. */
export function canonEntriesFromItems(input: {
  section: GuidanceSectionName;
  items: ReadonlyArray<Record<string, unknown>>;
  logger: CanonLogger;
}): CanonEntry[] {
  const entries: CanonEntry[] = [];
  let skipped = 0;
  for (const item of input.items) {
    const scopeKey = item.scope_key;
    const content = item.guidance;
    if (typeof scopeKey !== "string" || typeof content !== "string") {
      skipped++;
      continue;
    }
    entries.push({ scopeKey, content, section: input.section });
  }
  if (skipped > 0) {
    input.logger.warn("distill_jev_canon_keyless_skipped", {
      section: input.section,
      skipped,
    });
  }
  return entries;
}

const CANON_SECTIONS: readonly GuidanceSectionName[] = [
  "profile_guidance",
  "process_guidance",
];

/**
 * Issue 1618 B4 L1: the standing canon entries for one namespace, located, not
 * built. Delegates to the context-pack guidance read (`loadGuidanceSection`),
 * which owns the query and the supersession fold; this only reshapes its items.
 * Repo facts are excluded: they bind to a repo slug, not a namespace. A keyless
 * promote has no scope key to report, so it is left out and the count is
 * announced. A degraded read throws
 * rather than returning an empty set that would look like "no canon".
 */
export async function loadCanonEntriesForNamespace(input: {
  db: ContextPackQuerySurface;
  namespace: string;
  logger: CanonLogger;
}): Promise<ReadonlyArray<CanonEntry>> {
  const repository = createContextPackRepository(input.db);
  const entries: CanonEntry[] = [];
  for (const section of CANON_SECTIONS) {
    const fragment = await loadGuidanceSection(
      { section, namespace: input.namespace },
      { repository },
    );
    if (!fragment.section || fragment.degradedSources.length > 0) {
      throw new Error(`canon read degraded for section ${section}`);
    }
    const items = fragment.section.items as Array<Record<string, unknown>>;
    entries.push(...canonEntriesFromItems({ section, items, logger: input.logger }));
  }
  return entries;
}

export const CANON_CONFLICT_AT = 0.7; // guess, same as RESTATES_AT_V2 (decide-v2.ts:37); set by B4 L3
export const CANON_CONFLICT_TOP_K = 3;

export type EmbeddedCanonEntry = CanonEntry & { embedding: ReadonlyArray<number> };

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type CanonPair = { i: number; j: number; key: string };

function pairCorrectionsWithCanon(
  candidates: readonly PreparedCandidate[],
  embeddings: ReadonlyArray<ReadonlyArray<number> | null>,
  canon: ReadonlyArray<EmbeddedCanonEntry>,
): {
  pairs: CanonPair[];
  corrections: number;
  skipped: number;
  canon_dimension_mismatch: number;
} {
  const pairs: CanonPair[] = [];
  let corrections = 0;
  let skipped = 0;
  let firstLength: number | null = null;
  candidates.forEach((candidate, i) => {
    if (candidate.candidate_type !== "correction") return;
    corrections++;
    const vector = embeddings[i];
    if (!vector) {
      skipped++;
      return;
    }
    firstLength ??= vector.length;
    const matching = canon
      .map((entry, j) => ({ j, entry }))
      .filter(({ entry }) => entry.embedding.length === vector.length);
    if (matching.length === 0) {
      skipped++;
      return;
    }
    const ranked = matching
      .map(({ j, entry }) => ({ j, score: cosineSimilarity(vector, entry.embedding) }))
      .sort((a, b) => b.score - a.score || a.j - b.j)
      .slice(0, CANON_CONFLICT_TOP_K);
    for (const { j } of ranked) pairs.push({ i, j, key: `${i}:${j}` });
  });
  const expected: number | null = firstLength;
  const canon_dimension_mismatch =
    expected === null
      ? 0
      : canon.filter((entry) => entry.embedding.length !== expected).length;
  return { pairs, corrections, skipped, canon_dimension_mismatch };
}

async function askCanonConflict(
  input: {
    candidates: readonly PreparedCandidate[];
    canon: ReadonlyArray<EmbeddedCanonEntry>;
    config: JevConfig;
    fetchFn?: JevFetch;
  },
  pairs: readonly CanonPair[],
): Promise<Map<string, number>> {
  const plan = buildJevBatchPlan({
    sharedState: {},
    records: pairs.map(({ i, j, key }) => {
      const candidate = input.candidates[i] as PreparedCandidate;
      const entry = input.canon[j] as EmbeddedCanonEntry;
      return {
        key,
        content: candidate.content,
        fields: { correction: candidate.content, canon_entry: entry.content },
      };
    }),
    classifierSet: CANON_CONFLICT_CLASSIFIER_SET,
    limits: input.config,
  });
  const result = await executeJevBatchPlan(input.config, plan, input.fetchFn);
  const scores = new Map<string, number>();
  for (const { key } of pairs) {
    const answer = result.answers.get(key)?.contradicts_canon;
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul)) {
      throw new Error("Jev returned an invalid contradicts_canon answer");
    }
    scores.set(key, answer.noul);
  }
  return scores;
}

function applyCanonFlags(
  candidates: readonly PreparedCandidate[],
  canon: ReadonlyArray<EmbeddedCanonEntry>,
  pairs: readonly CanonPair[],
  scores: ReadonlyMap<string, number>,
): { out: PreparedCandidate[]; flagged: number } {
  const best = new Map<number, { j: number; noul: number }>();
  for (const { i, j, key } of pairs) {
    const noul = scores.get(key) ?? 0;
    const current = best.get(i);
    if (!current || noul > current.noul) best.set(i, { j, noul });
  }
  let flagged = 0;
  const out = candidates.map((candidate, i): PreparedCandidate => {
    const top = best.get(i);
    if (!top || top.noul < CANON_CONFLICT_AT) return candidate;
    const entry = canon[top.j] as EmbeddedCanonEntry;
    const note = `may contradict canon ${entry.scopeKey} (${top.noul})`;
    const uncertainty_reason = candidate.uncertainty_reason
      ? `${candidate.uncertainty_reason}; ${note}`
      : note;
    flagged++;
    return { ...candidate, uncertain: true, uncertainty_reason };
  });
  return { out, flagged };
}

/**
 * Issue 1618 B4 L2: pair each distilled correction with its top canon entries
 * by embedding similarity and ask whether it contradicts them. It only FLAGS a
 * candidate uncertain; it never changes type, tier, or canon, and never drops
 * or reorders. Any Jev failure returns every candidate unchanged.
 */
export async function flagCanonConflictsWithJev(input: {
  candidates: readonly PreparedCandidate[];
  /** Aligned with candidates by index; null where the embedder failed. */
  embeddings: ReadonlyArray<ReadonlyArray<number> | null>;
  canon: ReadonlyArray<EmbeddedCanonEntry>;
  config: JevConfig;
  fetchFn?: JevFetch;
  logger: {
    info(event: string, fields: Record<string, string | number>): void;
    warn(event: string, fields: Record<string, string | number>): void;
  };
}): Promise<PreparedCandidate[]> {
  const { candidates, canon } = input;
  if (
    !input.config.enabled ||
    canon.length === 0 ||
    !candidates.some((candidate) => candidate.candidate_type === "correction")
  ) {
    return [...candidates];
  }
  const { pairs, corrections, skipped, canon_dimension_mismatch } =
    pairCorrectionsWithCanon(candidates, input.embeddings, canon);
  let scores = new Map<string, number>();
  if (pairs.length > 0) {
    try {
      scores = await askCanonConflict(input, pairs);
    } catch (error) {
      input.logger.warn("distill_jev_canon_conflict_failed", {
        candidate_count: candidates.length,
        error_category: error instanceof Error ? error.name : typeof error,
      });
      return [...candidates];
    }
  }
  const { out, flagged } = applyCanonFlags(candidates, canon, pairs, scores);
  input.logger.info("distill_jev_canon_conflict_applied", {
    candidate_count: candidates.length,
    corrections,
    pairs: pairs.length,
    flagged,
    skipped_no_embedding: skipped,
    canon_dimension_mismatch,
    rubric: JEV_CANON_CONFLICT_RUBRIC_VERSION,
  });
  return out;
}
