// Row reads for the lane → own-durable tiering runner (issue #160). Split out of
// the entrypoint at issue 864 L6; both queries are byte-for-byte the ones the
// entrypoint ran, still fully parameterized.
import { createPool, type LaneEventRow } from "../settings.ts";
import type { Cursor } from "./types.ts";

type Pool = ReturnType<typeof createPool>;

export async function listNamespaces(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT namespace FROM ob_session_lanes ORDER BY namespace ASC`,
  );
  return rows.map((row) => row.namespace as string);
}

export async function candidateEvents(
  pool: Pool,
  namespace: string,
  cursor: Cursor | undefined,
  limit: number,
): Promise<LaneEventRow[]> {
  const params: unknown[] = [namespace, limit];
  let cursorSql = "";
  if (cursor?.created_at && cursor.id) {
    params.push(cursor.created_at, cursor.id);
    cursorSql = ` AND (e.created_at, e.id) > ($3::timestamptz, $4::uuid)`;
  }
  const { rows } = await pool.query(
    `SELECT
       e.id, e.lane_id, l.namespace, l.agent, l.session_key,
       e.event_type, e.content, e.importance, e.content_hash, e.created_at,
       e.metadata
     FROM ob_session_events e
     JOIN ob_session_lanes l ON e.lane_id = l.id
     WHERE l.namespace = $1${cursorSql}
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT $2`,
    params,
  );
  return rows as LaneEventRow[];
}
