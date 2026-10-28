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
  evidenceIncomplete: boolean;
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
  evidenceIncomplete: boolean;
  toolA: string;
  toolB: string;
  releaseA: string;
  releaseB: string;
  namespaceA: string;
  namespaceB: string;
  stages: StageComparison[];
}

export interface StageEvidence {
  durationMs: number;
  evidenceIncomplete: boolean;
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
  return String(value as string | number | boolean | bigint | symbol);
}

const metadataOf = (value: {
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> => value.metadata ?? {};

const rootObservation = (trace: LangfuseTrace): LangfuseObservation | undefined =>
  trace.observations?.find((observation) => !observation.parentObservationId);

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

export function traceStatus(trace: LangfuseTrace): string {
  const root = rootObservation(trace);
  const status = root ? metadataOf(root).status : undefined;
  if (typeof status === "string") return status;
  const failed = trace.observations?.some((observation) => {
    const level = (observation as { level?: unknown }).level;
    if (typeof level !== "string") return false;
    return ["ERROR", "WARNING"].includes(level.toUpperCase());
  });
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
  return (
    fields
      .filter(([, value]) => present(value) && value !== "")
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(" ") || "—"
  );
}

export function namespaceOf(trace: LangfuseTrace): string {
  const root = rootObservation(trace);
  const metadata = root ? metadataOf(root) : metadataOf(trace);
  const namespace = metadata.resolved_namespace ?? metadata.namespace;
  if (namespace !== undefined) return stableValue(namespace);
  const input = objectValue(trace.input);
  return stableValue(input?.namespace ?? objectValue(input?.scope)?.namespace);
}

export function escapeControl(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      return isControl ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    })
    .join("");
}

const isCountKey = (key: string): boolean => key === "count" || key.endsWith("_count");
const isRowIdsKey = (key: string): boolean =>
  key === "row_ids" || key.endsWith("_row_ids");

function digestField(key: string, path: string, child: unknown): string | undefined {
  if (isCountKey(key) && typeof child === "number") return `${path}=${child}`;
  if (isRowIdsKey(key) && Array.isArray(child)) {
    return `${path}=[${child.map((item) => escapeControl(String(item))).join(",")}]`;
  }
  return undefined;
}

function collectDigestFields(
  value: unknown,
  prefix = "",
  found: string[] = [],
): string[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const field = digestField(key, path, child);
    if (field !== undefined) found.push(field);
    if (Array.isArray(child))
      child.forEach((item, index) =>
        collectDigestFields(item, `${path}[${index}]`, found),
      );
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
  if (candidateRowIds.length > 0)
    fields.push(`candidate_row_ids=[${candidateRowIds.join(",")}]`);
  return fields.length > 0 ? fields.join(" ") : "—";
}

export function parsedTimestamp(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

const compareObservations = (a: LangfuseObservation, b: LangfuseObservation): number =>
  parsedTimestamp(a.startTime) - parsedTimestamp(b.startTime) ||
  parsedTimestamp(a.endTime) - parsedTimestamp(b.endTime) ||
  String(a.id ?? "").localeCompare(String(b.id ?? ""));

function stageLabel(observation: LangfuseObservation): string {
  const stage = metadataOf(observation).stage;
  if (typeof stage === "string") return stage;
  return observation.type?.toLowerCase() ?? "observation";
}

function timelineRow(observation: LangfuseObservation): string {
  const start = observation.startTime ?? "[startTime=unknown]";
  const id = escapeControl(observation.id ?? "—");
  return (
    `${start} ${observation.name ?? "unnamed"} id=${id} stage=${stageLabel(observation)}` +
    ` duration_ms=${observationDuration(observation)} output=${digestOutput(observation.output)}`
  );
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
  for (const observation of observations) lines.push(timelineRow(observation));
  return lines.join("\n");
}

function rowIdSequence(
  value: unknown,
  chosenOnly: boolean,
  found: string[] = [],
): string[] {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const isRowIds = isRowIdsKey(key);
    const isChosen = /^(selected|returned|chosen)_row_ids$/.test(key);
    if (isRowIds && Array.isArray(child) && (!chosenOnly || isChosen))
      child.forEach((id) => found.push(String(id)));
    if (Array.isArray(child))
      child.forEach((item) => rowIdSequence(item, chosenOnly, found));
    else rowIdSequence(child, chosenOnly, found);
  }
  return found;
}

function candidateObjects(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
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

const present = (value: unknown): boolean => value !== undefined && value !== null;

function candidateKey(
  candidate: Record<string, unknown>,
  index: number,
): string | undefined {
  if (present(candidate.row_id)) return String(candidate.row_id);
  if (present(candidate.id)) return String(candidate.id);
  return present(candidate.path) ? `${String(candidate.path)}#${index + 1}` : undefined;
}

function collectCounts(
  value: unknown,
  prefix = "",
  found = new Map<string, number>(),
): Map<string, number> {
  const object = objectValue(value);
  if (!object) return found;
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isCountEntry = isCountKey(key) || prefix.endsWith("counts");
    if (isCountEntry && typeof child === "number") found.set(path, child);
    if (Array.isArray(child))
      child.forEach((item, index) => collectCounts(item, `${path}[${index}]`, found));
    else collectCounts(child, path, found);
  }
  return found;
}

const DEGRADATION_KEYS = [
  "payload_degraded",
  "payload_degradation_reason",
  "payload_limit_bytes",
  "additional_spans_omitted",
  "evidence_complete",
  "evidence_truncated",
  "payload_evidence_truncated",
];

function collectDegradationMarkers(
  value: unknown,
  found: Map<string, string>,
  prefix = "",
): void {
  const object = objectValue(value);
  if (!object) {
    if (Array.isArray(value))
      value.forEach((item, index) =>
        collectDegradationMarkers(item, found, `${prefix}[${index}]`),
      );
    return;
  }
  for (const [key, child] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (DEGRADATION_KEYS.includes(key) && child !== undefined)
      found.set(path, stableValue(child));
    collectDegradationMarkers(child, found, path);
  }
}

function degradationMarkers(observation: LangfuseObservation): Map<string, string> {
  const found = new Map<string, string>();
  collectDegradationMarkers(metadataOf(observation), found);
  collectDegradationMarkers(observation.output, found, "output");
  return found;
}

function hasIncompleteMarker(value: unknown): boolean {
  const object = objectValue(value);
  if (!object) {
    return Array.isArray(value) && value.some(hasIncompleteMarker);
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "evidence_complete" && child === false) return true;
    if (
      (key === "evidence_truncated" || key === "payload_evidence_truncated") &&
      child === true
    )
      return true;
    if (hasIncompleteMarker(child)) return true;
  }
  return false;
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
    if (candidate.filtered_by !== undefined)
      filtered.set(key, stableValue(candidate.filtered_by));
    const numeric = new Map<string, number>();
    for (const [field, value] of Object.entries(candidate)) {
      if (
        typeof value === "number" &&
        /score|distance|similarity|usefulness/i.test(field)
      )
        numeric.set(field, value);
    }
    if (numeric.size > 0) scores.set(key, numeric);
  });
  const evidenceIncomplete =
    hasIncompleteMarker(observation.output) ||
    hasIncompleteMarker(observation.metadata);
  return {
    durationMs: observationDuration(observation),
    evidenceIncomplete,
    candidates,
    chosen,
    filtered,
    scores,
    counts: collectCounts(observation.output),
    degradation: degradationMarkers(observation),
  };
}

export function stagesOf(trace: LangfuseTrace): Map<string, StageEvidence[]> {
  const stages = new Map<string, StageEvidence[]>();
  for (const observation of [...(trace.observations ?? [])].sort(compareObservations)) {
    const name = observation.name ?? "unnamed";
    const group = stages.get(name) ?? [];
    group.push(stageEvidence(observation));
    stages.set(name, group);
  }
  return stages;
}
