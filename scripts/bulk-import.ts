#!/usr/bin/env node
/**
 * Bulk import markdown files into Open Brain.
 *
 * Usage:
 *   node scripts/bulk-import.ts <source-dir> [options]
 *
 * Options:
 *   --table <name>      Target: thoughts (default) | decisions | sessions
 *   --tags <t1,t2>      Additional tags for all imports
 *   --source <label>    Source label (default: "bulk-import")
 *   --embed             Generate embeddings inline (default: skip, use backfill)
 *   --extract           Run auto-metadata extraction (default: skip)
 *   --dry-run           Show what would be imported
 *   --pattern <glob>    File glob (default: "**\/*.md")
 */
import { glob, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";
import { toSql } from "pgvector/pg";
import {
  createPool,
  normalizedContentHash,
  generateEmbedding,
  EMBEDDING_MODEL,
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
  extractMetadata,
  mergeTags,
  logger,
  sharedNamespaceConfig,
} from "./settings.ts";

const DELAY_MS = 200;
const DEFAULT_IMPORT_NAMESPACE = sharedNamespaceConfig().sharedNamespace;

export type ImportTable = "thoughts" | "decisions" | "sessions";

export interface ParsedFile {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** The parsed command line, as every importer and the run loop see it. */
export interface ImportOptions {
  sourceDir: string;
  table: ImportTable;
  extraTags: string[];
  sourceLabel: string;
  embed: boolean;
  extract: boolean;
  dryRun: boolean;
  pattern: string;
}

export interface ImportStats {
  imported: number;
  skipped: number;
  duplicates: number;
  errors: number;
}

const QUOTES = /^["']|["']$/g;

/**
 * One frontmatter value: a simple `[a, b]` list becomes a string array, a
 * quoted scalar loses its quotes, anything else stays the raw trimmed string.
 */
function parseScalar(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(QUOTES, ""));
  }
  if (raw.startsWith('"') || raw.startsWith("'")) return raw.replace(QUOTES, "");
  return raw;
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const head = match?.[1];
  const rest = match?.[2];
  if (head === undefined || rest === undefined) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const fm: Record<string, unknown> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1).trim());
  }

  return { frontmatter: fm, body: rest.trim() };
}

export async function readFiles(
  sourceDir: string,
  pattern: string,
): Promise<ParsedFile[]> {
  const files: ParsedFile[] = [];

  for await (const path of glob(pattern, { cwd: sourceDir })) {
    const absolutePath = resolve(sourceDir, path);
    if ((await stat(absolutePath)).isDirectory()) continue;
    const raw = await readFile(absolutePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!body || body.length < 10) continue;
    files.push({ filePath: absolutePath, frontmatter, body });
  }

  return files;
}

/** Frontmatter `tags` when it is a list, plus the caller's extra tags. */
function startingTags(file: ParsedFile, extraTags: string[]): string[] {
  const fmTags = Array.isArray(file.frontmatter.tags)
    ? (file.frontmatter.tags as string[])
    : [];
  return [...fmTags, ...extraTags];
}

/**
 * The four embedding-derived insert values, which every importer writes in the
 * same order and leaves null together when nothing was embedded.
 */
function embeddingColumns(
  embedding: number[] | null,
): [string | null, string | null, string | null] {
  if (!embedding) return [null, null, null];
  return [toSql(embedding), new Date().toISOString(), EMBEDDING_MODEL];
}

/** Insert outcome from a dedupe-guarded `INSERT ... WHERE NOT EXISTS`. */
function insertOutcome(rowCount: number | null): "imported" | "duplicate" {
  return rowCount !== null && rowCount > 0 ? "imported" : "duplicate";
}

/** One import failure, logged with its file and reported as an error result. */
function reportImportError(file: ParsedFile, err: unknown): "error" {
  logger.warn("Import error", {
    file: file.filePath,
    error: err instanceof Error ? err.message : String(err),
  });
  return "error";
}

export async function importThought(
  pool: pg.Pool,
  file: ParsedFile,
  opts: {
    extraTags: string[];
    sourceLabel: string;
    embed: boolean;
    extract: boolean;
  },
): Promise<"imported" | "duplicate" | "error"> {
  const content = file.body;
  const hash = normalizedContentHash(content);

  let tags = startingTags(file, opts.extraTags);

  let embedding: number[] | null = null;
  let extracted: Awaited<ReturnType<typeof extractMetadata>> = null;

  if (opts.embed || opts.extract) {
    const promises: [
      Promise<number[] | null>,
      Promise<Awaited<ReturnType<typeof extractMetadata>>>,
    ] = [
      opts.embed ? generateEmbedding(content) : Promise.resolve(null),
      opts.extract ? extractMetadata(content) : Promise.resolve(null),
    ];
    [embedding, extracted] = await Promise.all(promises);
    tags = mergeTags(tags, extracted);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const [vector, embeddedAt, embeddingModel] = embeddingColumns(embedding);

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO thoughts (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model, extracted_metadata)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE NOT EXISTS (SELECT 1 FROM thoughts WHERE namespace = $5 AND content_hash = $7)`,
      [
        content,
        tags,
        opts.sourceLabel,
        "bulk-import",
        DEFAULT_IMPORT_NAMESPACE,
        vector,
        hash,
        embeddedAt,
        embeddingModel,
        extracted ? JSON.stringify(extracted) : null,
      ],
    );
    return insertOutcome(rowCount);
  } catch (err) {
    return reportImportError(file, err);
  }
}

export async function importDecision(
  pool: pg.Pool,
  file: ParsedFile,
  opts: {
    extraTags: string[];
    sourceLabel: string;
    embed: boolean;
    extract: boolean;
  },
): Promise<"imported" | "duplicate" | "error"> {
  const title =
    (file.frontmatter.title as string) ||
    (file.frontmatter.name as string) ||
    (file.body.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 200);
  const rationale = file.body;
  const context = `Imported from: ${file.filePath}`;

  let tags = startingTags(file, opts.extraTags);

  let embedding: number[] | null = null;
  let extracted: Awaited<ReturnType<typeof extractMetadata>> = null;

  if (opts.extract) {
    extracted = await extractMetadata(`${title}\n${rationale}`);
    tags = mergeTags(tags, extracted);
  }

  // Canonical decision text -- shared with the live writers and the
  // embedding-repair registry via decisionCanonicalText(). Built from the FINAL
  // inserted fields (including context and the post-extraction tags) so the row's
  // stored content_hash matches what the registry recomputes; the old
  // `${title}\n${rationale}` hash omitted context/tags and would be flagged as
  // source_drift the moment repair scanned the row.
  const textToEmbed = decisionCanonicalText({
    title,
    rationale,
    context,
    tags,
  });
  const hash = normalizedContentHash(textToEmbed);

  if (opts.embed) {
    embedding = await generateEmbedding(textToEmbed);
  }
  if (opts.embed || opts.extract) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const [vector, embeddedAt, embeddingModel] = embeddingColumns(embedding);

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO decisions (title, rationale, tags, context, created_by, namespace, embedding, content_hash, embedded_at, embedding_model, extracted_metadata)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE namespace = $6 AND content_hash = $8)`,
      [
        title,
        rationale,
        tags,
        context,
        "bulk-import",
        DEFAULT_IMPORT_NAMESPACE,
        vector,
        hash,
        embeddedAt,
        embeddingModel,
        extracted ? JSON.stringify(extracted) : null,
      ],
    );
    return insertOutcome(rowCount);
  } catch (err) {
    return reportImportError(file, err);
  }
}

export async function importSession(
  pool: pg.Pool,
  file: ParsedFile,
  opts: {
    extraTags: string[];
    sourceLabel: string;
    embed: boolean;
  },
): Promise<"imported" | "duplicate" | "error"> {
  const summary = file.body;
  const project = (file.frontmatter.project as string) || null;
  // Canonical session source hash + embed text -- shared with the live writers
  // (session_save / session_wrap / REST) and the embedding-repair registry via
  // sessionSourceHashInput()/sessionEmbedText(). The old timestamp-in-hash
  // produced a content_hash the registry can never reproduce, so every imported
  // session was permanently source_drift; hash the summary|project source
  // instead and dedup on it like the other importers.
  const hash = normalizedContentHash(sessionSourceHashInput({ summary, project }));

  const tags = startingTags(file, opts.extraTags);

  let embedding: number[] | null = null;
  if (opts.embed) {
    embedding = await generateEmbedding(sessionEmbedText({ summary, project }));
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const [vector, embeddedAt, embeddingModel] = embeddingColumns(embedding);

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO sessions (project, summary, tags, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
       WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE namespace = $5 AND content_hash = $7)`,
      [
        project,
        summary,
        tags,
        "bulk-import",
        DEFAULT_IMPORT_NAMESPACE,
        vector,
        hash,
        embeddedAt,
        embeddingModel,
      ],
    );
    return insertOutcome(rowCount);
  } catch (err) {
    return reportImportError(file, err);
  }
}

/** Everything one import pass over the parsed files needs. */
interface ImportRun {
  pool: pg.Pool;
  files: ParsedFile[];
  opts: ImportOptions;
  importer: (
    p: pg.Pool,
    f: ParsedFile,
    o: ImportOptions,
  ) => Promise<"imported" | "duplicate" | "error">;
  stats: ImportStats;
}

/**
 * Run every parsed file through the selected importer, tallying results and
 * printing progress every ten files and once at the end.
 */
async function runImport(run: ImportRun): Promise<void> {
  const { pool, files, opts, importer, stats } = run;
  let done = 0;
  for (const file of files) {
    recordResult(stats, await importer(pool, file, opts));
    done++;
    if (done % 10 !== 0 && done !== files.length) continue;
    console.log(
      `  [${done}/${files.length}] imported=${stats.imported} dupes=${stats.duplicates} errors=${stats.errors}`,
    );
  }
}

/** Tally one importer outcome into the running totals. */
function recordResult(
  stats: ImportStats,
  result: "imported" | "duplicate" | "error",
): void {
  if (result === "imported") stats.imported++;
  else if (result === "duplicate") stats.duplicates++;
  else stats.errors++;
}

/** Options that consume the next argv entry as their value. */
const VALUE_OPTIONS = new Set(["--table", "--tags", "--source", "--pattern"]);
/** Options that are present-or-absent and consume nothing. */
const BOOLEAN_OPTIONS = new Set(["--embed", "--extract", "--dry-run"]);

/** The raw argv scan: option values, present flags, and the positional dir. */
interface ScannedArgs {
  values: Map<string, string>;
  flags: Set<string>;
  sourceDir: string;
}

/**
 * Walk argv once, sorting each entry into its option value, its flag, or the
 * single positional source directory.
 */
function scanArgs(args: string[]): ScannedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let sourceDir = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (VALUE_OPTIONS.has(arg)) {
      values.set(arg, args[++i] ?? "");
    } else if (BOOLEAN_OPTIONS.has(arg)) {
      flags.add(arg);
    } else if (!arg.startsWith("--") && !sourceDir) {
      sourceDir = arg;
    }
  }

  return { values, flags, sourceDir };
}

export function parseArgs(argv: string[]): ImportOptions {
  const { values, flags, sourceDir } = scanArgs(argv.slice(2));

  const table = values.get("--table") ?? "thoughts";
  const rawTags = values.get("--tags");
  const extraTags = rawTags ? rawTags.split(",").map((t) => t.trim()) : [];
  const sourceLabel = values.get("--source") ?? "bulk-import";
  const pattern = values.get("--pattern") ?? "**/*.md";
  const embed = flags.has("--embed");
  const extract = flags.has("--extract");
  const dryRun = flags.has("--dry-run");

  if (!sourceDir) {
    console.error(
      "Usage: node scripts/bulk-import.ts <source-dir> [--table thoughts|decisions|sessions] [--tags t1,t2] [--embed] [--extract] [--dry-run]",
    );
    process.exit(1);
  }

  const validTables = new Set(["thoughts", "decisions", "sessions"] as const);
  if (!validTables.has(table as ImportTable)) {
    console.error(`Invalid table: ${table}. Must be thoughts, decisions, or sessions.`);
    process.exit(1);
  }

  return {
    sourceDir,
    table: table as ImportTable,
    extraTags,
    sourceLabel,
    embed,
    extract,
    dryRun,
    pattern,
  };
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);
  const files = await readFiles(opts.sourceDir, opts.pattern);

  logger.info("Bulk import starting", {
    sourceDir: opts.sourceDir,
    table: opts.table,
    fileCount: files.length,
    embed: opts.embed,
    extract: opts.extract,
    dryRun: opts.dryRun,
  });

  if (opts.dryRun) {
    for (const f of files) {
      const title =
        (f.frontmatter.title as string) ||
        (f.frontmatter.name as string) ||
        (f.body.split("\n")[0] ?? "").slice(0, 80);
      console.log(`  ${f.filePath} -> ${title}`);
    }
    console.log(`\n${files.length} files would be imported into ${opts.table}`);
    process.exit(0);
  }

  const pool = createPool();
  const stats: ImportStats = {
    imported: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
  };

  try {
    const importers: Record<
      ImportTable,
      (
        p: pg.Pool,
        f: ParsedFile,
        o: typeof opts,
      ) => Promise<"imported" | "duplicate" | "error">
    > = {
      thoughts: importThought,
      decisions: importDecision,
      sessions: importSession,
    };
    const importer = importers[opts.table];

    await runImport({ pool, files, opts, importer, stats });

    const suffix = opts.embed ? "" : " -- run 'npm run backfill' for embeddings";
    logger.info(
      `Import complete${suffix}`,
      stats as unknown as Record<string, unknown>,
    );
  } catch (err) {
    logger.error("Import failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}
