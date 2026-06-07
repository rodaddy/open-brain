import type { Table } from "../types.ts";

/** Valid cognitive tier values, shared across search-brain and list-recent */
export const VALID_TIERS: Set<string> = new Set<string>([
  "hot",
  "warm",
  "cold",
]);

/**
 * All five brain tables.
 *
 * Every table shares these columns added by migrations 001 and 002:
 *   - access_count (integer, default 0)
 *   - usefulness_score (float, nullable)
 *   - tags (text[], nullable)
 *   - last_accessed_at (timestamptz, nullable)
 */
export const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

/** Singular labels for search/list results */
export const SOURCE_LABELS: Record<Table, string> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/**
 * Content preview SQL expression per table.
 * Each produces a single text column normalized for search results.
 * Uses COALESCE for null safety on nullable columns.
 */
export const CONTENT_PREVIEW: Record<Table, string> = {
  thoughts: "t.content",
  decisions: "d.title || ': ' || COALESCE(d.rationale, '')",
  relationships: "r.person_name || ': ' || COALESCE(r.context, '')",
  projects: "p.name || ': ' || COALESCE(p.description, '')",
  sessions:
    "COALESCE(s.project || ': ', '') || LEFT(s.summary, 300)" +
    " || CASE WHEN s.key_decisions IS NOT NULL AND array_length(s.key_decisions, 1) > 0" +
    " THEN E'\\nDecisions: ' || immutable_array_to_string(s.key_decisions, '; ') ELSE '' END" +
    " || CASE WHEN s.next_steps IS NOT NULL AND array_length(s.next_steps, 1) > 0" +
    " THEN E'\\nNext: ' || immutable_array_to_string(s.next_steps, '; ') ELSE '' END",
};

/** Table alias used in CTE/SELECT queries */
export const TABLE_ALIAS: Record<Table, string> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

/**
 * Namespace validation regex: only allows alphanumeric, hyphens, underscores, dots.
 * Prevents SQL injection when namespace is interpolated into CTE queries.
 * Matches real values: "skippy", "collab", "rico", "geetesh"
 */
const VALID_NAMESPACE_RE = /^[a-zA-Z0-9_\-\.]+$/;

/**
 * Sanitize and validate a namespace value for safe SQL interpolation.
 * Returns the namespace if valid, or throws on invalid input.
 */
export function sanitizeNamespace(namespace: string): string {
  const trimmed = namespace.trim();
  if (!trimmed || trimmed.length > 64 || !VALID_NAMESPACE_RE.test(trimmed)) {
    throw new Error(`Invalid namespace: must be 1-64 alphanumeric/hyphen/underscore characters`);
  }
  return trimmed;
}
