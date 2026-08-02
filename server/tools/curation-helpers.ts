/**
 * Shared curation/tiering primitives for the server rewrite.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` (tier
 * model, `entry_access_log` as a log rather than a counter) and
 * `docs/dream-design.md`.
 */
import { z } from "zod";
import type { ResourceTable } from "../auth/types.ts";

/**
 * The ONLY table names permitted in an interpolated SQL position.
 *
 * Table names cannot be bound as parameters, so every curation query
 * interpolates one. That is safe only because the value is first narrowed by
 * `tableEnum` below, which is the Zod-enum allowlist the repo security rules
 * require: a value that is not one of these five never reaches SQL.
 */
export const ALL_TABLES = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const satisfies readonly ResourceTable[];

/** Zod-enum allowlist gate for every table-name interpolation. */
export const tableEnum = z.enum(ALL_TABLES);

/** Cognitive tiers from `006_cognitive_tiering.sql`. */
export const TIERS = ["hot", "warm", "cold"] as const;
export const tierEnum = z.enum(TIERS);
export type Tier = (typeof TIERS)[number];

/**
 * Singular `source_type` label per table, as observed in current-src.
 *
 * These are emitted as SQL string literals in UNION arms, so they are frozen
 * wire values: a client switching on `source_type` sees `thought`, not
 * `thoughts`.
 */
export const SOURCE_LABELS: Readonly<Record<ResourceTable, string>> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/**
 * Content preview SQL expression per table, unqualified.
 *
 * These mirror the observed current-src expressions in
 * `src/tools/curate-entries.ts` exactly, including the `sessions` `LEFT(...)`
 * call. They are frozen observed behavior reproduced for parity.
 */
export const CONTENT_PREVIEW: Readonly<Record<ResourceTable, string>> = {
  thoughts: "content",
  decisions: "title || ': ' || rationale",
  relationships: "person_name || ': ' || COALESCE(context, '')",
  projects: "name || ': ' || COALESCE(description, '')",
  sessions: "COALESCE(project || ': ', '') || LEFT(summary, 200)",
};

/**
 * Re-target an auth-derived namespace predicate at an aliased column.
 *
 * The foundation builder emits an unqualified `namespace` column, which is
 * ambiguous in a self-join (`curate_entries` duplicate detection joins a table
 * to itself). Rebuilding the clause from the builder's own parameter values
 * keeps the auth derivation authoritative while qualifying the column, instead
 * of string-patching the emitted SQL -- rewriting the builder's output would
 * silently fall back to an unqualified predicate if that string ever changed.
 *
 * @param predicate Clause and values from `namespacePredicate`.
 * @param column Alias-qualified column the predicate applies to.
 * @param startParameter Placeholder index the values begin at.
 * @returns The same namespace rule, bound to the qualified column.
 */
export function qualifyNamespacePredicate(
  predicate: { readonly clause: string; readonly values: readonly unknown[] },
  column: string,
  startParameter: number,
): string {
  if (predicate.values.length === 0) return "";
  return ` AND ${column} = ANY($${startParameter}::text[])`;
}

/** Observed current-src curation thresholds. */
export const DUPLICATE_THRESHOLD = 0.08;
export const STALE_DAYS = 90;

/** Preview width current-src slices each curation row to. */
export const PREVIEW_WIDTH = 200;

/** @returns The row preview sliced to the observed current-src width. */
export function previewOf(value: unknown): string {
  return String(value ?? "").slice(0, PREVIEW_WIDTH);
}
