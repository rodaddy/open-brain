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

/**
 * FTS source-text SQL expression per table -- the exact text the stored
 * `search_vector` generated column analyzes.
 *
 * The stored column's CURRENT definition is migration 007_search_improvements
 * (which dropped and rebuilt every `search_vector` from 005_fts_hybrid to also
 * fold in `tags`), so each expression here mirrors 007 exactly, INCLUDING the
 * trailing `immutable_array_to_string(tags, ' ')` term. This MUST stay
 * byte-for-byte aligned with the `to_tsvector(...)` argument in the migration
 * that currently owns the column, or the language-aware path would analyze
 * strictly less text than the english default -- silently dropping tag-token
 * recall for non-english corpora.
 *
 * It is used only on the language-aware FTS path, where the lexical arm
 * recomputes `to_tsvector(<config>, <this expression>)` on the fly so a
 * non-english corpus config analyzes the same text the english stored column
 * would -- just under the corpus's configuration. The english default path
 * never uses this; it keeps using the GIN-indexed stored column.
 *
 * Column aliases here (`t.`, `d.`, ... per TABLE_ALIAS) match the FROM aliases
 * in buildFtsCTE; the migration uses unqualified names because it runs inside
 * the table's own generated-column context.
 */
export const FTS_SOURCE_TEXT: Record<Table, string> = {
  thoughts:
    "COALESCE(t.content, '') || ' ' || " +
    "COALESCE(immutable_array_to_string(t.tags, ' '), '')",
  decisions:
    "COALESCE(d.title, '') || ' ' || COALESCE(d.rationale, '') || ' ' || " +
    "COALESCE(d.context, '') || ' ' || " +
    "COALESCE(immutable_array_to_string(d.tags, ' '), '')",
  relationships:
    "COALESCE(r.person_name, '') || ' ' || COALESCE(r.context, '') || ' ' || " +
    "COALESCE(immutable_array_to_string(r.tags, ' '), '')",
  projects:
    "COALESCE(p.name, '') || ' ' || COALESCE(p.description, '') || ' ' || " +
    "COALESCE(immutable_array_to_string(p.tags, ' '), '')",
  sessions:
    "COALESCE(s.summary, '') || ' ' || " +
    "COALESCE(immutable_array_to_string(s.next_steps, ' '), '') || ' ' || " +
    "COALESCE(immutable_array_to_string(s.key_decisions, ' '), '') || ' ' || " +
    "COALESCE(immutable_array_to_string(s.tags, ' '), '')",
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
 * (extended by 018_link_relation_supplements.sql) and LinkRelation type in
 * ../types.ts.
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
  "supplements",
] as const;
