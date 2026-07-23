/**
 * Single source of truth for every embedding-bearing table in Open Brain.
 *
 * Both `scripts/backfill.ts` and `src/embedding-repair.ts` consume this registry
 * instead of duplicating table -> text mappings. When a new embedding column
 * lands, add exactly one entry here and both the backfill and the repair
 * primitive pick it up.
 *
 * ## Two distinct texts per target
 *
 * `canonicalText` is the source text whose change means "the row was edited and
 * the embedding is now stale". It MUST match the exact input each table's
 * write-path feeds to `contentHash(...)`, so a stored `content_hash` can be
 * compared against a freshly computed one to detect source drift.
 *
 * `embedText` is what we actually pass to the embedding provider. It may differ
 * from `canonicalText` (e.g. thoughts append their tags to the embed text but
 * hash only the content -- see src/tools/log-thought.ts). Repair regenerates
 * from `embedText`; staleness is decided from `canonicalText`.
 *
 * ## Provenance capability
 *
 * `provenance` records which model/staleness columns physically exist on the
 * table in the CURRENT stored schema (see src/db/migrations). Staleness that
 * relies on a column MUST NOT be claimed for a table lacking it. `ob_entities`
 * has an `embedding` column but no `content_hash` / `embedded_at` /
 * `embedding_model`; only missing-embedding detection is runtime-truthful there
 * until the migration contract in docs/embedding-repair.md is applied. Because
 * it has no `content_hash` to guard on, it declares `sourceGuardColumns` so the
 * repair UPDATE snapshot-guards its actual source columns and never writes an
 * embedding built from source text that changed since selection.
 */
import { contentHash } from "./embedding.ts";
import {
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
} from "./embedding-canonical.ts";

/** A row projected from an embedding target's `selectColumns`. */
export type TargetRow = Record<string, unknown>;

/**
 * Which model/staleness provenance columns physically exist on a target table.
 * Drives which staleness reasons are runtime-detectable vs. schema-blocked.
 */
export interface TargetProvenance {
  /** `content_hash TEXT` column exists -> source-drift staleness detectable. */
  hasContentHash: boolean;
  /** `embedded_at TIMESTAMPTZ` column exists. */
  hasEmbeddedAt: boolean;
  /** `embedding_model TEXT` column exists -> model-drift staleness detectable. */
  hasEmbeddingModel: boolean;
}

export interface EmbeddingTarget {
  /** Physical table name. Allowlisted here; never interpolated from input. */
  table: string;
  /** Primary key column (always `id` today). */
  idColumn: string;
  /**
   * Columns to project when scanning. Projecting instead of `SELECT *` keeps
   * the wide halfvec(768) `embedding` column out of JS memory. Must include the
   * id column, every column `canonicalText`/`embedText` read, plus any column a
   * repair caller needs for its namespace/id predicate (e.g. `namespace`).
   */
  selectColumns: string[];
  /** Source text whose change marks the embedding stale (drives `sourceHash`). */
  canonicalText: (row: TargetRow) => string;
  /** Text handed to the embedding provider when (re)generating. */
  embedText: (row: TargetRow) => string;
  /**
   * Stable identity hash of the source, matching this table's write-path
   * `contentHash(...)` input exactly. Compared against the stored `content_hash`
   * to detect source drift and to guard idempotent no-overwrite updates.
   */
  sourceHash: (row: TargetRow) => string;
  /** Which provenance columns physically exist (current stored schema). */
  provenance: TargetProvenance;
  /**
   * Source columns to snapshot-guard on the UPDATE for targets that have NO
   * `content_hash` column (so no hash-based no-overwrite guard is possible).
   *
   * For such a target the only column-level staleness we can detect is a missing
   * embedding, but `embedding IS NULL` alone does NOT prevent writing an
   * embedding generated from now-stale source text: a concurrent edit can change
   * `entity_type`/`name` while leaving `embedding` NULL, and the stale UPDATE
   * would still match. To stay truthful, the guarded UPDATE additionally binds
   * each declared column with `<col> IS NOT DISTINCT FROM $captured` (NULL-safe),
   * using the exact value projected at selection time. If any source column
   * changed since selection, the UPDATE matches zero rows and repair skips
   * instead of clobbering the row with an embedding built from stale text.
   *
   * Every identifier here is registry-static (never caller-supplied), so it is
   * safe to interpolate; the captured VALUES are always parameterized. These
   * columns MUST be in `selectColumns` so the captured snapshot is available.
   *
   * Only meaningful when `provenance.hasContentHash` is false; a target WITH a
   * content_hash guards on the hash instead and ignores this field.
   */
  sourceGuardColumns?: string[];
  /**
   * Extra SQL predicate always applied when scanning this table, e.g.
   * `archived_at IS NULL` for soft-deletable graph entities. No parameters.
   */
  baseFilterSql?: string;
  /** Namespace column name if the table is namespace-isolated, else undefined. */
  namespaceColumn?: string;
  /**
   * Namespace isolation via a foreign key to a parent table that owns the
   * `namespace` column, for tables that carry no `namespace` column of their
   * own (e.g. `ob_session_events` -> `ob_session_lanes` via `lane_id`).
   *
   * Every identifier here is registry-static (never caller-supplied), so
   * interpolating them into the JOIN/EXISTS predicate stays allowlisted; the
   * namespace VALUE list is always parameterized. When set, both selection and
   * the guarded UPDATE bind namespace through this FK -- an id-only read or
   * write can never cross a namespace boundary.
   *
   * A target MUST declare exactly one of `namespaceColumn` or `namespaceVia`;
   * a target with neither cannot be namespace-scoped and selection/repair fail
   * closed when a namespace list is supplied (see requireNamespacePredicate).
   */
  namespaceVia?: {
    /** Parent table that owns the namespace column (allowlisted, static). */
    table: string;
    /** FK column on THIS target referencing the parent's key (e.g. lane_id). */
    localKey: string;
    /** Key column on the parent table the FK points at (e.g. id). */
    remoteKey: string;
    /** Namespace column on the parent table. */
    namespaceColumn: string;
  };
}

const FULL_PROVENANCE: TargetProvenance = {
  hasContentHash: true,
  hasEmbeddedAt: true,
  hasEmbeddingModel: true,
};

/**
 * `ob_entities` has an `embedding` column but no `content_hash`,
 * `embedded_at`, or `embedding_model` (see 010_entity_links.sql /
 * 017_entity_graph_lifecycle.sql). Only missing-embedding repair is
 * runtime-truthful until the migration contract is applied.
 */
const ENTITY_PROVENANCE: TargetProvenance = {
  hasContentHash: false,
  hasEmbeddedAt: false,
  hasEmbeddingModel: false,
};

function joinNonEmpty(parts: Array<unknown>): string {
  return parts
    .map((p) => (p == null ? "" : String(p)))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Every embedding-bearing table, keyed by physical table name.
 *
 * Text mappings mirror the write paths:
 * - thoughts      src/tools/log-thought.ts (hash content; embed content + tags)
 * - decisions     src/tools/log-decision.ts (embed == hash of
 *                 title \n rationale [\n context] [\n alternatives joined ", "]
 *                 [\n tags joined " "]; shared via decisionCanonicalText())
 * - relationships src/tools/upsert-person.ts (name \n context \n notes)
 * - projects      scripts/backfill.ts / project write (name \n description)
 * - sessions      src/tools/session-save.ts / session-wrap.ts (hash summary|project;
 *                 embed summary [\n key_decisions] [\n next_steps] [\n blockers];
 *                 shared via sessionSourceHashInput()/sessionEmbedText())
 * - ob_session_lanes  src/tools/append-session-event.ts (topic [\n project];
 *                     hash = contentHash(session_key + "|" + topic))
 * - ob_session_events src/tools/append-session-event.ts (content)
 * - ob_entities   src/tools/hydrate-entities.ts (entity_type: name)
 */
export const EMBEDDING_TARGETS: Record<string, EmbeddingTarget> = {
  thoughts: {
    table: "thoughts",
    idColumn: "id",
    selectColumns: ["id", "content", "tags", "namespace"],
    canonicalText: (row) => (row.content as string) ?? "",
    embedText: (row) => {
      const content = (row.content as string) ?? "";
      const tags = row.tags as string[] | null | undefined;
      return tags?.length ? `${content}\n${tags.join(" ")}` : content;
    },
    sourceHash: (row) => contentHash((row.content as string) ?? ""),
    provenance: FULL_PROVENANCE,
    namespaceColumn: "namespace",
  },
  decisions: {
    table: "decisions",
    idColumn: "id",
    // Every source field the write path folds into the canonical text must be
    // projected, or repair would recompute a shorter string and flag the row as
    // drifted. `alternatives` is a jsonb column (arrives parsed); `tags` a
    // text[]; `context` a nullable text. See src/tools/log-decision.ts.
    selectColumns: [
      "id",
      "title",
      "rationale",
      "context",
      "alternatives",
      "tags",
      "namespace",
    ],
    // Decisions embed and hash the SAME canonical string; see the write path in
    // src/tools/log-decision.ts / rest-api.ts POST /decisions. Both build
    // [title, rationale, context?, alternatives.join(", ")?, tags.join(" ")?].
    canonicalText: (row) => decisionCanonicalText(row),
    embedText: (row) => decisionCanonicalText(row),
    sourceHash: (row) => contentHash(decisionCanonicalText(row)),
    provenance: FULL_PROVENANCE,
    namespaceColumn: "namespace",
  },
  relationships: {
    table: "relationships",
    idColumn: "id",
    selectColumns: ["id", "person_name", "context", "notes", "namespace"],
    canonicalText: (row) =>
      joinNonEmpty([row.person_name, row.context, row.notes]),
    embedText: (row) => joinNonEmpty([row.person_name, row.context, row.notes]),
    sourceHash: (row) =>
      contentHash(joinNonEmpty([row.person_name, row.context, row.notes])),
    provenance: FULL_PROVENANCE,
    namespaceColumn: "namespace",
  },
  projects: {
    table: "projects",
    idColumn: "id",
    selectColumns: ["id", "name", "description", "namespace"],
    canonicalText: (row) => joinNonEmpty([row.name, row.description]),
    embedText: (row) => joinNonEmpty([row.name, row.description]),
    sourceHash: (row) => contentHash(joinNonEmpty([row.name, row.description])),
    provenance: FULL_PROVENANCE,
    namespaceColumn: "namespace",
  },
  sessions: {
    table: "sessions",
    idColumn: "id",
    // Sessions hash `summary|project` but embed a richer text
    // (summary + key_decisions/next_steps/blockers). Project both the hash
    // input columns (summary, project) and the embed-only text[] columns so the
    // registry can reproduce each writer's exact string. See session-save.ts,
    // session-wrap.ts, and rest-api.ts POST /sessions.
    selectColumns: [
      "id",
      "summary",
      "project",
      "key_decisions",
      "next_steps",
      "blockers",
      "namespace",
    ],
    // Canonical text drives sourceHash and MUST equal the writers' hash input:
    // contentHash(summary + "|" + project). It is NOT the embed text.
    canonicalText: (row) => sessionSourceHashInput(row),
    // Embed text is the richer continuity text every writer feeds the provider.
    embedText: (row) => sessionEmbedText(row),
    sourceHash: (row) => contentHash(sessionSourceHashInput(row)),
    provenance: FULL_PROVENANCE,
    namespaceColumn: "namespace",
  },
  ob_session_lanes: {
    table: "ob_session_lanes",
    idColumn: "id",
    selectColumns: ["id", "session_key", "topic", "project", "namespace"],
    // Lane embed text = topic [\n project]; see firstWriteLaneEmbedding().
    canonicalText: (row) => joinNonEmpty([row.topic, row.project]),
    embedText: (row) => joinNonEmpty([row.topic, row.project]),
    // Lane hash formula is session_key + "|" + topic, NOT the embed text; see
    // firstWriteLaneContentHash() in append-session-event.ts. Diverging from
    // this would flag every lane as drifted on the first scan.
    sourceHash: (row) => {
      const topic = (row.topic as string) ?? "";
      return contentHash(`${row.session_key ?? ""}|${topic}`);
    },
    provenance: FULL_PROVENANCE,
    baseFilterSql: "topic IS NOT NULL AND btrim(topic) <> ''",
    namespaceColumn: "namespace",
  },
  ob_session_events: {
    table: "ob_session_events",
    idColumn: "id",
    // ob_session_events has no namespace column of its own; isolation is via
    // lane_id -> ob_session_lanes.namespace. Selection and the guarded UPDATE
    // both bind namespace through this FK (see namespaceVia), so an id-only
    // read or write can never cross a namespace boundary.
    selectColumns: ["id", "content", "lane_id"],
    canonicalText: (row) => (row.content as string) ?? "",
    embedText: (row) => (row.content as string) ?? "",
    sourceHash: (row) => contentHash((row.content as string) ?? ""),
    provenance: FULL_PROVENANCE,
    namespaceVia: {
      table: "ob_session_lanes",
      localKey: "lane_id",
      remoteKey: "id",
      namespaceColumn: "namespace",
    },
  },
  ob_entities: {
    table: "ob_entities",
    idColumn: "id",
    selectColumns: ["id", "entity_type", "name", "namespace"],
    canonicalText: (row) => `${row.entity_type ?? ""}: ${row.name ?? ""}`,
    embedText: (row) => `${row.entity_type ?? ""}: ${row.name ?? ""}`,
    // No content_hash column exists; sourceHash is provided for callers that
    // opt into the documented migration contract, but is NOT persisted or
    // compared at runtime today.
    sourceHash: (row) =>
      contentHash(`${row.entity_type ?? ""}: ${row.name ?? ""}`),
    provenance: ENTITY_PROVENANCE,
    // No content_hash guard is possible; snapshot-guard the actual source
    // columns instead so a concurrent name/type edit (which leaves embedding
    // NULL) can't be clobbered by an embedding built from the stale snapshot.
    sourceGuardColumns: ["entity_type", "name"],
    baseFilterSql: "archived_at IS NULL",
    namespaceColumn: "namespace",
  },
};

/** Physical table names of every embedding-bearing target. */
export const EMBEDDING_TARGET_NAMES: string[] = Object.keys(EMBEDDING_TARGETS);

/** Look up a target by physical table name; throws if unknown (allowlist gate). */
export function getEmbeddingTarget(table: string): EmbeddingTarget {
  const target = EMBEDDING_TARGETS[table];
  if (!target) {
    throw new Error(`Unknown embedding target table: ${table}`);
  }
  return target;
}
