import type pg from "pg";
import { toSql } from "pgvector/pg";
import { contentHash, EMBEDDING_MODEL } from "./embedding.ts";
import type { generateEmbedding } from "./embedding.ts";

/**
 * Lane → own-durable memory tiering (Issue #160).
 *
 * Graduates `ob_session_events` lane events into the agent's OWN durable
 * `thoughts` table within the SAME namespace. This is distinct from shared-kb
 * promotion (#161): no cross-namespace move, no promoter role required.
 */

export type EventType =
  | "fact"
  | "decision"
  | "blocker"
  | "action"
  | "artifact"
  | "receipt"
  | "question"
  | "correction"
  | "handoff";

export type Importance = "hot" | "warm" | "cold";

export type Classification = "graduate" | "keep" | "archive" | "manual-review";

/** Default minimum content length for a graduate-eligible event. */
export const DEFAULT_MIN_CONTENT_LENGTH = 24;

/** Default cosine-distance threshold for near-duplicate detection. */
export const DEFAULT_DUP_THRESHOLD = 0.08;

/** Event types whose substance warrants durable graduation. */
const GRADUATE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "fact",
  "decision",
  "handoff",
]);

/** Event types that are operational noise — archive rather than graduate. */
const ARCHIVE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "question",
  "action",
]);

/** Minimal shape the classifier needs from a lane event. */
export interface ClassifiableEvent {
  event_type: EventType;
  content: string;
  importance: Importance;
  metadata?: Record<string, unknown> | null;
}

/**
 * Pure classifier — no DB, no I/O. Decides how a single lane event should be
 * tiered. Duplicate detection is handled separately (see `findDurableDuplicate`)
 * because it needs the target table.
 *
 * Rules:
 * - graduate: type ∈ {fact, decision, handoff} AND importance !== "cold"
 *   AND trimmed content length >= minContentLength.
 * - archive: type ∈ {question, action} OR importance === "cold".
 * - manual-review: graduate-eligible by type/importance but content is too
 *   short to be sure (ambiguous).
 * - keep: everything else (default short-term retention).
 *
 * Archive precedence note: a `cold` fact/decision/handoff archives rather than
 * graduating — cold importance means the agent has down-tiered it.
 */
export function classifyLaneEvent(
  event: ClassifiableEvent,
  minContentLength: number = DEFAULT_MIN_CONTENT_LENGTH,
): Classification {
  if (event.metadata?.memory_lifecycle_action !== undefined) {
    return "keep";
  }

  const isColdOrArchiveType =
    event.importance === "cold" || ARCHIVE_TYPES.has(event.event_type);
  if (isColdOrArchiveType) {
    return "archive";
  }

  if (GRADUATE_TYPES.has(event.event_type)) {
    // type + importance qualify; length decides graduate vs ambiguous.
    const length = event.content.trim().length;
    return length >= minContentLength ? "graduate" : "manual-review";
  }

  return "keep";
}

/** A lane event row joined with its lane's namespace + agent. */
export interface LaneEventRow {
  id: string;
  lane_id: string;
  namespace: string;
  agent: string | null;
  session_key: string;
  event_type: EventType;
  content: string;
  importance: Importance;
  content_hash: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export type DuplicateKind = "exact" | "near";

export interface DuplicateMatch {
  kind: DuplicateKind;
  thought_id: string;
  distance?: number;
}

/**
 * Check whether an event is already present in the target durable `thoughts`
 * table for its namespace. Two passes:
 *  - exact: identical content_hash in thoughts(namespace).
 *  - near: cosine distance `embedding <=> embedding < threshold` to an existing
 *    thought in that namespace (mirrors find-duplicates.ts convention).
 *
 * Returns the first match found, or null. SQL is fully parameterized.
 */
export async function findDurableDuplicate(
  pool: pg.Pool,
  namespace: string,
  hash: string | null,
  embedding: number[] | null,
  threshold: number = DEFAULT_DUP_THRESHOLD,
): Promise<DuplicateMatch | null> {
  if (hash) {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts
       WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
       LIMIT 1`,
      [hash, namespace],
    );
    if (rows.length > 0) {
      return { kind: "exact", thought_id: rows[0].id as string };
    }
  }

  if (embedding) {
    const { rows } = await pool.query(
      `SELECT id, embedding <=> $1 AS distance
       FROM thoughts
       WHERE namespace = $2
         AND archived_at IS NULL
         AND embedding IS NOT NULL
         AND embedding <=> $1 < $3
       ORDER BY distance ASC
       LIMIT 1`,
      [toSql(embedding), namespace, threshold],
    );
    if (rows.length > 0) {
      return {
        kind: "near",
        thought_id: rows[0].id as string,
        distance: Number(rows[0].distance),
      };
    }
  }

  return null;
}

/** Provenance payload recorded on graduated thoughts. */
export interface LaneGraduationProvenance {
  source: "session-lane";
  lane_id: string;
  session_key: string;
  event_id: string;
  event_type: EventType;
  importance: Importance;
  agent: string | null;
  classification: Classification;
  reason: string;
  graduated_at: string;
}

export interface GraduateResult {
  thought_id: string;
  is_new: boolean;
}

/**
 * Insert a graduated lane event into the agent's own `thoughts` namespace.
 * Idempotent via ON CONFLICT (content_hash, namespace) — re-running a batch
 * produces no duplicate rows (mirrors log-thought.ts). Provenance is stored in
 * `promoted_from` (the existing provenance column) and surfaced in tags.
 */
export async function graduateLaneEvent(
  pool: pg.Pool,
  event: LaneEventRow,
  namespace: string,
  createdBy: string,
  embedding: number[] | null,
  reason: string,
): Promise<GraduateResult> {
  // Defense-in-depth: a lane event must only graduate into ITS OWN namespace.
  // Callers already scope the source read by namespace, but assert here so a
  // future caller that constructs rows differently cannot write cross-namespace.
  if (event.namespace !== namespace) {
    throw new Error(
      `lane event namespace '${event.namespace}' does not match graduation target '${namespace}'`,
    );
  }
  const hash = event.content_hash ?? contentHash(event.content);
  const tags = [
    "tiered-from-lane",
    `lane:${event.session_key}`,
    `event-type:${event.event_type}`,
  ];
  const provenance: LaneGraduationProvenance = {
    source: "session-lane",
    lane_id: event.lane_id,
    session_key: event.session_key,
    event_id: event.id,
    event_type: event.event_type,
    importance: event.importance,
    agent: event.agent,
    classification: "graduate",
    reason,
    graduated_at: new Date().toISOString(),
  };

  const { rows } = await pool.query(
    `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, promoted_from)
     VALUES ($1, $2, 'lane-tiering', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET
       tags = (
         SELECT COALESCE(array_agg(DISTINCT tag), '{}')
         FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
         WHERE tag IS NOT NULL
       ),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [
      event.content,
      tags,
      createdBy,
      namespace,
      embedding ? toSql(embedding) : null,
      hash,
      embedding ? new Date().toISOString() : null,
      embedding ? EMBEDDING_MODEL : null,
      JSON.stringify(provenance),
    ],
  );

  return {
    thought_id: rows[0].id as string,
    is_new: rows[0].is_new as boolean,
  };
}

export interface TierReceipt {
  scanned: number;
  graduated: number;
  kept: number;
  archived: number;
  manual_review: number;
  duplicates: number;
  dry_run: boolean;
}

export function newTierReceipt(dryRun: boolean): TierReceipt {
  return {
    scanned: 0,
    graduated: 0,
    kept: 0,
    archived: 0,
    manual_review: 0,
    duplicates: 0,
    dry_run: dryRun,
  };
}

export interface TierEventOptions {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
  namespace: string;
  createdBy: string;
  minContentLength?: number;
  dupThreshold?: number;
  dryRun: boolean;
}

/**
 * Classify + dedup + (optionally) graduate a single lane event, mutating the
 * receipt in place. Shared by the on-demand `tier_lane` tool and the background
 * runner so both paths apply identical policy.
 */
export async function tierLaneEvent(
  event: LaneEventRow,
  receipt: TierReceipt,
  opts: TierEventOptions,
): Promise<void> {
  receipt.scanned += 1;

  const minContentLength = opts.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH;
  const classification = classifyLaneEvent(event, minContentLength);

  if (classification === "keep") {
    receipt.kept += 1;
    return;
  }
  if (classification === "archive") {
    receipt.archived += 1;
    return;
  }
  if (classification === "manual-review") {
    receipt.manual_review += 1;
    return;
  }

  // classification === "graduate" — needs an embedding for near-dup detection
  // and for the durable thought. Embedding failures degrade to hash-only dedup.
  let embedding: number[] | null = null;
  try {
    embedding = await opts.embedFn(event.content);
  } catch {
    embedding = null;
  }

  const hash = event.content_hash ?? contentHash(event.content);
  const duplicate = await findDurableDuplicate(
    opts.pool,
    opts.namespace,
    hash,
    embedding,
    opts.dupThreshold ?? DEFAULT_DUP_THRESHOLD,
  );
  if (duplicate) {
    receipt.duplicates += 1;
    return;
  }

  if (opts.dryRun) {
    receipt.graduated += 1;
    return;
  }

  await graduateLaneEvent(
    opts.pool,
    event,
    opts.namespace,
    opts.createdBy,
    embedding,
    `lane tiering: ${event.event_type}/${event.importance}`,
  );
  receipt.graduated += 1;
}
