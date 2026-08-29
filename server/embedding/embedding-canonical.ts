/**
 * Canonical embed-text and source-hash builders shared by the live write paths
 * and the embedding-repair registry.
 *
 * The stale-embedding repair primitive (src/embedding-repair.ts) decides that a
 * row drifted by recomputing its source hash and comparing it to the stored
 * `content_hash`, and regenerates the embedding from the embed text. If the
 * repair side and the write side compute either string differently -- even by a
 * separator -- repair will (a) falsely flag freshly written rows as drifted,
 * (b) regenerate a DIFFERENT embedding than the writer produced, and (c) write a
 * different `content_hash`, corrupting the dedup key. These helpers are the ONE
 * implementation both sides call, so a formula can only change in a single place.
 *
 * Keep every function here pure and free of DB/provider imports so both the
 * registry and the tool handlers can import it without cycles. That rule is why
 * this module reports nothing itself; where a value cannot be decoded, it
 * exposes a predicate (`undecidableStringArray`) so the callers that do have a
 * logger can report it. See coerceStringArray for the one case that matters.
 */

/**
 * Coerce a `jsonb` array column (e.g. `decisions.alternatives`) or an in-memory
 * `string[]` argument into a `string[]`. node-postgres parses a jsonb column
 * into a JS value, so a healthy row arrives as an array; but a legacy row could
 * hold a JSON-encoded string, `null`, or a non-array jsonb scalar. This never
 * throws: anything that is not a usable array of strings collapses to `[]` so
 * the caller degrades to "no optional field".
 *
 * ONE COLLAPSE IS NOT BENIGN, AND IT IS NOT SILENT ANY MORE.
 *
 * The other collapses are honest: `null`, a number, or an object genuinely
 * carries no strings, so `[]` is the true answer and the hash built from it is
 * the right hash. But a value that is a non-empty STRING which fails to parse is
 * different -- it may well be an array whose text is damaged, and collapsing it
 * drops content that belongs in the canonical text. Since the canonical text is
 * what `content_hash` is baked from, that row then hashes differently here than
 * its writer computed, which the embedding-repair registry reads as
 * `source_drift`: it regenerates a different vector and rewrites the dedup key,
 * every pass, forever. That is the exact corruption this module exists to
 * prevent, and the header's claim that collapsing degrades "rather than
 * corrupting the hash" was wrong for this one case.
 *
 * This module cannot log it: the file header requires it stay pure and
 * import-free so the repair registry and the tool handlers can both import it
 * without a cycle. So instead of logging, the case is made DETECTABLE --
 * `undecidableStringArray()` below answers the same question without a logger,
 * and `src/embedding-repair.ts` consults it and reports before it can be
 * mistaken for drift.
 *
 * It also deliberately does NOT throw. `target.sourceHash(row)` is called inside
 * the drift-detection loop with no try/catch, so throwing here would abort an
 * entire repair scan on one damaged legacy row -- turning a one-row problem into
 * a total outage. Detectable-and-reported is the correct shape; fail-fast is not.
 */
export function coerceStringArray(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    // A jsonb column occasionally surfaces as its raw JSON text; try to parse.
    try {
      v = JSON.parse(v);
    } catch {
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
 * order WITHOUT mutating the caller's input. Returns a fresh array.
 *
 * This is the owning-boundary rule for tag order in the canonical text. The
 * decision `content_hash` is baked from this text at INSERT time, but the
 * `ON CONFLICT DO UPDATE` merge stores `array_agg(DISTINCT tag)`, whose order is
 * NOT guaranteed by Postgres. If the canonical text folded tags in raw array
 * order, a post-conflict row (with its arbitrarily-ordered merged tags) would
 * recompute a different source hash than the stored one and the embedding-repair
 * registry would flag it as false `source_drift` — regenerating a different
 * vector and rewriting the dedup key on every repair pass (churn).
 *
 * Sorting by codepoint order (a strict total order — no locale/collation
 * ambiguity that could tie two distinct tags and leave their relative order
 * platform-dependent) makes the folded tag segment identical for any permutation
 * or duplication of the same tag set, so the INSERT hash, the merged-row repair
 * recompute, and the update_entry writer all converge on one string regardless
 * of tag ordering. The stored `tags` COLUMN is unaffected — only the string fed
 * to embed/hash is normalized.
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
  const title = source.title == null ? "" : String(source.title);
  const rationale = source.rationale == null ? "" : String(source.rationale);
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
  const summary = source.summary == null ? "" : String(source.summary);
  const project = source.project == null ? "" : String(source.project);
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
  const summary = source.summary == null ? "" : String(source.summary);
  const parts: string[] = [summary];

  const keyDecisions = coerceStringArray(source.key_decisions);
  if (keyDecisions.length) parts.push(keyDecisions.join(". "));

  const nextSteps = coerceStringArray(source.next_steps);
  if (nextSteps.length) parts.push(nextSteps.join(". "));

  const blockers = coerceStringArray(source.blockers);
  if (blockers.length) parts.push(blockers.join(". "));

  return parts.join("\n");
}
