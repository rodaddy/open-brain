// The database reads and writes the lane→shared-kb promoter performs (issue
// #161). Split out of the entrypoint at issue 864 L6; every statement, its
// parameters, and the provenance shape are unchanged.
import { toSql } from "pgvector/pg";
import {
  normalizedContentHash,
  type createPool,
  EMBEDDING_MODEL,
} from "../settings.ts";
import type { Cursor, NominatedEventRow, NominatedRow, PromoteTable } from "./types.ts";

type Pool = ReturnType<typeof createPool>;

/** Fetch nominated rows from a promoteEntry-backed table (thoughts/decisions). */
export async function nominatedTableRows(
  pool: Pool,
  table: PromoteTable,
  cursor: Cursor | undefined,
  limit: number,
): Promise<NominatedRow[]> {
  const contentSql =
    table === "decisions"
      ? "COALESCE(title, '') || ' ' || COALESCE(rationale, '')"
      : "content";
  const params: unknown[] = [limit];
  let cursorSql = "";
  if (cursor?.created_at && cursor.id) {
    params.push(cursor.created_at, cursor.id);
    cursorSql = ` AND (created_at, id) > ($2::timestamptz, $3::uuid)`;
  }
  const { rows } = await pool.query(
    `SELECT id, created_at, ${contentSql} AS content, tags,
            extracted_metadata AS metadata
     FROM ${table}
     WHERE extracted_metadata->>'share_candidate' = 'true'
       AND extracted_metadata->>'memory_lifecycle_action' = 'nominate_shared'
       AND archived_at IS NULL${cursorSql}
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    params,
  );
  return rows as NominatedRow[];
}

/** Fetch nominated lane events joined to their lane. */
export async function nominatedEventRows(
  pool: Pool,
  cursor: Cursor | undefined,
  limit: number,
): Promise<NominatedEventRow[]> {
  const params: unknown[] = [limit];
  let cursorSql = "";
  if (cursor?.created_at && cursor.id) {
    params.push(cursor.created_at, cursor.id);
    cursorSql = ` AND (e.created_at, e.id) > ($2::timestamptz, $3::uuid)`;
  }
  const { rows } = await pool.query(
    `SELECT
       e.id, e.created_at, e.content, e.content_hash, e.event_type,
       e.importance, e.metadata, e.lane_id, l.namespace, l.agent, l.session_key,
       l.metadata->>'repo' AS repo, l.project AS project
     FROM ob_session_events e
     JOIN ob_session_lanes l ON e.lane_id = l.id
     WHERE e.metadata->>'share_candidate' = 'true'
       AND e.metadata->>'memory_lifecycle_action' = 'nominate_shared'${cursorSql}
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT $1`,
    params,
  );
  return rows as NominatedEventRow[];
}

/** The namespaces, vector, reason, and identity one shared-kb event write needs. */
export interface ShareEventTarget {
  targetPhysicalNamespace: string;
  targetCanonicalNamespace: string;
  embedding: number[] | null;
  reason: string;
  promotedBy: string;
}

/** Read one Discord id out of a lane event's metadata, or null when absent. */
function discordId(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  return (metadata?.[key] as string | undefined) ?? null;
}

/**
 * Insert a nominated lane event into shared-kb as a thought, with the SAME
 * provenance shape promoteEntry builds. Idempotent via ON CONFLICT
 * (content_hash, namespace). Returns the inserted thought id, or null if the
 * row already existed (ON CONFLICT DO NOTHING).
 */
export async function shareEventToSharedKb(
  pool: Pool,
  event: NominatedEventRow,
  target: ShareEventTarget,
): Promise<string | null> {
  const hash = event.content_hash ?? normalizedContentHash(event.content);
  const provenance = {
    source_physical_namespace: event.namespace,
    source_namespace: event.namespace,
    source_table: "ob_session_events",
    source_id: event.id,
    source_lane_id: event.lane_id,
    source_event_id: event.id,
    source_agent: event.agent,
    source_identity: event.agent,
    source_discord: {
      server_id: discordId(event.metadata, "discord_server_id"),
      channel_id: discordId(event.metadata, "discord_channel_id"),
      thread_id: discordId(event.metadata, "discord_thread_id"),
    },
    source_repo: event.repo,
    source_project: event.project,
    target_namespace: target.targetCanonicalNamespace,
    target_kind: "shared-kb",
    promotion_reason: target.reason,
    promotion_confidence: null,
    promoted_at: new Date().toISOString(),
    promoted_by: target.promotedBy,
  };
  const tags = [
    "shared-from-lane",
    `lane:${event.session_key}`,
    `event-type:${event.event_type}`,
  ];
  const { embedding } = target;

  const { rows } = await pool.query(
    `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, promoted_from)
     VALUES ($1, $2, 'lane-shared-promotion', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      event.content,
      tags,
      target.promotedBy,
      target.targetPhysicalNamespace,
      embedding ? toSql(embedding) : null,
      hash,
      embedding ? new Date().toISOString() : null,
      embedding ? EMBEDDING_MODEL : null,
      JSON.stringify(provenance),
    ],
  );
  return rows.length > 0 ? (rows[0].id as string) : null;
}

/**
 * Clear the explicit shared nomination from a source row so it is not re-swept.
 * Drops the share flag and lifecycle action, then stamps a processed marker.
 * Idempotent. `column` is the metadata jsonb column for the table
 * (extracted_metadata vs metadata).
 */
export async function clearNomination(
  pool: Pool,
  location: { table: string; column: string },
  id: string,
  now: string,
): Promise<void> {
  await pool.query(
    `UPDATE ${location.table}
     SET ${location.column} = (${location.column} - 'share_candidate' - 'memory_lifecycle_action')
       || jsonb_build_object('share_promoted_at', $2::text)
     WHERE id = $1`,
    [id, now],
  );
}
