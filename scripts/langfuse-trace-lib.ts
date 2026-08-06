export interface LangfuseObservation {
  id?: string;
  name?: string;
  type?: string;
  parentObservationId?: string | null;
  startTime?: string;
  endTime?: string;
  latency?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface LangfuseTrace {
  id: string;
  name?: string;
  timestamp?: string;
  release?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  latency?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
  observations?: LangfuseObservation[];
}

export type ComparisonBasis = "row_ids" | "counts+degradation" | "mixed";

export interface StageComparison {
  name: string;
  durationA?: number;
  durationB?: number;
  basis: ComparisonBasis;
  candidateAdded: string[];
  candidateRemoved: string[];
  chosenAdded: string[];
  chosenRemoved: string[];
  chosenReordered: boolean;
  countDifferences: string[];
  degradationDifferences: string[];
  filteredDifferences: string[];
  scoreDeltas: string[];
  equivalent: boolean;
}

export interface TraceComparison {
  equivalent: boolean | null;
  toolA: string;
  toolB: string;
  releaseA: string;
  releaseB: string;
  namespaceA: string;
  namespaceB: string;
  stages: StageComparison[];
}

interface StageEvidence {
  durationMs: number;
  candidates: Set<string>;
  chosen: string[];
  filtered: Map<string, string>;
  scores: Map<string, Map<string, number>>;
  counts: Map<string, number>;
  degradation: Map<string, string>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.map(stableValue).sort().join(",");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${key}:${stableValue(child)}`)
      .join(",");
  }
  return String(value);
}

function metadataOf(value: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  return value.metadata ?? {};
}

function rootObservation(trace: LangfuseTrace): LangfuseObservation | undefined {
  return trace.observations?.find((observation) => !observation.parentObservationId);
}

function observationDuration(observation: LangfuseObservation): number {
  const metadataDuration = metadataOf(observation).duration_ms;
  if (typeof metadataDuration === "number" && Number.isFinite(metadataDuration)) {
    return Math.max(0, metadataDuration);
  }
  const start = Date.parse(observation.startTime ?? "");
  const end = Date.parse(observation.endTime ?? "");
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  return Math.max(0, (observation.latency ?? 0) * 1_000);
}

function traceStatus(trace: LangfuseTrace): string {
  const root = rootObservation(trace);
  const status = root ? metadataOf(root).status : undefined;
  if (typeof status === "string") return status;
  const failed = trace.observations?.some((observation) =>
    ["ERROR", "WARNING"].includes(String((observation as { level?: unknown }).level ?? "").toUpperCase()),
  );
  return failed ? "error" : "unknown";
}

function callerIdentity(trace: LangfuseTrace): string {
  const rootMetadata = metadataOf(rootObservation(trace) ?? {});
  const fields = [
    ["user", trace.userId],
    ["client", rootMetadata.caller_client_id],
    ["token_client", rootMetadata.caller_token_client_id],
    ["agent", rootMetadata.caller_agent_id],
    ["role", rootMetadata.caller_role],
  ] as const;
  return fields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(" ") || "—";
}

function namespaceOf(trace: LangfuseTrace): string {
  const root = rootObservation(trace);
  const metadata = root ? metadataOf(root) : metadataOf(trace);
  const namespace = metadata.resolved_namespace ?? metadata.namespace;
  if (namespace !== undefined) return stableValue(namespace);
  const input = objectValue(trace.input);
  return stableValue(input?.namespace ?? objectValue(input?.scope)?.namespace);
}

function escapeControl(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      return isControl ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    })
    .join("");
}

function collectDigestFields(value: unknown, prefix = "", found: string[] = []): string[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const countField = key === "count" || key.endsWith("_count");
    const rowIdsField = key === "row_ids" || key.endsWith("_row_ids");
    if (countField && typeof child === "number") found.push(`${path}=${child}`);
    if (rowIdsField && Array.isArray(child)) {
      found.push(`${path}=[${child.map((item) => escapeControl(String(item))).join(",")}]`);
    }
    if (Array.isArray(child)) child.forEach((item, index) => collectDigestFields(item, `${path}[${index}]`, found));
    else collectDigestFields(child, path, found);
  }
  return found;
}

/** Return a compact, content-free summary of count and row-id fields. */
export function digestOutput(output: unknown): string {
  const fields = collectDigestFields(output);
  const candidateRowIds = [
    ...new Set(
      candidateObjects(output)
        .map((candidate, index) => candidateKey(candidate, index))
        .filter((key) => key !== undefined)
        .map((key) => escapeControl(key)),
    ),
  ];
  if (candidateRowIds.length > 0) fields.push(`candidate_row_ids=[${candidateRowIds.join(",")}]`);
  return fields.length > 0 ? fields.join(" ") : "—";
}

function parsedTimestamp(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareObservations(a: LangfuseObservation, b: LangfuseObservation): number {
  return parsedTimestamp(a.startTime) - parsedTimestamp(b.startTime)
    || parsedTimestamp(a.endTime) - parsedTimestamp(b.endTime)
    || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/** Render one trace and all observations in deterministic chronological order. */
export function renderTimeline(trace: LangfuseTrace): string {
  const observations = [...(trace.observations ?? [])].sort(compareObservations);
  const lines = [
    `name=${trace.name ?? "—"}`,
    `release=${trace.release ?? "—"}`,
    `sessionId=${escapeControl(trace.sessionId ?? "—")}`,
    `caller=${callerIdentity(trace)}`,
    `status=${traceStatus(trace)}`,
  ];
  for (const observation of observations) {
    const metadata = metadataOf(observation);
    const stage = typeof metadata.stage === "string" ? metadata.stage : observation.type?.toLowerCase() ?? "observation";
    const start = observation.startTime ?? "[startTime=unknown]";
    lines.push(
      `${start} ${observation.name ?? "unnamed"} id=${escapeControl(observation.id ?? "—")} stage=${stage} duration_ms=${observationDuration(observation)} output=${digestOutput(observation.output)}`,
    );
  }
  return lines.join("\n");
}

function rowIdSequence(value: unknown, chosenOnly: boolean, found: string[] = []): string[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const isRowIds = key === "row_ids" || key.endsWith("_row_ids");
    const isChosen = /^(selected|returned|chosen)_row_ids$/.test(key);
    if (isRowIds && Array.isArray(child) && (!chosenOnly || isChosen)) child.forEach((id) => found.push(String(id)));
    if (Array.isArray(child)) child.forEach((item) => rowIdSequence(item, chosenOnly, found));
    else rowIdSequence(child, chosenOnly, found);
  }
  return found;
}

function candidateObjects(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    if (key === "candidates" && Array.isArray(child)) {
      child.forEach((candidate) => {
        const item = objectValue(candidate);
        if (item) found.push(item);
      });
    }
    if (Array.isArray(child)) child.forEach((item) => candidateObjects(item, found));
    else candidateObjects(child, found);
  }
  return found;
}

function candidateKey(candidate: Record<string, unknown>, index: number): string | undefined {
  if (candidate.row_id !== undefined && candidate.row_id !== null) return String(candidate.row_id);
  if (candidate.id !== undefined && candidate.id !== null) return String(candidate.id);
  if (candidate.path !== undefined && candidate.path !== null) return `${String(candidate.path)}#${index + 1}`;
  return undefined;
}

function collectCounts(value: unknown, prefix = "", found = new Map<string, number>()): Map<string, number> {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if ((key === "count" || key.endsWith("_count") || prefix.endsWith("counts")) && typeof child === "number") {
      found.set(path, child);
    }
    if (Array.isArray(child)) child.forEach((item, index) => collectCounts(item, `${path}[${index}]`, found));
    else collectCounts(child, path, found);
  }
  return found;
}

function stageEvidence(observation: LangfuseObservation): StageEvidence {
  const candidates = new Set(rowIdSequence(observation.output, false));
  const chosen = rowIdSequence(observation.output, true);
  const filtered = new Map<string, string>();
  const scores = new Map<string, Map<string, number>>();
  candidateObjects(observation.output).forEach((candidate, index) => {
    const key = candidateKey(candidate, index);
    if (!key) return;
    candidates.add(key);
    if (candidate.chosen === true && !chosen.includes(key)) chosen.push(key);
    if (candidate.filtered_by !== undefined) filtered.set(key, stableValue(candidate.filtered_by));
    const numeric = new Map<string, number>();
    for (const [field, value] of Object.entries(candidate)) {
      if (typeof value === "number" && /score|distance|similarity|usefulness/i.test(field)) numeric.set(field, value);
    }
    if (numeric.size > 0) scores.set(key, numeric);
  });
  const metadata = metadataOf(observation);
  const degradation = new Map<string, string>();
  for (const key of ["payload_degraded", "payload_degradation_reason", "payload_limit_bytes", "additional_spans_omitted"]) {
    if (metadata[key] !== undefined) degradation.set(key, stableValue(metadata[key]));
  }
  return {
    durationMs: observationDuration(observation),
    candidates,
    chosen,
    filtered,
    scores,
    counts: collectCounts(observation.output),
    degradation,
  };
}

function stagesOf(trace: LangfuseTrace): Map<string, StageEvidence[]> {
  const stages = new Map<string, StageEvidence[]>();
  const observations = [...(trace.observations ?? [])].sort(compareObservations);
  for (const observation of observations) {
    const name = observation.name ?? "unnamed";
    const group = stages.get(name) ?? [];
    group.push(stageEvidence(observation));
    stages.set(name, group);
  }
  return stages;
}

function setDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => !b.has(value)).sort();
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareMaps(a: Map<string, string | number>, b: Map<string, string | number>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys]
    .sort()
    .filter((key) => a.get(key) !== b.get(key))
    .map((key) => `${key}: ${a.get(key) ?? "—"} -> ${b.get(key) ?? "—"}`);
}

function compareFiltered(a?: StageEvidence, b?: StageEvidence): string[] {
  return compareMaps(a?.filtered ?? new Map(), b?.filtered ?? new Map());
}

function compareScores(a?: StageEvidence, b?: StageEvidence): string[] {
  const rows = new Set([...(a?.scores.keys() ?? []), ...(b?.scores.keys() ?? [])]);
  const deltas: string[] = [];
  for (const row of [...rows].sort()) {
    const fields = new Set([...(a?.scores.get(row)?.keys() ?? []), ...(b?.scores.get(row)?.keys() ?? [])]);
    for (const field of [...fields].sort()) {
      const left = a?.scores.get(row)?.get(field);
      const right = b?.scores.get(row)?.get(field);
      if (left === right) continue;
      const delta = left === undefined || right === undefined ? "—" : String(right - left);
      deltas.push(`${row}.${field}: ${left ?? "—"} -> ${right ?? "—"} delta=${delta}`);
    }
  }
  return deltas;
}

function hasEvidence(stage?: StageEvidence): boolean {
  return Boolean(stage && (
    stage.candidates.size > 0
    || stage.chosen.length > 0
    || stage.counts.size > 0
    || stage.degradation.size > 0
  ));
}

function comparisonBasis(a?: StageEvidence, b?: StageEvidence): ComparisonBasis {
  const aHasRows = Boolean(a && (a.candidates.size > 0 || a.chosen.length > 0));
  const bHasRows = Boolean(b && (b.candidates.size > 0 || b.chosen.length > 0));
  if (aHasRows && bHasRows) return "row_ids";
  if (!aHasRows && !bHasRows) return "counts+degradation";
  return "mixed";
}

function compareStage(name: string, a?: StageEvidence, b?: StageEvidence): StageComparison {
  const basis = comparisonBasis(a, b);
  const candidateAdded = setDifference(b?.candidates ?? new Set(), a?.candidates ?? new Set());
  const candidateRemoved = setDifference(a?.candidates ?? new Set(), b?.candidates ?? new Set());
  const chosenA = a?.chosen ?? [];
  const chosenB = b?.chosen ?? [];
  const chosenAdded = setDifference(new Set(chosenB), new Set(chosenA));
  const chosenRemoved = setDifference(new Set(chosenA), new Set(chosenB));
  const chosenReordered = chosenAdded.length === 0 && chosenRemoved.length === 0 && !arraysEqual(chosenA, chosenB);
  const countDifferences = compareMaps(a?.counts ?? new Map(), b?.counts ?? new Map());
  const degradationDifferences = compareMaps(a?.degradation ?? new Map(), b?.degradation ?? new Map());
  const rowEvidenceEqual = Boolean(a && b && setsEqual(a.candidates, b.candidates) && arraysEqual(chosenA, chosenB));
  const fallbackEvidenceEqual = Boolean(a && b && countDifferences.length === 0 && degradationDifferences.length === 0);
  const equivalent = basis === "row_ids" ? rowEvidenceEqual : basis === "counts+degradation" && fallbackEvidenceEqual;
  return {
    name,
    durationA: a?.durationMs,
    durationB: b?.durationMs,
    basis,
    candidateAdded,
    candidateRemoved,
    chosenAdded,
    chosenRemoved,
    chosenReordered,
    countDifferences,
    degradationDifferences,
    filteredDifferences: compareFiltered(a, b),
    scoreDeltas: compareScores(a, b),
    equivalent,
  };
}

/** Compare repeated stage occurrences pairwise while keeping timing and score changes informational. */
export function diffTraces(traceA: LangfuseTrace, traceB: LangfuseTrace): TraceComparison {
  const stagesA = stagesOf(traceA);
  const stagesB = stagesOf(traceB);
  const names = [...new Set([...stagesA.keys(), ...stagesB.keys()])].sort();
  const stages: StageComparison[] = [];
  let evidenceStageCount = 0;
  for (const name of names) {
    const groupA = stagesA.get(name) ?? [];
    const groupB = stagesB.get(name) ?? [];
    const occurrences = Math.max(groupA.length, groupB.length);
    for (let index = 0; index < occurrences; index += 1) {
      const label = occurrences > 1 ? `${name}[${index + 1}]` : name;
      if (hasEvidence(groupA[index]) || hasEvidence(groupB[index])) evidenceStageCount += 1;
      stages.push(compareStage(label, groupA[index], groupB[index]));
    }
  }
  const equivalent = evidenceStageCount === 0
    ? null
    : (traceA.name ?? "") === (traceB.name ?? "") && stages.every((stage) => stage.equivalent);
  return {
    equivalent,
    toolA: traceA.name ?? "—",
    toolB: traceB.name ?? "—",
    releaseA: traceA.release ?? "—",
    releaseB: traceB.release ?? "—",
    namespaceA: namespaceOf(traceA),
    namespaceB: namespaceOf(traceB),
    stages,
  };
}

function list(values: string[]): string {
  return values.length > 0 ? values.map(escapeControl).join(",") : "—";
}

export function traceDiffExitCode(comparison: TraceComparison): number {
  if (comparison.equivalent === null) return 2;
  return comparison.equivalent ? 0 : 1;
}

export function repeatExitCode(comparisons: TraceComparison[]): number {
  if (comparisons.some((comparison) => comparison.equivalent === null)) return 2;
  return comparisons.some((comparison) => comparison.equivalent === false) ? 1 : 0;
}

/** Render a stage-aligned trace comparison. */
export function renderTraceDiff(comparison: TraceComparison): string {
  const equivalence = comparison.equivalent === null
    ? "unknown (no retrieval evidence found)"
    : String(comparison.equivalent);
  const lines = [
    `equivalent=${equivalence}`,
    `tool A=${comparison.toolA} B=${comparison.toolB}`,
    `release A=${comparison.releaseA} B=${comparison.releaseB}`,
    `namespace A=${comparison.namespaceA} B=${comparison.namespaceB}`,
  ];
  for (const stage of comparison.stages) {
    lines.push(`stage=${stage.name} basis=${stage.basis} duration_ms A=${stage.durationA ?? "—"} B=${stage.durationB ?? "—"}`);
    lines.push(`  candidate_row_ids added=${list(stage.candidateAdded)} removed=${list(stage.candidateRemoved)}`);
    lines.push(`  chosen_row_ids added=${list(stage.chosenAdded)} removed=${list(stage.chosenRemoved)} reordered=${stage.chosenReordered}`);
    lines.push(`  counts ${list(stage.countDifferences)}`);
    lines.push(`  degradation ${list(stage.degradationDifferences)}`);
    lines.push(`  filtered ${list(stage.filteredDifferences)}`);
    lines.push(`  scores ${list(stage.scoreDeltas)}`);
  }
  return lines.join("\n");
}

export function renderSessionTraces(traces: LangfuseTrace[]): string {
  return [...traces]
    .sort((a, b) => parsedTimestamp(a.timestamp) - parsedTimestamp(b.timestamp) || a.id.localeCompare(b.id))
    .map((trace) => {
      const durationMs = Math.max(0, (trace.latency ?? 0) * 1_000);
      const timestamp = trace.timestamp ?? "[timestamp=unknown]";
      return `${escapeControl(trace.id)} ${trace.name ?? "—"} ${timestamp} release=${trace.release ?? "—"} status=${traceStatus(trace)} duration_ms=${durationMs}`;
    })
    .join("\n");
}

export function renderRepeatReport(sessionId: string, traces: LangfuseTrace[]): string {
  const baseline = traces[0];
  if (!baseline) return `sessionId=${escapeControl(sessionId)}\nno traces found`;
  const comparisons = traces.slice(1).map((trace) => diffTraces(baseline, trace));
  const stageNames = new Set(comparisons.flatMap((comparison) => comparison.stages.map((stage) => stage.name)));
  const lines = [
    `sessionId=${escapeControl(sessionId)}`,
    `trace_ids=${traces.map((trace) => escapeControl(trace.id)).join(",")}`,
  ];
  for (const stageName of [...stageNames].sort()) {
    const changes = new Set<string>();
    for (const comparison of comparisons) {
      const stage = comparison.stages.find((item) => item.name === stageName);
      if (!stage) {
        changes.add("presence");
        continue;
      }
      if (stage.durationA !== stage.durationB) changes.add("duration_ms");
      if (stage.candidateAdded.length > 0 || stage.candidateRemoved.length > 0) changes.add("candidate_row_ids");
      if (stage.chosenAdded.length > 0 || stage.chosenRemoved.length > 0) changes.add("chosen_row_ids");
      if (stage.chosenReordered) changes.add("chosen_order");
      if (stage.countDifferences.length > 0) changes.add("counts");
      if (stage.degradationDifferences.length > 0) changes.add("degradation");
      if (stage.filteredDifferences.length > 0) changes.add("filtered");
      if (stage.scoreDeltas.length > 0) changes.add("score_fields");
    }
    lines.push(changes.size === 0
      ? `stage=${stageName} DETERMINISTIC`
      : `stage=${stageName} VARIES fields=${[...changes].sort().join(",")}`);
  }
  comparisons.forEach((comparison, index) => {
    lines.push(`\ncomparison=1:${index + 2}`);
    lines.push(renderTraceDiff(comparison));
  });
  return lines.join("\n");
}
