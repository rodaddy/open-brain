/**
 * Shared table shape constants for the search and recall arms.
 *
 * These strings are SQL fragments, so two rules govern the whole file:
 *
 * - Nothing here is caller-supplied. Every value is a compile-time literal
 *   selected by a validated table name, so interpolating them is the same
 *   discipline the repo already applies to table names. Query text, namespaces,
 *   and scope values stay parameterized at the call site.
 * - `FTS_SOURCE_TEXT` must stay byte-aligned with the migration that owns the
 *   stored `search_vector` column. See the note on that constant.
 */
import type { ResourceTable } from "../auth/types.ts";

/** Cognitive tiers a row may carry. */
export const VALID_TIERS: ReadonlySet<string> = new Set([
  "hot",
  "warm",
  "cold",
]);

export type Tier = "hot" | "warm" | "cold";

/** Content tables searched by every arm, in stable order. */
export const ALL_TABLES: readonly ResourceTable[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

/** Singular result labels; the wire `source_type` of a row. */
export const SOURCE_LABELS: Readonly<Record<ResourceTable, string>> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/** FROM-clause alias per table; referenced by every fragment below. */
export const TABLE_ALIAS: Readonly<Record<ResourceTable, string>> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

/**
 * Single normalized preview column per table. COALESCE guards every nullable
 * column so a null field cannot collapse the whole concatenation to NULL.
 */
export const CONTENT_PREVIEW: Readonly<Record<ResourceTable, string>> = {
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
 * The exact text the stored `search_vector` generated column analyzes.
 *
 * This MUST stay byte-for-byte aligned with the `to_tsvector(...)` argument in
 * the migration that currently owns the column (007_search_improvements, which
 * rebuilt every `search_vector` from 005_fts_hybrid to also fold in `tags`),
 * INCLUDING the trailing `immutable_array_to_string(tags, ' ')` term.
 *
 * Only the language-aware path reads it: a non-english configuration recomputes
 * `to_tsvector(<config>, <this expression>)` on the fly so it analyzes the same
 * text the english stored column would, under its own configuration. If this
 * drifted from the migration, a non-english corpus would silently analyze less
 * text than english does and lose tag-token recall. The english default never
 * uses these expressions -- it reads the GIN-indexed stored column directly.
 *
 * Aliases are qualified here (per TABLE_ALIAS) because these appear in a FROM
 * clause; the migration uses bare names inside the table's own generated-column
 * context.
 */
export const FTS_SOURCE_TEXT: Readonly<Record<ResourceTable, string>> = {
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

/**
 * Tables carrying an `extracted_metadata` column.
 *
 * Verified against the live schema, not inferred: `information_schema.columns`
 * reports `extracted_metadata` on exactly `thoughts` and `decisions`. Every
 * other table selects `NULL::jsonb` for that slot so the UNION arms stay
 * type-compatible. Naming a table here that lacks the column produces a runtime
 * SQL error; omitting one that has it silently drops the metadata from results.
 */
export const HAS_EXTRACTED_METADATA: ReadonlySet<ResourceTable> = new Set<ResourceTable>([
  "thoughts",
  "decisions",
]);

/**
 * Every valid edge relation in the entity link graph.
 *
 * This list IS the graph's vocabulary and must stay byte-aligned with the
 * `CHECK (relation IN (...))` clause on `ob_links`. A value this list accepts
 * but the database rejects becomes a write failure at the far end of a call; a
 * value the database accepts but this list omits becomes an edge no traversal
 * can filter for. Verified against the live schema (migrations 010 + 018): the
 * database allows exactly these fourteen, in this order.
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

export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** Reciprocal-rank-fusion constant (Cormack et al. 2009). */
export const RRF_K = 60;

/** Per-tier additive adjustment applied after fusion. */
export const TIER_BOOST: Readonly<Record<Tier, number>> = {
  hot: 0.3,
  warm: 0,
  cold: -0.2,
};

/** Per-table importance: primary content outranks summaries. */
export const TABLE_WEIGHT: Readonly<Record<string, number>> = {
  thought: 1.2,
  decision: 1.2,
  relationship: 1.0,
  project: 0.9,
  session: 0.8,
  entity: 1.0,
};
