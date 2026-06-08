import type { Table } from "../types.ts";

/** Valid cognitive tier values, shared across search-brain and list-recent */
export const VALID_TIERS: Set<string> = new Set<string>([
  "hot",
  "warm",
  "cold",
]);

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

/** Valid session event types */
export const EVENT_TYPES = [
  "fact",
  "decision",
  "blocker",
  "action",
  "artifact",
  "receipt",
  "question",
  "correction",
  "handoff",
] as const;

/** Valid event importance levels */
export const IMPORTANCE_LEVELS = ["hot", "warm", "cold"] as const;

/** Table alias used in CTE/SELECT queries */
export const TABLE_ALIAS: Record<Table, string> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

/**
 * All valid link relation types for the entity graph.
 * Keep in sync with CHECK (relation IN (...)) in 010_entity_links.sql
 * and LinkRelation type in ../types.ts.
 */
export const LINK_RELATIONS = [
  "artifact",
  "depends_on",
  "supersedes",
  "caused_by",
  "same_lane",
  "adjacent",
  "mentions",
  "implemented_by",
  "blocked_by",
  "decided_by",
  "relates_to",
  "contradicts",
  "duplicates",
] as const;
