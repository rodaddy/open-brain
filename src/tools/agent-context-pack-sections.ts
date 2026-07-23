// Shared shapes and helpers for the standalone agent-context-pack section
// modules (profile_guidance, process_guidance, repo_facts).
//
// These modules are intentionally decoupled from agent-context-pack.ts: each
// builds one self-contained section fragment from an authorized namespace and
// an explicit selector, obeys supplied char/item budgets, emits a deterministic
// order, degrades content-free on database failure, and returns a defined empty
// state rather than fabricating guidance. Wiring these fragments into the pack
// envelope (and prompt placement) is deliberately out of scope for this change.

/**
 * A single assembled context-pack section fragment. The shape mirrors the
 * envelope fields already produced by loadDurableLaneContext so a future caller
 * can splice section/warnings/budget/citations without reshaping.
 */
export type SectionFragment = {
  /** The assembled section body, omitted only on hard internal error. */
  section?: Record<string, unknown>;
  /** Exact-binding / authorization denials, content-free. */
  scopeDenials: Array<Record<string, unknown>>;
  /** Char/item truncation notices, content-free. */
  truncation: Array<Record<string, unknown>>;
  /** Degraded sources (e.g. database_unavailable), content-free. */
  degradedSources: Array<Record<string, unknown>>;
  /** Budget accounting for this section. */
  budget: Record<string, unknown>;
  /** Source citations for every included item. */
  citations: Array<Record<string, unknown>>;
};

/**
 * Minimal query surface a section reader needs. Matches the pg Pool.query
 * signature used elsewhere so the real pool, a pooled client, or a fake
 * transport can all satisfy it.
 */
export type SectionQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type SectionReaderDeps = {
  query: SectionQuery;
};

/** Per-section item budget defaults; callers may tighten via SectionBudget. */
export type SectionBudget = {
  /** Hard cap on items included in the section (after ordering). */
  maxItems?: number;
  /** Hard cap on characters for each item's primary text field. */
  maxItemChars?: number;
};

/**
 * Clamp a string to maxChars. Returns null (with truncated=true) when the input
 * is a non-empty string that a zero/negative budget cannot admit, so callers can
 * record the omission without leaking the content.
 */
export function boundedItemText(
  value: unknown,
  maxChars: number,
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) {
    return { text: null, truncated: false };
  }
  if (maxChars <= 0) {
    return { text: null, truncated: true };
  }
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Resolve an effective item budget from a supplied budget and module defaults.
 * Never returns negative values; a caller passing 0 gets an explicit empty
 * section, not an unbounded one.
 */
export function resolveItemBudget(
  supplied: SectionBudget | undefined,
  defaults: { maxItems: number; maxItemChars: number },
): { maxItems: number; maxItemChars: number } {
  const maxItems = Math.max(
    0,
    Math.min(defaults.maxItems, supplied?.maxItems ?? defaults.maxItems),
  );
  const maxItemChars = Math.max(
    0,
    Math.min(
      defaults.maxItemChars,
      supplied?.maxItemChars ?? defaults.maxItemChars,
    ),
  );
  return { maxItems, maxItemChars };
}

/** A content-free degraded-source fragment for database-unavailable paths. */
export function databaseUnavailableFragment(
  source: string,
  budget: Record<string, unknown>,
): SectionFragment {
  return {
    scopeDenials: [],
    truncation: [],
    degradedSources: [{ source, reason: "database_unavailable" }],
    budget,
    citations: [],
  };
}
