#!/usr/bin/env bun
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
 * Default vault: /Volumes/collab/ObsidianVault
 * Override via OBSIDIAN_VAULT_PATH env var or CLI arg.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import pg from "pg";
import { logger } from "../src/logger.ts";

const DEFAULT_VAULT = "/Volumes/collab/ObsidianVault";
const UNTAGGED = "_untagged";

/**
 * Project grouping -- merge related sub-projects into a parent folder.
 * Key = parent folder name, Value = sub-project names that nest under it.
 * Files land at: Projects/<parent>/<sub>/Decisions|Thoughts|Sessions/
 */
const PROJECT_GROUPS: Record<string, string[]> = {
  King: [
    "king",
    "king-ng",
    "king-capital",
    "king-ingest",
    "king-strat",
    "king-trading",
  ],
};

// Build reverse lookup: sub-project -> parent group
const GROUP_LOOKUP = new Map<string, string>();
for (const [parent, children] of Object.entries(PROJECT_GROUPS)) {
  for (const child of children) {
    GROUP_LOOKUP.set(child, parent);
  }
}

/* ---------- Types ---------- */

interface PersonRow {
  id: string;
  person_name: string;
  context: string | null;
  warmth: number | null;
  last_contact: string | null;
  notes: string | null;
  tags: string[];
  relationship_type: string | null;
  email: string | null;
  phone: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

interface DecisionRow {
  id: string;
  title: string;
  rationale: string;
  alternatives: unknown[];
  tags: string[];
  context: string | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

interface ThoughtRow {
  id: string;
  content: string;
  tags: string[];
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

interface SessionRow {
  id: string;
  project: string | null;
  summary: string;
  tags: string[];
  blockers: string[];
  next_steps: string[];
  key_decisions: string[];
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

/* ---------- Helpers ---------- */

function sanitize(name: string, maxLen = 80): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().split("T")[0]!;
}

function shortId(uuid: string): string {
  return uuid.split("-")[0]!;
}

function warmthStars(w: number | null): string {
  if (!w) return "—";
  return "★".repeat(w) + "☆".repeat(5 - w) + ` (${w}/5)`;
}

function tagLine(tags: string[], prefix: string): string {
  const merged = [prefix, ...tags.filter((t) => t !== prefix)];
  return `[${merged.map((t) => `"${t}"`).join(", ")}]`;
}

function listItems(items: string[] | unknown[]): string {
  if (!items || items.length === 0) return "—";
  return items.map((i) => `- ${String(i)}`).join("\n");
}

/** Find first tag matching a known project name, or UNTAGGED */
function resolveProject(tags: string[], knownProjects: Set<string>): string {
  for (const tag of tags) {
    if (knownProjects.has(tag)) return tag;
    // Case-insensitive fallback
    const lower = tag.toLowerCase();
    for (const p of knownProjects) {
      if (p.toLowerCase() === lower) return p;
    }
  }
  return UNTAGGED;
}

/** Resolve vault path segments for a project: [parent, sub] or just [project] */
function projectPath(project: string): string[] {
  const parent = GROUP_LOOKUP.get(project);
  if (parent) return [sanitize(parent), sanitize(project)];
  return [sanitize(project)];
}

/** Inject [[wikilinks]] for known people and project names in text */
function injectLinks(
  text: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  let result = text;
  const names = [...Array.from(people.keys()), ...Array.from(projects)].sort(
    (a, b) => b.length - a.length,
  );

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, "gi");
    result = result.replace(re, `[[${name}]]`);
  }
  return result;
}

function isSyncManaged(path: string): boolean {
  if (!existsSync(path)) return true;
  const content = readFileSync(path, "utf-8");
  return content.includes("ob_id:");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/* ---------- Renderers ---------- */

function renderPerson(
  row: PersonRow,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const meta = row.metadata || {};
  const lines: (string | null)[] = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "relationships"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/person")}`,
    `warmth: ${row.warmth || 0}`,
    row.relationship_type
      ? `relationship_type: "${row.relationship_type}"`
      : null,
    row.email ? `email: "${row.email}"` : null,
    row.phone ? `phone: "${row.phone}"` : null,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# ${row.person_name}`,
    "",
  ];

  if (row.relationship_type || row.warmth) {
    lines.push("| Field | Value |", "|---|---|");
    if (row.relationship_type)
      lines.push(`| Relationship | ${row.relationship_type} |`);
    if (row.warmth) lines.push(`| Warmth | ${warmthStars(row.warmth)} |`);
    if (row.last_contact)
      lines.push(`| Last Contact | ${fmtDate(row.last_contact)} |`);
    if (row.email) lines.push(`| Email | ${row.email} |`);
    if (row.phone) lines.push(`| Phone | ${row.phone} |`);
    if (meta.imessage) lines.push(`| iMessage | ${String(meta.imessage)} |`);
    lines.push("");
  }

  if (row.context) {
    lines.push(
      "## Context",
      "",
      injectLinks(row.context, people, projects),
      "",
    );
  }
  if (row.notes) {
    lines.push("## Notes", "", injectLinks(row.notes, people, projects), "");
  }

  lines.push("---", `> Synced from Open Brain | ${fmtDate(row.created_at)}`);
  return lines.filter((l) => l !== null).join("\n");
}

function renderDecision(
  row: DecisionRow,
  project: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "decisions"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/decision")}`,
    `project: "${project}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# ${row.title}`,
    "",
    "## Rationale",
    "",
    injectLinks(row.rationale, people, projects),
    "",
  ];

  if (row.alternatives && row.alternatives.length > 0) {
    lines.push("## Alternatives Considered", "");
    for (const alt of row.alternatives) {
      if (typeof alt === "string") {
        lines.push(`- ${alt}`);
      } else if (typeof alt === "object" && alt !== null) {
        const a = alt as Record<string, unknown>;
        lines.push(`- **${a.option || "Option"}**: ${a.reason || a.pro || ""}`);
      }
    }
    lines.push("");
  }

  if (row.context) {
    lines.push(
      "## Context",
      "",
      injectLinks(row.context, people, projects),
      "",
    );
  }

  lines.push("---", `> Synced from Open Brain | ${fmtDate(row.created_at)}`);
  return lines.join("\n");
}

function renderThought(
  row: ThoughtRow,
  project: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "thoughts"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/thought")}`,
    `project: "${project}"`,
    `source: "${row.source}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    injectLinks(row.content, people, projects),
    "",
    "---",
    `> Synced from Open Brain | ${fmtDate(row.created_at)}`,
  ];
  return lines.join("\n");
}

function renderSession(
  row: SessionRow,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const projectLabel = row.project || "General";
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "sessions"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/session")}`,
    `project: "${projectLabel}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# Session: [[${projectLabel}]] -- ${fmtDate(row.created_at)}`,
    "",
    "## Summary",
    "",
    injectLinks(row.summary, people, projects),
    "",
  ];

  if (row.key_decisions.length > 0) {
    lines.push("## Key Decisions", "", listItems(row.key_decisions), "");
  }
  if (row.blockers.length > 0) {
    lines.push("## Blockers", "", listItems(row.blockers), "");
  }
  if (row.next_steps.length > 0) {
    lines.push("## Next Steps", "", listItems(row.next_steps), "");
  }

  lines.push("---", `> Synced from Open Brain | ${fmtDate(row.created_at)}`);
  return lines.join("\n");
}

/** Generate project MOC (Map of Content) index */
function renderProjectMOC(projectName: string, vaultRelPath: string): string {
  // For grouped projects, list sub-project folders with dataview
  const isGroup = PROJECT_GROUPS[projectName] !== undefined;
  const subProjects = PROJECT_GROUPS[projectName] || [];

  const subLinks = isGroup
    ? subProjects.map((s) => `- [[${s}]]`).join("\n")
    : "";

  return `---
ob_synced: "${new Date().toISOString()}"
tags: [ob/project, ob/moc]
project: "${projectName}"
---

# ${projectName}

> Map of Content for **${projectName}** -- auto-generated from Open Brain.

${isGroup ? `## Sub-Projects\n\n${subLinks}\n\n---\n` : ""}
## Sessions

\`\`\`dataview
TABLE created as "Date", project as "Sub-Project"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "sessions"
SORT created DESC
\`\`\`

---

## Decisions

\`\`\`dataview
TABLE created as "Date"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "decisions"
SORT created DESC
\`\`\`

---

## Thoughts

\`\`\`dataview
TABLE created as "Date", source as "Source"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "thoughts"
SORT created DESC
\`\`\`
`;
}

/* ---------- Sync Logic ---------- */

interface SyncStats {
  written: number;
  skipped: number;
  orphansRemoved: number;
  projectCount: number;
}

async function syncPeople(
  pool: pg.Pool,
  vault: string,
  people: Map<string, string>,
  projects: Set<string>,
  stats: SyncStats,
): Promise<void> {
  const { rows } = await pool.query<PersonRow>(
    `SELECT id, person_name, context, warmth, last_contact, notes, tags,
            relationship_type, email, phone, metadata, created_by,
            created_at, updated_at, namespace
     FROM relationships WHERE archived_at IS NULL
     ORDER BY person_name`,
  );

  const dir = join(vault, "People");
  ensureDir(dir);
  for (const row of rows) {
    const filename = `${sanitize(row.person_name)}.md`;
    const path = join(dir, filename);
    if (!isSyncManaged(path)) {
      stats.skipped++;
      continue;
    }
    writeFileSync(path, renderPerson(row, people, projects));
    stats.written++;
  }
}

async function syncDecisions(
  pool: pg.Pool,
  vault: string,
  people: Map<string, string>,
  knownProjects: Set<string>,
  stats: SyncStats,
): Promise<void> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT id, title, rationale, alternatives, tags, context,
            created_by, created_at, updated_at, namespace
     FROM decisions WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing decisions", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const project = resolveProject(row.tags, knownProjects);
    const segments = projectPath(project);
    const dir = join(vault, "Projects", ...segments, "Decisions");
    ensureDir(dir);

    const filename = `${fmtDate(row.created_at)} ${sanitize(row.title)}.md`;
    const path = join(dir, filename);
    if (!isSyncManaged(path)) {
      stats.skipped++;
      continue;
    }
    writeFileSync(path, renderDecision(row, project, people, knownProjects));
    stats.written++;
    if ((i + 1) % 200 === 0)
      logger.info(`  decisions: ${i + 1}/${rows.length}`);
  }
}

async function syncThoughts(
  pool: pg.Pool,
  vault: string,
  people: Map<string, string>,
  knownProjects: Set<string>,
  stats: SyncStats,
): Promise<void> {
  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, tags, source, created_by, created_at, updated_at, namespace
     FROM thoughts WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing thoughts", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const project = resolveProject(row.tags, knownProjects);
    const segments = projectPath(project);
    const dir = join(vault, "Projects", ...segments, "Thoughts");
    ensureDir(dir);

    const contentPreview = row.content
      .split("\n")[0]!
      .replace(/^#+\s*/, "")
      .slice(0, 50)
      .trim();
    const filename = `${fmtDate(row.created_at)} ${sanitize(contentPreview)} ${shortId(row.id)}.md`;
    const path = join(dir, filename);
    if (!isSyncManaged(path)) {
      stats.skipped++;
      continue;
    }
    writeFileSync(path, renderThought(row, project, people, knownProjects));
    stats.written++;
    if ((i + 1) % 500 === 0) logger.info(`  thoughts: ${i + 1}/${rows.length}`);
  }
}

async function syncSessions(
  pool: pg.Pool,
  vault: string,
  people: Map<string, string>,
  knownProjects: Set<string>,
  stats: SyncStats,
): Promise<void> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, project, summary, tags, blockers, next_steps, key_decisions,
            created_by, created_at, updated_at, namespace
     FROM sessions WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );

  logger.info("Syncing sessions", { count: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const project = row.project || UNTAGGED;
    const segments = projectPath(project);
    const dir = join(vault, "Projects", ...segments, "Sessions");
    ensureDir(dir);

    const projectLabel = row.project || "General";
    const filename = `${fmtDate(row.created_at)} ${sanitize(projectLabel)} ${shortId(row.id)}.md`;
    const path = join(dir, filename);
    if (!isSyncManaged(path)) {
      stats.skipped++;
      continue;
    }
    writeFileSync(path, renderSession(row, people, knownProjects));
    stats.written++;
    if ((i + 1) % 500 === 0) logger.info(`  sessions: ${i + 1}/${rows.length}`);
  }
}

/** Recursively remove orphaned sync files in Projects/ */
async function cleanOrphans(
  pool: pg.Pool,
  vault: string,
  stats: SyncStats,
): Promise<void> {
  const tableMap: Record<string, string> = {
    thoughts: "thoughts",
    decisions: "decisions",
    relationships: "relationships",
    sessions: "sessions",
  };

  // Collect all ob_id-bearing files recursively
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

  const searchDirs = [join(vault, "Projects"), join(vault, "People")];
  for (const searchDir of searchDirs) {
    const files = walkDir(searchDir);
    for (const path of files) {
      const content = readFileSync(path, "utf-8");
      const idMatch = content.match(/ob_id:\s*"([^"]+)"/);
      const tableMatch = content.match(/ob_table:\s*"([^"]+)"/);
      if (!idMatch || !tableMatch) continue;

      const obId = idMatch[1]!;
      const obTable = tableMap[tableMatch[1]!];
      if (!obTable) continue;

      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${obTable} WHERE id = $1 AND archived_at IS NULL`,
        [obId],
      );
      if (!rowCount || rowCount === 0) {
        rmSync(path);
        logger.info("Removed orphan", { path });
        stats.orphansRemoved++;
      }
    }
  }
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const vault =
    process.argv[2] || process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT;

  if (!existsSync(vault)) {
    logger.error("Vault path not found", { vault });
    process.exit(1);
  }

  const pool = new pg.Pool({
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
  const stats: SyncStats = {
    written: 0,
    skipped: 0,
    orphansRemoved: 0,
    projectCount: 0,
  };

  try {
    // 1. Build people cross-reference map
    const { rows: peopleRows } = await pool.query(
      "SELECT person_name FROM relationships WHERE archived_at IS NULL",
    );
    const people = new Map<string, string>(
      peopleRows.map((r: { person_name: string }) => [
        r.person_name,
        r.person_name,
      ]),
    );

    // 2. Build canonical project list from session.project values ONLY
    //    Tags are too noisy -- zsh, react, bun etc. are not projects.
    const { rows: projectRows } = await pool.query(
      "SELECT DISTINCT project FROM sessions WHERE archived_at IS NULL AND project IS NOT NULL",
    );
    const knownProjects = new Set<string>(
      projectRows.map((r: { project: string }) => r.project),
    );

    logger.info("Starting sync", {
      vault,
      people: people.size,
      projects: knownProjects.size,
    });

    // 3. Sync all tables
    await syncPeople(pool, vault, people, knownProjects, stats);
    await syncDecisions(pool, vault, people, knownProjects, stats);
    await syncThoughts(pool, vault, people, knownProjects, stats);
    await syncSessions(pool, vault, people, knownProjects, stats);

    // 4. Generate MOC index for each project folder
    const projectsDir = join(vault, "Projects");
    if (existsSync(projectsDir)) {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relPath = `Projects/${entry.name}`;
        const mocPath = join(projectsDir, entry.name, `_${entry.name}.md`);
        writeFileSync(mocPath, renderProjectMOC(entry.name, relPath));
        stats.projectCount++;

        // For grouped projects, also generate sub-project MOCs
        if (PROJECT_GROUPS[entry.name]) {
          for (const sub of readdirSync(join(projectsDir, entry.name), {
            withFileTypes: true,
          })) {
            if (!sub.isDirectory()) continue;
            const subRelPath = `Projects/${entry.name}/${sub.name}`;
            const subMocPath = join(
              projectsDir,
              entry.name,
              sub.name,
              `_${sub.name}.md`,
            );
            writeFileSync(subMocPath, renderProjectMOC(sub.name, subRelPath));
          }
        }
      }
    }

    // 5. Clean orphans
    await cleanOrphans(pool, vault, stats);

    // 6. Skip Home.md, section dashboards (_People.md, _Projects.md, _Skippy.md)
    //    These are hand-crafted and should not be overwritten by sync.

    logger.info("Sync complete", stats as unknown as Record<string, unknown>);
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
