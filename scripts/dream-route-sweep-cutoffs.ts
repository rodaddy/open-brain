/**
 * Sets the DREAM route V2 cutoffs OFFLINE from a recorded readings file, per
 * `_plans/1469-jev-matrix.md` section 4 steps 5 and 6: no further paid calls.
 * Sweeps lastingAt, confidenceAt and pickAt over 0.05..0.95 and reports the two
 * error classes separately, because they cost differently: false_commit writes
 * a false memory, lost_commit loses a real one. It never edits decide-v2.ts;
 * `measuredIn` is written by hand from this report.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { JevAnswer } from "../server/integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS_V2,
  NONE_OPTION,
  decideRouteV2,
  type RouteThresholdsV2,
} from "../server/domain/dream-route/decide-v2.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import type {
  RouteCandidate,
  RouteMatrix,
} from "../server/domain/dream-route/types.ts";

/** The fields of a proof-v1 `CaseReading` the sweep reads. */
export interface SweepReading {
  candidate_id: string;
  golden_dest: string;
  singleton_answers: Record<string, JevAnswer>;
}

export interface ComboScore {
  thresholds: RouteThresholdsV2;
  golden: number;
  false_commit: number;
  lost_commit: number;
}

export interface SweepResult {
  cases: number;
  best: ComboScore;
  top: ComboScore[];
  confusion: Record<string, Record<string, number>>;
}

const GRID = Array.from({ length: 19 }, (_, i) => Number(((i + 1) * 0.05).toFixed(2)));
const TOP_N = 10;

/**
 * The decider reads the candidate only for the authority tier, which the sweep
 * does not score.
 */
export function stubCandidate(id: string): RouteCandidate {
  return {
    id,
    namespace: "sweep",
    candidateType: "fact",
    content: "",
    operatorText: null,
    unitKind: "fragment",
    anchorKind: null,
  };
}

/** `null`, `none`, and any commits-false row all read as `none`. */
function normalise(dest: string | null, matrix: RouteMatrix): string {
  if (dest === null || dest === NONE_OPTION) return NONE_OPTION;
  const row = matrix.rows.find((r) => r.name === dest);
  return row && !row.commits ? NONE_OPTION : dest;
}

function commits(name: string, matrix: RouteMatrix): boolean {
  return matrix.rows.some((r) => r.name === name && r.commits);
}

function decideAll(
  readings: readonly SweepReading[],
  matrix: RouteMatrix,
  thresholds: RouteThresholdsV2,
): Array<[string, string]> {
  return readings.map((reading) => [
    normalise(reading.golden_dest, matrix),
    normalise(
      decideRouteV2(
        stubCandidate(reading.candidate_id),
        reading.singleton_answers,
        matrix,
        thresholds,
      ).destination,
      matrix,
    ),
  ]);
}

function score(
  pairs: Array<[string, string]>,
  matrix: RouteMatrix,
  thresholds: RouteThresholdsV2,
): ComboScore {
  const result: ComboScore = { thresholds, golden: 0, false_commit: 0, lost_commit: 0 };
  for (const [golden, decided] of pairs) {
    if (golden === decided) result.golden += 1;
    if (golden === NONE_OPTION && commits(decided, matrix)) result.false_commit += 1;
    if (commits(golden, matrix) && !commits(decided, matrix)) result.lost_commit += 1;
  }
  return result;
}

function rank(a: ComboScore, b: ComboScore): number {
  return (
    a.false_commit - b.false_commit ||
    b.golden - a.golden ||
    a.lost_commit - b.lost_commit ||
    a.thresholds.lastingAt - b.thresholds.lastingAt ||
    a.thresholds.confidenceAt - b.thresholds.confidenceAt ||
    a.thresholds.pickAt - b.thresholds.pickAt
  );
}

function allThresholds(): RouteThresholdsV2[] {
  return GRID.flatMap((lastingAt) =>
    GRID.flatMap((confidenceAt) =>
      GRID.map((pickAt) => ({
        lastingAt,
        confidenceAt,
        pickAt,
        droveDecisionAt: DEFAULT_THRESHOLDS_V2.droveDecisionAt,
        measuredIn: "",
      })),
    ),
  );
}

export function sweepCutoffs(
  readings: readonly SweepReading[],
  matrix: RouteMatrix,
): SweepResult {
  const scores = allThresholds()
    .map((t) => score(decideAll(readings, matrix, t), matrix, t))
    .sort(rank);
  const best = scores[0] as ComboScore;
  const confusion: Record<string, Record<string, number>> = {};
  for (const [golden, decided] of decideAll(readings, matrix, best.thresholds)) {
    const row = (confusion[golden] ??= {});
    row[decided] = (row[decided] ?? 0) + 1;
  }
  return { cases: readings.length, best, top: scores.slice(0, TOP_N), confusion };
}

function cutoffs(t: RouteThresholdsV2): string {
  return `lastingAt=${t.lastingAt} confidenceAt=${t.confidenceAt} pickAt=${t.pickAt}`;
}

function report(result: SweepResult): string[] {
  const lines = [`cases=${result.cases}`];
  for (const s of result.top) {
    lines.push(
      `${cutoffs(s.thresholds)} golden=${s.golden} false_commit=${s.false_commit} lost_commit=${s.lost_commit}`,
    );
  }
  for (const [golden, row] of Object.entries(result.confusion)) {
    for (const [decided, n] of Object.entries(row)) {
      lines.push(`golden=${golden} -> decided=${decided}: ${n}`);
    }
  }
  const b = result.best;
  lines.push(
    `BEST ${cutoffs(b.thresholds)} golden=${b.golden}/${result.cases} false_commit=${b.false_commit} lost_commit=${b.lost_commit}`,
  );
  return lines;
}

function refuse(message: string): never {
  process.stderr.write(`dream-route-sweep-cutoffs: ${message}\n`);
  process.exit(2);
}

function parseCli(): { readings: string; matrix: string; json: boolean } {
  let values: { readings?: string; matrix?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        readings: { type: "string" },
        matrix: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    refuse((error as Error).message);
  }
  if (!values.readings || !isAbsolute(values.readings)) {
    refuse("--readings <absolute path to .readings.json> is required");
  }
  return {
    readings: values.readings,
    matrix: values.matrix ?? DEFAULT_MATRIX_PATH,
    json: values.json === true,
  };
}

function main(): void {
  const options = parseCli();
  const readings = JSON.parse(readFileSync(options.readings, "utf8")) as SweepReading[];
  const result = sweepCutoffs(readings, loadMatrix(options.matrix));
  process.stdout.write(`${report(result).join("\n")}\n`);
  if (options.json) {
    const out = `${options.readings.replace(/\.readings\.json$/, "")}.sweep.json`;
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`SWEEP -> ${out}\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
