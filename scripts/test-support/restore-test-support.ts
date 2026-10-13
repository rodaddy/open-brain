import type { BackupManifestV1, Queryable } from "../backup-lib.ts";
import { DUMP_FILENAME, MANIFEST_SCHEMA_ID } from "../backup-lib.ts";

/** Row content the validator must never surface in a result. */
export const CONTENT_SENTINEL = "SENTINEL-RESTORED-ROW-CONTENT";
/** Namespace name the validator must never surface in a result. */
export const NS_SENTINEL = "SENTINEL-RESTORED-NAMESPACE";

export interface SchemaCount {
  schemaname: string;
  count: number;
}

/** Fake target db for the wipe-scope gate, recording every SQL it is asked. */
export function makeTargetDb(schemas: SchemaCount[]): {
  db: Queryable;
  queries: string[];
} {
  const queries: string[] = [];
  const db: Queryable = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("pg_catalog.pg_tables")) {
        return { rows: schemas };
      }
      if (sql.startsWith("DROP SCHEMA") || sql.startsWith("CREATE SCHEMA")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query in fake target db: ${sql}`);
    },
  };
  return { db, queries };
}

export function makeManifest(
  overrides: Partial<{
    row_counts: Record<string, number>;
    archived_row_counts: Record<string, number>;
    distinct_namespaces: number;
    applied: string[];
  }> = {},
): BackupManifestV1 {
  return {
    schema: MANIFEST_SCHEMA_ID,
    created_at: "2026-07-20T00:00:00.000Z",
    source: {
      db_host: "127.0.0.1",
      db_port: 5432,
      db_name: "unit_db",
      hostname: "unit-host",
    },
    migrations: {
      head: "002_curation.sql",
      applied: overrides.applied ?? ["001_init.sql", "002_curation.sql"],
    },
    contract: {
      version: "2026-07-17.memory-tools.v22",
      schema_hash: "a".repeat(64),
    },
    embedding: { model: "m", dimensions: 768, column_type: "halfvec" },
    pgvector_version: "0.8.2",
    files: [{ name: DUMP_FILENAME, sha256: "b".repeat(64), bytes: 10 }],
    row_counts: overrides.row_counts ?? { thoughts: 5 },
    archived_row_counts: overrides.archived_row_counts ?? { thoughts: 1 },
    namespace_inventory: {
      distinct_namespaces: overrides.distinct_namespaces ?? 2,
    },
  };
}

export interface FakeDbState {
  applied: string[];
  counts: Record<string, number>;
  archived: Record<string, number>;
  distinctNamespaces: number;
  hasVector: boolean;
  embeddingColType: string | null;
  existingTables: string[];
  namespaceColumnTables: string[];
}

type QueryResult = Awaited<ReturnType<Queryable["query"]>>;
type Handler = (s: FakeDbState, sql: string, params?: unknown[]) => QueryResult;

/**
 * Dispatch table for the fake restored db, in priority order: the first entry
 * whose `match` accepts the SQL handles it. A table rather than an if/else
 * chain so adding a validator query does not deepen one function.
 */
const RESTORED_DB_HANDLERS: ReadonlyArray<{
  match: (sql: string) => boolean;
  handle: Handler;
}> = [
  {
    match: (sql) => sql.includes("FROM _migrations"),
    handle: (s) => ({
      rows: s.applied.map((filename) => ({
        filename,
        // Hostile shape: extra content the validator must never surface.
        content: CONTENT_SENTINEL,
      })),
    }),
  },
  {
    match: (sql) => sql.includes("information_schema.tables"),
    handle: (s, _sql, params) => {
      const table = typeof params?.[0] === "string" ? params[0] : "";
      return { rows: s.existingTables.includes(table) ? [{ "1": 1 }] : [] };
    },
  },
  {
    match: (sql) =>
      sql.includes("information_schema.columns") && sql.includes("'namespace'"),
    handle: (s, _sql, params) => {
      const table = typeof params?.[0] === "string" ? params[0] : "";
      return {
        rows: s.namespaceColumnTables.includes(table) ? [{ "1": 1 }] : [],
      };
    },
  },
  {
    // namespace_predicate_columns spot check (fully parameterized)
    match: (sql) => sql.includes("information_schema.columns"),
    handle: () => ({ rows: [{ count: 2 }] }),
  },
  {
    match: (sql) => sql.includes("archived_at IS NOT NULL"),
    handle: (s, sql) => {
      const table = sql.match(/FROM (\w+) WHERE/)?.[1] ?? "";
      return { rows: [{ count: s.archived[table] ?? 0 }] };
    },
  },
  {
    match: (sql) => sql.includes(") AS ns"),
    handle: (s) => ({
      rows: [{ count: s.distinctNamespaces, namespace: NS_SENTINEL }],
    }),
  },
  {
    match: (sql) => sql.includes("pg_extension"),
    handle: (s) => ({ rows: s.hasVector ? [{ extversion: "0.8.2" }] : [] }),
  },
  {
    match: (sql) => sql.includes("format_type"),
    handle: (s) => ({
      rows: s.embeddingColType === null ? [] : [{ col_type: s.embeddingColType }],
    }),
  },
  {
    match: (sql) => sql.startsWith("SELECT COUNT(*)::bigint AS count FROM "),
    handle: (s, sql) => {
      const table = sql.match(/FROM (\w+)$/)?.[1] ?? "";
      return { rows: [{ count: s.counts[table] ?? 0 }] };
    },
  },
];

export function makeRestoredDb(state: Partial<FakeDbState> = {}): Queryable {
  const s: FakeDbState = {
    applied: ["001_init.sql", "002_curation.sql"],
    counts: { thoughts: 5 },
    archived: { thoughts: 1 },
    distinctNamespaces: 2,
    hasVector: true,
    embeddingColType: "halfvec(768)",
    existingTables: ["thoughts", "ob_session_lanes"],
    namespaceColumnTables: ["thoughts", "ob_session_lanes"],
    ...state,
  };
  return {
    async query(sql: string, params?: unknown[]) {
      const entry = RESTORED_DB_HANDLERS.find((h) => h.match(sql));
      if (entry === undefined) {
        throw new Error(`unexpected query in fake restored db: ${sql}`);
      }
      return entry.handle(s, sql, params);
    },
  };
}

/** Fake restored db that records every SQL it is asked, for leak assertions. */
export function makeRecordingRestoredDb(): {
  db: Queryable;
  queries: string[];
} {
  const queries: string[] = [];
  const inner = makeRestoredDb();
  const db: Queryable = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      return inner.query(sql, params);
    },
  };
  return { db, queries };
}

/**
 * Hostile driver: every query throws an error whose MESSAGE carries row and
 * namespace content (as real pg errors do via DETAIL/CONTEXT), with a pg-style
 * code on alternating calls and none on the rest.
 */
export function makeLeakyThrowingDb(): Queryable {
  let flip = false;
  return {
    async query() {
      flip = !flip;
      const err = new Error(
        `duplicate key value ${CONTENT_SENTINEL} in namespace ${NS_SENTINEL}`,
      );
      if (flip) (err as Error & { code?: string }).code = "23505";
      throw err;
    },
  };
}
