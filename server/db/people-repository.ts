/**
 * Owns every SQL statement the people surface executes.
 *
 * It exists so the tools tier and the REST people/sessions routes hold no SQL
 * text: `server/tools/people.ts` and
 * `server/transport/rest-api-people-sessions.ts` take this port instead of
 * reaching for a Pool (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md:111` gives server/db the repositories,
 * and :117-119 reserves raw SQL for them.
 *
 * Both people upserts are kept as separate methods even though their SQL is
 * near-identical: the two callers pass different parameter shapes and the
 * statements differ in indentation, so folding them would have to rewrite SQL
 * text this lane moves verbatim.
 */
import { toSql } from "pgvector/pg";
import type { QuerySurface } from "./transaction.ts";

/** Columns `find_person` returns, matching observed current-src. */
const PERSON_COLUMNS = `id, person_name, context, relationship_type, warmth,
  last_contact, email, phone, notes, tags, metadata, created_at`;

/**
 * `INSERT ... ON CONFLICT` for a contact row.
 *
 * `tags`/`metadata` use a NULL-check rather than COALESCE on the update side so
 * that an explicitly-passed empty array or object REPLACES the stored value,
 * while omitting the field leaves it untouched. COALESCE alone cannot tell
 * those two cases apart.
 */
const UPSERT_PERSON_SQL = `INSERT INTO relationships (
           person_name, context, relationship_type, warmth, last_contact,
           email, phone, notes, tags, metadata,
           created_by, namespace, embedding, content_hash, embedded_at, embedding_model
         ) VALUES (
           $1, $2, $3, $4, $5::date,
           $6, $7, $8, COALESCE($9::text[], '{}'), COALESCE($10::jsonb, '{}'),
           $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (namespace, person_name) DO UPDATE SET
           context = COALESCE(EXCLUDED.context, relationships.context),
           relationship_type = COALESCE(EXCLUDED.relationship_type, relationships.relationship_type),
           warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
           last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
           email = COALESCE(EXCLUDED.email, relationships.email),
           phone = COALESCE(EXCLUDED.phone, relationships.phone),
           notes = COALESCE(EXCLUDED.notes, relationships.notes),
           tags = CASE WHEN $9 IS NOT NULL THEN EXCLUDED.tags ELSE relationships.tags END,
           metadata = CASE WHEN $10 IS NOT NULL THEN EXCLUDED.metadata ELSE relationships.metadata END,
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           embedded_at = EXCLUDED.embedded_at,
           embedding_model = EXCLUDED.embedding_model
         RETURNING id, (xmax = 0) AS inserted`;

const PERSON_UPSERT_SQL = `INSERT INTO relationships (
        person_name, context, relationship_type, warmth, last_contact,
        email, phone, notes, tags, metadata,
        created_by, namespace, embedding, content_hash, embedded_at, embedding_model
      ) VALUES (
        $1, $2, $3, $4, $5::date,
        $6, $7, $8, COALESCE($9::text[], '{}'), COALESCE($10::jsonb, '{}'),
        $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (namespace, person_name) DO UPDATE SET
        context = COALESCE(EXCLUDED.context, relationships.context),
        relationship_type = COALESCE(EXCLUDED.relationship_type, relationships.relationship_type),
        warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
        last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
        email = COALESCE(EXCLUDED.email, relationships.email),
        phone = COALESCE(EXCLUDED.phone, relationships.phone),
        notes = COALESCE(EXCLUDED.notes, relationships.notes),
        tags = CASE WHEN $9 IS NOT NULL THEN EXCLUDED.tags ELSE relationships.tags END,
        metadata = CASE WHEN $10 IS NOT NULL THEN EXCLUDED.metadata ELSE relationships.metadata END,
        embedding = EXCLUDED.embedding,
        content_hash = EXCLUDED.content_hash,
        embedded_at = EXCLUDED.embedded_at,
        embedding_model = EXCLUDED.embedding_model
      RETURNING id, (xmax = 0) AS inserted`;

const SESSION_UPSERT_SQL = `INSERT INTO sessions (session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (namespace, session_id) WHERE session_id IS NOT NULL
         DO UPDATE SET
           summary = EXCLUDED.summary,
           tags = EXCLUDED.tags,
           blockers = EXCLUDED.blockers,
           next_steps = EXCLUDED.next_steps,
           key_decisions = EXCLUDED.key_decisions,
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           embedded_at = EXCLUDED.embedded_at,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new`;

const SESSION_INSERT_SQL = `INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
       RETURNING id`;

/** Rows `find_person` reads, in either search mode. */
export type PersonRow = Record<string, unknown>;

/**
 * The `RETURNING` rows the four upserts read.
 *
 * `pg` types `QueryResult.rows` as `any[]` by default, which is what the
 * callers of these statements were written against: they read `rows[0].id`,
 * `.inserted`, and `.is_new` directly. Naming that type here keeps the port a
 * pure move -- narrowing it would push new undefined-checks into handlers this
 * lane is not allowed to change the behavior of. Tightening it belongs with the
 * caller hardening, not with moving the SQL.
 */
// oxlint-disable-next-line no-explicit-any
export type UpsertReturningRow = any;

export interface PeopleRepository {
  /**
   * Semantic mode: nearest contacts by embedding distance. `predicateClause`
   * and `predicateValues` carry the auth-derived namespace predicate, which is
   * appended to the WHERE clause exactly as the caller built it.
   */
  findPeopleSemantic(input: {
    embedding: number[];
    rowCount: number;
    offset: number;
    predicateClause: string;
    predicateValues: readonly unknown[];
  }): Promise<PersonRow[]>;

  /** Name mode: ILIKE partial match, warmest and most recently contacted first. */
  findPeopleByName(input: {
    pattern: string;
    rowCount: number;
    offset: number;
    predicateClause: string;
    predicateValues: readonly unknown[];
  }): Promise<PersonRow[]>;

  /** `upsert_person`'s contact upsert. `values` is the positional list, in declaration order. */
  upsertPersonFromTool(input: {
    values: readonly unknown[];
  }): Promise<UpsertReturningRow[]>;

  /** The REST `POST /person` contact upsert. */
  upsertPersonFromRest(input: {
    values: readonly unknown[];
  }): Promise<UpsertReturningRow[]>;

  /** The REST `POST /session` upsert for a caller-supplied session_id. */
  upsertKeyedSession(input: {
    values: readonly unknown[];
  }): Promise<UpsertReturningRow[]>;

  /** The REST `POST /session` insert with no session_id; an empty result means a duplicate. */
  insertUnkeyedSession(input: {
    values: readonly unknown[];
  }): Promise<UpsertReturningRow[]>;
}

export function createPeopleRepository(db: QuerySurface): PeopleRepository {
  return {
    async findPeopleSemantic(input) {
      const result = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS},
                  embedding <=> $1::halfvec(768) AS distance
             FROM relationships
            WHERE embedding IS NOT NULL AND archived_at IS NULL${input.predicateClause}
            ORDER BY distance ASC
            LIMIT $2 OFFSET $3`,
        [
          toSql(input.embedding),
          input.rowCount,
          input.offset,
          ...input.predicateValues,
        ],
      );
      return result.rows;
    },

    async findPeopleByName(input) {
      const result = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS}
             FROM relationships
            WHERE person_name ILIKE $1 AND archived_at IS NULL${input.predicateClause}
            ORDER BY warmth DESC NULLS LAST, last_contact DESC NULLS LAST
            LIMIT $2 OFFSET $3`,
        [input.pattern, input.rowCount, input.offset, ...input.predicateValues],
      );
      return result.rows;
    },

    async upsertPersonFromTool(input) {
      const { rows } = await db.query<UpsertReturningRow>(UPSERT_PERSON_SQL, [
        ...input.values,
      ]);
      return rows;
    },

    async upsertPersonFromRest(input) {
      const { rows } = await db.query<UpsertReturningRow>(PERSON_UPSERT_SQL, [
        ...input.values,
      ]);
      return rows;
    },

    async upsertKeyedSession(input) {
      const { rows } = await db.query<UpsertReturningRow>(SESSION_UPSERT_SQL, [
        ...input.values,
      ]);
      return rows;
    },

    async insertUnkeyedSession(input) {
      const { rows } = await db.query<UpsertReturningRow>(SESSION_INSERT_SQL, [
        ...input.values,
      ]);
      return rows;
    },
  };
}
