#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { repoFactMetadata } from "../server/domain/repo-facts.ts";

const manifestSchema = z.object({
  version: z.literal(1),
  source: z.object({
    system: z.literal("qmd"),
    collection: z.string().trim().min(1),
    exported_at: z.string().datetime(),
    note: z.string().trim().min(1).optional(),
  }),
  defaults: z
    .object({
      namespace: z.string().trim().min(1).optional(),
    })
    .optional(),
  facts: z.array(repoFactMetadata).min(1),
});

type Manifest = z.infer<typeof manifestSchema>;

type UpsertResult = {
  id?: string;
  is_new?: boolean;
  canonical_id?: string;
  metadata?: { fact_id?: string };
};

type Summary = {
  total: number;
  would_promote: number;
  promoted: number;
  updated: number;
  unchanged: number;
  stale: number;
  skipped: number;
  failed: number;
  verified_after_timeout: number;
  dry_run: boolean;
  failures: Array<{ index: number; repo?: string; path?: string; error: string }>;
};

function usage(): never {
  console.error(
    [
      "Usage: node scripts/promote-qmd-repo-facts.ts --file <manifest.json> [--namespace <namespace>] [--dry-run]",
      "       [--timeout-ms <milliseconds>]",
      "",
      "Reads curated qmd-derived repo facts and upserts them with open-brain.upsert_repo_fact.",
      "This promotes facts and source pointers only; raw qmd/code chunks are rejected by Open Brain.",
    ].join("\n"),
  );
  process.exit(2);
}

type Args = {
  file: string;
  namespace: string;
  dryRun: boolean;
  mcp2cli: string;
  timeoutMs: number;
};

/** Flags that consume the next argv entry as their value. */
const VALUE_FLAGS: Record<string, (args: Args, value: string) => void> = {
  "--file": (args, value) => {
    args.file = value;
  },
  "--namespace": (args, value) => {
    args.namespace = value;
  },
  "--mcp2cli": (args, value) => {
    args.mcp2cli = value;
  },
  "--timeout-ms": (args, value) => {
    args.timeoutMs = Number(value);
  },
};

/** Flags that consume no argv entry. */
const BARE_FLAGS: Record<string, (args: Args) => void> = {
  "--dry-run": (args) => {
    args.dryRun = true;
  },
  "--help": () => usage(),
  "-h": () => usage(),
};

function argsAreUsable(args: Args): boolean {
  return Boolean(
    args.file && args.mcp2cli && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0,
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: "",
    namespace: "",
    dryRun: false,
    mcp2cli: process.env.MCP2CLI_BIN || "mcp2cli",
    timeoutMs: Number(process.env.MCP2CLI_TIMEOUT_MS || 30000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const applyValue = VALUE_FLAGS[arg];
    if (applyValue) {
      applyValue(args, argv[++i] ?? "");
      continue;
    }
    const applyBare = BARE_FLAGS[arg];
    if (applyBare) {
      applyBare(args);
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (!argsAreUsable(args)) usage();
  return args;
}

function loadManifest(path: string): Manifest {
  const raw = readFileSync(path, "utf8");
  return manifestSchema.parse(JSON.parse(raw));
}

function callMcp2Cli(
  mcp2cli: string,
  tool: string,
  timeoutMs: number,
  params: Record<string, unknown>,
): unknown {
  const result = spawnSync(
    mcp2cli,
    ["open-brain", tool, "--params", JSON.stringify(params)],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(output.trim() || `mcp2cli exited ${result.status}`);
  }

  const envelope = JSON.parse(result.stdout || "{}") as {
    success?: boolean;
    result?: string | UpsertResult;
    error?: unknown;
  };
  if (envelope.success === false || envelope.error) {
    throw new Error(JSON.stringify(envelope.error ?? envelope));
  }

  if (typeof envelope.result === "string") {
    return JSON.parse(envelope.result) as unknown;
  }
  return envelope.result ?? {};
}

function callUpsert(
  mcp2cli: string,
  timeoutMs: number,
  namespace: string | undefined,
  metadata: z.infer<typeof repoFactMetadata>,
): UpsertResult {
  return callMcp2Cli(
    mcp2cli,
    "upsert_repo_fact",
    timeoutMs,
    namespace ? { namespace, metadata } : { metadata },
  ) as UpsertResult;
}

function factExists(
  mcp2cli: string,
  timeoutMs: number,
  namespace: string | undefined,
  metadata: z.infer<typeof repoFactMetadata>,
): boolean {
  return existingFactState(mcp2cli, timeoutMs, namespace, metadata) === "exact";
}

function existingFactState(
  mcp2cli: string,
  timeoutMs: number,
  namespace: string | undefined,
  metadata: z.infer<typeof repoFactMetadata>,
): "exact" | "stale" | "missing" {
  const subject = metadata.symbol ?? metadata.subject;
  const rows = callMcp2Cli(mcp2cli, "list_repo_facts", timeoutMs, {
    ...(namespace ? { namespace } : {}),
    repo: metadata.repo,
    collection: metadata.collection,
    path: metadata.path,
    ...(subject ? { subject } : {}),
    limit: 20,
  }) as Array<{ metadata?: Record<string, unknown> }>;

  let sawSameIdentity = false;
  for (const row of rows) {
    const found = row.metadata ?? {};
    if (found.fact_type !== metadata.fact_type) continue;
    sawSameIdentity = true;
    if (isSameFactContent(found, metadata)) return "exact";
  }
  return sawSameIdentity ? "stale" : "missing";
}

function isSameFactContent(
  found: Record<string, unknown>,
  metadata: z.infer<typeof repoFactMetadata>,
): boolean {
  return (
    found.fact === metadata.fact &&
    found.source_commit === metadata.source_commit &&
    found.source_url === metadata.source_url
  );
}

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("ETIMEDOUT") || err.message.includes("timed out");
}

type Fact = z.infer<typeof repoFactMetadata>;

type PromoteOptions = {
  namespace?: string;
  dryRun?: boolean;
  mcp2cli?: string;
  timeoutMs?: number;
};

const DEFAULT_MCP2CLI = "mcp2cli";
const DEFAULT_TIMEOUT_MS = 30000;

function identityKey(namespace: string | undefined, fact: Fact): string {
  return [
    namespace ?? "",
    fact.repo,
    fact.collection,
    fact.path,
    fact.symbol ?? fact.subject ?? "",
    fact.fact_type,
  ].join("\0");
}

function contentFingerprint(fact: Fact): string {
  return JSON.stringify({
    fact: fact.fact,
    source_commit: fact.source_commit,
    source_url: fact.source_url,
    verified_at: fact.verified_at,
    confidence: fact.confidence,
    staleness_policy: fact.staleness_policy,
    refresh_hint: fact.refresh_hint,
  });
}

/**
 * Reads the current state of a fact, treating a read failure as "missing" so
 * the write attempt still happens; the write result decides final failure.
 */
function readStateOrMissing(
  options: PromoteOptions,
  namespace: string | undefined,
  fact: Fact,
): "exact" | "stale" | "missing" {
  try {
    return existingFactState(
      options.mcp2cli ?? DEFAULT_MCP2CLI,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      namespace,
      fact,
    );
  } catch {
    return "missing";
  }
}

/** After a timeout the write may still have landed; a re-read settles it. */
function landedDespiteTimeout(
  err: unknown,
  options: PromoteOptions,
  namespace: string | undefined,
  fact: Fact,
): boolean {
  if (!isTimeout(err)) return false;
  try {
    return factExists(
      options.mcp2cli ?? DEFAULT_MCP2CLI,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      namespace,
      fact,
    );
  } catch {
    return false;
  }
}

type PromoteRun = {
  summary: Summary;
  options: PromoteOptions;
  namespace: string | undefined;
};

function promoteOne(run: PromoteRun, fact: Fact, index: number): void {
  const { summary, options, namespace } = run;
  const state = readStateOrMissing(options, namespace, fact);
  if (state === "exact") {
    summary.unchanged += 1;
    return;
  }
  const wasStale = state === "stale";
  if (wasStale) summary.stale += 1;

  try {
    const upsert = callUpsert(
      options.mcp2cli ?? DEFAULT_MCP2CLI,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      namespace,
      fact,
    );
    if (upsert.is_new === false) {
      if (wasStale) summary.updated += 1;
      else summary.unchanged += 1;
    } else {
      summary.promoted += 1;
    }
  } catch (err) {
    if (landedDespiteTimeout(err, options, namespace, fact)) {
      summary.verified_after_timeout += 1;
      return;
    }
    summary.failed += 1;
    summary.failures.push({
      index,
      repo: fact.repo,
      path: fact.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function promoteManifest(manifest: Manifest, options: PromoteOptions): Summary {
  const namespace = options.namespace ?? manifest.defaults?.namespace;
  const summary: Summary = {
    total: manifest.facts.length,
    would_promote: 0,
    promoted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    skipped: 0,
    failed: 0,
    verified_after_timeout: 0,
    dry_run: Boolean(options.dryRun),
    failures: [],
  };

  const seen = new Map<string, string>();
  for (const [index, fact] of manifest.facts.entries()) {
    const key = identityKey(namespace, fact);
    const fingerprint = contentFingerprint(fact);
    const seenFingerprint = seen.get(key);
    if (seenFingerprint !== undefined) {
      if (seenFingerprint === fingerprint) {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.failures.push({
          index,
          repo: fact.repo,
          path: fact.path,
          error: "Conflicting duplicate repo fact identity in manifest",
        });
      }
      continue;
    }
    seen.set(key, fingerprint);

    if (options.dryRun) {
      summary.would_promote += 1;
      continue;
    }

    promoteOne({ summary, options, namespace }, fact, index);
  }

  return summary;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.file);
  const summary = promoteManifest(manifest, {
    namespace: args.namespace,
    dryRun: args.dryRun,
    mcp2cli: args.mcp2cli,
    timeoutMs: args.timeoutMs,
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed > 0 ? 1 : 0);
}
