/**
 * Canonical embed-text and source-hash builders shared by the live write paths
 * and the embedding-repair registry. These helpers are the ONE implementation
 * both sides call, and every function here is pure and free of DB/provider
 * imports so the repair registry and the tool handlers can import it without a
 * cycle; where a value cannot be decoded it exposes a predicate
 * (`undecidableStringArray`) rather than logging.
 *
 * See docs/decisions/embedding-canonical-one-implementation-both-sides.md
 */

/**
 * Coerce a `jsonb` array column (e.g. `decisions.alternatives`) or an in-memory
 * `string[]` argument into a `string[]`. Anything that is not a usable array of
 * strings collapses to `[]`; this never throws. The one collapse that is not
 * benign -- a non-empty string that fails to parse -- is made detectable via
 * `undecidableStringArray()` below rather than logged or thrown.
 *
 * See docs/decisions/embedding-canonical-one-implementation-both-sides.md
 */
export function coerceStringArray(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    // A jsonb column occasionally surfaces as its raw JSON text; try to parse.
    try {
      v = JSON.parse(v);
    } catch {
      // Deliberate fail-open, per the doc comment above: the caller with a
      // logger asks the same question through undecidableStringArray (:81) and
      // reports it, so this stays pure and never aborts a repair scan.
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

/**
 * Would `coerceStringArray(value)` drop content it could not decide about?
 *
 * True ONLY for a non-empty string that is not parseable JSON -- the one input
 * whose collapse to `[]` may lose real content and therefore change the
 * canonical text and its hash. Every other collapse (`null`, a number, an
 * object, a parseable non-array) is an honest empty answer and returns false.
 *
 * Pure and import-free, like everything else here, so the callers that DO have a
 * logger can ask the question and report it. Keeping the predicate next to the
 * coercion is what stops the two from drifting apart.
 */
export function undecidableStringArray(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  try {
    JSON.parse(value);
    return false;
  } catch {
    // Deliberate: the parse failure is the predicate's answer, not an error.
    // canonicalDroppedFields (:103) turns it into the reported field list.
    return true;
  }
}

/**
 * Which fields of a row would silently lose content on the way into the
 * canonical text. Empty means the canonical text is trustworthy.
 *
 * The repair path calls this before treating a hash mismatch as `source_drift`,
 * so a damaged legacy row is reported as damaged instead of being re-embedded
 * and re-keyed on every pass.
 */
export function undecidableCanonicalFields(source: Record<string, unknown>): string[] {
  // Every field either builder feeds through coerceStringArray.
  const fields = ["alternatives", "tags", "key_decisions", "next_steps", "blockers"];
  return fields.filter((field) => undecidableStringArray(source[field]));
}

/**
 * Render one canonical text field from an untyped column value.
 *
 * Mirrored byte-for-byte by `canonicalField` in `server/tools/entry-text.ts`; the
 * two must change together for the same reason every other formula here must.
 *
 * A string passes through unchanged, so every well-formed row produces exactly
 * the byte sequence it produced before this helper existed and no stored
 * `content_hash` moves. `null`/`undefined` is the empty string, as it always
 * was. Anything else renders as JSON rather than through default object
 * stringification, which collapsed every distinct object to the single token
 * `[object Object]` -- so two damaged rows with different content hashed
 * identically and were indistinguishable to the repair registry. JSON keeps them
 * apart. Primitives such as numbers and booleans render identically either way.
 */
function canonicalField(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface DecisionSource {
  title?: unknown;
  rationale?: unknown;
  /** `string[]` from the tool arg, or a parsed `jsonb` value from the row. */
  context?: unknown;
  alternatives?: unknown;
  tags?: unknown;
}

/**
 * Deterministically normalize a decision tag set: dedupe and sort into a fixed
 * codepoint order WITHOUT mutating the caller's input. Returns a fresh array.
 * This is the owning-boundary rule for tag order in the canonical text; the
 * stored `tags` COLUMN is unaffected.
 *
 * See docs/decisions/embedding-canonical-decision-tags-are-order-independent.md
 */
function normalizeDecisionTags(tags: string[]): string[] {
  return [...new Set(tags)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Canonical decision text. Decisions embed and hash the SAME string, so this is
 * both the embed text and the source-hash input. Mirrors log_decision / the
 * REST POST /decisions writer exactly, EXCEPT that the tag segment is
 * order-independent:
 *
 *   [title, rationale, context?, alternatives.join(", ")?,
 *    normalizeDecisionTags(tags).join(" ")?].join("\n")
 *
 * Optional fields are appended only when present/non-empty, in this fixed order.
 * `alternatives` is joined with ", " (comma + space); `tags` are deduped, sorted
 * (see normalizeDecisionTags — closes the array_agg(DISTINCT) drift, #345/#356),
 * then joined with " " (space). `alternatives` keeps caller order because its
 * ON CONFLICT merge does not reorder it; only `tags` is merged via array_agg.
 */
export function decisionCanonicalText(source: DecisionSource): string {
  const title = canonicalField(source.title);
  const rationale = canonicalField(source.rationale);
  const parts: string[] = [title, rationale];

  const context = typeof source.context === "string" ? source.context : undefined;
  if (context) parts.push(context);

  const alternatives = coerceStringArray(source.alternatives);
  if (alternatives.length) parts.push(alternatives.join(", "));

  const tags = normalizeDecisionTags(coerceStringArray(source.tags));
  if (tags.length) parts.push(tags.join(" "));

  return parts.join("\n");
}

export interface SessionSource {
  summary?: unknown;
  project?: unknown;
  key_decisions?: unknown;
  next_steps?: unknown;
  blockers?: unknown;
}

/**
 * Canonical session source-hash INPUT. Every session writer
 * (session_save / session_wrap / REST POST /sessions) hashes
 * `summary + "|" + project`, so repair must recompute the same string or it
 * flags every session as drifted. This is the hash input ONLY -- the embed text
 * is richer (see sessionEmbedText).
 */
export function sessionSourceHashInput(source: SessionSource): string {
  const summary = canonicalField(source.summary);
  const project = canonicalField(source.project);
  return `${summary}|${project}`;
}

/**
 * Canonical session EMBED text. Distinct from the hash input: the writers embed
 * the summary plus any structured continuity fields so search matches on them:
 *
 *   [summary, key_decisions.join(". ")?, next_steps.join(". ")?,
 *    blockers.join(". ")?].join("\n")
 *
 * Each optional array is appended only when non-empty, in this fixed order,
 * joined with ". " (period + space). session_wrap has no `blockers` field; it
 * simply passes none and that segment is omitted -- the function is total over
 * whichever fields a caller has.
 */
export function sessionEmbedText(source: SessionSource): string {
  const summary = canonicalField(source.summary);
  const parts: string[] = [summary];

  const keyDecisions = coerceStringArray(source.key_decisions);
  if (keyDecisions.length) parts.push(keyDecisions.join(". "));

  const nextSteps = coerceStringArray(source.next_steps);
  if (nextSteps.length) parts.push(nextSteps.join(". "));

  const blockers = coerceStringArray(source.blockers);
  if (blockers.length) parts.push(blockers.join(". "));

  return parts.join("\n");
}
