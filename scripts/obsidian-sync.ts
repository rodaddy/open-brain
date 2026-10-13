#!/usr/bin/env node
/**
 * Sync Open Brain data to Obsidian vault as project-centric .md files.
 *
 * Structure:
 *   Projects/<project-name>/_<project-name>.md   (MOC index)
 *   Projects/<project-name>/Decisions/...
 *   Projects/<project-name>/Thoughts/...
 *   Projects/<project-name>/Sessions/...
 *   Projects/_untagged/...                       (entries with no project)
 *   People/...
 *   Skippy/...                                   (human-authored, untouched)
 *   Home.md                                      (auto-generated index)
 *
 * Usage:
 *   bun run scripts/obsidian-sync.ts [vault-path]
 *
 * Default vault: /srv/shared/ObsidianVault
 * Override via OBSIDIAN_VAULT_PATH env var or CLI arg.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import pg from "pg";
import { logger } from "./settings.ts";
import { DEFAULT_VAULT, PROJECT_GROUPS } from "./obsidian-sync/helpers.ts";
import { renderProjectMOC } from "./obsidian-sync/renderers.ts";
import type { SyncStats } from "./obsidian-sync/rows.ts";
import {
  cleanOrphans,
  syncDecisions,
  syncPeople,
  syncSessions,
  syncThoughts,
  type SyncContext,
} from "./obsidian-sync/sync.ts";

function openPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "open_brain",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
}

/** Cross-reference map of every known person name. */
async function loadPeople(pool: pg.Pool): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    "SELECT person_name FROM relationships WHERE archived_at IS NULL",
  );
  return new Map<string, string>(
    rows.map((r: { person_name: string }) => [r.person_name, r.person_name]),
  );
}

/**
 * Canonical project list from session.project values ONLY.
 * Tags are too noisy -- zsh, react, bun etc. are not projects.
 */
async function loadProjects(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query(
    "SELECT DISTINCT project FROM sessions WHERE archived_at IS NULL AND project IS NOT NULL",
  );
  return new Set<string>(rows.map((r: { project: string }) => r.project));
}

/** Write the sub-project MOCs nested under one grouped parent folder. */
function writeSubProjectMOCs(projectsDir: string, parent: string): void {
  for (const sub of readdirSync(join(projectsDir, parent), {
    withFileTypes: true,
  })) {
    if (!sub.isDirectory()) continue;
    const subMocPath = join(projectsDir, parent, sub.name, `_${sub.name}.md`);
    writeFileSync(
      subMocPath,
      renderProjectMOC(sub.name, `Projects/${parent}/${sub.name}`),
    );
  }
}

/** Generate the MOC index for each project folder in the vault. */
function writeProjectMOCs(vault: string, stats: SyncStats): void {
  const projectsDir = join(vault, "Projects");
  if (!existsSync(projectsDir)) return;

  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mocPath = join(projectsDir, entry.name, `_${entry.name}.md`);
    writeFileSync(mocPath, renderProjectMOC(entry.name, `Projects/${entry.name}`));
    stats.projectCount++;

    if (PROJECT_GROUPS[entry.name]) {
      writeSubProjectMOCs(projectsDir, entry.name);
    }
  }
}

async function runSync(ctx: SyncContext): Promise<void> {
  logger.info("Starting sync", {
    vault: ctx.vault,
    people: ctx.people.size,
    projects: ctx.knownProjects.size,
  });

  await syncPeople(ctx);
  await syncDecisions(ctx);
  await syncThoughts(ctx);
  await syncSessions(ctx);

  writeProjectMOCs(ctx.vault, ctx.stats);

  await cleanOrphans(ctx.pool, ctx.vault, ctx.stats, (path) => rmSync(path));

  // Home.md and the section dashboards (_People.md, _Projects.md, _Skippy.md)
  // are hand-crafted and are deliberately not overwritten by sync.
  logger.info("Sync complete", ctx.stats as unknown as Record<string, unknown>);
}

async function main(): Promise<void> {
  const vault = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT;

  if (!existsSync(vault)) {
    logger.error("Vault path not found", { vault });
    process.exit(1);
  }

  const pool = openPool();
  const stats: SyncStats = {
    written: 0,
    skipped: 0,
    orphansRemoved: 0,
    projectCount: 0,
  };

  try {
    const people = await loadPeople(pool);
    const knownProjects = await loadProjects(pool);
    await runSync({ pool, vault, people, knownProjects, stats });
  } catch (err) {
    logger.error("Sync failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
