import type { ChunkRepository } from "../db/chunk-repository.ts";
import type { TieringRepository } from "../db/tiering-repository.ts";
import { normalizedContentHash, embeddingModel } from "../embedding/provider.ts";
import type { generateEmbedding } from "../embedding/provider.ts";
import { logger } from "../logging/legacy-logger.ts";
import { describeError } from "../observability/log-surface.ts";

/**
 * Lane → own-durable memory tiering (Issue #160).
 *
 * Graduates `ob_session_events` lane events into the agent's OWN durable
 * `thoughts` table within the SAME namespace. This is distinct from shared-kb
 * promotion (#161): no cross-namespace move, no promoter role required.
 */

/**
 * The per-section write this module needs, as a SHAPE rather than an import.
 *
 * Graduation writes a thought, so a long one is followed by chunk rows through
 * the shared thought-write boundary (#605). That boundary lives in the capture
 * tier, and a domain module reaching up into it inverts the direction (#1210):
 * capture writes, domain decides. So the writer ARRIVES -- `server/tools/
 * tier-lane.ts` imports the capture-tier writer and passes it in, and this
 * module declares only what it calls and what it reads back. The function on
 * the other end is the same one it always was; nothing about what is written,
 * or when, is decided here.
 */
interface ChunkWriterOptions {
  parentId: string;
  namespace: string;
  createdBy: string;
  content: string;
  tags?: string[];
  embedFn: (text: string) => Promise<number[] | null>;
  source?: string;
  /** False for a merge onto an existing parent; chunking is skipped. */
  isNew: boolean;
  /** Names the calling writer in the failure log. */
  caller: string;
}

/** The counts a chunk write reports back. Passed through, never read here. */
interface ChunkWriteReceipt {
  written: number;
  duplicates: number;
  unembedded: number;
}

/**
 * What the writer returns. `result` null with `failed` false means there was
 * nothing to chunk; `failed` true means the parent committed with the complete
 * text and per-section writing threw.
 */
interface ChunkWriteAttempt {
  result: ChunkWriteReceipt | null;
  failed: boolean;
}

type ChunkWriter = (
  repository: ChunkRepository,
  options: ChunkWriterOptions,
) => Promise<ChunkWriteAttempt>;

type EventType =
  | "fact"
  | "decision"
  | "blocker"
  | "action"
  | "artifact"
  | "receipt"
  | "question"
  | "correction"
  | "handoff";

type Importance = "hot" | "warm" | "cold";

type Classification = "graduate" | "keep" | "archive" | "manual-review";

/** Default minimum content length for a graduate-eligible event. */
const DEFAULT_MIN_CONTENT_LENGTH = 24;

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

/** Lifecycle actions that explicitly keep a candidate out of automatic own-durable graduation. */
const OWN_DURABLE_KEEP_LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set([
  "candidate",
  "promote",
  "relegate",
  "discard",
]);

/** Minimal shape the classifier needs from a lane event. */
interface ClassifiableEvent {
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
  const lifecycleAction = event.metadata?.memory_lifecycle_action;
  if (
    typeof lifecycleAction === "string" &&
    OWN_DURABLE_KEEP_LIFECYCLE_ACTIONS.has(lifecycleAction)
  ) {
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

type DuplicateKind = "exact" | "near";

interface DuplicateMatch {
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
interface DuplicateLookup {
  hash: string | null;
  embedding: number[] | null;
  threshold?: number;
}

export async function findDurableDuplicate(
  repository: TieringRepository,
  namespace: string,
  lookup: DuplicateLookup,
): Promise<DuplicateMatch | null> {
  const { hash, embedding } = lookup;
  const threshold = lookup.threshold ?? DEFAULT_DUP_THRESHOLD;
  if (hash) {
    const [row] = await repository.findExactDuplicate({ hash, namespace });
    if (row) {
      return { kind: "exact", thought_id: row.id };
    }
  }

  if (embedding) {
    const [row] = await repository.findNearDuplicate({
      embedding,
      namespace,
      threshold,
    });
    if (row) {
      return {
        kind: "near",
        thought_id: row.id,
        distance: Number(row.distance),
      };
    }
  }

  return null;
}

/** Provenance payload recorded on graduated thoughts. */
interface LaneGraduationProvenance {
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

interface GraduateResult {
  thought_id: string;
  is_new: boolean;
  /** Chunk receipt for a long graduated event; null when chunking did not run. */
  chunks?: ChunkWriteReceipt | null;
  /** True when the parent committed but per-section writing threw. */
  chunking_failed?: boolean;
}

/**
 * Insert a graduated lane event into the agent's own `thoughts` namespace.
 * Idempotent via ON CONFLICT (content_hash, namespace) — re-running a batch
 * produces no duplicate rows (mirrors log-thought.ts). Provenance is stored in
 * `promoted_from` (the existing provenance column) and surfaced in tags.
 *
 * A graduated event becomes an ordinary thought, so it is stored like one:
 * when `embedFn` is supplied and the content is long, the parent is followed
 * by per-section chunk rows via the shared thought-write boundary (#605).
 * `embedFn` is optional so an existing caller that has no embedder still
 * graduates — it simply does not chunk, which is the pre-#605 behavior rather
 * than a new failure.
 */
interface GraduateLaneEventOptions {
  createdBy: string;
  /** Injected per-section writer; see ChunkWriter. */
  writeChunks: ChunkWriter;
  embedding: number[] | null;
  reason: string;
  embedFn?: (text: string) => Promise<number[] | null>;
}

export async function graduateLaneEvent(
  repository: TieringRepository,
  event: LaneEventRow,
  namespace: string,
  opts: GraduateLaneEventOptions,
): Promise<GraduateResult> {
  const { createdBy, embedding, reason, embedFn, writeChunks } = opts;
  // Defense-in-depth: a lane event must only graduate into ITS OWN namespace.
  // Callers already scope the source read by namespace, but assert here so a
  // future caller that constructs rows differently cannot write cross-namespace.
  if (event.namespace !== namespace) {
    throw new Error(
      `lane event namespace '${event.namespace}' does not match graduation target '${namespace}'`,
    );
  }
  const hash = event.content_hash ?? normalizedContentHash(event.content);
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

  const rows = await repository.upsertGraduatedThought({
    content: event.content,
    tags,
    createdBy,
    namespace,
    embedding,
    contentHash: hash,
    embeddedAt: embedding ? new Date().toISOString() : null,
    embeddingModel: embedding ? embeddingModel() : null,
    promotedFrom: JSON.stringify(provenance),
  });

  // The statement is an upsert whose DO UPDATE branch always returns, so a
  // zero-row result is not a case the old code had either -- it indexed [0]
  // unguarded. Saying so out loud beats a non-null assertion that reads as an
  // oversight.
  const [row] = rows;
  if (!row) {
    throw new Error("graduation upsert returned no row");
  }
  const thoughtId = row.id;
  const isNew = row.is_new;

  if (!embedFn) return { thought_id: thoughtId, is_new: isNew };

  const chunks = await writeChunks(repository.chunks, {
    parentId: thoughtId,
    namespace,
    createdBy,
    content: event.content,
    tags,
    embedFn,
    source: "lane-tiering-chunk",
    isNew,
    caller: "tiering/graduateLaneEvent",
  });

  return {
    thought_id: thoughtId,
    is_new: isNew,
    chunks: chunks.result,
    chunking_failed: chunks.failed,
  };
}

interface TierReceipt {
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

interface TierEventOptions {
  repository: TieringRepository;
  /** Injected per-section writer, handed down to graduateLaneEvent. */
  writeChunks: ChunkWriter;
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
  } catch (error) {
    embedding = null;
    // The degradation is deliberate (hash-only dedup still works, and the
    // adversarial SME checklist requires it keep working). The silence was not:
    // a thought graduated without a vector is invisible to semantic recall
    // afterwards, permanently, and nothing said the provider was down. This is
    // the standard's degraded path, so it is a warning, not a debug line.
    logger.warn("tier_embedding_degraded", {
      namespace: opts.namespace,
      event_id: event.id,
      dedup_mode: "hash_only",
      ...describeError(error),
    });
  }

  const hash = event.content_hash ?? normalizedContentHash(event.content);
  const duplicate = await findDurableDuplicate(opts.repository, opts.namespace, {
    hash,
    embedding,
    threshold: opts.dupThreshold ?? DEFAULT_DUP_THRESHOLD,
  });
  if (duplicate) {
    receipt.duplicates += 1;
    return;
  }

  if (opts.dryRun) {
    receipt.graduated += 1;
    return;
  }

  await graduateLaneEvent(opts.repository, event, opts.namespace, {
    createdBy: opts.createdBy,
    embedding,
    reason: `lane tiering: ${event.event_type}/${event.importance}`,
    embedFn: opts.embedFn,
    writeChunks: opts.writeChunks,
  });
  receipt.graduated += 1;
}
