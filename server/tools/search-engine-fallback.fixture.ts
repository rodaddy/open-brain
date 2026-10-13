/**
 * The one fixture the scoped-fallback suite is driven from.
 *
 * Issue 841 cut 1 used it to compare the ported modern fallback against the
 * legacy executors (retired in issue 841 cut 3); the row ids that comparison
 * proved are now stated here directly, as {@link EXPECTED_TOPPED_UP_IDS} and
 * {@link EXPECTED_NO_TOPUP_IDS}, so the suite pins the modern engine without a
 * second implementation to ask.
 *
 * The stub pool answers on the NAMESPACE PARAMETER rather than on SQL text,
 * which keeps this file a statement about namespaces and stops it breaking when
 * the engine's query changes shape.
 */

export const PHYSICAL_SHARED = "shared-kb";
export const LEGACY_SHARED = "collab";
export const PRIVATE_NAMESPACE = "rico-private";

/** The caller's readable set: their own namespace plus the shared one. */
export const SCOPE = [PRIVATE_NAMESPACE, PHYSICAL_SHARED];

/** A row shaped enough for merge, canonicalization, and id comparison. */
function row(id: string, namespace: string): Record<string, unknown> {
  return {
    source_type: "thoughts",
    id,
    namespace,
    content_preview: `preview ${id}`,
    tags: null,
    created_by: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: null,
    usefulness: 1,
    tier: "warm",
    fts_rank: 1,
    access_count: 0,
  };
}

/**
 * Rows keyed by the namespace the query asked for.
 *
 * The primary arm (the caller's two-namespace scope) is RICH at three rows; the
 * shared arm alone is THIN at one, below `fallbackMinResults`. That is the shape
 * that makes the top-up fire, and it is the shape a wrong gate misreads.
 */
const ROWS_BY_NAMESPACE = new Map<string, Record<string, unknown>[]>([
  [
    SCOPE.join("|"),
    [
      row("11111111-1111-4111-8111-111111111111", PRIVATE_NAMESPACE),
      row("22222222-2222-4222-8222-222222222222", PRIVATE_NAMESPACE),
      row("33333333-3333-4333-8333-333333333333", PHYSICAL_SHARED),
    ],
  ],
  [PHYSICAL_SHARED, [row("33333333-3333-4333-8333-333333333333", PHYSICAL_SHARED)]],
  [LEGACY_SHARED, [row("44444444-4444-4444-8444-444444444444", LEGACY_SHARED)]],
]);

/** Row ids the fixture holds for one namespace key, in fixture order. */
function idsFor(key: string): string[] {
  return (ROWS_BY_NAMESPACE.get(key) ?? []).map((row) => row.id as string);
}

/** The single legacy-namespace row a licensed top-up contributes. */
export const LEGACY_ROW_ID = idsFor(LEGACY_SHARED)[0] as string;

/**
 * What the scoped fallback must return when the shared arm is thin: the
 * primary scope's rows, then the legacy namespace's top-up appended.
 *
 * Derived from the fixture rows rather than written out, so a fixture edit
 * cannot leave the expectation behind.
 */
export const EXPECTED_TOPPED_UP_IDS: string[] = [
  ...idsFor(SCOPE.join("|")),
  ...idsFor(LEGACY_SHARED),
];

/**
 * What it must return when the gate says no top-up: the primary scope's rows
 * alone, with nothing from the legacy namespace.
 */
export const EXPECTED_NO_TOPUP_IDS: string[] = idsFor(SCOPE.join("|"));

/** The namespace a query is scoped to, read off its bound parameters. */
function namespaceKeyOf(params: unknown[] | undefined): string | undefined {
  for (const param of params ?? []) {
    if (typeof param === "string" && ROWS_BY_NAMESPACE.has(param)) {
      return param;
    }
    if (Array.isArray(param)) {
      const key = param.join("|");
      if (ROWS_BY_NAMESPACE.has(key)) return key;
    }
  }
  return undefined;
}

/** A pool that answers on the namespace parameter and nothing else. */
export function fixturePool(): {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  return {
    query: async (_text: string, params?: unknown[]) => {
      const key = namespaceKeyOf(params);
      return { rows: key === undefined ? [] : (ROWS_BY_NAMESPACE.get(key) ?? []) };
    },
  };
}
