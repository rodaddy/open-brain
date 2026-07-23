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
 * registry and the tool handlers can import it without cycles.
 */

/**
 * Coerce a `jsonb` array column (e.g. `decisions.alternatives`) or an in-memory
 * `string[]` argument into a `string[]`. node-postgres parses a jsonb column
 * into a JS value, so a healthy row arrives as an array; but a legacy row could
 * hold a JSON-encoded string, `null`, or a non-array jsonb scalar. This never
 * throws: anything that is not a usable array of strings collapses to `[]` so
 * the caller degrades to "no optional field" rather than corrupting the hash.
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

  const context =
    typeof source.context === "string" ? source.context : undefined;
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
