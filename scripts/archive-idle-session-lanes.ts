#!/usr/bin/env bun
/**
 * Archive idle session lanes.
 *
 * Safety model:
 * - Dry-run by default; no rows mutate unless --execute is passed.
 * - Narrow by default to Discord/realtime lanes via source='discord'.
 * - Parameterized SQL only; caller values are never interpolated.
 * - Idempotent: already archived/wrapped lanes are skipped.
 */
import type pg from "pg";
import { createPool } from "../src/db/pool.ts";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export interface ArchiveIdleLaneArgs {
  execute: boolean;
  olderThanDays: number;
  limit: number;
  source?: string;
  namespace?: string;
  sessionKeyPrefix?: string;
}

export interface ArchiveIdleLaneCandidate {
  id: string;
  namespace: string;
  session_key: string;
  source: string | null;
  last_event_at: string | null;
  lane_created_at: string;
  lane_updated_at: string;
}

export interface ArchiveIdleLaneReport {
  dry_run: boolean;
  older_than_days: number;
  limit: number;
  source: string | null;
  namespace: string | null;
  session_key_prefix: string | null;
  candidates: ArchiveIdleLaneCandidate[];
  archived: number;
}

export function parseArgs(argv: string[]): ArchiveIdleLaneArgs {
  const args: ArchiveIdleLaneArgs = {
    execute: false,
    olderThanDays: 30,
    limit: 500,
    source: "discord",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    if (arg === "--execute") args.execute = true;
    else if (arg === "--older-than-days") {
      args.olderThanDays = parsePositiveInt(next(), arg);
    } else if (arg === "--limit") {
      args.limit = parsePositiveInt(next(), arg);
    } else if (arg === "--source") {
      const value = next();
      args.source = value === "*" ? undefined : value;
    } else if (arg === "--namespace") {
      args.namespace = next();
    } else if (arg === "--session-key-prefix") {
      args.sessionKeyPrefix = next();
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.source && !args.namespace && !args.sessionKeyPrefix) {
    throw new Error(
      "Refusing broad idle-lane sweep: provide --source, --namespace, or --session-key-prefix",
    );
  }

  return args;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function buildFilters(args: ArchiveIdleLaneArgs): {
  where: string[];
  params: unknown[];
} {
  const params: unknown[] = [args.olderThanDays, args.limit];
  const where = [
    "l.status = 'active'",
    "l.ended_at IS NULL",
    "COALESCE(last_event.last_event_at, l.created_at) < NOW() - ($1::int * INTERVAL '1 day')",
  ];

  if (args.source) {
    params.push(args.source);
    where.push(`l.source = $${params.length}`);
  }
  if (args.namespace) {
    params.push(args.namespace);
    where.push(`l.namespace = $${params.length}`);
  }
  if (args.sessionKeyPrefix) {
    params.push(`${args.sessionKeyPrefix}%`);
    where.push(`l.session_key LIKE $${params.length}`);
  }

  return { where, params };
}

export async function archiveIdleSessionLanes(
  db: Queryable,
  args: ArchiveIdleLaneArgs,
): Promise<ArchiveIdleLaneReport> {
  const { where, params } = buildFilters(args);
  const whereSql = where.join("\n       AND ");

  const { rows: candidates } = await db.query(
    `SELECT l.id, l.namespace, l.session_key, l.source,
            last_event.last_event_at,
            l.created_at AS lane_created_at,
            l.updated_at AS lane_updated_at
       FROM ob_session_lanes l
       LEFT JOIN LATERAL (
         SELECT MAX(e.created_at) AS last_event_at
           FROM ob_session_events e
          WHERE e.lane_id = l.id
       ) last_event ON TRUE
      WHERE ${whereSql}
      ORDER BY COALESCE(last_event.last_event_at, l.created_at) ASC, l.id ASC
      LIMIT $2`,
    params,
  );

  let archived = 0;
  if (args.execute && candidates.length > 0) {
    const ids = candidates.map((row) => row.id);
    const result = await db.query(
      `UPDATE ob_session_lanes
          SET status = 'archived',
              ended_at = COALESCE(ended_at, NOW()),
              updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND status = 'active'
          AND ended_at IS NULL`,
      [ids],
    );
    archived = result.rowCount ?? 0;
  }

  return {
    dry_run: !args.execute,
    older_than_days: args.olderThanDays,
    limit: args.limit,
    source: args.source ?? null,
    namespace: args.namespace ?? null,
    session_key_prefix: args.sessionKeyPrefix ?? null,
    candidates: candidates as ArchiveIdleLaneCandidate[],
    archived,
  };
}

function printUsage(): void {
  console.error(`Usage:
  bun run scripts/archive-idle-session-lanes.ts [--execute] [options]

Options:
  --older-than-days N      Archive lanes idle longer than N days (default 30)
  --limit N               Maximum lanes per run (default 500)
  --source VALUE          Lane source to sweep (default discord, "*" disables)
  --namespace VALUE       Restrict to one namespace
  --session-key-prefix P  Restrict to session_key LIKE "P%"
`);
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (!process.env.DB_HOST || !process.env.DB_USER) {
      throw new Error(
        "DB_HOST and DB_USER are required (DB_NAME defaults to open_brain).",
      );
    }
    const pool = createPool({
      max: 2,
      statement_timeout: 60000,
      application_name: "openbrain-archive-idle-session-lanes",
    });
    try {
      const report = await archiveIdleSessionLanes(pool, args);
      console.log(JSON.stringify(report, null, 2));
      if (report.dry_run) {
        console.error(
          "\nDRY-RUN complete. No rows were mutated. Re-run with --execute to apply.",
        );
      }
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }
}
