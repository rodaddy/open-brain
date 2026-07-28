/**
 * DREAM Stage 1 — Light. Issue #390.
 *
 * The always-on, MODEL-FREE stage. Its rule, verbatim from #390:
 *
 *   Records only what is already KNOWN at write time [...] If light needs a
 *   model to infer what capture already told it, the capture is broken.
 *
 * So this module contains no model call, no embedding call, and no inference.
 * It is SQL over facts the ingest path already established. If a future change
 * needs a model here, the change belongs in REM or Deep, not in Light.
 *
 * WHAT IT PRODUCES, and why it is the load-bearing stage:
 *
 *   The occurrence count light maintains IS the corroboration signal that
 *   promotion (#394) and supersession (#396) depend on. Things that actually
 *   mattered get said more than once, across sessions. That is evidence the
 *   model does not generate — it just gets measured.
 *
 * That matters because the alternative — trusting a small model's own
 * confidence — is already measured as unreliable: in the 2026-07-24
 * Qwen3.5-4B-4bit run, 112 of 214 candidates were mislabelled `preference`,
 * including an OAuth redirect URI and a Caddyfile procedure. A count is not an
 * opinion, and it is free.
 *
 * CORROBORATION IS CROSS-SESSION, NOT REPETITION. `occurrence_count` rises when
 * anyone says a thing again; `session_count` rises only when a DIFFERENT
 * session does. Promotion reads `session_count`. One chatty session restating
 * itself ten times must never read as ten independent confirmations, so the two
 * are tracked separately and never conflated.
 *
 * WHY NOT A COLUMN ON ob_raw_turns: `content_hash` is deliberately not an
 * identity key there (032_raw_turns.sql:119-126) — keying on it would merge
 * 3,495 turns and destroy the reply chain, since each copy has a different
 * parent. Counts therefore live in `content_occurrences`, alongside the turns
 * rather than inside them.
 *
 * HARNESS NOISE is excluded using `isHarnessNoise` imported from the ingest
 * path — the same predicate, not a copy. If the two ever disagreed, the counts
 * would drift from what was actually stored. Without it,
 * "[Request interrupted by user]" (270 occurrences across 51 sessions) would be
 * the single best-corroborated "fact" in the system.
 *
 * IDEMPOTENCY: the sweep claims a bounded batch of turns, counts them, and
 * stamps `light_swept_at`. A replayed job re-selects on `light_swept_at IS
 * NULL`, finds the same turns already stamped, and resolves as a no-op. The
 * queue is at-least-once, so this is required, not a nicety.
 *
 * TIME: every timestamp written here comes from the turn's `occurred_at`, never
 * `now()`. #396 makes that a hard constraint — a backfill keyed on write time
 * would collapse months of history onto the import moment.
 */

import type { Pool } from "pg";
import { isHarnessNoise } from "./tools/ingest-raw-turn.ts";

/** Job kind this stage registers under in the maintenance queue. */
export const DREAM_LIGHT_JOB_KIND = "dream.light";

/**
 * Turns processed per sweep. Bounded because an unbounded sweep over a growing
 * corpus is the shape that turns a maintenance job into an outage. #390 requires
 * light to be incapable of overwhelming anything.
 */
export const DEFAULT_LIGHT_BATCH_SIZE = 500;

/**
 * Cap on retained session refs per occurrence row. The count is authoritative;
 * this is an audit sample. Unbounded, it would turn one row into a log.
 */
export const MAX_SESSION_REFS = 20;

/**
 * Content that is real (so ingest correctly stores it) but carries no claim, so
 * counting it as corroboration is meaningless.
 *
 * `[tool_use: Bash]` and friends are flattening artifacts: `raw-turns.ts`
 * records that a tool was called and discards the input, so ~35% of the corpus
 * is these stubs. They are legitimately stored — the fact a tool ran is part of
 * the reply chain — but they are identical across thousands of unrelated turns.
 *
 * MEASURED, not theorised: the very first Light sweep over 50 real turns ranked
 * `[tool_use: Bash]` as the single best-corroborated content in the database
 * (occurrence 15, 3 distinct sessions) before this filter existed. Promotion
 * reads `session_count`, so without this the strongest "evidence" in the system
 * would be the string "[tool_use: Bash]".
 *
 * Deliberately SEPARATE from `isHarnessNoise`: that predicate decides what
 * ingest refuses to STORE, and these must stay stored. This one decides what
 * Light refuses to COUNT. Same shape, different question.
 */
const UNCOUNTABLE: readonly RegExp[] = [
  // Tool-call stubs left by transcript flattening.
  /^\[tool_use:\s*[^\]]*\]$/i,
  /^\[tool_result[^\]]*\]$/i,
  // Bare structural markers with no claim in them.
  /^\[(?:image|attachment|file)[^\]]*\]$/i,
];

/**
 * Roles whose content is SPEECH — something a person or an agent actually said.
 *
 * Corroboration is a claim being made again, so only speech can corroborate.
 * `role='tool'` is machine output: it recurs constantly across unrelated
 * sessions and means nothing when it does.
 *
 * MEASURED on the full 3,549-turn corpus, 2026-07-27. Counting every role, the
 * top "corroborated facts" in the database were:
 *
 *   {"receipt":{"schema":"openbrain.runtime_receipt.v1", ...}}   10 sessions
 *   (Bash completed with no output)                               5 sessions
 *   The file <path> has been updated successfully                 2-3 sessions
 *
 * All 99 such turns are `role='tool'`, and ZERO leak into user/assistant — the
 * separation the corpus already carried, unused. Restricting to speech and
 * dropping the tool-call stubs leaves exactly one real cross-session result:
 * "are we at a good stop point, this box needs to reboot", said in 5 distinct
 * sessions. One survivor out of 3,549 turns is not a bug; corroboration is
 * genuinely rare, which is what makes it evidence.
 *
 * BOTH filters are required — role alone is not enough. `[tool_use: Bash]` is
 * stored as `role='assistant'` (it is the assistant's ACTION, not its speech)
 * and appears in 26 sessions. Role removes tool results; UNCOUNTABLE removes
 * tool calls.
 */
const SPEECH_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

/**
 * Should Light count this content toward corroboration?
 *
 * Exported so the boundary is testable directly rather than only through a
 * database sweep.
 */
export function isCountable(content: string, role?: string): boolean {
  // Only speech corroborates. An unknown role is treated as speech so a new
  // runtime cannot silently drop real content — the failure mode to avoid here
  // is losing evidence, not counting a little extra.
  if (role !== undefined && !SPEECH_ROLES.has(role)) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  // A handful of characters cannot corroborate anything; this also cheaply
  // excludes "ok", "yes", "done" answers that recur constantly across sessions.
  if (trimmed.length < 16) return false;
  return !UNCOUNTABLE.some((p) => p.test(trimmed));
}

export interface DreamLightSummary {
  /** Turns examined this sweep. */
  scanned: number;
  /** Turns skipped as harness noise — counted, never stored. */
  skipped_noise: number;
  /** Occurrence rows created (content seen for the first time). */
  created: number;
  /** Occurrence rows updated (content seen again). */
  updated: number;
  /** Updates that raised session_count — i.e. genuine cross-session corroboration. */
  corroborated: number;
}

export interface DreamLightDeps {
  pool: Pool;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  batchSize?: number;
}

interface SweepRow {
  id: string;
  namespace: string;
  content: string;
  content_hash: string;
  session_ref: string | null;
  role: string | null;
  occurred_at: Date;
}

/**
 * Run one bounded Light sweep.
 *
 * Selects unswept turns, maintains `content_occurrences`, and stamps each turn
 * so it is never counted twice. Returns a content-free summary.
 */
export async function runLightSweep(
  deps: DreamLightDeps,
): Promise<DreamLightSummary> {
  const batchSize = deps.batchSize ?? DEFAULT_LIGHT_BATCH_SIZE;
  const summary: DreamLightSummary = {
    scanned: 0,
    skipped_noise: 0,
    created: 0,
    updated: 0,
    corroborated: 0,
  };

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE SKIP LOCKED so two concurrent sweeps take disjoint batches
    // rather than serialising or double-counting. Same primitive the
    // maintenance queue uses to claim jobs (maintenance-queue.ts).
    const claimed = await client.query<SweepRow>(
      `SELECT id, namespace, content, content_hash, session_ref, role, occurred_at
         FROM ob_raw_turns
        WHERE light_swept_at IS NULL
        ORDER BY occurred_at ASC
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    summary.scanned = claimed.rows.length;
    if (claimed.rows.length === 0) {
      await client.query("COMMIT");
      return summary;
    }

    const sweptIds: string[] = [];

    for (const row of claimed.rows) {
      sweptIds.push(row.id);

      // Stamped as swept but never counted: must not be reconsidered next
      // sweep, and must not inflate corroboration. Two separate reasons to
      // skip -- harness noise (which ingest should not have stored) and
      // uncountable-but-legitimate content like tool-call stubs.
      if (
        isHarnessNoise(row.content) ||
        !isCountable(row.content, row.role ?? undefined)
      ) {
        summary.skipped_noise++;
        continue;
      }

      const sessionRef = row.session_ref ?? "";

      // The upsert. session_count increments ONLY when this session has not
      // already contributed — that condition is what makes the number
      // corroboration rather than repetition. occurred_at drives both
      // timestamps; first_seen_at never moves once set.
      // session_bumped MUST be computed from the PRE-update row
      // (`content_occurrences.session_refs`, the excluded-row alias inside DO
      // UPDATE), never from the returned row. Evaluating `session_refs @> $3`
      // in RETURNING reads the row AFTER the append, so the ref is always
      // present and the flag is always false — measured: the counter reported 0
      // corroborations on a sweep that produced a session_count of 3.
      const upserted = await client.query<{
        existed: boolean;
        session_bumped: boolean;
      }>(
        `INSERT INTO content_occurrences (
           namespace, content_hash, occurrence_count, session_count,
           session_refs, sample_content, first_seen_at, last_seen_at, updated_at
         ) VALUES ($1, $2, 1, 1, $3, $4, $5, $5, now())
         ON CONFLICT (namespace, content_hash) DO UPDATE SET
           occurrence_count = content_occurrences.occurrence_count + 1,
           session_count = content_occurrences.session_count
             + CASE WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
                    THEN 1 ELSE 0 END,
           session_refs = CASE
             WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
             THEN (content_occurrences.session_refs || $3)[1:${MAX_SESSION_REFS}]
             ELSE content_occurrences.session_refs
           END,
           last_seen_at = GREATEST(content_occurrences.last_seen_at, $5),
           first_seen_at = LEAST(content_occurrences.first_seen_at, $5),
           updated_at = now()
         RETURNING (xmax <> 0) AS existed,
                   (xmax <> 0
                    AND $6 <> ''
                    AND NOT (content_occurrences.session_refs @> $3)) AS session_bumped`,
        [
          row.namespace,
          row.content_hash,
          sessionRef === "" ? [] : [sessionRef],
          row.content.slice(0, 500),
          row.occurred_at,
          sessionRef,
        ],
      );

      // xmax <> 0 distinguishes an UPDATE from an INSERT on a conflicting
      // upsert — the standard Postgres idiom, and cheaper than a pre-SELECT.
      const existed = upserted.rows[0]?.existed;
      if (existed) {
        summary.updated++;
        if (upserted.rows[0]?.session_bumped) summary.corroborated++;
      } else {
        summary.created++;
      }
    }

    await client.query(
      `UPDATE ob_raw_turns SET light_swept_at = now() WHERE id = ANY($1::uuid[])`,
      [sweptIds],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Content-free telemetry: counts only, no content, no hashes.
  deps.logger.info("dream light sweep complete", {
    scanned: summary.scanned,
    skipped_noise: summary.skipped_noise,
    created: summary.created,
    updated: summary.updated,
    corroborated: summary.corroborated,
  });

  return summary;
}

/**
 * Build the maintenance-queue handler for `dream.light`.
 *
 * Runner contract: resolving marks the job succeeded; throwing records a
 * failure and re-queues with backoff. A sweep failure here is transient by
 * nature (lock contention, connection loss), so it THROWS and lets the durable
 * retry policy re-deliver.
 */
export function makeDreamLightHandler(deps: DreamLightDeps) {
  return async function dreamLightHandler(): Promise<void> {
    await runLightSweep(deps);
  };
}
