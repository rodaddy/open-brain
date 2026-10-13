/**
 * DREAM route proof question-set selection and reading tally, hoisted verbatim
 * from dream-route-proof-v1.ts: the `--set v1|v2` stable/expected answer ids,
 * the singleton-versus-batch comparison, and the counts (including
 * false_commit / lost_commit) scored over the readings file, per
 * `_plans/1469-jev-matrix.md` section 4.
 */

import type { JevAnswer } from "../server/integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS,
  decideRoute,
} from "../server/domain/dream-route/decide.ts";
import {
  DEFAULT_THRESHOLDS_V2,
  DEST_V2_ID,
  LASTING_ID,
  decideRouteV2,
} from "../server/domain/dream-route/decide-v2.ts";
import type { loadMatrix } from "../server/domain/dream-route/matrix.ts";
import {
  DEST_ID,
  DROVE_DECISION_ID,
  RESTATES_ID,
  ynId,
} from "../server/domain/dream-route/questions.ts";
import {
  DESTINATIONS,
  type RouteCandidate,
} from "../server/domain/dream-route/types.ts";
import type { readMatrixCases, CaseDestination } from "./dream-route-case-store.ts";
import type { FrozenRow } from "./dream-route-selection.ts";

const STABLE_ANSWER_IDS = [
  DEST_ID,
  ...DESTINATIONS.map(ynId),
  DROVE_DECISION_ID,
] as const;
const STABLE_ANSWER_IDS_V2 = [LASTING_ID, DEST_V2_ID, DROVE_DECISION_ID] as const;

export type QuestionSet = "v1" | "v2";

export function stableIdsFor(set: QuestionSet): readonly string[] {
  return set === "v2" ? STABLE_ANSWER_IDS_V2 : STABLE_ANSWER_IDS;
}

/** Every id a complete reading carries; V2 has no RESTATES question. */
export function expectedIdsFor(set: QuestionSet): readonly string[] {
  return set === "v2" ? STABLE_ANSWER_IDS_V2 : [...STABLE_ANSWER_IDS, RESTATES_ID];
}

export interface RoutedReading {
  readonly answers: Record<string, JevAnswer>;
  readonly candidate: RouteCandidate;
}

export function sameAnswer(
  left: JevAnswer | undefined,
  right: JevAnswer | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasEveryAnswer(
  answers: Record<string, JevAnswer>,
  set: QuestionSet,
): boolean {
  return expectedIdsFor(set).every((id) => answers[id] !== undefined);
}

/** R5 scores steering and an absent destination as the same no-commit class. */
export function normalizeNoCommit(
  destination: CaseDestination | null,
): Exclude<CaseDestination, "steering"> {
  return destination === null || destination === "steering" ? "none" : destination;
}

/** Counts from the records, so a printed count and the file cannot disagree. */
export function tallyReadings(
  readings: readonly CaseReading[],
  missing: number,
  matrix: ReturnType<typeof loadMatrix>,
): ReadingCounts {
  const count = (k: (one: CaseReading) => boolean): number => readings.filter(k).length;
  const commits = (dest: string): boolean =>
    matrix.rows.some((row) => row.name === dest && row.commits);
  return {
    false_commit: count(
      (one) => one.golden_dest === "none" && commits(one.singleton_dest),
    ),
    lost_commit: count(
      (one) => commits(one.golden_dest) && !commits(one.singleton_dest),
    ),
    missing,
    stable: count((one) => !one.stable),
    restates: count((one) => one.differing_keys.includes(RESTATES_ID)),
    destinations: count((one) => !one.dest_match),
    golden: count((one) => one.golden_match),
  };
}

export function compareReadings(args: {
  rows: readonly FrozenRow[];
  labels: Awaited<ReturnType<typeof readMatrixCases>>;
  matrix: ReturnType<typeof loadMatrix>;
  singleton: Map<string, RoutedReading>;
  batchAnswers: Map<string, Record<string, JevAnswer>>;
  set?: QuestionSet;
}): { counts: ReadingCounts; readings: CaseReading[] } {
  const set = args.set ?? "v1";
  const stableIds = stableIdsFor(set);
  let missing = 0;
  const readings: CaseReading[] = [];
  const labelById = new Map(
    args.labels.map((label) => [label.candidate_id, label] as const),
  );
  for (const row of args.rows) {
    const one = args.singleton.get(row.candidateId);
    const many = args.batchAnswers.get(row.candidateId);
    const label = labelById.get(row.candidateId);
    if (one === undefined || many === undefined || label === undefined) {
      missing += 1;
      continue;
    }
    if (!hasEveryAnswer(one.answers, set) || !hasEveryAnswer(many, set)) missing += 1;
    const diff = expectedIdsFor(set).filter(
      (id) => !sameAnswer(one.answers[id], many[id]),
    );
    const read = (a: Record<string, JevAnswer>): ReturnType<typeof decideRoute> =>
      set === "v2"
        ? decideRouteV2(one.candidate, a, args.matrix, DEFAULT_THRESHOLDS_V2)
        : decideRoute(one.candidate, a, args.matrix, DEFAULT_THRESHOLDS);
    const single = read(one.answers);
    const batch = read(many);
    const singleDest = normalizeNoCommit(single.destination);
    const batchDest = normalizeNoCommit(batch.destination);
    const goldenDest = normalizeNoCommit(label.dest);
    readings.push({
      candidate_id: row.candidateId,
      golden_dest: goldenDest,
      golden_yn: Object.fromEntries(
        DESTINATIONS.map((name) => [ynId(name), label[`yn_${name}`]]),
      ),
      singleton_answers: one.answers,
      batch_answers: many,
      singleton_dest: singleDest,
      batch_dest: batchDest,
      stable: !stableIds.some((id) => diff.includes(id)),
      dest_match: singleDest === batchDest,
      golden_match: batchDest === goldenDest,
      differing_keys: diff,
    });
  }
  return { counts: tallyReadings(readings, missing, args.matrix), readings };
}

export type ReadingCounts = Record<
  | "missing"
  | "stable"
  | "destinations"
  | "restates"
  | "golden"
  | "false_commit"
  | "lost_commit",
  number
>;

/** One case, as both readings saw it: an entry in the readings file. */
export interface CaseReading {
  candidate_id: string;
  golden_dest: string;
  golden_yn: Record<string, boolean>;
  singleton_answers: Record<string, JevAnswer>;
  batch_answers: Record<string, JevAnswer>;
  singleton_dest: string;
  batch_dest: string;
  stable: boolean;
  dest_match: boolean;
  golden_match: boolean;
  differing_keys: string[];
}
