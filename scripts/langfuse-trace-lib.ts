import {
  escapeControl,
  namespaceOf,
  parsedTimestamp,
  stagesOf,
  traceStatus,
  type ComparisonBasis,
  type LangfuseTrace,
  type StageComparison,
  type StageEvidence,
  type TraceComparison,
} from "./langfuse-trace-evidence.ts";

export {
  digestOutput,
  renderTimeline,
  type ComparisonBasis,
  type LangfuseObservation,
  type LangfuseTrace,
  type StageComparison,
  type TraceComparison,
} from "./langfuse-trace-evidence.ts";

const setDifference = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((value) => !b.has(value)).sort();

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const compareMaps = (
  a: Map<string, string | number>,
  b: Map<string, string | number>,
): string[] =>
  sortedUnion(a.keys(), b.keys())
    .filter((key) => a.get(key) !== b.get(key))
    .map((key) => `${key}: ${a.get(key) ?? "—"} -> ${b.get(key) ?? "—"}`);

function sortedUnion(a: Iterable<string>, b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function scoreDeltaLine(
  row: string,
  field: string,
  left?: number,
  right?: number,
): string {
  const delta = left === undefined || right === undefined ? "—" : String(right - left);
  return `${row}.${field}: ${left ?? "—"} -> ${right ?? "—"} delta=${delta}`;
}

function scoreRowDeltas(
  row: string,
  scoresA: Map<string, number> = new Map(),
  scoresB: Map<string, number> = new Map(),
): string[] {
  return sortedUnion(scoresA.keys(), scoresB.keys())
    .filter((field) => scoresA.get(field) !== scoresB.get(field))
    .map((field) => scoreDeltaLine(row, field, scoresA.get(field), scoresB.get(field)));
}

function compareScores(a?: StageEvidence, b?: StageEvidence): string[] {
  const scoresA = a?.scores ?? new Map<string, Map<string, number>>();
  const scoresB = b?.scores ?? new Map<string, Map<string, number>>();
  return sortedUnion(scoresA.keys(), scoresB.keys()).flatMap((row) =>
    scoreRowDeltas(row, scoresA.get(row), scoresB.get(row)),
  );
}

const hasRowEvidence = (stage?: StageEvidence): boolean =>
  Boolean(stage && (stage.candidates.size > 0 || stage.chosen.length > 0));

const hasEvidence = (stage?: StageEvidence): boolean =>
  hasRowEvidence(stage) ||
  Boolean(stage && (stage.counts.size > 0 || stage.degradation.size > 0));

function comparisonBasis(a?: StageEvidence, b?: StageEvidence): ComparisonBasis {
  const aHasRows = hasRowEvidence(a);
  const bHasRows = hasRowEvidence(b);
  if (aHasRows && bHasRows) return "row_ids";
  return aHasRows || bHasRows ? "mixed" : "counts+degradation";
}

const EMPTY_EVIDENCE: StageEvidence = {
  durationMs: 0,
  evidenceIncomplete: false,
  candidates: new Set(),
  chosen: [],
  filtered: new Map(),
  scores: new Map(),
  counts: new Map(),
  degradation: new Map(),
};

interface ChosenComparison {
  added: string[];
  removed: string[];
  reordered: boolean;
  identical: boolean;
}

function compareChosen(chosenA: string[], chosenB: string[]): ChosenComparison {
  const added = setDifference(new Set(chosenB), new Set(chosenA));
  const removed = setDifference(new Set(chosenA), new Set(chosenB));
  const identical = arraysEqual(chosenA, chosenB);
  return {
    added,
    removed,
    reordered: added.length === 0 && removed.length === 0 && !identical,
    identical,
  };
}

function stageEquivalent(
  basis: ComparisonBasis,
  a?: StageEvidence,
  b?: StageEvidence,
): boolean {
  if (!a || !b || a.evidenceIncomplete || b.evidenceIncomplete) return false;
  if (basis === "row_ids")
    return setsEqual(a.candidates, b.candidates) && arraysEqual(a.chosen, b.chosen);
  return (
    basis === "counts+degradation" &&
    compareMaps(a.counts, b.counts).length === 0 &&
    compareMaps(a.degradation, b.degradation).length === 0
  );
}

function compareStage(
  name: string,
  a?: StageEvidence,
  b?: StageEvidence,
): StageComparison {
  const basis = comparisonBasis(a, b);
  const left = a ?? EMPTY_EVIDENCE;
  const right = b ?? EMPTY_EVIDENCE;
  const chosen = compareChosen(left.chosen, right.chosen);
  const countDifferences = compareMaps(left.counts, right.counts);
  const degradationDifferences = compareMaps(left.degradation, right.degradation);
  const evidenceIncomplete = left.evidenceIncomplete || right.evidenceIncomplete;
  return {
    name,
    durationA: a?.durationMs,
    durationB: b?.durationMs,
    basis,
    evidenceIncomplete,
    candidateAdded: setDifference(right.candidates, left.candidates),
    candidateRemoved: setDifference(left.candidates, right.candidates),
    chosenAdded: chosen.added,
    chosenRemoved: chosen.removed,
    chosenReordered: chosen.reordered,
    countDifferences,
    degradationDifferences,
    filteredDifferences: compareMaps(left.filtered, right.filtered),
    scoreDeltas: compareScores(a, b),
    equivalent: stageEquivalent(basis, a, b),
  };
}

function pairStageOccurrences(
  name: string,
  groupA: StageEvidence[],
  groupB: StageEvidence[],
): { stages: StageComparison[]; evidenceCount: number; incompleteEvidence: boolean } {
  const occurrences = Math.max(groupA.length, groupB.length);
  const stages: StageComparison[] = [];
  let evidenceCount = 0;
  let incompleteEvidence = false;
  for (let index = 0; index < occurrences; index += 1) {
    const label = occurrences > 1 ? `${name}[${index + 1}]` : name;
    if (hasEvidence(groupA[index]) || hasEvidence(groupB[index])) evidenceCount += 1;
    const stage = compareStage(label, groupA[index], groupB[index]);
    incompleteEvidence ||= stage.evidenceIncomplete;
    stages.push(stage);
  }
  return { stages, evidenceCount, incompleteEvidence };
}

function pairAllStages(
  stagesA: Map<string, StageEvidence[]>,
  stagesB: Map<string, StageEvidence[]>,
): { stages: StageComparison[]; evidenceCount: number; incompleteEvidence: boolean } {
  const stages: StageComparison[] = [];
  let evidenceCount = 0;
  let incompleteEvidence = false;
  for (const name of sortedUnion(stagesA.keys(), stagesB.keys())) {
    const paired = pairStageOccurrences(
      name,
      stagesA.get(name) ?? [],
      stagesB.get(name) ?? [],
    );
    evidenceCount += paired.evidenceCount;
    incompleteEvidence ||= paired.incompleteEvidence;
    stages.push(...paired.stages);
  }
  return { stages, evidenceCount, incompleteEvidence };
}

function traceEquivalence(
  traceA: LangfuseTrace,
  traceB: LangfuseTrace,
  stages: StageComparison[],
  evidenceCount: number,
): boolean | null {
  if (evidenceCount === 0) return null;
  if (stages.some((stage) => stage.evidenceIncomplete)) return null;
  const sameTool = (traceA.name ?? "") === (traceB.name ?? "");
  return sameTool && stages.every((stage) => stage.equivalent);
}

/** Compare repeated stage occurrences pairwise while keeping timing and score changes informational. */
export function diffTraces(
  traceA: LangfuseTrace,
  traceB: LangfuseTrace,
): TraceComparison {
  const stagesA = stagesOf(traceA);
  const stagesB = stagesOf(traceB);
  const { stages, evidenceCount, incompleteEvidence } = pairAllStages(stagesA, stagesB);
  const equivalent = traceEquivalence(traceA, traceB, stages, evidenceCount);
  return {
    equivalent,
    evidenceIncomplete: incompleteEvidence,
    toolA: traceA.name ?? "—",
    toolB: traceB.name ?? "—",
    releaseA: traceA.release ?? "—",
    releaseB: traceB.release ?? "—",
    namespaceA: namespaceOf(traceA),
    namespaceB: namespaceOf(traceB),
    stages,
  };
}

const list = (values: string[]): string =>
  values.length > 0 ? values.map(escapeControl).join(",") : "—";

export const traceDiffExitCode = (comparison: TraceComparison): number =>
  comparison.equivalent === null ? 2 : comparison.equivalent ? 0 : 1;

export function repeatExitCode(comparisons: TraceComparison[]): number {
  if (comparisons.some((comparison) => comparison.equivalent === null)) return 2;
  return comparisons.some((comparison) => comparison.equivalent === false) ? 1 : 0;
}

/** Render a stage-aligned trace comparison. */
export function renderTraceDiff(comparison: TraceComparison): string {
  const equivalence =
    comparison.equivalent === null
      ? comparison.evidenceIncomplete
        ? "unknown (incomplete retrieval evidence)"
        : "unknown (no retrieval evidence found)"
      : String(comparison.equivalent);
  const lines = [
    `equivalent=${equivalence}`,
    `tool A=${comparison.toolA} B=${comparison.toolB}`,
    `release A=${comparison.releaseA} B=${comparison.releaseB}`,
    `namespace A=${comparison.namespaceA} B=${comparison.namespaceB}`,
  ];
  for (const stage of comparison.stages) {
    lines.push(
      `stage=${stage.name} basis=${stage.basis} duration_ms A=${stage.durationA ?? "—"} B=${stage.durationB ?? "—"}`,
      `  candidate_row_ids added=${list(stage.candidateAdded)} removed=${list(stage.candidateRemoved)}`,
      `  chosen_row_ids added=${list(stage.chosenAdded)} removed=${list(stage.chosenRemoved)} reordered=${stage.chosenReordered}`,
      `  counts ${list(stage.countDifferences)}`,
      `  degradation ${list(stage.degradationDifferences)}`,
      `  filtered ${list(stage.filteredDifferences)}`,
      `  scores ${list(stage.scoreDeltas)}`,
    );
  }
  return lines.join("\n");
}

export function renderSessionTraces(traces: LangfuseTrace[]): string {
  return [...traces]
    .sort(
      (a, b) =>
        parsedTimestamp(a.timestamp) - parsedTimestamp(b.timestamp) ||
        a.id.localeCompare(b.id),
    )
    .map((trace) => {
      const durationMs = Math.max(0, (trace.latency ?? 0) * 1_000);
      const timestamp = trace.timestamp ?? "[timestamp=unknown]";
      return `${escapeControl(trace.id)} ${trace.name ?? "—"} ${timestamp} release=${trace.release ?? "—"} status=${traceStatus(trace)} duration_ms=${durationMs}`;
    })
    .join("\n");
}

const STAGE_CHANGE_FIELDS: ReadonlyArray<
  readonly [string, (s: StageComparison) => boolean]
> = [
  ["duration_ms", (s) => s.durationA !== s.durationB],
  [
    "candidate_row_ids",
    (s) => s.candidateAdded.length > 0 || s.candidateRemoved.length > 0,
  ],
  ["chosen_row_ids", (s) => s.chosenAdded.length > 0 || s.chosenRemoved.length > 0],
  ["chosen_order", (s) => s.chosenReordered],
  ["counts", (s) => s.countDifferences.length > 0],
  ["degradation", (s) => s.degradationDifferences.length > 0],
  ["filtered", (s) => s.filteredDifferences.length > 0],
  ["score_fields", (s) => s.scoreDeltas.length > 0],
];

function stageChangeFields(stage: StageComparison | undefined): string[] {
  if (!stage) return ["presence"];
  return STAGE_CHANGE_FIELDS.filter(([, changed]) => changed(stage)).map(
    ([field]) => field,
  );
}

export function renderRepeatReport(sessionId: string, traces: LangfuseTrace[]): string {
  const baseline = traces[0];
  if (!baseline) return `sessionId=${escapeControl(sessionId)}\nno traces found`;
  const comparisons = traces.slice(1).map((trace) => diffTraces(baseline, trace));
  const stageNames = new Set(
    comparisons.flatMap((comparison) => comparison.stages.map((stage) => stage.name)),
  );
  const lines = [
    `sessionId=${escapeControl(sessionId)}`,
    `trace_ids=${traces.map((trace) => escapeControl(trace.id)).join(",")}`,
  ];
  for (const stageName of [...stageNames].sort()) {
    const changes = new Set(
      comparisons.flatMap((comparison) =>
        stageChangeFields(comparison.stages.find((item) => item.name === stageName)),
      ),
    );
    lines.push(
      changes.size === 0
        ? `stage=${stageName} DETERMINISTIC`
        : `stage=${stageName} VARIES fields=${[...changes].sort().join(",")}`,
    );
  }
  comparisons.forEach((comparison, index) => {
    lines.push(`\ncomparison=1:${index + 2}`);
    lines.push(renderTraceDiff(comparison));
  });
  return lines.join("\n");
}
