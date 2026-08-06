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

export interface StageComparison {
  name: string;
  durationA?: number;
  durationB?: number;
  candidateAdded: string[];
  candidateRemoved: string[];
  chosenAdded: string[];
  chosenRemoved: string[];
  filteredDifferences: string[];
  scoreDeltas: string[];
}

export interface TraceComparison {
  equivalent: boolean;
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
  chosen: Set<string>;
  filtered: Map<string, string>;
  scores: Map<string, Map<string, number>>;
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
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${key}:${stableValue(child)}`);
    return entries.join(",");
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

function collectDigestFields(value: unknown, prefix = "", found: string[] = []): string[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const countField = key === "count" || key.endsWith("_count");
    const rowIdsField = key === "row_ids" || key.endsWith("_row_ids");
    if (countField && typeof child === "number") found.push(`${path}=${child}`);
    if (rowIdsField && Array.isArray(child)) {
      found.push(`${path}=[${child.map(String).join(",")}]`);
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => collectDigestFields(item, `${path}[${index}]`, found));
    } else {
      collectDigestFields(child, path, found);
    }
  }
  return found;
}

/** Return a compact, content-free summary of count and row-id fields. */
export function digestOutput(output: unknown): string {
  const fields = collectDigestFields(output);
  const candidateRowIds = [
    ...new Set(
      candidateObjects(output)
        .map((candidate) => candidate.row_id)
        .filter((rowId) => rowId !== undefined)
        .map(String),
    ),
  ];
  if (candidateRowIds.length > 0) {
    fields.push(`candidate_row_ids=[${candidateRowIds.join(",")}]`);
  }
  return fields.length > 0 ? fields.join(" ") : "—";
}

/** Render one trace and all observations in chronological order. */
export function renderTimeline(trace: LangfuseTrace): string {
  const observations = [...(trace.observations ?? [])].sort((a, b) =>
    String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")),
  );
  const lines = [
    `name=${trace.name ?? "—"}`,
    `release=${trace.release ?? "—"}`,
    `sessionId=${trace.sessionId ?? "—"}`,
    `caller=${callerIdentity(trace)}`,
    `status=${traceStatus(trace)}`,
  ];
  for (const observation of observations) {
    const metadata = metadataOf(observation);
    const stage = typeof metadata.stage === "string" ? metadata.stage : observation.type?.toLowerCase() ?? "observation";
    lines.push(
      `${observation.startTime ?? "—"} ${observation.name ?? "unnamed"} stage=${stage} duration_ms=${observationDuration(observation)} output=${digestOutput(observation.output)}`,
    );
  }
  return lines.join("\n");
}

function rowIdArrays(value: unknown, chosenOnly: boolean, found = new Set<string>()): Set<string> {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const isRowIds = key === "row_ids" || key.endsWith("_row_ids");
    const isChosen = /^(selected|returned|chosen)_row_ids$/.test(key);
    if (isRowIds && Array.isArray(child) && (!chosenOnly || isChosen)) {
      child.forEach((id) => found.add(String(id)));
    }
    if (Array.isArray(child)) child.forEach((item) => rowIdArrays(item, chosenOnly, found));
    else rowIdArrays(child, chosenOnly, found);
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

function candidateKey(candidate: Record<string, unknown>, index: number): string {
  return String(candidate.row_id ?? candidate.id ?? candidate.path ?? `candidate_${index}`);
}

function stageEvidence(observation: LangfuseObservation): StageEvidence {
  const candidates = rowIdArrays(observation.output, false);
  const chosen = rowIdArrays(observation.output, true);
  const filtered = new Map<string, string>();
  const scores = new Map<string, Map<string, number>>();
  candidateObjects(observation.output).forEach((candidate, index) => {
    const key = candidateKey(candidate, index);
    if (candidate.row_id !== undefined) candidates.add(String(candidate.row_id));
    if (candidate.chosen === true) chosen.add(key);
    if (candidate.filtered_by !== undefined) filtered.set(key, stableValue(candidate.filtered_by));
    const numeric = new Map<string, number>();
    for (const [field, value] of Object.entries(candidate)) {
      if (typeof value === "number" && /score|distance|similarity|usefulness/i.test(field)) {
        numeric.set(field, value);
      }
    }
    if (numeric.size > 0) scores.set(key, numeric);
  });
  return { durationMs: observationDuration(observation), candidates, chosen, filtered, scores };
}

function mergeEvidence(target: StageEvidence, source: StageEvidence): void {
  target.durationMs += source.durationMs;
  source.candidates.forEach((value) => target.candidates.add(value));
  source.chosen.forEach((value) => target.chosen.add(value));
  source.filtered.forEach((value, key) => target.filtered.set(key, value));
  source.scores.forEach((value, key) => target.scores.set(key, value));
}

function stagesOf(trace: LangfuseTrace): Map<string, StageEvidence> {
  const stages = new Map<string, StageEvidence>();
  for (const observation of trace.observations ?? []) {
    const name = observation.name ?? "unnamed";
    const evidence = stageEvidence(observation);
    const current = stages.get(name);
    if (current) mergeEvidence(current, evidence);
    else stages.set(name, evidence);
  }
  return stages;
}

function setDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => !b.has(value)).sort();
}

function mapsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function compareFiltered(a?: StageEvidence, b?: StageEvidence): string[] {
  const keys = new Set([...(a?.filtered.keys() ?? []), ...(b?.filtered.keys() ?? [])]);
  return [...keys]
    .sort()
    .filter((key) => a?.filtered.get(key) !== b?.filtered.get(key))
    .map((key) => `${key}: ${a?.filtered.get(key) ?? "—"} -> ${b?.filtered.get(key) ?? "—"}`);
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

/** Compare stage evidence while keeping timing and metadata changes informational. */
export function diffTraces(traceA: LangfuseTrace, traceB: LangfuseTrace): TraceComparison {
  const stagesA = stagesOf(traceA);
  const stagesB = stagesOf(traceB);
  const names = [...new Set([...stagesA.keys(), ...stagesB.keys()])].sort();
  let equivalent = (traceA.name ?? "") === (traceB.name ?? "");
  const stages = names.map((name) => {
    const a = stagesA.get(name);
    const b = stagesB.get(name);
    const candidateAdded = setDifference(b?.candidates ?? new Set(), a?.candidates ?? new Set());
    const candidateRemoved = setDifference(a?.candidates ?? new Set(), b?.candidates ?? new Set());
    const chosenAdded = setDifference(b?.chosen ?? new Set(), a?.chosen ?? new Set());
    const chosenRemoved = setDifference(a?.chosen ?? new Set(), b?.chosen ?? new Set());
    if (!a || !b || !mapsEqual(a.candidates, b.candidates) || !mapsEqual(a.chosen, b.chosen)) {
      equivalent = false;
    }
    return {
      name,
      durationA: a?.durationMs,
      durationB: b?.durationMs,
      candidateAdded,
      candidateRemoved,
      chosenAdded,
      chosenRemoved,
      filteredDifferences: compareFiltered(a, b),
      scoreDeltas: compareScores(a, b),
    };
  });
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
  return values.length > 0 ? values.join(",") : "—";
}

export function traceDiffExitCode(comparison: TraceComparison): number {
  return comparison.equivalent ? 0 : 1;
}

/** Render a stage-aligned trace comparison. */
export function renderTraceDiff(comparison: TraceComparison): string {
  const lines = [
    `equivalent=${comparison.equivalent}`,
    `tool A=${comparison.toolA} B=${comparison.toolB}`,
    `release A=${comparison.releaseA} B=${comparison.releaseB}`,
    `namespace A=${comparison.namespaceA} B=${comparison.namespaceB}`,
  ];
  for (const stage of comparison.stages) {
    lines.push(`stage=${stage.name} duration_ms A=${stage.durationA ?? "—"} B=${stage.durationB ?? "—"}`);
    lines.push(`  candidate_row_ids added=${list(stage.candidateAdded)} removed=${list(stage.candidateRemoved)}`);
    lines.push(`  chosen_row_ids added=${list(stage.chosenAdded)} removed=${list(stage.chosenRemoved)}`);
    lines.push(`  filtered ${list(stage.filteredDifferences)}`);
    lines.push(`  scores ${list(stage.scoreDeltas)}`);
  }
  return lines.join("\n");
}

export function renderSessionTraces(traces: LangfuseTrace[]): string {
  return [...traces]
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
    .map((trace) => {
      const durationMs = Math.max(0, (trace.latency ?? 0) * 1_000);
      return `${trace.id} ${trace.name ?? "—"} ${trace.timestamp ?? "—"} release=${trace.release ?? "—"} status=${traceStatus(trace)} duration_ms=${durationMs}`;
    })
    .join("\n");
}

export function renderRepeatReport(sessionId: string, traces: LangfuseTrace[]): string {
  const baseline = traces[0];
  if (!baseline) return `sessionId=${sessionId}\nno traces found`;
  const comparisons = traces.slice(1).map((trace) => diffTraces(baseline, trace));
  const stageNames = new Set(comparisons.flatMap((comparison) => comparison.stages.map((stage) => stage.name)));
  const lines = [
    `sessionId=${sessionId}`,
    `trace_ids=${traces.map((trace) => trace.id).join(",")}`,
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
      if (stage.filteredDifferences.length > 0) changes.add("filtered");
      if (stage.scoreDeltas.length > 0) changes.add("score_fields");
    }
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
