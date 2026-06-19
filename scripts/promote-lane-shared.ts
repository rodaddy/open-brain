#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { toSql } from "pgvector/pg";
import { createPool } from "../src/db/pool.ts";
import { contentHash, EMBEDDING_MODEL, generateEmbedding } from "../src/embedding.ts";
import { logger } from "../src/logger.ts";
import { promoteEntry } from "../src/promotion-service.ts";
import {
  canonicalNamespace,
  sharedNamespaceConfig,
} from "../src/shared-namespace.ts";
import { classifyShareCandidate, type ShareDecision } from "../src/sharing.ts";
import type { AuthInfo } from "../src/types.ts";

/**
 * Background runner for lane/own-durable → shared-kb promotion (Issue #161).
 *
 * Mirrors scripts/promote-legacy-shared.ts and scripts/tier-lane-durable.ts
 * (cursor/state/receipt/args, dry-run default, resumable cursor, kill-switch).
 *
 * Runs as the PROMOTER identity and sweeps THREE sources for the nomination flag
 * `metadata->>'share_candidate' = 'true'`:
 *   - thoughts   → classify → promoteEntry into shared-kb.
 *   - decisions  → classify → promoteEntry into shared-kb.
 *   - ob_session_events JOIN ob_session_lanes → classify → focused
 *     event→shared-kb insert into `thoughts` (promoteEntry does not cover
 *     events), idempotent via ON CONFLICT (content_hash, namespace).
 *
 * Every secret/private candidate is hard-refused before any write. After a
 * candidate is processed the nomination flag is cleared so it is not re-swept.
 */

/** Promotable own-durable tables that promoteEntry handles directly. */
const PROMOTE_TABLES = ["thoughts", "decisions"] as const;
type PromoteTable = (typeof PROMOTE_TABLES)[number];
type Source = PromoteTable | "ob_session_events";

interface Cursor {
  created_at?: string;
  id?: string;
}

interface State {
  version: 1;
  target_namespace: string;
  cursors: Partial<Record<Source, Cursor>>;
  last_receipt?: Receipt;
}

interface SourceReceipt {
  scanned: number;
  shared: number;
  would_share: number;
  rejected_secret: number;
  rejected_private: number;
  rejected_noise: number;
  manual_review: number;
  duplicates: number;
  failed: number;
}

interface Receipt {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  target_namespace: string;
  scanned: number;
  shared: number;
  would_share: number;
  rejected_secret: number;
  rejected_private: number;
  rejected_noise: number;
  manual_review: number;
  duplicates: number;
  failed: number;
  sources: Partial<Record<Source, SourceReceipt>>;
  failures: Array<{ source: Source; id: string; error: string }>;
}

interface Args {
  apply: boolean;
  targetNamespace: string;
  stateFile: string;
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
}

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/promote-lane-shared.ts [--apply] [--once]",
      "       [--state-file <path>] [--batch-size 20] [--max-apply 5]",
      "       [--delay-ms 250] [--loop] [--interval-ms 60000]",
      "       [--min-content-length 24]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode is bounded by --max-apply promotions, runs as the promoter",
      "identity, and only promotes entries nominated via metadata share_candidate.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseArgs(argv: string[]): Args {
  const config = sharedNamespaceConfig();
  const args: Args = {
    apply: false,
    targetNamespace: config.canonicalSharedNamespace,
    stateFile:
      process.env.OPENBRAIN_SHARED_PROMOTER_STATE ??
      `${process.env.HOME ?? "."}/.local/state/open-brain/shared-promoter/state.json`,
    batchSize: Number(process.env.OPENBRAIN_SHARED_PROMOTER_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_SHARED_PROMOTER_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_SHARED_PROMOTER_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(
      process.env.OPENBRAIN_SHARED_PROMOTER_INTERVAL_MS ?? 60000,
    ),
    minContentLength: Number(
      process.env.OPENBRAIN_SHARED_PROMOTER_MIN_CONTENT_LENGTH ?? 24,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--once") args.loop = false;
    else if (arg === "--loop") args.loop = true;
    else if (arg === "--state-file") args.stateFile = argv[++i] ?? "";
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i] ?? 0);
    else if (arg === "--max-apply") args.maxApply = Number(argv[++i] ?? 0);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i] ?? 0);
    else if (arg === "--interval-ms") args.intervalMs = Number(argv[++i] ?? 0);
    else if (arg === "--min-content-length") {
      args.minContentLength = Number(argv[++i] ?? 0);
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  if (
    !args.targetNamespace ||
    !args.stateFile ||
    !Number.isInteger(args.batchSize) ||
    args.batchSize < 1 ||
    args.batchSize > 250 ||
    !Number.isInteger(args.maxApply) ||
    args.maxApply < 0 ||
    args.maxApply > 100 ||
    !Number.isInteger(args.delayMs) ||
    args.delayMs < 0 ||
    !Number.isInteger(args.intervalMs) ||
    args.intervalMs < 1000 ||
    !Number.isInteger(args.minContentLength) ||
    args.minContentLength < 0
  ) {
    usage();
  }

  return args;
}

function defaultState(args: Args): State {
  return {
    version: 1,
    target_namespace: canonicalNamespace(args.targetNamespace),
    cursors: {},
  };
}

function loadState(args: Args): State {
  const expectedTarget = canonicalNamespace(args.targetNamespace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
  } catch {
    return defaultState(args);
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const state = parsed as State;
    if (state.version === 1 && state.target_namespace === expectedTarget) {
      state.cursors ??= {};
      return state;
    }
  }
  return defaultState(args);
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function newSourceReceipt(): SourceReceipt {
  return {
    scanned: 0,
    shared: 0,
    would_share: 0,
    rejected_secret: 0,
    rejected_private: 0,
    rejected_noise: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
  };
}

function addCount(
  receipt: Receipt,
  source: Source,
  field: keyof SourceReceipt,
): void {
  const sourceReceipt = (receipt.sources[source] ??= newSourceReceipt());
  sourceReceipt[field] += 1;
  receipt[field] += 1;
}

/** Map a non-share classification to its receipt counter. */
function rejectionField(decision: ShareDecision): keyof SourceReceipt {
  switch (decision) {
    case "reject-secret":
      return "rejected_secret";
    case "reject-private":
      return "rejected_private";
    case "reject-noise":
      return "rejected_noise";
    default:
      return "manual_review";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return (err.message.split("\n")[0] ?? err.name).slice(0, 240);
  }
  return String(err).slice(0, 240);
}

interface NominatedRow {
  id: string;
  created_at: string;
  content: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
}

/** Fetch nominated rows from a promoteEntry-backed table (thoughts/decisions). */
async function nominatedTableRows(
  pool: ReturnType<typeof createPool>,
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
       AND archived_at IS NULL${cursorSql}
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    params,
  );
  return rows as NominatedRow[];
}

interface NominatedEventRow {
  id: string;
  created_at: string;
  content: string;
  content_hash: string | null;
  event_type: string;
  importance: string;
  metadata: Record<string, unknown> | null;
  lane_id: string;
  namespace: string;
  agent: string | null;
  session_key: string;
  repo: string | null;
  project: string | null;
}

/** Fetch nominated lane events joined to their lane. */
async function nominatedEventRows(
  pool: ReturnType<typeof createPool>,
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
     WHERE e.metadata->>'share_candidate' = 'true'${cursorSql}
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT $1`,
    params,
  );
  return rows as NominatedEventRow[];
}

/**
 * Insert a nominated lane event into shared-kb as a thought, with the SAME
 * provenance shape promoteEntry builds. Idempotent via ON CONFLICT
 * (content_hash, namespace). Returns true if a new row was inserted.
 */
export async function shareEventToSharedKb(
  pool: ReturnType<typeof createPool>,
  event: NominatedEventRow,
  targetPhysicalNamespace: string,
  targetCanonicalNamespace: string,
  embedding: number[] | null,
  reason: string,
  promotedBy: string,
): Promise<boolean> {
  const hash = event.content_hash ?? contentHash(event.content);
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
      server_id:
        (event.metadata?.discord_server_id as string | undefined) ?? null,
      channel_id:
        (event.metadata?.discord_channel_id as string | undefined) ?? null,
      thread_id:
        (event.metadata?.discord_thread_id as string | undefined) ?? null,
    },
    source_repo: event.repo,
    source_project: event.project,
    target_namespace: targetCanonicalNamespace,
    target_kind: "shared-kb",
    promotion_reason: reason,
    promotion_confidence: null,
    promoted_at: new Date().toISOString(),
    promoted_by: promotedBy,
  };
  const tags = [
    "shared-from-lane",
    `lane:${event.session_key}`,
    `event-type:${event.event_type}`,
  ];

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
      promotedBy,
      targetPhysicalNamespace,
      embedding ? toSql(embedding) : null,
      hash,
      embedding ? new Date().toISOString() : null,
      embedding ? EMBEDDING_MODEL : null,
      JSON.stringify(provenance),
    ],
  );
  return rows.length > 0;
}

/**
 * Clear the share_candidate nomination from a source row so it is not re-swept.
 * Drops the flag and stamps a processed marker. Idempotent. `column` is the
 * metadata jsonb column for the table (extracted_metadata vs metadata).
 */
async function clearNomination(
  pool: ReturnType<typeof createPool>,
  table: string,
  column: string,
  id: string,
  now: string,
): Promise<void> {
  await pool.query(
    `UPDATE ${table}
     SET ${column} = (${column} - 'share_candidate')
       || jsonb_build_object('share_promoted_at', $2::text)
     WHERE id = $1`,
    [id, now],
  );
}

export async function runSharedPromoter(args: Args): Promise<Receipt> {
  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw new Error("OPENBRAIN_PROMOTION_KILL_SWITCH is enabled");
  }

  const config = sharedNamespaceConfig();
  const targetCanonicalNamespace = canonicalNamespace(args.targetNamespace);
  const targetPhysicalNamespace = config.physicalSharedNamespace;
  const state = loadState(args);
  const receipt: Receipt = {
    started_at: new Date().toISOString(),
    finished_at: "",
    dry_run: !args.apply,
    target_namespace: targetCanonicalNamespace,
    scanned: 0,
    shared: 0,
    would_share: 0,
    rejected_secret: 0,
    rejected_private: 0,
    rejected_noise: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
    sources: {},
    failures: [],
  };

  // Synthetic promoter identity (mirrors promote-legacy-shared.ts), but using
  // the first-class promoter role added in #159 so canWriteNamespace permits
  // shared-kb writes.
  const auth: AuthInfo = {
    role: "promoter",
    clientId: "openbrain-promoter",
    tokenClientId: "openbrain-promoter",
    namespaceSource: "token",
  };
  const promotedBy = auth.tokenClientId ?? auth.clientId;
  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-shared-promoter",
  });
  let applied = 0;

  try {
    // ── thoughts + decisions via promoteEntry ──
    sources: for (const table of PROMOTE_TABLES) {
      const rows = await nominatedTableRows(
        pool,
        table,
        state.cursors[table],
        args.batchSize,
      );
      for (const row of rows) {
        addCount(receipt, table, "scanned");
        const nextCursor = {
          created_at: new Date(row.created_at).toISOString(),
          id: row.id,
        };

        const decision = classifyShareCandidate(
          {
            content: row.content,
            tags: row.tags ?? undefined,
            metadata: row.metadata ?? undefined,
          },
          { minLen: args.minContentLength },
        );
        if (decision !== "share") {
          addCount(receipt, table, rejectionField(decision));
          if (args.apply) {
            // Clear the nomination on a terminal reject so it is not re-swept.
            // manual-review keeps the flag for a human to resolve.
            if (decision !== "manual-review") {
              await clearNomination(
                pool,
                table,
                "extracted_metadata",
                row.id,
                new Date().toISOString(),
              );
            }
            // Advance the cursor for EVERY processed row, including
            // manual-review — otherwise a trailing manual-review row pins the
            // cursor and the runner re-scans it forever (stuck-loop).
            state.cursors[table] = nextCursor;
          }
          continue;
        }

        if (args.apply && applied >= args.maxApply) break sources;

        try {
          const result = await promoteEntry(
            pool,
            table,
            row.id,
            args.targetNamespace,
            "lane-shared promoter nomination",
            auth,
            { dryRun: !args.apply },
          );
          if (result.status === "duplicate") {
            addCount(receipt, table, "duplicates");
          } else if (result.status === "dry_run") {
            addCount(receipt, table, "would_share");
          } else if (result.status === "promoted") {
            applied += 1;
            addCount(receipt, table, "shared");
            logger.info("shared_promoter_promoted", {
              actor: promotedBy,
              source: table,
              id: row.id,
              new_id: result.new_id,
            });
          }
          if (args.apply) {
            await clearNomination(
              pool,
              table,
              "extracted_metadata",
              row.id,
              new Date().toISOString(),
            );
            state.cursors[table] = nextCursor;
          }
        } catch (err) {
          addCount(receipt, table, "failed");
          receipt.failures.push({
            source: table,
            id: row.id,
            error: sanitizeError(err),
          });
          // Advance the cursor past a failed row (apply mode) before stopping
          // the sweep, so a deterministically-failing row cannot pin the cursor
          // and block every row behind it on the next run (poison-pill loop).
          // The nomination flag is intentionally left set and the failure is
          // recorded in receipt.failures for human follow-up.
          if (args.apply) state.cursors[table] = nextCursor;
          break sources;
        }

        if (args.delayMs > 0) await sleep(args.delayMs);
      }
    }

    // ── ob_session_events via focused shared-kb insert ──
    if (!(args.apply && applied >= args.maxApply)) {
      const events = await nominatedEventRows(
        pool,
        state.cursors.ob_session_events,
        args.batchSize,
      );
      events: for (const event of events) {
        addCount(receipt, "ob_session_events", "scanned");
        const nextCursor = {
          created_at: new Date(event.created_at).toISOString(),
          id: event.id,
        };

        const decision = classifyShareCandidate(
          {
            event_type: event.event_type,
            importance: event.importance,
            content: event.content,
            metadata: event.metadata ?? undefined,
          },
          { minLen: args.minContentLength },
        );
        if (decision !== "share") {
          addCount(receipt, "ob_session_events", rejectionField(decision));
          if (args.apply) {
            // Clear the nomination on a terminal reject so it is not re-swept.
            // manual-review keeps the flag for a human to resolve.
            if (decision !== "manual-review") {
              await clearNomination(
                pool,
                "ob_session_events",
                "metadata",
                event.id,
                new Date().toISOString(),
              );
            }
            // Advance the cursor for EVERY processed row, including
            // manual-review — otherwise a trailing manual-review event pins the
            // cursor and the runner re-scans it forever (stuck-loop).
            state.cursors.ob_session_events = nextCursor;
          }
          continue;
        }

        if (args.apply && applied >= args.maxApply) break events;

        try {
          // Dry-run must not call the embedding endpoint: it neither writes nor
          // needs the vector, and the embedding call is the expensive part of a
          // sweep. Count the would-share and move on before embedding.
          if (!args.apply) {
            addCount(receipt, "ob_session_events", "would_share");
            continue;
          }

          let embedding: number[] | null = null;
          try {
            embedding = await generateEmbedding(event.content);
          } catch {
            embedding = null;
          }

          const inserted = await shareEventToSharedKb(
            pool,
            event,
            targetPhysicalNamespace,
            targetCanonicalNamespace,
            embedding,
            "lane-shared promoter nomination",
            promotedBy,
          );
          if (inserted) {
            applied += 1;
            addCount(receipt, "ob_session_events", "shared");
            logger.info("shared_promoter_promoted", {
              actor: promotedBy,
              source: "ob_session_events",
              id: event.id,
            });
          } else {
            addCount(receipt, "ob_session_events", "duplicates");
          }
          await clearNomination(
            pool,
            "ob_session_events",
            "metadata",
            event.id,
            new Date().toISOString(),
          );
          state.cursors.ob_session_events = nextCursor;
        } catch (err) {
          addCount(receipt, "ob_session_events", "failed");
          receipt.failures.push({
            source: "ob_session_events",
            id: event.id,
            error: sanitizeError(err),
          });
          // Advance past a failed event (apply mode) before stopping so a
          // deterministically-failing event cannot pin the cursor and re-embed
          // every run (poison-pill loop). Nomination left set; failure recorded.
          if (args.apply) state.cursors.ob_session_events = nextCursor;
          break events;
        }

        if (args.delayMs > 0) await sleep(args.delayMs);
      }
    }
  } finally {
    await pool.end();
  }

  receipt.finished_at = new Date().toISOString();
  state.target_namespace = targetCanonicalNamespace;
  state.last_receipt = receipt;
  saveState(args.stateFile, state);
  return receipt;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const runOnce = async (): Promise<void> => {
    const receiptPath = resolve(
      dirname(args.stateFile),
      `receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    const receipt = await runSharedPromoter(args);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    logger.info("shared_promoter_receipt", {
      receipt_path: receiptPath,
      dry_run: receipt.dry_run,
      scanned: receipt.scanned,
      shared: receipt.shared,
      would_share: receipt.would_share,
      rejected_secret: receipt.rejected_secret,
      rejected_private: receipt.rejected_private,
      rejected_noise: receipt.rejected_noise,
      manual_review: receipt.manual_review,
      duplicates: receipt.duplicates,
      failed: receipt.failed,
    });
    console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }));
  };
  const run = async (): Promise<void> => {
    do {
      await runOnce();
      if (args.loop) await sleep(args.intervalMs);
    } while (args.loop);
  };
  run().catch((err) => {
    logger.error("shared_promoter_failed", { error: sanitizeError(err) });
    process.exit(1);
  });
}
