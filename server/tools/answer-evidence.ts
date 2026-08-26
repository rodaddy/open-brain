/**
 * Pure evidence and citation shaping for `brain_answer`.
 *
 * Extracted from `brain-answer.ts` (#780) so the tool handler is left with
 * request handling and the retrieval call, and the reasoning about WHICH rows
 * are citable — and what the tool does not know about them — lives in one
 * testable place with no server or transport dependency.
 *
 * Nothing here paraphrases. Every function either selects a stored excerpt,
 * scores it, or states a caveat about it; the extractive constraint that makes
 * `brain_answer` traceable is preserved by construction.
 */
import type { SearchRow, SourceRef } from "./search-engine.ts";

/** Longest excerpt quoted per citation. */
const MAX_EXCERPT_CHARS = 500;

export interface Citation {
  index: number;
  source_ref: SourceRef;
  excerpt: string;
  score: number;
  stale: boolean;
}

export interface Evidence {
  row: SearchRow;
  excerpt: string;
  source_ref: SourceRef;
}

/** Retrieved rows split into citable evidence and the gaps that explain the rest. */
export interface EvidenceSelection {
  evidence: Evidence[];
  knownGaps: string[];
}

/**
 * Clamp a relevance score into a finite `[0,1]`.
 *
 * Neither raw input is bounded: `ts_rank_cd` is only *typically* below 1, and
 * cosine distance can exceed 1, which makes `1 - distance` negative. Clamping at
 * this consumer boundary keeps the emitted score a comparable relevance value
 * rather than an artifact of whichever arm produced it.
 */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Relevance score for one row, from whichever arm ranked it. */
export function scoreFor(row: SearchRow): number {
  return clampScore(
    row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5),
  );
}

/** Collapse whitespace and shorten one row's quotable excerpt. */
export function excerptFor(row: SearchRow): string | null {
  const excerpt = (row.content_preview ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
  return excerpt.length > 0 ? excerpt : null;
}

/**
 * Whether a row is older than the staleness window.
 *
 * A row with no usable timestamp counts as STALE. Age cannot be proven, and the
 * failure modes are asymmetric: flagging fresh evidence costs a caveat, while
 * silently presenting undateable evidence as current is the error this exists to
 * prevent.
 */
export function isStale(row: SearchRow, maxAgeDays: number): boolean {
  const raw = row.source_ref?.last_updated_at ?? row.source_ref?.created_at;
  if (!raw) return true;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() > maxAgeDays * 86_400_000;
}

/** Normalize a "use X" target so the two polarities compare on equal footing. */
function normalizeUseTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[`~"'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collect every normalized target matched by a polarity pattern. */
function useTargets(text: string, pattern: RegExp): Set<string> {
  const targets = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const target = normalizeUseTarget(match[1] ?? "");
    if (target) targets.add(target);
  }
  return targets;
}

/**
 * Detect evidence that both endorses and forbids the same target.
 *
 * A deliberately shallow lexical check, and it is reported as UNCERTAINTY rather
 * than resolved: two records saying "use X" and "never use X" are usually a
 * superseded decision, and picking a winner by recency would silently discard a
 * still-current constraint. The tool surfaces the conflict and lets the caller
 * decide.
 */
export function hasConflictingUseTargets(
  evidence: readonly Evidence[],
): boolean {
  const negative = new Set<string>();
  const affirmative = new Set<string>();
  for (const item of evidence) {
    const lower = item.excerpt.toLowerCase();
    for (const target of useTargets(
      lower,
      /\b(?:should not|must not|do not|don't|never)\s+use\s+([^.;,]+)/g,
    )) {
      negative.add(target);
    }
    for (const target of useTargets(
      lower,
      /\b(?<!not\s)(?:should\s+use|must\s+use|use)\s+([^.;,]+)/g,
    )) {
      affirmative.add(target);
    }
  }
  for (const target of negative) {
    if (affirmative.has(target)) return true;
  }
  return false;
}

/** The exact no-evidence gap sentence; frozen by the parity contract. */
export function gapMessage(query: string): string {
  return `No readable Open Brain evidence was found for: ${query}`;
}

/**
 * Split retrieved rows into citable evidence, recording why each rejection happened.
 *
 * A row without a `source_ref` or without usable preview text cannot be traced
 * back to a stored record, so it is dropped and NAMED in `knownGaps` rather than
 * silently omitted.
 */
export function selectEvidence(rows: readonly SearchRow[]): EvidenceSelection {
  const evidence: Evidence[] = [];
  const knownGaps: string[] = [];
  for (const row of rows) {
    const excerpt = excerptFor(row);
    if (!row.source_ref || !excerpt) {
      knownGaps.push(
        `Skipped ${row.source_type}:${row.id} because it lacked citation metadata or usable preview text.`,
      );
      continue;
    }
    evidence.push({ row, excerpt, source_ref: row.source_ref });
  }
  return { evidence, knownGaps };
}

/** Number every piece of selected evidence and attach its score and staleness. */
export function buildCitations(
  evidence: readonly Evidence[],
  maxAgeDays: number,
): Citation[] {
  return evidence.map((item, index) => ({
    index: index + 1,
    source_ref: item.source_ref,
    excerpt: item.excerpt,
    score: scoreFor(item.row),
    stale: isStale(item.row, maxAgeDays),
  }));
}

/**
 * State what the answer does NOT establish about its own evidence.
 *
 * Stale citations, self-contradicting wording, and rows dropped as uncitable are
 * each reported rather than resolved; removing any of them would leave a
 * confident-looking answer with its caveats stripped.
 */
export function uncertaintyFor(options: {
  citations: readonly Citation[];
  evidence: readonly Evidence[];
  retrievedCount: number;
  maxAgeDays: number;
}): string[] {
  const { citations, evidence, retrievedCount, maxAgeDays } = options;
  const uncertainty: string[] = [];
  const staleCount = citations.filter((citation) => citation.stale).length;
  if (staleCount > 0) {
    uncertainty.push(
      `${staleCount} cited entr${staleCount === 1 ? "y is" : "ies are"} older than ${maxAgeDays} days or missing a usable timestamp.`,
    );
  }
  if (hasConflictingUseTargets(evidence)) {
    uncertainty.push(
      "Retrieved evidence contains both affirmative and negative wording; verify whether these are truly contradictory before treating this as settled.",
    );
  }
  if (evidence.length < retrievedCount) {
    uncertainty.push(
      "Some retrieved rows were omitted because they were not safe to cite.",
    );
  }
  return uncertainty;
}

/**
 * The extractive answer body.
 *
 * Every bullet is a stored excerpt followed by the index of the citation it came
 * from. No sentence originates in this tool.
 */
export function renderAnswer(citations: readonly Citation[]): string {
  return [
    "Cited Open Brain evidence:",
    "",
    ...citations.map((citation) => `- ${citation.excerpt} [${citation.index}]`),
  ].join("\n");
}
