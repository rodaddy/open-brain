/**
 * Shared shapes for the self-contained context-pack section builders
 * (profile_guidance, process_guidance, repo_facts, pointers, candidate_memory).
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape").
 *
 * Each builder is decoupled from the pack orchestrator: it assembles ONE section
 * from an authorized namespace and an explicit selector, obeys the supplied
 * char/item budgets, emits a deterministic order, degrades content-free on
 * database failure, and returns a DEFINED empty state rather than fabricating
 * content. The orchestrator's job is only to fit the fragments into the shared
 * whole-pack budget and splice the envelope.
 *
 * The shape below mirrors what the durable-lane loader already produces, so
 * every section — loaded or computed — is admitted through one code path.
 */

/** One assembled section fragment: its body plus its envelope contributions. */
export type SectionFragment = {
  /** The assembled section body. Omitted ONLY on hard internal error. */
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
 * The minimal query surface a section reader needs. It matches the pg
 * `Pool.query` signature, so the real pool, a pooled client, or a fake all
 * satisfy it — which is what lets these builders be tested without a database.
 */
export type SectionQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type SectionReaderDeps = {
  query: SectionQuery;
};

/** Per-section item bounds. Callers may TIGHTEN a default, never widen it. */
export type SectionBudget = {
  /** Hard cap on items included (after ordering). */
  maxItems?: number;
  /** Hard cap on characters for each item's primary text field. */
  maxItemChars?: number;
};

/**
 * Clamp a string to `maxChars`.
 *
 * Returns `null` with `truncated: true` when the input is a non-empty string a
 * zero/negative budget cannot admit — that distinction is what lets a caller
 * record "there was content and it did not fit" WITHOUT leaking the content, as
 * opposed to an empty field that reads as "there was nothing".
 */
export function boundedItemText(
  value: unknown,
  maxChars: number,
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) {
    return { text: null, truncated: false };
  }
  if (maxChars <= 0) return { text: null, truncated: true };
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Resolve an effective item budget from a supplied budget and module defaults.
 *
 * `Math.min` against the defaults is the direction that matters: a caller can
 * only ask for LESS than the module allows. A caller passing 0 gets an explicit
 * empty section, never an unbounded one.
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

/**
 * A content-free degraded-source fragment for database-unavailable paths.
 *
 * No section body: there is genuinely nothing to report, and emitting an empty
 * items array here would be indistinguishable from a successful read that found
 * nothing. The degraded marker is the whole story.
 */
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
