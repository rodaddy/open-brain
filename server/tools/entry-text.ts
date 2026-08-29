/**
 * Canonical embed-text and source-hash builders for entry rewrites.
 *
 * These mirror `server/embedding/embedding-canonical.ts` byte-for-byte. The embedding-repair
 * registry decides a row drifted by recomputing its source hash and comparing
 * it to the stored `content_hash`, so a writer that builds either string
 * differently -- even by one separator -- makes every row it writes look
 * drifted, regenerate a different vector, and rewrite the dedup key on every
 * repair pass. Any change here must land in both places together.
 */

/**
 * Coerce a `jsonb` array column or an in-memory `string[]` into a `string[]`.
 *
 * Never throws: a damaged legacy value collapses to `[]` so the caller degrades
 * to "no optional field" instead of aborting a scan on one bad row.
 */
export function coerceStringArray(value: unknown): string[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item): item is string => typeof item === "string");
}

/** Deduplicate and sort decision tags, matching the canonical builder. */
function normalizeDecisionTags(tags: string[]): string[] {
  return [...new Set(tags)].sort();
}

/** Canonical decision embed text and hash input. */
export function decisionCanonicalText(source: Record<string, unknown>): string {
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

/**
 * Canonical session HASH input -- deliberately distinct from the embed text.
 *
 * Sessions hash `summary|project` but embed a richer continuity text. Keeping
 * the two separate is what stops a freshly written session row from being read
 * as drifted by the repair registry.
 */
export function sessionSourceHashInput(source: Record<string, unknown>): string {
  const summary = source.summary == null ? "" : String(source.summary);
  const project = source.project == null ? "" : String(source.project);
  return `${summary}|${project}`;
}

/** Canonical session EMBED text. */
export function sessionCanonicalEmbedText(source: Record<string, unknown>): string {
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
