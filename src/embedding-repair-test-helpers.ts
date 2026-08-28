/**
 * Shared seeding, cleanup, and inspection helpers for the #345 stale-embedding
 * repair live-Postgres suites, split out of src/embedding-repair.pg.test.ts so
 * both halves of the split share one copy.
 *
 * This module holds no test and creates no pool: every function that touches
 * the database takes the caller's `pool` as its first parameter, so each suite
 * file owns and ends exactly one connection.
 */
import type { Pool } from "pg";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, contentHash } from "./embedding.ts";
import {
  decisionCanonicalText,
  sessionSourceHashInput,
} from "./embedding-canonical.ts";
import type { EmbedWithMetaFn } from "./embedding-repair.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";
import { expectDefined } from "../scripts/test-support/expect-defined.ts";

export { expectDefined };

// Deterministic, provider-free embedding: a fixed unit vector. Repair only needs
// a valid halfvec(768); content correctness is the provider's concern, not ours.
export const stubEmbed: EmbedWithMetaFn = async () => ({
  embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01),
});

export const NS_A = "ns-a-lane345";
export const NS_B = "ns-b-lane345";
export const CREATED_BY = "lane345-test";
// Every maintenance job this suite enqueues shares this idempotency-key prefix,
// so cleanup can delete exactly the queue rows this suite owns and nothing else.
export const JOB_KEY_PREFIX = "lane345-";

export const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function cleanup(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM ob_session_events WHERE created_by = $1", [CREATED_BY]);
  await pool.query("DELETE FROM ob_session_lanes WHERE created_by = $1", [CREATED_BY]);
  for (const t of ["thoughts", "ob_entities", "decisions", "sessions"]) {
    await pool.query(`DELETE FROM ${t} WHERE created_by = $1`, [CREATED_BY]);
  }
  // Clear the suite's own queue rows too. maintenance_jobs is durable and its
  // ON CONFLICT (job_kind, idempotency_key) DO NOTHING enqueue is idempotent:
  // a job left in a terminal `succeeded` state from a prior run is no longer
  // claimable, so re-enqueuing the same key returns that stale succeeded job
  // and the runner never repairs the freshly-seeded rows. Deleting the
  // suite-owned keys makes every run start with a claimable queue.
  await pool.query("DELETE FROM maintenance_jobs WHERE idempotency_key LIKE $1", [
    `${JOB_KEY_PREFIX}%`,
  ]);
}

/** Seed a thought with NO embedding (missing) in a given namespace. */
export async function seedMissingThought(
  pool: Pool,
  ns: string,
  content: string,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, created_by, namespace) VALUES ($1, $2, $3) RETURNING id`,
    [content, CREATED_BY, ns],
  );
  return rows[0].id as string;
}

export async function seedMissingEntity(
  pool: Pool,
  ns: string,
  name: string,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO ob_entities (entity_type, name, created_by, namespace)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["person", name, CREATED_BY, ns],
  );
  return rows[0].id as string;
}

export const STUB_VECTOR = Array(EMBEDDING_DIMENSIONS).fill(0.01);

/**
 * Seed a decision the way the live writer does: embedding + content_hash =
 * contentHash(decisionCanonicalText(...)) with ALL optional fields set, so we
 * can prove repair does NOT immediately flag a genuinely written row as
 * source_drift. `alternatives` is a jsonb column.
 */
export async function seedWrittenDecision(
  pool: Pool,
  ns: string,
  fields: {
    title: string;
    rationale: string;
    context?: string;
    alternatives?: string[];
    tags?: string[];
  },
): Promise<string> {
  const pgvector = await import("pgvector/pg");
  const hash = contentHash(decisionCanonicalText(fields));
  const { rows } = await pool.query(
    `INSERT INTO decisions
       (title, rationale, alternatives, tags, context, created_by, namespace,
        embedding, content_hash, embedded_at, embedding_model)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, NOW(), $10)
     RETURNING id`,
    [
      fields.title,
      fields.rationale,
      JSON.stringify(fields.alternatives ?? []),
      fields.tags ?? [],
      fields.context ?? null,
      CREATED_BY,
      ns,
      pgvector.toSql(STUB_VECTOR),
      hash,
      EMBEDDING_MODEL,
    ],
  );
  return rows[0].id as string;
}

/**
 * Seed a session the way the live writer does: embedding of
 * sessionEmbedText(...) and content_hash = contentHash(summary|project) with
 * the structured text[] fields set, so we can prove repair does NOT
 * immediately flag it as source_drift even though the embed text != hash input.
 */
export async function seedWrittenSession(
  pool: Pool,
  ns: string,
  fields: {
    summary: string;
    project?: string;
    key_decisions?: string[];
    next_steps?: string[];
    blockers?: string[];
  },
): Promise<string> {
  const pgvector = await import("pgvector/pg");
  const hash = contentHash(sessionSourceHashInput(fields));
  const { rows } = await pool.query(
    `INSERT INTO sessions
       (project, summary, tags, blockers, next_steps, key_decisions,
        created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
     RETURNING id`,
    [
      fields.project ?? null,
      fields.summary,
      [],
      fields.blockers ?? [],
      fields.next_steps ?? [],
      fields.key_decisions ?? [],
      CREATED_BY,
      ns,
      pgvector.toSql(STUB_VECTOR),
      hash,
      EMBEDDING_MODEL,
    ],
  );
  return rows[0].id as string;
}

export async function storedHash(
  pool: Pool,
  table: string,
  id: string,
): Promise<string | null> {
  const { rows } = await pool.query(`SELECT content_hash FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return (rows[0]?.content_hash as string | null) ?? null;
}

export async function embeddingIsNull(
  pool: Pool,
  table: string,
  id: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT embedding IS NULL AS is_null FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0].is_null as boolean;
}
