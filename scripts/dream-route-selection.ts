/**
 * DREAM route cohort selection: the parts with no database in them.
 *
 * Argument parsing, the per-stratum draw arithmetic, the source-precedence
 * merge, and the cohort digest. They live apart from scripts/dream-route-cohort.ts
 * so each can be tested without Postgres, and so the freezer module stays the
 * SQL and transaction story alone.
 */
import { createHash } from "node:crypto";
import type { CohortSource, FrozenRow } from "../server/domain/dream-route/types.ts";
export type {
  CandidateSnapshot,
  CohortSource,
  FrozenRow,
} from "../server/domain/dream-route/types.ts";

export const DREAM_ROUTE_SELECTION_VERSION = "dream-route-cohort-v1";

/** Precedence when a row qualifies more than one way: labelled > draw > neighbour. */
const SOURCE_PRECEDENCE: Readonly<Record<CohortSource, number>> = {
  labelled: 3,
  draw: 2,
  neighbour: 1,
};

/**
 * Which drawn rows get a neighbour search.
 *
 * `decided` runs the search for operator-sourced rows -- the same rule
 * `server/domain/dream-route/authority.ts` calls the `decided` tier -- so the
 * cohort grows around what the operator actually said. `all` runs it for every
 * drawn row.
 */
export type NeighboursFor = "decided" | "all";

export const NEIGHBOURS_FOR_VALUES: readonly NeighboursFor[] = ["decided", "all"];

export interface DreamRouteCohortOptions {
  namespace: string;
  fraction: number;
  seed: string;
  neighbours: number;
  neighboursFor: NeighboursFor;
  maxDistance: number;
  labels?: string;
  note: string;
  /** `--allow-live-db`: write into a live database anyway (issue 1501). */
  allowLiveDb: boolean;
}

/** One stratum of the draw: a `(candidate_type, anchor_kind)` pair and its size. */
export interface StratumShare {
  candidateType: string;
  anchorKind: string;
  count: number;
  share: number;
}

/** A row on its way into the cohort, before precedence is resolved. */
export interface CohortMember {
  candidateId: string;
  source: CohortSource;
  neighbourOf: string | null;
}

export interface CohortCounts {
  draw: number;
  neighbour: number;
  labelled: number;
  /** Drawn rows that got a neighbour search, under the active `--neighbours-for`. */
  neighbour_anchors: number;
  strata: Record<string, number>;
}

export interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  operator_text: string | null;
  unit_kind: string;
  anchor_kind: string | null;
  first_said_at: Date | null;
  last_said_at: Date | null;
  source_turn_ids: string[];
}

const LABELS_SCHEMA_PATTERN = /^dream_run_[0-9]{3}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Reads a `--name value` pair, refusing a repeat or a missing value.
 *
 * Same shape as `rem-ethereal-run.ts`'s reader, kept local because that one is
 * not exported and this script's option set is disjoint from its own.
 *
 * @param argv - The raw argument vector, without the node/script prefix.
 * @param name - The option name, without leading dashes.
 * @returns The value, or undefined when the option is absent.
 * @throws {Error} When the option repeats or carries no value.
 */
function valueArg(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) =>
    value === `--${name}` ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`--${name} may be supplied only once`);
  if (indexes.length === 0) return undefined;
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function parseFraction(raw: string | undefined): number {
  if (raw === undefined) return 0.05;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error("--fraction must be a number in (0, 1]");
  }
  return parsed;
}

function parseNeighbours(raw: string | undefined): number {
  if (raw === undefined) return 3;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("--neighbours must be a non-negative integer");
  }
  return parsed;
}

function parseNeighboursFor(raw: string | undefined): NeighboursFor {
  if (raw === undefined) return "decided";
  const match = NEIGHBOURS_FOR_VALUES.find((value) => value === raw);
  if (match === undefined) {
    throw new Error(
      `--neighbours-for must be one of ${NEIGHBOURS_FOR_VALUES.join(", ")}: ${raw}`,
    );
  }
  return match;
}

function parseMaxDistance(raw: string | undefined): number {
  if (raw === undefined) return 0.15;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error("--max-distance must be a cosine distance in [0, 2]");
  }
  return parsed;
}

function parseLabels(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!LABELS_SCHEMA_PATTERN.test(raw)) {
    throw new Error(`--labels must name a dream_run_NNN schema: ${raw}`);
  }
  return raw;
}

function parseNamespace(raw: string | undefined): string {
  if (raw === undefined) throw new Error("--namespace is required");
  if (raw.length === 0 || raw.trim() !== raw) {
    throw new Error("--namespace must be non-empty and have no surrounding whitespace");
  }
  return raw;
}

function parseSeed(raw: string | undefined): string {
  if (raw === undefined) return "dream-route-v1";
  if (raw.length === 0) throw new Error("--seed must be non-empty");
  return raw;
}

/**
 * Parses the CLI argument vector, rejecting any unknown `--` token.
 *
 * @param argv - The raw argument vector, without the node/script prefix.
 * @returns The fully defaulted options.
 * @throws {Error} On an unknown option or any invalid value.
 */
export function parseDreamRouteArgs(argv: readonly string[]): DreamRouteCohortOptions {
  const known = new Set([
    "--namespace",
    "--fraction",
    "--seed",
    "--neighbours",
    "--neighbours-for",
    "--max-distance",
    "--labels",
    "--note",
    "--allow-live-db",
  ]);
  for (const token of argv) {
    if (token.startsWith("--") && !known.has(token)) {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return {
    namespace: parseNamespace(valueArg(argv, "namespace")),
    fraction: parseFraction(valueArg(argv, "fraction")),
    seed: parseSeed(valueArg(argv, "seed")),
    neighbours: parseNeighbours(valueArg(argv, "neighbours")),
    neighboursFor: parseNeighboursFor(valueArg(argv, "neighbours-for")),
    maxDistance: parseMaxDistance(valueArg(argv, "max-distance")),
    labels: parseLabels(valueArg(argv, "labels")),
    note: valueArg(argv, "note") ?? "",
    allowLiveDb: argv.includes("--allow-live-db"),
  };
}

/**
 * How many rows a stratum contributes to the draw.
 *
 * `ceil(fraction * count)`, so a non-empty stratum always contributes at least
 * one row and the smallest strata are not silently dropped by rounding. An
 * empty stratum contributes nothing.
 *
 * @param count - Rows in the stratum.
 * @param fraction - The requested sampling fraction, in (0, 1].
 * @returns The stratum share, never greater than `count`.
 */
export function stratumShare(count: number, fraction: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("stratum count must be a non-negative integer");
  }
  if (count === 0) return 0;
  return Math.min(count, Math.ceil(fraction * count));
}

/**
 * Resolves duplicate members to one row each by source precedence.
 *
 * `labelled` beats `draw` beats `neighbour`. `neighbour_of` survives only on a
 * row that stays a neighbour, because a drawn or labelled row was not pulled in
 * by anything. The result is ordered by precedence (strongest first) then
 * candidate id, which is what makes the ordinals deterministic.
 *
 * @param members - Candidate members, in any order, possibly with duplicates.
 * @returns One entry per candidate id, in deterministic ordinal order.
 */
export function mergeByPrecedence(members: readonly CohortMember[]): CohortMember[] {
  const best = new Map<string, CohortMember>();
  for (const member of members) {
    const existing = best.get(member.candidateId);
    if (
      existing === undefined ||
      SOURCE_PRECEDENCE[member.source] > SOURCE_PRECEDENCE[existing.source]
    ) {
      best.set(member.candidateId, {
        candidateId: member.candidateId,
        source: member.source,
        neighbourOf: member.source === "neighbour" ? member.neighbourOf : null,
      });
    }
  }
  return [...best.values()].sort((left, right) => {
    const bySource = SOURCE_PRECEDENCE[right.source] - SOURCE_PRECEDENCE[left.source];
    return bySource || left.candidateId.localeCompare(right.candidateId);
  });
}

/**
 * Tallies a merged cohort into the manifest's `counts` shape.
 *
 * @param rows - The frozen rows, after precedence merge.
 * @param strata - The per-stratum shares actually drawn.
 * @param neighbourAnchors - Drawn rows that got a neighbour search.
 * @returns Source totals plus a per-stratum breakdown.
 */
export function cohortCounts(
  rows: readonly FrozenRow[],
  strata: readonly StratumShare[],
  neighbourAnchors: number,
): CohortCounts {
  const counts: CohortCounts = {
    draw: 0,
    neighbour: 0,
    labelled: 0,
    neighbour_anchors: neighbourAnchors,
    strata: {},
  };
  for (const row of rows) counts[row.source] += 1;
  for (const stratum of strata) {
    counts.strata[`${stratum.candidateType}/${stratum.anchorKind}`] = stratum.share;
  }
  return counts;
}

/**
 * The cohort digest: ordinal, id, namespace, and content hash per row.
 *
 * Deliberately the same construction as `rem-ethereal-cohort.ts`'s digest, so a
 * DREAM cohort and a REM cohort of the same rows in the same order hash alike.
 * The embedding is not in it, because the embedding is not frozen.
 *
 * @param rows - The frozen rows, in ordinal order.
 * @returns A 64-character lowercase sha256 hex digest.
 */
export function cohortDigest(rows: readonly FrozenRow[]): string {
  return sha256(
    rows
      .map((row) =>
        JSON.stringify([row.ordinal, row.candidateId, row.namespace, row.contentHash]),
      )
      .join("\n"),
  );
}
