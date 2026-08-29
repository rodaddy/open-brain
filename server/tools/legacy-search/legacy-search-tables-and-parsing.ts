import { canRead } from "../../security/permissions.ts";
import { type SourceScope } from "../../domain/source-refs.ts";
import type { LinkRelation, Role, Table, Tier } from "../../../src/types.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import { logger } from "../../../src/logger.ts";
import { ALL_TABLES, SOURCE_LABELS, LINK_RELATIONS } from "../../db/table-constants.ts";
import { traceRetrievalSpan } from "../../observability/langfuse-tracing.ts";
import { type FtsConfig } from "./fts-config.ts";
export { ALL_TABLES };

/** Reverse map: singular label -> table name for tracking UPDATEs */
export const LABEL_TO_TABLE: Record<string, Table> = Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([table, label]) => [label, table as Table]),
) as Record<string, Table>;

export type SearchMode = "hybrid" | "vector" | "keyword";
export type NamespaceFilter = string | string[];
/**
 * Tables the retrieval arms can read.
 *
 * `Table` is the PHYSICAL-table type: it drives `PERMISSIONS`, the REST table
 * enum, and every write path, so widening it would demand a permission row and
 * a write contract for corpora that have neither. `entities` and
 * `session_events` are read-only retrieval sources instead — searchable, never
 * writable through this surface — and each carries its own CTE branch below
 * because its columns do not match the shared shape.
 */
export type SearchTable = Table | "entities" | "session_events";

/**
 * Session events are namespaced INDIRECTLY. `ob_session_events` has no
 * `namespace` column at all (verified against information_schema on the
 * dogfood DB, 2026-08-07); scope lives on `ob_session_lanes` and is reached
 * only through `ob_session_events.lane_id`. Every CTE below therefore joins
 * the lane table and applies the auth-derived namespace predicate to
 * `lane.namespace` — omitting that join does not merely widen results, it
 * exposes every agent's session history to every other namespace.
 *
 * The corpus also lacks `archived_at`, `tier`, `tags`, `usefulness_score`,
 * `access_count`, `search_vector`, and `source_refs`. Those slots are filled
 * with typed literals so the UNION arms stay type-compatible, and the
 * consequences are deliberate:
 *   - no stored `search_vector` -> the lexical arm matches with ILIKE on
 *     `content` rather than `to_tsvector`, so it is substring-based, not
 *     stemmed. That is the honest capability of a column that does not exist.
 *   - no `tier` -> `importance` carries the same hot/warm/cold vocabulary and
 *     the same CHECK constraint, so it is used as the tier for filtering and
 *     for TIER_BOOST.
 *   - no `source_refs` -> a source-scope filter cannot be satisfied, so the
 *     corpus is excluded when one is requested rather than silently ignoring
 *     the scope (which would leak out-of-scope rows into a scoped query).
 */
export const SESSION_EVENTS_SOURCE_LABEL = "session_event";

/**
 * The recall sources a role may read, in one place.
 *
 * This exists because the selection was previously OPEN-CODED at each call
 * site, and that is exactly how #433 defect 1 happened: `search_brain` added
 * `entities` to its list, `brain_answer` did not, and nothing added
 * `session_events` anywhere -- so a corpus of 11,136 rows was unreachable from
 * the tool agents actually ask. Three copies of a list is three chances to
 * forget one. Callers that need the default set MUST use this function so a
 * new source is added once and appears everywhere at once.
 *
 * `entities` and `session_events` have no PERMISSIONS row: they are read-only
 * retrieval sources, never written through this surface, and both ride the
 * `sessions` read permission.
 */
export function readableSearchTables(
  role: Role,
  options: { includeEntities?: boolean } = {},
): SearchTable[] {
  const tables: SearchTable[] = ALL_TABLES.filter((table) => canRead(role, table));
  if (canRead(role, "sessions")) {
    // `entities` is opt-in because the two recall surfaces legitimately differ:
    // search_brain returns rows for a caller to read, while brain_answer cites
    // extractive evidence, and an entity row's preview is a name label rather
    // than a statement. Silently adding it to brain_answer would be a behavior
    // change #433 never asked for. `session_events` is unconditional: it is
    // real recorded content and its absence IS the defect.
    if (options.includeEntities) tables.push("entities");
    tables.push("session_events");
  }
  return tables;
}
export type { SourceScope };

export type ExecuteSearchTuning = {
  enableGraph?: boolean;
  /**
   * Text-search configuration for the lexical arm. When unset, defaults to the
   * shared english configuration. The public `search_brain` handler is the only
   * boundary that resolves its request argument and deployment env; sibling
   * executeSearch callers remain byte-compatible unless they explicitly pass a
   * config.
   */
  ftsConfig?: FtsConfig;
};

/**
 * Every argument the four legacy execute entry points take, as one object.
 * The field order matches the legacy positional order the src/ L5 adapter
 * still accepts, so the two forms read the same way side by side.
 */
export type ExecuteSearchOptions = {
  deps: ToolDeps;
  accessibleTables: SearchTable[];
  query: string;
  limit: number;
  mode?: SearchMode;
  tier?: Tier;
  offset?: number;
  namespace?: NamespaceFilter;
  includeLinks?: boolean;
  sourceScope?: SourceScope;
  tuning?: ExecuteSearchTuning;
};

export const NON_ENGLISH_FTS_AUTHORIZATION_ERROR =
  "Permission denied: non-English FTS configuration requires admin or ob-admin";

/** RRF constant -- standard value from Cormack et al. 2009 */
export const RRF_K = 60;

/** Over-fetch multiplier for hybrid mode (fetch N*3 from each path, merge to N) */
export const HYBRID_FETCH_MULTIPLIER = 3;
export const DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS = 3000;
export const RELATIONAL_GRAPH_FETCH_LIMIT = 50;

/** Tier-based RRF score adjustments for cognitive tiering */
export const TIER_BOOST: Record<Tier, number> = {
  hot: 0.3,
  warm: 0,
  cold: -0.2,
};

/** Scoring weights for vector search ranking formula */
export const VECTOR_WEIGHT = 0.7;
export const USEFULNESS_WEIGHT = 0.15;
export const AGE_WEIGHT = 0.0001;

/** Per-table importance weights: primary content > summaries */
export const TABLE_WEIGHT: Record<string, number> = {
  thought: 1.2,
  decision: 1.2,
  relationship: 1.0,
  project: 0.9,
  session: 0.8,
  entity: 1.0,
};

export type RelationalDirection = "incoming" | "outgoing";

export const RELATIONAL_INCOMING_QUERY_PATTERN =
  /^what\s+(?:is\s+)?(?:was\s+)?(?<relation>depends on|blocked by|implemented by|decided by|supersedes|duplicates|contradicts|mentions|relates to)\s+(?<seed>[^?]{1,160})\??$/iu;

export const RELATIONAL_OUTGOING_DEPENDS_PATTERN =
  /^what\s+does\s+(?<seed>[^?]{1,160})\s+depend\s+on\??$/iu;

export const RELATIONAL_OUTGOING_BLOCKED_PATTERN =
  /^what\s+(?:is\s+)?(?<seed>[^?]{1,160})\s+blocked\s+by\??$/iu;

export const RELATION_ALIASES: Record<string, LinkRelation> = {
  "depends on": "depends_on",
  "blocked by": "blocked_by",
  "implemented by": "implemented_by",
  "decided by": "decided_by",
  supersedes: "supersedes",
  duplicates: "duplicates",
  contradicts: "contradicts",
  mentions: "mentions",
  "relates to": "relates_to",
};

export type RelationalQuery = {
  relation: LinkRelation;
  seed: string;
  direction: RelationalDirection;
};

/** Collapse the internal whitespace a matched seed may carry. */
function normalizeSeed(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The outgoing forms, in match order. Each names one relation outright, so the
 * only thing that varies between them is the pattern and the relation it means.
 */
const RELATIONAL_OUTGOING_MATCHERS: ReadonlyArray<{
  pattern: RegExp;
  relation: LinkRelation;
}> = [
  { pattern: RELATIONAL_OUTGOING_DEPENDS_PATTERN, relation: "depends_on" },
  { pattern: RELATIONAL_OUTGOING_BLOCKED_PATTERN, relation: "blocked_by" },
];

/** The outgoing forms, whose pattern names the relation outright. */
function parseOutgoingRelationalQuery(
  trimmed: string,
): { parsed: RelationalQuery | undefined } | undefined {
  for (const { pattern, relation } of RELATIONAL_OUTGOING_MATCHERS) {
    const matched = pattern.exec(trimmed)?.groups;
    if (!matched?.seed) continue;
    const seed = normalizeSeed(matched.seed);
    return { parsed: seed ? { relation, seed, direction: "outgoing" } : undefined };
  }
  return undefined;
}

/** The incoming form, whose relation arrives as an alias needing resolution. */
function parseIncomingRelationalQuery(trimmed: string): RelationalQuery | undefined {
  const groups = RELATIONAL_INCOMING_QUERY_PATTERN.exec(trimmed)?.groups;
  if (!groups?.relation || !groups.seed) return undefined;
  const relation = RELATION_ALIASES[groups.relation.toLowerCase()];
  const seed = normalizeSeed(groups.seed);
  if (!relation || !seed || !LINK_RELATIONS.includes(relation)) return undefined;
  return { relation, seed, direction: "incoming" };
}

export function parseRelationalQuery(query: string): RelationalQuery | undefined {
  const trimmed = query.trim();
  // An outgoing pattern that matched settles the parse, even when its seed was
  // empty and the answer is therefore undefined -- the incoming form must not
  // get a second look at a query the outgoing form already claimed.
  const outgoing = parseOutgoingRelationalQuery(trimmed);
  if (outgoing) return outgoing.parsed;
  return parseIncomingRelationalQuery(trimmed);
}

/**
 * The search-embedding timeout arrives through a READER (issue 864, rule M13a)
 * rather than a process.env read: server/ code may not read the environment,
 * and the value is read per call because callers change it between calls. The
 * default reader returns undefined so the original numeric default applies,
 * which is what a src/ caller that registers nothing still gets.
 */
type SearchEmbeddingTimeoutReader = () => number | undefined;

const defaultSearchEmbeddingTimeoutReader: SearchEmbeddingTimeoutReader = () =>
  undefined;

let searchEmbeddingTimeoutReader: SearchEmbeddingTimeoutReader =
  defaultSearchEmbeddingTimeoutReader;

/**
 * Install the reader the timeout is taken from, returning the previous one so a
 * caller can restore it. The src/ adapter registers a reader over process.env;
 * server/main.ts registers one over the server config it already holds.
 */
export function setSearchEmbeddingTimeoutReader(
  read: SearchEmbeddingTimeoutReader,
): SearchEmbeddingTimeoutReader {
  const previous = searchEmbeddingTimeoutReader;
  searchEmbeddingTimeoutReader = read;
  return previous;
}

export function searchEmbeddingTimeoutMs(): number {
  const value = searchEmbeddingTimeoutReader();
  if (value === undefined) return DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS;
  return Number.isNaN(value) || value < 1 ? DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS : value;
}

export async function generateSearchEmbedding(
  deps: ToolDeps,
  query: string,
): Promise<number[] | null> {
  const timeoutMs = searchEmbeddingTimeoutMs();
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  return traceRetrievalSpan({
    name: "retrieval.embedding",
    input: { query, timeout_ms: timeoutMs },
    metadata: { stage: "candidate_generation" },
    run: async () => {
      try {
        return await Promise.race([
          deps.embedFn(query, undefined, { signal: controller.signal }),
          new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              logger.warn("search_embedding_timeout", {
                timeoutMs,
                queryLength: query.length,
              });
              resolve(null);
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    output: (embedding) => ({
      generated: embedding !== null,
      dimensions: embedding?.length ?? 0,
    }),
  });
}

/** Gentle recency factor: today=1.0, 30d=0.97, 90d=0.92, 365d=0.73 */
