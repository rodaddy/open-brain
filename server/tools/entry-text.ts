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
      // Deliberate fail-open, per the doc comment at :15-16: a damaged legacy
      // value collapses to `[]` so the caller degrades to "no optional field"
      // instead of aborting a scan on one bad row. This module is pure and
      // import-free, mirroring embedding/embedding-canonical.ts:61.
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item): item is string => typeof item === "string");
}

/**
 * Render one canonical text field from an untyped column value.
 *
 * Mirrors `canonicalField` in `server/embedding/embedding-canonical.ts`. A
 * string passes through unchanged, so every well-formed row produces exactly the
 * byte sequence it produced before this helper existed. `null`/`undefined` is
 * the empty string, as it always was. Anything else is rendered as JSON rather
 * than through the default object stringification, which turned an object into
 * `[object Object]` -- one indistinguishable token for every distinct object, so
 * two different damaged rows hashed the same. JSON keeps them distinguishable.
 * Primitives such as numbers and booleans render identically either way.
 */
function canonicalField(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Deduplicate and sort decision tags, matching the canonical builder. */
function normalizeDecisionTags(tags: string[]): string[] {
  return [...new Set(tags)].sort();
}

/** Canonical decision embed text and hash input. */
export function decisionCanonicalText(source: Record<string, unknown>): string {
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

/**
 * Canonical session HASH input -- deliberately distinct from the embed text.
 *
 * Sessions hash `summary|project` but embed a richer continuity text. Keeping
 * the two separate is what stops a freshly written session row from being read
 * as drifted by the repair registry.
 */
export function sessionSourceHashInput(source: Record<string, unknown>): string {
  const summary = canonicalField(source.summary);
  const project = canonicalField(source.project);
  return `${summary}|${project}`;
}

/** Canonical session EMBED text. */
export function sessionCanonicalEmbedText(source: Record<string, unknown>): string {
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
