/**
 * Owns every SQL statement the knowledge-graph entity tools execute.
 *
 * It exists so the tools tier holds no SQL text: `server/tools/entities.ts`,
 * `server/tools/entity-links.ts` and `server/tools/entity-hydrate.ts` take this
 * port instead of running statements against a Pool (issue 1209). Design
 * authority: `_plans/463-server-rewrite-charter.md:111` reserves repositories
 * for server/db, and :117-119 says a tool calls a repository and holds no raw
 * SQL.
 *
 * The namespace predicates arrive already built by the auth tier and are passed
 * through as clause text plus values, exactly as the tools built them, so the
 * isolation boundary is unchanged by the move.
 */
import type { QuerySurface } from "./transaction.ts";

/**
 * One row as the tools consume it, shaped by the projection each statement
 * asks for. The columns vary per statement, so the row stays an open record --
 * the same shape the tools read off an untyped driver result before the move.
 */
export interface EntityRow {
  id: string;
  [column: string]: unknown;
}

/** The `id, namespace` projection the archive UPDATE returns. */
export interface ArchivedEntityRow extends EntityRow {
  namespace: string;
}

/** The columns `hydrate_entities` selects for re-embedding. */
export interface HydrateSelectionRow extends EntityRow {
  entity_type: string;
  name: string;
}

export interface EntityRepository {
  /** Fetch one active entity by ID, scoped by the caller's read predicate. */
  getEntityById(values: {
    columns: string;
    predicateClause: string;
    id: string;
    predicateValues: readonly unknown[];
  }): Promise<EntityRow[]>;

  /** Insert or update one entity, returning the upserted projection. */
  upsertEntity(values: {
    entityType: string;
    name: string;
    canonicalId: string | null;
    namespace: string;
    metadata: string;
    embedding: string | null;
    createdBy: string;
  }): Promise<EntityRow[]>;

  /** List active entities under a caller-built filter set. */
  listEntities(values: {
    columns: string;
    where: string;
    limitPlaceholder: string;
    offsetPlaceholder: string;
    filterValues: readonly unknown[];
  }): Promise<EntityRow[]>;

  /** Archive one entity, scoped by the caller's delete predicate. */
  archiveEntity(values: {
    predicateClause: string;
    id: string;
    predicateValues: readonly unknown[];
  }): Promise<ArchivedEntityRow[]>;

  /** Archive every active link that references one entity in its namespace. */
  archiveLinksForEntity(values: { id: string; namespace: string }): Promise<number>;

  /** Insert or update one graph link, returning the upserted projection. */
  upsertLink(values: {
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    relation: string;
    weight: number;
    namespace: string;
    metadata: string;
    createdBy: string;
  }): Promise<EntityRow[]>;

  /** Soft-delete one active link by its idempotency key. */
  archiveLink(values: {
    namespace: string;
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    relation: string;
  }): Promise<EntityRow[]>;

  /** Select the entity rows one `hydrate_entities` call will re-embed. */
  selectHydrationTargets(values: {
    where: string;
    limitPlaceholder: string;
    filterValues: readonly unknown[];
  }): Promise<HydrateSelectionRow[]>;

  /** Write one refreshed embedding back, re-proving the row's namespace. */
  updateEntityEmbedding(values: {
    scoped: string;
    updateValues: readonly unknown[];
  }): Promise<number>;
}

/** The four `ob_entities` statements the entity tools run. */
function entityStatements(
  db: QuerySurface,
): Pick<
  EntityRepository,
  "getEntityById" | "upsertEntity" | "listEntities" | "archiveEntity"
> {
  return {
    async getEntityById(values) {
      const { rows } = await db.query<EntityRow>(
        `SELECT ${values.columns} FROM ob_entities
          WHERE id = $1 AND archived_at IS NULL${values.predicateClause}`,
        [values.id, ...values.predicateValues],
      );
      return rows;
    },

    async upsertEntity(values) {
      const { rows } = await db.query<EntityRow>(
        `INSERT INTO ob_entities
           (entity_type, name, canonical_id, namespace, metadata, embedding, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (namespace, entity_type, lower(name))
         WHERE archived_at IS NULL
         DO UPDATE SET
           canonical_id = COALESCE(EXCLUDED.canonical_id, ob_entities.canonical_id),
           metadata = ob_entities.metadata || EXCLUDED.metadata,
           embedding = COALESCE(EXCLUDED.embedding, ob_entities.embedding),
           archived_at = NULL,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new, entity_type, name, namespace, created_at, updated_at`,
        [
          values.entityType,
          values.name,
          values.canonicalId,
          values.namespace,
          values.metadata,
          values.embedding,
          values.createdBy,
        ],
      );
      return rows;
    },

    async listEntities(values) {
      const { rows } = await db.query<EntityRow>(
        `SELECT ${values.columns}
           FROM ob_entities
          WHERE ${values.where}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ${values.limitPlaceholder} OFFSET ${values.offsetPlaceholder}`,
        [...values.filterValues],
      );
      return rows;
    },

    async archiveEntity(values) {
      // The mutation predicate is applied to the UPDATE itself, not checked
      // beforehand: an ID-based write that authorizes in a separate statement
      // is the isolation bug class this repo's rules name explicitly.
      const { rows } = await db.query<ArchivedEntityRow>(
        `UPDATE ob_entities
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL${values.predicateClause}
      RETURNING id, namespace`,
        [values.id, ...values.predicateValues],
      );
      return rows;
    },
  };
}

/** The two `ob_links` statements the link tools run. */
function linkStatements(
  db: QuerySurface,
): Pick<EntityRepository, "archiveLinksForEntity" | "upsertLink" | "archiveLink"> {
  return {
    async archiveLinksForEntity(values) {
      // The link sweep matches on the namespace the entity was actually found
      // in, taken from the RETURNING row rather than re-derived from the
      // caller, so the cascade cannot reach a neighbouring namespace.
      const { rowCount } = await db.query(
        `UPDATE ob_links
        SET archived_at = NOW(), updated_at = NOW()
      WHERE archived_at IS NULL
        AND ((from_type = 'entity' AND from_id = $1) OR (to_type = 'entity' AND to_id = $1))
        AND namespace = $2`,
        [values.id, values.namespace],
      );
      return rowCount ?? 0;
    },

    async upsertLink(values) {
      const { rows } = await db.query<EntityRow>(
        `INSERT INTO ob_links
           (from_type, from_id, to_type, to_id, relation, weight, namespace, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)
         WHERE archived_at IS NULL
         DO UPDATE SET
           weight = EXCLUDED.weight,
           metadata = ob_links.metadata || EXCLUDED.metadata,
           archived_at = NULL,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new, relation, weight, created_at`,
        [
          values.fromType,
          values.fromId,
          values.toType,
          values.toId,
          values.relation,
          values.weight,
          values.namespace,
          values.metadata,
          values.createdBy,
        ],
      );
      return rows;
    },

    async archiveLink(values) {
      // Soft delete: the row is retained with an `archived_at` stamp so the
      // graph's history stays reconstructible.
      const { rows } = await db.query<EntityRow>(
        `UPDATE ob_links
            SET archived_at = NOW(), updated_at = NOW()
          WHERE namespace = $1
            AND from_type = $2
            AND from_id = $3
            AND to_type = $4
            AND to_id = $5
            AND relation = $6
            AND archived_at IS NULL
        RETURNING id`,
        [
          values.namespace,
          values.fromType,
          values.fromId,
          values.toType,
          values.toId,
          values.relation,
        ],
      );
      return rows;
    },
  };
}

/** The two hydration statements `hydrate_entities` runs. */
function hydrationStatements(
  db: QuerySurface,
): Pick<EntityRepository, "selectHydrationTargets" | "updateEntityEmbedding"> {
  return {
    async selectHydrationTargets(values) {
      const { rows } = await db.query<HydrateSelectionRow>(
        `SELECT id, entity_type, name, namespace
       FROM ob_entities
      WHERE ${values.where}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ${values.limitPlaceholder}`,
        [...values.filterValues],
      );
      return rows;
    },

    async updateEntityEmbedding(values) {
      const { rowCount } = await db.query(
        `UPDATE ob_entities
        SET embedding = $2, updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL${values.scoped}`,
        [...values.updateValues],
      );
      return rowCount ?? 0;
    },
  };
}

export function createEntityRepository(db: QuerySurface): EntityRepository {
  return {
    ...entityStatements(db),
    ...linkStatements(db),
    ...hydrationStatements(db),
  };
}
