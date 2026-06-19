#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPool } from "../src/db/pool.ts";
import { logger } from "../src/logger.ts";
import { promoteEntry } from "../src/promotion-service.ts";
import {
  canonicalNamespace,
  sharedNamespaceConfig,
} from "../src/shared-namespace.ts";
import { ALL_TABLES } from "../src/tools/table-constants.ts";
import type { AuthInfo, Table } from "../src/types.ts";

interface Cursor {
  created_at?: string;
  id?: string;
}

interface State {
  version: 1;
  source_namespace: string;
  target_namespace: string;
  cursors: Partial<Record<Table, Cursor>>;
  last_receipt?: Receipt;
}

interface Receipt {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  source_namespace: string;
  target_namespace: string;
  scanned: number;
  promoted: number;
  would_promote: number;
  duplicates: number;
  skipped: number;
  failed: number;
  tables: Partial<Record<Table, TableReceipt>>;
  failures: Array<{ table: Table; id: string; error: string }>;
}

interface TableReceipt {
  scanned: number;
  promoted: number;
  would_promote: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

interface Args {
  apply: boolean;
  sourceNamespace: string;
  targetNamespace: string;
  stateFile: string;
  tables: Table[];
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
}

const TABLE_CONTENT_SQL: Record<Table, string> = {
  thoughts: "content",
  decisions: "title || ' ' || COALESCE(rationale, '')",
  relationships: "person_name || ' ' || COALESCE(context, '') || ' ' || COALESCE(notes, '')",
  projects: "name || ' ' || COALESCE(description, '')",
  sessions: "COALESCE(project, '') || ' ' || COALESCE(summary, '')",
};

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/promote-legacy-shared.ts [--apply] [--once]",
      "       [--source-namespace collab] [--target-namespace shared-kb]",
      "       [--state-file <path>] [--tables thoughts,decisions]",
      "       [--batch-size 20] [--max-apply 5] [--delay-ms 250]",
      "       [--loop] [--interval-ms 60000]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode is bounded by --max-apply and uses the server promotion",
      "service for provenance, duplicate checks, and policy.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const config = sharedNamespaceConfig();
  const args: Args = {
    apply: false,
    sourceNamespace: config.legacySharedNamespace,
    targetNamespace: config.canonicalSharedNamespace,
    stateFile:
      process.env.OPENBRAIN_LEGACY_PROMOTER_STATE ??
      "/Volumes/ThunderBolt/_tmp/open-brain-legacy-promoter/state.json",
    tables: ALL_TABLES,
    batchSize: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(
      process.env.OPENBRAIN_LEGACY_PROMOTER_INTERVAL_MS ?? 60000,
    ),
    minContentLength: Number(
      process.env.OPENBRAIN_LEGACY_PROMOTER_MIN_CONTENT_LENGTH ?? 24,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--once") args.loop = false;
    else if (arg === "--loop") args.loop = true;
    else if (arg === "--source-namespace") args.sourceNamespace = argv[++i] ?? "";
    else if (arg === "--target-namespace") args.targetNamespace = argv[++i] ?? "";
    else if (arg === "--state-file") args.stateFile = argv[++i] ?? "";
    else if (arg === "--tables") args.tables = parseTables(argv[++i] ?? "");
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
    !args.sourceNamespace ||
    !args.targetNamespace ||
    !args.stateFile ||
    args.tables.length === 0 ||
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

function parseTables(raw: string): Table[] {
  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const valid = new Set<Table>(ALL_TABLES);
  const tables = requested.filter((table): table is Table =>
    valid.has(table as Table),
  );
  if (tables.length !== requested.length) {
    throw new Error(`Invalid table list: ${raw}`);
  }
  return tables;
}

function defaultState(args: Args): State {
  return {
    version: 1,
    source_namespace: args.sourceNamespace,
    target_namespace: canonicalNamespace(args.targetNamespace),
    cursors: {},
  };
}

function loadState(args: Args): State {
  try {
    const parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
    if (parsed?.version === 1) return parsed as State;
  } catch {
    // First run or corrupt state: start conservatively from the beginning.
  }
  return defaultState(args);
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function newTableReceipt(): TableReceipt {
  return {
    scanned: 0,
    promoted: 0,
    would_promote: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
  };
}

function addCount(receipt: Receipt, table: Table, field: keyof TableReceipt): void {
  const tableReceipt = (receipt.tables[table] ??= newTableReceipt());
  tableReceipt[field] += 1;
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

async function candidateRows(
  pool: ReturnType<typeof createPool>,
  table: Table,
  namespace: string,
  cursor: Cursor | undefined,
  limit: number,
): Promise<Array<{ id: string; created_at: string; preview: string }>> {
  const params: unknown[] = [namespace, limit];
  let cursorSql = "";
  if (cursor?.created_at && cursor.id) {
    params.push(cursor.created_at, cursor.id);
    cursorSql = ` AND (created_at, id) > ($3::timestamptz, $4::uuid)`;
  }
  const { rows } = await pool.query(
    `SELECT id, created_at, LEFT(COALESCE(${TABLE_CONTENT_SQL[table]}, ''), 500) AS preview
     FROM ${table}
     WHERE namespace = $1 AND archived_at IS NULL${cursorSql}
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    params,
  );
  return rows;
}

export async function runLegacyPromoter(args: Args): Promise<Receipt> {
  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw new Error("OPENBRAIN_PROMOTION_KILL_SWITCH is enabled");
  }

  const state = loadState(args);
  const receipt: Receipt = {
    started_at: new Date().toISOString(),
    finished_at: "",
    dry_run: !args.apply,
    source_namespace: args.sourceNamespace,
    target_namespace: canonicalNamespace(args.targetNamespace),
    scanned: 0,
    promoted: 0,
    would_promote: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    tables: {},
    failures: [],
  };

  const auth: AuthInfo = {
    role: "n8n",
    clientId: "openbrain-promoter",
    tokenClientId: "openbrain-promoter",
    namespaceSource: "token",
  };
  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-legacy-promoter",
  });
  let applied = 0;

  try {
    tables:
    for (const table of args.tables) {
      const rows = await candidateRows(
        pool,
        table,
        args.sourceNamespace,
        state.cursors[table],
        args.batchSize,
      );
      for (const row of rows) {
        addCount(receipt, table, "scanned");
        const nextCursor = {
          created_at: new Date(row.created_at).toISOString(),
          id: row.id,
        };

        if ((row.preview ?? "").trim().length < args.minContentLength) {
          addCount(receipt, table, "skipped");
          if (args.apply) state.cursors[table] = nextCursor;
          continue;
        }
        if (args.apply && applied >= args.maxApply) {
          break tables;
        }

        try {
          const result = await promoteEntry(
            pool,
            table,
            row.id,
            args.targetNamespace,
            "legacy collab background promoter",
            auth,
            { dryRun: !args.apply },
          );
          if (result.status === "duplicate") {
            addCount(receipt, table, "duplicates");
            if (args.apply) state.cursors[table] = nextCursor;
          } else if (result.status === "dry_run") {
            addCount(receipt, table, "would_promote");
          } else if (result.status === "promoted") {
            applied += 1;
            addCount(receipt, table, "promoted");
            state.cursors[table] = nextCursor;
          }
        } catch (err) {
          addCount(receipt, table, "failed");
          receipt.failures.push({ table, id: row.id, error: sanitizeError(err) });
        }

        if (args.delayMs > 0) await sleep(args.delayMs);
      }
    }
  } finally {
    await pool.end();
  }

  receipt.finished_at = new Date().toISOString();
  state.source_namespace = args.sourceNamespace;
  state.target_namespace = receipt.target_namespace;
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
    const receipt = await runLegacyPromoter(args);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    logger.info("legacy_promoter_receipt", {
      receipt_path: receiptPath,
      dry_run: receipt.dry_run,
      scanned: receipt.scanned,
      promoted: receipt.promoted,
      would_promote: receipt.would_promote,
      duplicates: receipt.duplicates,
      skipped: receipt.skipped,
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
  run()
    .catch((err) => {
      logger.error("legacy_promoter_failed", { error: sanitizeError(err) });
      process.exit(1);
    });
}
