#!/usr/bin/env node
/**
 * Restates pair sheet (issue 1519): writes one section per neighbour pair of a
 * frozen cohort for the operator to label `yes`/`no`, and scores the labelled
 * pairs with the pairwise restates pass on the free fake backend.
 *
 * Rows come from a `dream_run_NNN` schema (read-only sessions; the live
 * dogfood database is refused) or from a JSON file of `FrozenRow`s. The
 * default backend is the fake, which counts shared words and judges nothing,
 * so it proves the plumbing, not the cutoff. `--backend jev` is the paid
 * arm: refused without `--yes`, and its config comes from `backendFor` in
 * dream-route-run.ts. `--sweep` adds one agreement line per cutoff.
 *
 *   node scripts/dream-route-restates-pairs.ts sheet (--schema <s> | --rows <f>) --out <path>
 *   node scripts/dream-route-restates-pairs.ts score --sheet <path> (--schema <s> | --rows <f>)
 *     [--backend fake|jev] [--yes] [--sweep]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as liveGuard from "./dream-route-live-guard.ts";
import { readCohortRows } from "./dream-route-run-store.ts";
import { backendFor, type RouteBackend } from "./dream-route-run.ts";
import { RESTATES_AT_V2 } from "../server/domain/dream-route/decide-v2.ts";
import { runRestatesPass } from "../server/domain/dream-route/restates-pass.ts";
import { candidateOf, neighbourPairs } from "../server/domain/dream-route/run-core.ts";
import type { JevFetch } from "../server/integrations/jev.ts";
import type { FrozenRow, RouteCandidate } from "../server/domain/dream-route/types.ts";

/** Where the cohort rows come from. */
export type RowSource =
  { kind: "schema"; schema: string } | { kind: "rows"; file: string };

/** One candidate pair the operator labels. */
export interface CandidatePair {
  item: RouteCandidate;
  member: RouteCandidate;
}

/** One pair as read back from a sheet; `label` null means undecided. */
export interface SheetEntry {
  itemId: string;
  memberId: string;
  label: boolean | null;
}

/** Agreement between operator labels and restates scores at a cutoff. */
export interface Agreement {
  labelled: number;
  agree: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  unscored: number;
}

interface ParsedArgs {
  command: "sheet" | "score";
  source: RowSource;
  out: string | null;
  sheet: string | null;
  backend: RouteBackend;
  yes: boolean;
  sweep: boolean;
}

/** Cutoffs the sweep reports: 0.50, 0.55, ... 0.95. */
const SWEEP_CUTOFFS = Array.from({ length: 10 }, (_, index) => (50 + index * 5) / 100);

class UsageError extends Error {}

/**
 * Loads the cohort rows from a JSON file or, read-only, from a dream_run schema.
 *
 * @param source - The row source.
 * @returns The frozen rows.
 * @throws {Error} When the target database is the live dogfood database.
 */
export async function loadRows(source: RowSource): Promise<FrozenRow[]> {
  if (source.kind === "rows") {
    return JSON.parse(readFileSync(source.file, "utf8")) as FrozenRow[];
  }
  liveGuard.assertNotLiveDatabase({
    databaseName: liveGuard.resolvedDatabaseName(process.env),
    allowLive: false,
  });
  const { createPool } = await import("./settings.ts");
  // readCohortRows takes a Pool, so the read-only guarantee is the server-side
  // session default: every session on this pool is read-only and cannot write.
  const pool = createPool({ options: "-c default_transaction_read_only=on" });
  try {
    return await readCohortRows(pool, source.schema);
  } finally {
    await pool.end();
  }
}

function quote(text: string | null): string[] {
  if (text === null || text.trim() === "") return ["> not recorded"];
  return text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
}

function quoteContent(text: string): string[] {
  return text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
}

function renderPair(pair: CandidatePair, index: number): string {
  return [
    `## Pair ${index + 1}`,
    "",
    `- item: ${pair.item.id}`,
    `- member: ${pair.member.id}`,
    "",
    "Item, operator said:",
    ...quote(pair.item.operatorText),
    "",
    "Item content:",
    ...quoteContent(pair.item.content),
    "",
    "Member, operator said:",
    ...quote(pair.member.operatorText),
    "",
    "Member content:",
    ...quoteContent(pair.member.content),
    "",
    "label: ?",
  ].join("\n");
}

/**
 * Renders the pair sheet. Byte-stable: no date or time in the output.
 *
 * @param input - The source label and the pairs, in `neighbourPairs` order.
 * @returns The sheet text, ending in exactly one newline.
 */
export function renderSheet(input: { source: string; pairs: CandidatePair[] }): string {
  const head = [
    "# Restates pair sheet (issue 1519)",
    "",
    `Source: ${input.source}. Pairs: ${input.pairs.length}.`,
    "",
    "Label each pair by replacing `?` on its `label:` line with `yes` (the item says",
    "the same lasting thing as the member, so keeping both stores one memory twice)",
    "or `no`. Leave `?` for undecided. Only the `label:` lines are read back.",
  ].join("\n");
  return [head, ...input.pairs.map(renderPair)].join("\n\n") + "\n";
}

function lineValue(lines: string[], prefix: string): string | undefined {
  const hit = lines.find((line) => line.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length).trim();
}

function parseLabel(value: string, pair: string): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  if (value === "?") return null;
  throw new Error(`pair ${pair}: label must be yes, no or ?, got "${value}"`);
}

/**
 * Reads the pairs and labels back from a sheet.
 *
 * @param text - The sheet text.
 * @returns One entry per `## Pair` section, in sheet order.
 * @throws {Error} Naming the pair number on a bad label or a missing line.
 */
export function parseSheet(text: string): SheetEntry[] {
  const sections = text.split(/^## Pair /m).slice(1);
  return sections.map((section) => {
    const lines = section.split("\n");
    const pair = (lines[0] ?? "").trim();
    const itemId = lineValue(lines, "- item: ");
    const memberId = lineValue(lines, "- member: ");
    const label = lineValue(lines, "label: ");
    if (itemId === undefined || memberId === undefined || label === undefined) {
      throw new Error(`pair ${pair}: missing its item, member or label line`);
    }
    return { itemId, memberId, label: parseLabel(label, pair) };
  });
}

/**
 * Compares operator labels with restates scores; predicted = score >= cutoff.
 * A labelled item with no score counts as unscored and as predicted false.
 *
 * @param input - The labelled pairs, the item id to score map, and the cutoff.
 * @returns The confusion counts and the agreement total.
 */
export function agreement(input: {
  labelled: { itemId: string; label: boolean }[];
  scores: Map<string, number>;
  cutoff: number;
}): Agreement {
  const result: Agreement = {
    labelled: 0,
    agree: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    unscored: 0,
  };
  for (const { itemId, label } of input.labelled) {
    const score = input.scores.get(itemId);
    if (score === undefined) result.unscored += 1;
    const predicted = score !== undefined && score >= input.cutoff;
    result.labelled += 1;
    if (predicted === label) result.agree += 1;
    if (predicted && label) result.tp += 1;
    else if (predicted) result.fp += 1;
    else if (label) result.fn += 1;
    else result.tn += 1;
  }
  return result;
}

/**
 * Scores the labelled pairs of a sheet with the restates pass.
 *
 * @param input - The sheet text, the cohort rows, and the options: `backend`
 *   (default fake), `sweep`, `env` for the jev config, `fetchFn` (tests
 *   only: replaces the backend's fetch), and `log` for the paid notice.
 * @returns The report lines.
 * @throws {Error} When a sheet id is not in the rows, or jev has no key.
 */
export async function scoreSheet(input: {
  text: string;
  rows: FrozenRow[];
  backend?: RouteBackend;
  sweep?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchFn?: JevFetch;
  log?: (line: string) => void;
}): Promise<string[]> {
  const backend = input.backend ?? "fake";
  const entries = parseSheet(input.text);
  const byId = new Map(input.rows.map((row) => [row.candidateId, row]));
  const candidate = (id: string): RouteCandidate => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`sheet id ${id} is not in the cohort rows`);
    return candidateOf(row);
  };
  const labelled = entries.flatMap((entry) =>
    entry.label === null ? [] : [{ ...entry, label: entry.label }],
  );
  const pairs = labelled.map((entry) => ({
    item: candidate(entry.itemId),
    member: candidate(entry.memberId),
  }));
  const resolved = backendFor(
    {
      schema: "",
      backend,
      yes: backend === "jev",
      capUsd: 0,
      inFlight: 1,
      rerun: false,
      note: "",
      allowLiveDb: false,
    },
    input.env ?? process.env,
  );
  if (backend === "jev") {
    (input.log ?? console.log)(`paid: ${pairs.length} pairs, backend jev`);
  }
  const scores = await runRestatesPass({
    pairs,
    config: resolved.config,
    fetchFn: input.fetchFn ?? resolved.fetchFn,
  });
  const got = agreement({ labelled, scores, cutoff: RESTATES_AT_V2 });
  const lines = [
    backend === "jev"
      ? "backend jev"
      : "backend fake (counts shared words; judges nothing)",
    `cutoff ${RESTATES_AT_V2}`,
    `labelled ${got.labelled} undecided ${entries.length - labelled.length}`,
    `agree ${got.agree}/${got.labelled}`,
    `tp ${got.tp} fp ${got.fp} fn ${got.fn} tn ${got.tn} unscored ${got.unscored}`,
  ];
  if (input.sweep !== true) return lines;
  for (const cutoff of SWEEP_CUTOFFS) {
    const at = agreement({ labelled, scores, cutoff });
    lines.push(
      `sweep ${cutoff.toFixed(2)} agree ${at.agree}/${at.labelled} tp ${at.tp} fp ${at.fp} fn ${at.fn} tn ${at.tn}`,
    );
  }
  return lines;
}

const FLAGS = new Set(["--schema", "--rows", "--out", "--sheet", "--backend"]);
const SWITCHES = new Set(["--yes", "--sweep"]);

function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index] ?? "";
    if (SWITCHES.has(flag)) {
      flags.set(flag, "");
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown flag ${flag}`);
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    flags.set(flag, value);
    index += 2;
  }
  return flags;
}

function sourceOf(flags: Map<string, string>): RowSource {
  const schema = flags.get("--schema");
  const file = flags.get("--rows");
  if ((schema === undefined) === (file === undefined)) {
    throw new UsageError("give exactly one of --schema or --rows");
  }
  return schema === undefined
    ? { kind: "rows", file: file ?? "" }
    : { kind: "schema", schema };
}

/**
 * Reads `--backend`, refusing the paid one without `--yes`.
 *
 * @param flags - The parsed flags.
 * @returns The backend.
 * @throws {UsageError} On an unknown backend, or jev without --yes.
 */
function backendOf(flags: Map<string, string>): RouteBackend {
  const raw = flags.get("--backend") ?? "fake";
  if (raw !== "fake" && raw !== "jev") {
    throw new UsageError(`--backend must be fake or jev, got ${raw}`);
  }
  if (raw === "jev" && !flags.has("--yes")) {
    throw new UsageError("refusing --backend jev without --yes (paid call)");
  }
  return raw;
}

/**
 * Parses the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The command, row source, and paths.
 * @throws {UsageError} On an unknown flag or a missing required one.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "sheet" && command !== "score") {
    throw new UsageError("usage: dream-route-restates-pairs.ts sheet|score ...");
  }
  const flags = readFlags(rest);
  const source = sourceOf(flags);
  const out = flags.get("--out") ?? null;
  const sheet = flags.get("--sheet") ?? null;
  if (command === "sheet" && out === null) throw new UsageError("sheet needs --out");
  if (command === "score" && sheet === null)
    throw new UsageError("score needs --sheet");
  const backend = backendOf(flags);
  return {
    command,
    source,
    out,
    sheet,
    backend,
    yes: flags.has("--yes"),
    sweep: flags.has("--sweep"),
  };
}

function sourceLabel(source: RowSource): string {
  return source.kind === "schema"
    ? `schema ${source.schema}`
    : `rows ${basename(source.file)}`;
}

async function run(args: ParsedArgs): Promise<void> {
  if (args.command === "score") {
    const text = readFileSync(args.sheet ?? "", "utf8");
    const rows = await loadRows(args.source);
    for (const line of await scoreSheet({
      text,
      rows,
      backend: args.backend,
      sweep: args.sweep,
    }))
      console.log(line);
    return;
  }
  const rows = await loadRows(args.source);
  const pairs = neighbourPairs(rows).map(({ item, member }) => ({
    item: candidateOf(item),
    member: candidateOf(member),
  }));
  const out = args.out ?? "";
  writeFileSync(out, renderSheet({ source: sourceLabel(args.source), pairs }));
  console.log(`pairs ${pairs.length} -> ${out}`);
}

/**
 * Entry point: a usage error exits 2, any other failure exits 1.
 *
 * @param argv - Arguments after the script name.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  try {
    await run(args);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await main();
