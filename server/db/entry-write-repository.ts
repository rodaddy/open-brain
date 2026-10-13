/**
 * Owns the statements that WRITE an entry from the tools tier (issue 1209).
 *
 * It exists so the entry-write tools hold no SQL text: each takes this port
 * instead of reaching for the pool. Design authority:
 * `_plans/463-server-rewrite-charter.md:111` assigns server/db the
 * repositories, and :117-119 reserves raw SQL for them.
 *
 * The files it serves:
 *   server/tools/ingest-raw-turn.ts — the raw turn batch insert
 *   server/tools/capture.ts         — the thought and decision upserts
 *   server/tools/decompose-entry.ts — the source load, replacement insert, and
 *                                     duplicate lookup
 *   server/tools/find-duplicates.ts — the pairwise self-join
 *   server/tools/update-entry.ts    — the row lock, collision guard, and UPDATE
 *
 * Every method takes ONE object argument (D3, issue 1184 comment 17408), and
 * the factory takes a `QuerySurface`, so the same code runs on the pool and on
 * a transaction client inside `withTransaction`.
 *
 * The last two arrived once `withTransaction` grew its `readOnly`,
 * `statementTimeoutMs`, and `abort` options (`./transaction.ts`): the READ ONLY
 * bounded scan `find-duplicates.ts` needs and the mid-transaction rollbacks
 * `update-entry.ts` RETURNS an envelope from are both expressible there now,
 * so neither tool has to keep its own transaction code to keep its behavior.
 */
import { toSql } from "pgvector/pg";
import type { ResourceTable } from "../auth/types.ts";
import type { QuerySurface } from "./transaction.ts";

/**
 * Encode one embedding for a parameter slot, or `null` when there is none.
 *
 * Exported because `server/tools/update-entry.ts` builds a DYNAMIC `SET` list:
 * its embedding is one positional parameter among many the caller assembles, so
 * it cannot be handed to a repository method as its own field. Keeping the
 * `toSql` call here is what lets that tool hold no driver import at all — the
 * port's rule is that the encoder travels with the statement tier, and this is
 * the one statement whose parameters are built outside it.
 */
export function encodeEmbedding(embedding: number[] | null): string | null {
  return embedding ? toSql(embedding) : null;
}

/** One inserted raw turn id. */
export interface RawTurnIdRow {
  readonly id?: string;
}

/** An upserted entry, with the `xmax` flag that distinguishes insert from merge. */
export interface UpsertedEntryRow {
  readonly id: unknown;
  readonly is_new: unknown;
  readonly source_refs: unknown;
}

/** The decomposition source row, or `undefined` when absent or archived. */
export interface DecompositionSourceRow {
  readonly id: unknown;
  readonly namespace: unknown;
  /**
   * Text, or NULL: every `SOURCE_CONTENT_SQL` expression is a string
   * concatenation. Narrower than the `unknown` the pre-port declaration used,
   * because the caller stringifies it and an `unknown` there stringifies as
   * `[object Object]`.
   */
  readonly content_text: string | null;
}

export interface EntryWriteRepository {
  /**
   * Insert a batch of raw turns, returning the ids that were actually written.
   * A turn already present in the namespace is skipped, so the returned count
   * is the ingested count and the remainder are duplicates.
   *
   * `tuples` is the caller-built positional VALUES list and `values` its
   * matching parameters; both are generated together from the same batch.
   */
  insertRawTurns(input: {
    tuples: string[];
    values: unknown[];
  }): Promise<RawTurnIdRow[]>;

  /**
   * Upsert one thought, merging tags onto an identical existing content hash.
   *
   * `embedding` arrives already in its SQL text form from `embeddingFields`,
   * which is where the `toSql` call lives for this path; it is passed through
   * unchanged.
   */
  upsertThought(input: {
    content: string;
    tags: string[];
    createdBy: string;
    namespace: string;
    embedding: string | null;
    contentHash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
    sourceRefs: string;
  }): Promise<UpsertedEntryRow>;

  /** Upsert one decision, merging tags onto an identical existing content hash. */
  upsertDecision(input: {
    title: string;
    rationale: string;
    alternatives: string;
    tags: string[];
    context: string | null;
    createdBy: string;
    namespace: string;
    /** Already in SQL text form, as for `upsertThought`. */
    embedding: string | null;
    contentHash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
    sourceRefs: string;
  }): Promise<UpsertedEntryRow>;

  /**
   * Load the row a decomposition reads, under the caller's read predicate.
   *
   * `table` and `contentSql` are both static values narrowed before they reach
   * this method — the table by `tableEnum`, the expression by a per-table
   * literal map — and `predicateClause`/`predicateValues` come from
   * `namespacePredicate`. None is caller input.
   */
  loadDecompositionSource(input: {
    table: ResourceTable;
    contentSql: string;
    id: string;
    predicateClause: string;
    predicateValues: readonly unknown[];
  }): Promise<DecompositionSourceRow | undefined>;

  /**
   * Insert one decomposition replacement thought.
   *
   * @returns The new row id, or `undefined` when the hash already existed.
   */
  insertDecompositionReplacement(input: {
    content: string;
    tags: string[];
    createdBy: string;
    namespace: string;
    embedding: number[] | null;
    contentHash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
    provenance: string;
    parentId: string | null;
    chunkIndex: number;
  }): Promise<string | undefined>;

  /** @returns The id of a live thought already carrying this hash, if any. */
  findLiveThoughtByHash(input: {
    contentHash: string;
    namespace: string;
  }): Promise<string | undefined>;

  /**
   * One table's nearest duplicate pairs within the resolved namespaces.
   *
   * BOTH sides of the self-join take the same `$3` namespace list, which is
   * what keeps it bounded for every role — the measured #485 fix recorded in
   * `docs/decisions/1214-find-duplicates-namespace-bounded-self-join.md`.
   * `previewA`/`previewB` are the alias-qualified preview expressions the
   * caller builds from a table-literal map, and `table` reaches here already
   * validated by the caller's Zod enum; neither is caller input.
   */
  selectDuplicatePairs(input: {
    table: ResourceTable;
    previewA: string;
    previewB: string;
    previewWidth: number;
    threshold: number;
    remaining: number;
    namespaces: readonly string[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * Lock one row `FOR UPDATE` under the caller's write namespace predicate.
   *
   * The lock is what makes the archived guard above it meaningful: it holds the
   * row against a concurrent archive between this SELECT and the UPDATE.
   *
   * @returns The matching rows — empty when the id is absent or unreadable.
   */
  lockExistingRow(input: {
    table: ResourceTable;
    selectColumns: string;
    predicateClause: string;
    id: string;
    predicateValues: readonly unknown[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * Other rows in the same namespace already carrying this content hash.
   *
   * Run inside the caller's transaction so an identical concurrent write cannot
   * land between the check and the UPDATE.
   */
  selectForCollision(input: {
    table: ResourceTable;
    contentHash: string;
    id: string;
    namespace: unknown;
  }): Promise<Record<string, unknown>[]>;

  /**
   * Apply one dynamic `SET` list under the caller's write predicate.
   *
   * `setClauses` and `params` are built together by the caller from its own
   * field allowlist; `table` is Zod-validated before it arrives.
   *
   * @returns The updated rows — empty when the predicate matched nothing.
   */
  updateEntryRow(input: {
    table: ResourceTable;
    setClauses: readonly string[];
    idParam: number;
    predicateClause: string;
    params: readonly unknown[];
  }): Promise<Record<string, unknown>[]>;
}

/** The decomposition half of the port, split out to keep each factory small. */
type DecompositionWrites = Pick<
  EntryWriteRepository,
  "loadDecompositionSource" | "insertDecompositionReplacement" | "findLiveThoughtByHash"
>;

function createDecompositionWrites(db: QuerySurface): DecompositionWrites {
  return {
    async loadDecompositionSource(input) {
      const { rows } = await db.query<DecompositionSourceRow>(
        `SELECT id, namespace, ${input.contentSql} AS content_text
       FROM ${input.table}
      WHERE id = $1 AND archived_at IS NULL${input.predicateClause}`,
        [input.id, ...input.predicateValues],
      );
      return rows[0];
    },

    async insertDecompositionReplacement(input) {
      const { rows } = await db.query<{ id?: unknown }>(
        `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, promoted_from, parent_id, chunk_index)
     VALUES ($1, $2, 'dreamengine-decomposition', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
     RETURNING id`,
        [
          input.content,
          input.tags,
          input.createdBy,
          input.namespace,
          input.embedding ? toSql(input.embedding) : null,
          input.contentHash,
          input.embeddedAt,
          input.embeddingModel,
          input.provenance,
          // ONLY for a `thoughts` source: the FK targets `thoughts(id)`
          // (`011_chunking.sql`), so a decision's id here would violate it. For the
          // other four tables the JSON provenance above stays the only lineage.
          input.parentId,
          input.chunkIndex,
        ],
      );
      const insertedId = rows[0]?.id;
      return typeof insertedId === "string" ? insertedId : undefined;
    },

    async findLiveThoughtByHash(input) {
      const existing = await db.query<{ id?: unknown }>(
        `SELECT id FROM thoughts
          WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL`,
        [input.contentHash, input.namespace],
      );
      const existingId = existing.rows[0]?.id;
      return typeof existingId === "string" ? existingId : undefined;
    },
  };
}

/** The `update_entry` half of the port, split out to keep each factory small. */
type EntryUpdateWrites = Pick<
  EntryWriteRepository,
  "lockExistingRow" | "selectForCollision" | "updateEntryRow"
>;

function createEntryUpdateWrites(db: QuerySurface): EntryUpdateWrites {
  return {
    async lockExistingRow(input) {
      const { rows } = await db.query(
        `SELECT id, namespace, ${input.selectColumns} FROM ${input.table}
            WHERE id = $1${input.predicateClause} FOR UPDATE`,
        [input.id, ...input.predicateValues],
      );
      return rows;
    },

    async selectForCollision(input) {
      const { rows } = await db.query(
        `SELECT id FROM ${input.table} WHERE content_hash = $1 AND id != $2 AND namespace = $3`,
        [input.contentHash, input.id, input.namespace],
      );
      return rows;
    },

    async updateEntryRow(input) {
      const { rows } = await db.query(
        `UPDATE ${input.table} SET ${input.setClauses.join(", ")}
            WHERE id = $${input.idParam}${input.predicateClause} RETURNING id`,
        [...input.params],
      );
      return rows;
    },
  };
}

export function createEntryWriteRepository(db: QuerySurface): EntryWriteRepository {
  return {
    ...createDecompositionWrites(db),
    ...createEntryUpdateWrites(db),

    async selectDuplicatePairs(input) {
      const { rows } = await db.query(
        `SELECT
       a.id AS id_a,
       LEFT(${input.previewA}, ${input.previewWidth}) AS preview_a,
       b.id AS id_b,
       LEFT(${input.previewB}, ${input.previewWidth}) AS preview_b,
       a.embedding <=> b.embedding AS distance
     FROM ${input.table} a
     JOIN ${input.table} b ON a.id < b.id
       AND b.archived_at IS NULL
       AND b.embedding IS NOT NULL
       AND b.namespace = ANY($3::text[])
     WHERE a.archived_at IS NULL
       AND a.embedding IS NOT NULL
       AND a.namespace = ANY($3::text[])
       AND a.embedding <=> b.embedding < $1
     ORDER BY distance ASC
     LIMIT $2`,
        [input.threshold, input.remaining, input.namespaces],
      );
      return rows;
    },

    async insertRawTurns({ tuples, values }) {
      const rows = await db.query<RawTurnIdRow>(
        `INSERT INTO ob_raw_turns
             (namespace, turn_uuid, parent_turn_uuid, logical_parent_turn_uuid,
              prompt_id, session_ref, repo, git_branch, turn_index, role,
              is_human_prompt, content, content_hash, runtime, token_estimate,
              metadata, redaction_applied, created_by, occurred_at)
           VALUES ${tuples.join(",")}
           ON CONFLICT (namespace, turn_uuid) DO NOTHING
           RETURNING id`,
        values,
      );
      return rows.rows;
    },

    async upsertThought(input) {
      const rows = await db.query<UpsertedEntryRow>(
        `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, 'mcp', $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, source_refs`,
        [
          input.content,
          input.tags,
          input.createdBy,
          input.namespace,
          input.embedding,
          input.contentHash,
          input.embeddedAt,
          input.embeddingModel,
          input.sourceRefs,
        ],
      );
      return rows.rows[0] as UpsertedEntryRow;
    },

    async upsertDecision(input) {
      const rows = await db.query<UpsertedEntryRow>(
        `INSERT INTO decisions
       (title, rationale, alternatives, tags, context, created_by, namespace,
        embedding, content_hash, embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, source_refs`,
        [
          input.title,
          input.rationale,
          input.alternatives,
          input.tags,
          input.context,
          input.createdBy,
          input.namespace,
          input.embedding,
          input.contentHash,
          input.embeddedAt,
          input.embeddingModel,
          input.sourceRefs,
        ],
      );
      return rows.rows[0] as UpsertedEntryRow;
    },
  };
}
