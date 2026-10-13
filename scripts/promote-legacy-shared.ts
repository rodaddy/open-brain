#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ALL_TABLES,
  canonicalNamespace,
  createPool,
  logger,
  promoteEntry,
  sharedNamespaceConfig,
} from "./settings.ts";
import type { AuthInfo, Table } from "./settings.ts";

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
  relationships:
    "person_name || ' ' || COALESCE(context, '') || ' ' || COALESCE(notes, '')",
  projects: "name || ' ' || COALESCE(description, '')",
  sessions: "COALESCE(project, '') || ' ' || COALESCE(summary, '')",
};

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: node scripts/promote-legacy-shared.ts [--apply] [--once]",
      "       [--source-namespace collab] [--target-namespace shared-kb]",
      "       [--state-file <path>] [--tables thoughts,decisions]",
      "       [--batch-size 20] [--max-apply 5] [--delay-ms 250]",
      "       [--loop] [--interval-ms 60000]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode is bounded by --max-apply promotions and uses the server promotion",
      "service for provenance, duplicate checks, and policy.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/** The `--flag value` options, each keyed by the field it sets. */
const STRING_OPTIONS: Record<
  string,
  "sourceNamespace" | "targetNamespace" | "stateFile"
> = {
  "--source-namespace": "sourceNamespace",
  "--target-namespace": "targetNamespace",
  "--state-file": "stateFile",
};

const NUMBER_OPTIONS: Record<
  string,
  "batchSize" | "maxApply" | "delayMs" | "intervalMs" | "minContentLength"
> = {
  "--batch-size": "batchSize",
  "--max-apply": "maxApply",
  "--delay-ms": "delayMs",
  "--interval-ms": "intervalMs",
  "--min-content-length": "minContentLength",
};

const BOOLEAN_OPTIONS: Record<string, { field: "apply" | "loop"; value: boolean }> = {
  "--apply": { field: "apply", value: true },
  "--once": { field: "loop", value: false },
  "--loop": { field: "loop", value: true },
};

/** The valued options, applied by table lookup; null when `arg` names none. */
function applyValuedArgument(args: Args, arg: string, value: string): boolean {
  const stringField = STRING_OPTIONS[arg];
  if (stringField) {
    args[stringField] = value;
    return true;
  }
  const numberField = NUMBER_OPTIONS[arg];
  if (numberField) {
    args[numberField] = Number(value);
    return true;
  }
  if (arg === "--tables") {
    args.tables = parseTables(value);
    return true;
  }
  return false;
}

/** Apply one argv token to `args`; returns the index of the last token consumed. */
function applyArgument(args: Args, argv: string[], index: number): number {
  const arg = argv[index] ?? "";
  const booleanOption = BOOLEAN_OPTIONS[arg];
  if (booleanOption) {
    args[booleanOption.field] = booleanOption.value;
    return index;
  }
  if (applyValuedArgument(args, arg, argv[index + 1] ?? "")) return index + 1;
  if (arg === "--help" || arg === "-h") usage(0);
  console.error(`Unknown argument: ${arg}`);
  usage();
}

function isInRange(value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** True when every parsed field is within the shape the promoter accepts. */
function argsAreValid(args: Args): boolean {
  return (
    Boolean(args.sourceNamespace) &&
    Boolean(args.targetNamespace) &&
    Boolean(args.stateFile) &&
    args.tables.length > 0 &&
    isInRange(args.batchSize, 1, 250) &&
    isInRange(args.maxApply, 0, 100) &&
    isInRange(args.delayMs, 0) &&
    isInRange(args.intervalMs, 1000) &&
    isInRange(args.minContentLength, 0)
  );
}

function defaultArgs(): Args {
  const config = sharedNamespaceConfig();
  return {
    apply: false,
    sourceNamespace: config.legacySharedNamespace,
    targetNamespace: config.canonicalSharedNamespace,
    stateFile:
      process.env.OPENBRAIN_LEGACY_PROMOTER_STATE ??
      `${process.env.HOME ?? "."}/.local/state/open-brain/legacy-promoter/state.json`,
    tables: ALL_TABLES,
    batchSize: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(process.env.OPENBRAIN_LEGACY_PROMOTER_INTERVAL_MS ?? 60000),
    minContentLength: Number(
      process.env.OPENBRAIN_LEGACY_PROMOTER_MIN_CONTENT_LENGTH ?? 24,
    ),
  };
}

function parseArgs(argv: string[]): Args {
  const args = defaultArgs();
  for (let i = 0; i < argv.length; i += 1) {
    i = applyArgument(args, argv, i);
  }
  if (!argsAreValid(args)) usage();
  validateLegacySharedRoute(args);
  return args;
}

function validateLegacySharedRoute(args: Args): void {
  const config = sharedNamespaceConfig();
  if (
    args.sourceNamespace !== config.legacySharedNamespace ||
    args.targetNamespace !== config.canonicalSharedNamespace
  ) {
    throw new Error(
      [
        "legacy shared promoter is restricted to the configured legacy shared",
        `namespace '${config.legacySharedNamespace}' -> canonical shared namespace`,
        `'${config.canonicalSharedNamespace}'`,
      ].join(" "),
    );
  }
}

function parseTables(raw: string): Table[] {
  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const valid = new Set<Table>(ALL_TABLES);
  const tables = requested.filter((table): table is Table => valid.has(table as Table));
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
  const expectedSource = args.sourceNamespace;
  const expectedTarget = canonicalNamespace(args.targetNamespace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
  } catch {
    // First run or corrupt state: start conservatively from the beginning.
    return defaultState(args);
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const state = parsed as State;
    if (state.version === 1) {
      if (
        state.source_namespace !== expectedSource ||
        state.target_namespace !== expectedTarget
      ) {
        throw new Error(
          [
            `state file ${args.stateFile} was created for`,
            `${state.source_namespace} -> ${state.target_namespace},`,
            `not ${expectedSource} -> ${expectedTarget}`,
          ].join(" "),
        );
      }
      return state;
    }
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

interface CandidateQuery {
  table: Table;
  namespace: string;
  cursor: Cursor | undefined;
  limit: number;
}

async function candidateRows(
  pool: ReturnType<typeof createPool>,
  query: CandidateQuery,
): Promise<Array<{ id: string; created_at: string; preview: string }>> {
  const { table, namespace, cursor, limit } = query;
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

interface PromoterRun {
  args: Args;
  pool: ReturnType<typeof createPool>;
  state: State;
  receipt: Receipt;
  auth: AuthInfo;
  applied: number;
}

type RowOutcome = "continue" | "stop";

/** Fold one promotion result into the receipt and, where it applies, the cursor. */
function recordPromotion(
  run: PromoterRun,
  table: Table,
  status: string,
  nextCursor: Cursor,
): void {
  const { args, receipt, state } = run;
  if (status === "duplicate") {
    addCount(receipt, table, "duplicates");
    if (args.apply) state.cursors[table] = nextCursor;
    return;
  }
  if (status === "dry_run") {
    addCount(receipt, table, "would_promote");
    return;
  }
  if (status === "promoted") {
    run.applied += 1;
    addCount(receipt, table, "promoted");
    state.cursors[table] = nextCursor;
  }
}

/** Promote one row; returns "stop" when the run should end after this row. */
async function promoteRow(
  run: PromoterRun,
  table: Table,
  row: { id: string; created_at: string; preview: string },
): Promise<RowOutcome> {
  const { args, receipt, state } = run;
  addCount(receipt, table, "scanned");
  const nextCursor = {
    created_at: new Date(row.created_at).toISOString(),
    id: row.id,
  };

  if ((row.preview ?? "").trim().length < args.minContentLength) {
    addCount(receipt, table, "skipped");
    if (args.apply) state.cursors[table] = nextCursor;
    return "continue";
  }
  if (args.apply && run.applied >= args.maxApply) return "stop";

  try {
    const result = await promoteEntry(
      run.pool,
      table,
      row.id,
      args.targetNamespace,
      "legacy collab background promoter",
      run.auth,
      { dryRun: !args.apply },
    );
    recordPromotion(run, table, result.status, nextCursor);
  } catch (err) {
    addCount(receipt, table, "failed");
    receipt.failures.push({ table, id: row.id, error: sanitizeError(err) });
    return "stop";
  }

  if (args.delayMs > 0) await sleep(args.delayMs);
  return "continue";
}

/** Scan and promote one table's batch; returns "stop" to end the whole run. */
async function promoteTable(run: PromoterRun, table: Table): Promise<RowOutcome> {
  const rows = await candidateRows(run.pool, {
    table,
    namespace: run.args.sourceNamespace,
    cursor: run.state.cursors[table],
    limit: run.args.batchSize,
  });
  for (const row of rows) {
    if ((await promoteRow(run, table, row)) === "stop") return "stop";
  }
  return "continue";
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
    role: "ob-admin",
    clientId: "openbrain-promoter",
    tokenClientId: "openbrain-promoter",
    namespaceSource: "token",
  };
  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-legacy-promoter",
  });
  const run: PromoterRun = { args, pool, state, receipt, auth, applied: 0 };

  try {
    for (const table of args.tables) {
      if ((await promoteTable(run, table)) === "stop") break;
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
  const args = parseArgs(process.argv.slice(2));
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
  run().catch((err) => {
    logger.error("legacy_promoter_failed", { error: sanitizeError(err) });
    process.exit(1);
  });
}
