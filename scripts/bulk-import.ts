#!/usr/bin/env bun
/**
 * Bulk import markdown files into Open Brain.
 *
 * Usage:
 *   bun run scripts/bulk-import.ts <source-dir> [options]
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
import { Glob } from "bun";
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { createPool } from "../src/db/pool.ts";
import {
  contentHash,
  generateEmbedding,
  EMBEDDING_MODEL,
} from "../src/embedding.ts";
import {
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
} from "../src/embedding-canonical.ts";
import { extractMetadata, mergeTags } from "../src/extraction.ts";
import { logger } from "../src/logger.ts";
import { sharedNamespaceConfig } from "../src/shared-namespace.ts";

const DELAY_MS = 200;
const DEFAULT_IMPORT_NAMESPACE = sharedNamespaceConfig().sharedNamespace;

export type ImportTable = "thoughts" | "decisions" | "sessions";

export interface ParsedFile {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ImportStats {
  imported: number;
  skipped: number;
  duplicates: number;
  errors: number;
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const fm: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val: unknown = line.slice(colon + 1).trim();
    // Handle simple YAML arrays like [a, b] or quoted strings
    if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else if (
      typeof val === "string" &&
      (val.startsWith('"') || val.startsWith("'"))
    ) {
      val = val.replace(/^["']|["']$/g, "");
    }
    fm[key] = val;
  }

  return { frontmatter: fm, body: match[2]!.trim() };
}

export async function readFiles(
  sourceDir: string,
  pattern: string,
): Promise<ParsedFile[]> {
  const glob = new Glob(pattern);
  const files: ParsedFile[] = [];

  for await (const path of glob.scan({ cwd: sourceDir, absolute: true })) {
    const raw = await Bun.file(path).text();
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!body || body.length < 10) continue;
    files.push({ filePath: path, frontmatter, body });
  }

  return files;
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
  const hash = contentHash(content);

  const fmTags = Array.isArray(file.frontmatter.tags)
    ? (file.frontmatter.tags as string[])
    : [];
  let tags = [...fmTags, ...opts.extraTags];

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
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
        extracted ? JSON.stringify(extracted) : null,
      ],
    );
    return rowCount && rowCount > 0 ? "imported" : "duplicate";
  } catch (err) {
    logger.warn("Import error", {
      file: file.filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return "error";
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

  const fmTags = Array.isArray(file.frontmatter.tags)
    ? (file.frontmatter.tags as string[])
    : [];
  let tags = [...fmTags, ...opts.extraTags];

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
  const hash = contentHash(textToEmbed);

  if (opts.embed) {
    embedding = await generateEmbedding(textToEmbed);
  }
  if (opts.embed || opts.extract) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

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
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
        extracted ? JSON.stringify(extracted) : null,
      ],
    );
    return rowCount && rowCount > 0 ? "imported" : "duplicate";
  } catch (err) {
    logger.warn("Import error", {
      file: file.filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return "error";
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
  const hash = contentHash(sessionSourceHashInput({ summary, project }));

  const fmTags = Array.isArray(file.frontmatter.tags)
    ? (file.frontmatter.tags as string[])
    : [];
  const tags = [...fmTags, ...opts.extraTags];

  let embedding: number[] | null = null;
  if (opts.embed) {
    embedding = await generateEmbedding(sessionEmbedText({ summary, project }));
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

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
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
      ],
    );
    return rowCount && rowCount > 0 ? "imported" : "duplicate";
  } catch (err) {
    logger.warn("Import error", {
      file: file.filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return "error";
  }
}

export function parseArgs(argv: string[]): {
  sourceDir: string;
  table: ImportTable;
  extraTags: string[];
  sourceLabel: string;
  embed: boolean;
  extract: boolean;
  dryRun: boolean;
  pattern: string;
} {
  const args = argv.slice(2);
  let sourceDir = "";
  let table = "thoughts";
  let extraTags: string[] = [];
  let sourceLabel = "bulk-import";
  let embed = false;
  let extract = false;
  let dryRun = false;
  let pattern = "**/*.md";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--table":
        table = args[++i]!;
        break;
      case "--tags":
        extraTags = args[++i]!.split(",").map((t) => t.trim());
        break;
      case "--source":
        sourceLabel = args[++i]!;
        break;
      case "--pattern":
        pattern = args[++i]!;
        break;
      case "--embed":
        embed = true;
        break;
      case "--extract":
        extract = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        if (!arg.startsWith("--") && !sourceDir) sourceDir = arg;
    }
  }

  if (!sourceDir) {
    console.error(
      "Usage: bun run scripts/bulk-import.ts <source-dir> [--table thoughts|decisions|sessions] [--tags t1,t2] [--embed] [--extract] [--dry-run]",
    );
    process.exit(1);
  }

  const validTables = new Set(["thoughts", "decisions", "sessions"] as const);
  if (!validTables.has(table as ImportTable)) {
    console.error(
      `Invalid table: ${table}. Must be thoughts, decisions, or sessions.`,
    );
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

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const result = await importer(pool, file, opts);

      switch (result) {
        case "imported":
          stats.imported++;
          break;
        case "duplicate":
          stats.duplicates++;
          break;
        case "error":
          stats.errors++;
          break;
      }

      if ((i + 1) % 10 === 0 || i === files.length - 1) {
        console.log(
          `  [${i + 1}/${files.length}] imported=${stats.imported} dupes=${stats.duplicates} errors=${stats.errors}`,
        );
      }
    }

    const suffix = opts.embed
      ? ""
      : " -- run 'bun run backfill' for embeddings";
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
