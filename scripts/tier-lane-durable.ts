#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPool } from "../src/db/pool.ts";
import { contentHash, generateEmbedding } from "../src/embedding.ts";
import { logger } from "../src/logger.ts";
import {
  classifyLaneEvent,
  findDurableDuplicate,
  graduateLaneEvent,
  type LaneEventRow,
} from "../src/tiering.ts";

/**
 * Background runner for lane → own-durable memory tiering (Issue #160).
 *
 * Mirrors scripts/promote-legacy-shared.ts (cursor/state/receipt/args, dry-run
 * default, resumable cursor, kill-switch). DIFFERENCE: instead of promoting
 * between table namespaces, it reads ob_session_events joined to their lane and
 * graduates substantive events into the lane agent's OWN durable `thoughts`
 * table within the SAME namespace.
 */

interface Cursor {
  created_at?: string;
  id?: string;
}

interface State {
  version: 1;
  cursors: Record<string, Cursor>;
  last_receipt?: Receipt;
}

interface Receipt {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  scanned: number;
  graduated: number;
  would_graduate: number;
  kept: number;
  archived: number;
  manual_review: number;
  duplicates: number;
  failed: number;
  namespaces: Record<string, NamespaceReceipt>;
  failures: Array<{ namespace: string; id: string; error: string }>;
}

interface NamespaceReceipt {
  scanned: number;
  graduated: number;
  would_graduate: number;
  kept: number;
  archived: number;
  manual_review: number;
  duplicates: number;
  failed: number;
}

interface Args {
  apply: boolean;
  stateFile: string;
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
  dupThreshold: number;
}

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/tier-lane-durable.ts [--apply] [--once]",
      "       [--state-file <path>] [--batch-size 20] [--max-apply 5]",
      "       [--delay-ms 250] [--loop] [--interval-ms 60000]",
      "       [--min-content-length 24] [--dup-threshold 0.08]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode is bounded by --max-apply graduations and graduates lane",
      "events into the lane agent's OWN durable thoughts namespace.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    stateFile:
      process.env.OPENBRAIN_LANE_TIERING_STATE ??
      `${process.env.HOME ?? "."}/.local/state/open-brain/lane-tiering/state.json`,
    batchSize: Number(process.env.OPENBRAIN_LANE_TIERING_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_LANE_TIERING_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_LANE_TIERING_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(
      process.env.OPENBRAIN_LANE_TIERING_INTERVAL_MS ?? 60000,
    ),
    minContentLength: Number(
      process.env.OPENBRAIN_LANE_TIERING_MIN_CONTENT_LENGTH ?? 24,
    ),
    dupThreshold: Number(
      process.env.OPENBRAIN_LANE_TIERING_DUP_THRESHOLD ?? 0.08,
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
    } else if (arg === "--dup-threshold") {
      args.dupThreshold = Number(argv[++i] ?? 0);
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  if (
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
    args.minContentLength < 0 ||
    !Number.isFinite(args.dupThreshold) ||
    args.dupThreshold < 0 ||
    args.dupThreshold > 1
  ) {
    usage();
  }

  return args;
}

function defaultState(): State {
  return { version: 1, cursors: {} };
}

function loadState(args: Args): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
  } catch {
    // First run or corrupt state: start conservatively from the beginning.
    return defaultState();
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const state = parsed as State;
    if (state.version === 1) {
      state.cursors ??= {};
      return state;
    }
  }
  return defaultState();
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function newNamespaceReceipt(): NamespaceReceipt {
  return {
    scanned: 0,
    graduated: 0,
    would_graduate: 0,
    kept: 0,
    archived: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
  };
}

function addCount(
  receipt: Receipt,
  namespace: string,
  field: keyof NamespaceReceipt,
): void {
  const nsReceipt = (receipt.namespaces[namespace] ??= newNamespaceReceipt());
  nsReceipt[field] += 1;
  receipt[field] += 1;
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

async function listNamespaces(
  pool: ReturnType<typeof createPool>,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT namespace FROM ob_session_lanes ORDER BY namespace ASC`,
  );
  return rows.map((row) => row.namespace as string);
}

async function candidateEvents(
  pool: ReturnType<typeof createPool>,
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

export async function runLaneTiering(args: Args): Promise<Receipt> {
  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw new Error("OPENBRAIN_PROMOTION_KILL_SWITCH is enabled");
  }

  const state = loadState(args);
  const receipt: Receipt = {
    started_at: new Date().toISOString(),
    finished_at: "",
    dry_run: !args.apply,
    scanned: 0,
    graduated: 0,
    would_graduate: 0,
    kept: 0,
    archived: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
    namespaces: {},
    failures: [],
  };

  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-lane-tiering",
  });
  let applied = 0;

  try {
    const namespaces = await listNamespaces(pool);
    namespaces:
    for (const namespace of namespaces) {
      const events = await candidateEvents(
        pool,
        namespace,
        state.cursors[namespace],
        args.batchSize,
      );
      for (const event of events) {
        addCount(receipt, namespace, "scanned");
        const nextCursor = {
          created_at: new Date(event.created_at).toISOString(),
          id: event.id,
        };

        const classification = classifyLaneEvent(event, args.minContentLength);
        if (classification === "keep") {
          addCount(receipt, namespace, "kept");
          if (args.apply) state.cursors[namespace] = nextCursor;
          continue;
        }
        if (classification === "archive") {
          addCount(receipt, namespace, "archived");
          if (args.apply) state.cursors[namespace] = nextCursor;
          continue;
        }
        if (classification === "manual-review") {
          addCount(receipt, namespace, "manual_review");
          if (args.apply) state.cursors[namespace] = nextCursor;
          continue;
        }

        // classification === "graduate"
        if (args.apply && applied >= args.maxApply) {
          break namespaces;
        }

        try {
          let embedding: number[] | null = null;
          try {
            embedding = await generateEmbedding(event.content);
          } catch {
            embedding = null;
          }

          // Recompute the hash when the event row has none, matching the tool
          // path — otherwise a null-hash event skips exact dedup and gets
          // mis-reported as graduated/would_graduate.
          const dedupHash = event.content_hash ?? contentHash(event.content);
          const duplicate = await findDurableDuplicate(
            pool,
            namespace,
            dedupHash,
            embedding,
            args.dupThreshold,
          );
          if (duplicate) {
            addCount(receipt, namespace, "duplicates");
            if (args.apply) state.cursors[namespace] = nextCursor;
            continue;
          }

          if (!args.apply) {
            addCount(receipt, namespace, "would_graduate");
            continue;
          }

          await graduateLaneEvent(
            pool,
            event,
            namespace,
            "openbrain-lane-tiering",
            embedding,
            `lane tiering: ${event.event_type}/${event.importance}`,
          );
          applied += 1;
          addCount(receipt, namespace, "graduated");
          state.cursors[namespace] = nextCursor;
        } catch (err) {
          addCount(receipt, namespace, "failed");
          receipt.failures.push({
            namespace,
            id: event.id,
            error: sanitizeError(err),
          });
          break namespaces;
        }

        if (args.delayMs > 0) await sleep(args.delayMs);
      }
    }
  } finally {
    await pool.end();
  }

  receipt.finished_at = new Date().toISOString();
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
    const receipt = await runLaneTiering(args);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    logger.info("lane_tiering_receipt", {
      receipt_path: receiptPath,
      dry_run: receipt.dry_run,
      scanned: receipt.scanned,
      graduated: receipt.graduated,
      would_graduate: receipt.would_graduate,
      kept: receipt.kept,
      archived: receipt.archived,
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
    logger.error("lane_tiering_failed", { error: sanitizeError(err) });
    process.exit(1);
  });
}
