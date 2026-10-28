/** Table-by-table sync of Open Brain rows into the Obsidian vault tree. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type pg from "pg";
import { logger } from "../settings.ts";
import {
  ensureDir,
  expectDefined,
  fmtDate,
  isSyncManaged,
  projectPath,
  resolveProject,
  sanitize,
  shortId,
  UNTAGGED,
} from "./helpers.ts";
import {
  renderDecision,
  renderPerson,
  renderSession,
  renderThought,
} from "./renderers.ts";
import type {
  DecisionRow,
  PersonRow,
  SessionRow,
  SyncStats,
  ThoughtRow,
} from "./rows.ts";

/** Everything a table sync needs beyond its own query. */
export interface SyncContext {
  pool: pg.Pool;
  vault: string;
  people: Map<string, string>;
  knownProjects: Set<string>;
  stats: SyncStats;
}

/** Write one rendered note unless a hand-authored file already holds the path. */
function writeNote(path: string, body: string, stats: SyncStats): void {
  if (!isSyncManaged(path)) {
    stats.skipped++;
    return;
  }
  writeFileSync(path, body);
  stats.written++;
}

function logProgress(label: string, index: number, total: number, every: number): void {
  if ((index + 1) % every === 0) {
    logger.info(`  ${label}: ${index + 1}/${total}`);
  }
}

export async function syncPeople(ctx: SyncContext): Promise<void> {
  const { rows } = await ctx.pool.query<PersonRow>(
    `SELECT id, person_name, context, warmth, last_contact, notes, tags,
            relationship_type, email, phone, metadata, created_by,
            created_at, updated_at, namespace
     FROM relationships WHERE archived_at IS NULL
     ORDER BY person_name`,
  );

  const dir = join(ctx.vault, "People");
  ensureDir(dir);
  for (const row of rows) {
    const path = join(dir, `${sanitize(row.person_name)}.md`);
    writeNote(path, renderPerson(row, ctx.people, ctx.knownProjects), ctx.stats);
  }
}

export async function syncDecisions(ctx: SyncContext): Promise<void> {
  const { rows } = await ctx.pool.query<DecisionRow>(
    `SELECT id, title, rationale, alternatives, tags, context,
            created_by, created_at, updated_at, namespace
     FROM decisions WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing decisions", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = expectDefined(rows[i], "decision row");
    const project = resolveProject(row.tags, ctx.knownProjects);
    const dir = join(ctx.vault, "Projects", ...projectPath(project), "Decisions");
    ensureDir(dir);

    const filename = `${fmtDate(row.created_at)} ${sanitize(row.title)}.md`;
    writeNote(
      join(dir, filename),
      renderDecision(row, project, ctx.people, ctx.knownProjects),
      ctx.stats,
    );
    logProgress("decisions", i, rows.length, 200);
  }
}

export async function syncThoughts(ctx: SyncContext): Promise<void> {
  const { rows } = await ctx.pool.query<ThoughtRow>(
    `SELECT id, content, tags, source, created_by, created_at, updated_at, namespace
     FROM thoughts WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing thoughts", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = expectDefined(rows[i], "thought row");
    const project = resolveProject(row.tags, ctx.knownProjects);
    const dir = join(ctx.vault, "Projects", ...projectPath(project), "Thoughts");
    ensureDir(dir);

    const contentPreview = expectDefined(
      row.content.split("\n")[0],
      "thought first line",
    )
      .replace(/^#+\s*/, "")
      .slice(0, 50)
      .trim();
    const filename = `${fmtDate(row.created_at)} ${sanitize(contentPreview)} ${shortId(row.id)}.md`;
    writeNote(
      join(dir, filename),
      renderThought(row, project, ctx.people, ctx.knownProjects),
      ctx.stats,
    );
    logProgress("thoughts", i, rows.length, 500);
  }
}

export async function syncSessions(ctx: SyncContext): Promise<void> {
  const { rows } = await ctx.pool.query<SessionRow>(
    `SELECT id, project, summary, tags, blockers, next_steps, key_decisions,
            created_by, created_at, updated_at, namespace
     FROM sessions WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing sessions", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = expectDefined(rows[i], "session row");
    const project = row.project || UNTAGGED;
    const dir = join(ctx.vault, "Projects", ...projectPath(project), "Sessions");
    ensureDir(dir);

    const projectLabel = row.project || "General";
    const filename = `${fmtDate(row.created_at)} ${sanitize(projectLabel)} ${shortId(row.id)}.md`;
    writeNote(
      join(dir, filename),
      renderSession(row, ctx.people, ctx.knownProjects),
      ctx.stats,
    );
    logProgress("sessions", i, rows.length, 500);
  }
}

const ORPHAN_TABLES: Record<string, string> = {
  thoughts: "thoughts",
  decisions: "decisions",
  relationships: "relationships",
  sessions: "sessions",
};

/** Collect all .md files under a directory, recursively. */
function walkDir(dir: string): string[] {
  const paths: string[] = [];
  if (!existsSync(dir)) return paths;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...walkDir(full));
    } else if (entry.name.endsWith(".md")) {
      paths.push(full);
    }
  }
  return paths;
}

/** The Open Brain row a synced note points at, when the note declares one. */
function noteOrigin(path: string): { obId: string; obTable: string } | null {
  const content = readFileSync(path, "utf-8");
  const idMatch = content.match(/ob_id:\s*"([^"]+)"/);
  const tableMatch = content.match(/ob_table:\s*"([^"]+)"/);
  if (!idMatch || !tableMatch) return null;

  const obId = idMatch[1];
  const declaredTable = tableMatch[1];
  if (obId === undefined || declaredTable === undefined) return null;

  const obTable = ORPHAN_TABLES[declaredTable];
  if (!obTable) return null;
  return { obId, obTable };
}

/** Recursively remove orphaned sync files in Projects/ and People/ */
export async function cleanOrphans(
  pool: pg.Pool,
  vault: string,
  stats: SyncStats,
  removeFile: (path: string) => void,
): Promise<void> {
  const searchDirs = [join(vault, "Projects"), join(vault, "People")];
  for (const searchDir of searchDirs) {
    for (const path of walkDir(searchDir)) {
      const origin = noteOrigin(path);
      if (!origin) continue;

      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${origin.obTable} WHERE id = $1 AND archived_at IS NULL`,
        [origin.obId],
      );
      if (rowCount) continue;

      removeFile(path);
      logger.info("Removed orphan", { path });
      stats.orphansRemoved++;
    }
  }
}
