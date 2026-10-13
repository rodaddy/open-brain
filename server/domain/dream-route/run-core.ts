/**
 * The pure core of a DREAM route run: no database, no network.
 *
 * Everything here is a function of its arguments. A cohort row becomes a
 * `RouteCandidate`, a candidate becomes a Jev record, records become batches,
 * batches become cost projections and parallel sub-plans, and a `RouteDecision`
 * becomes a statement of what an apply step WOULD do. The apply step itself,
 * the cohort read, and the table writes belong to the script that wraps this.
 *
 * Keeping them apart is what lets the whole pipe be proven for free: with
 * `fakeJevFetch` the route runs end to end with no paid call and no Postgres.
 */

import {
  type ClassifierSet,
  type JevAnswer,
  type JevBatch,
  type JevBatchPlan,
  type JevClassifierRecord,
  type JevFetch,
  type JevQuestion,
  type JevResponse,
  type JevStructuredText,
} from "../../integrations/jev.ts";
import type {
  CandidateSnapshot,
  FrozenRow,
  RouteCandidate,
  RouteDecision,
  RouteMatrix,
} from "./types.ts";

/**
 * Characters per token. Taken from the Development skill router
 * (`_DOCS/python-exemplar/src/exemplar/apps/skillrouter/request.py:105`). An
 * estimate until a paid run reports real usage.
 */
export const CHARS_PER_TOKEN = 3.6;

/**
 * US dollars per million input tokens. Taken from the Development skill router
 * (`_DOCS/python-exemplar/src/exemplar/apps/skillrouter/evaluate.py:55`). An
 * estimate until a paid run reports real usage.
 */
export const USD_PER_MILLION_INPUT_TOKENS = 0.042;

const CANDIDATE_TYPES = new Set(["decision", "correction", "fact", "preference"]);
const UNIT_KINDS = new Set(["exchange", "fragment"]);
const ANCHOR_KINDS = new Set(["typed", "askuserquestion", "orphan"]);

function bad(id: string, field: string, value: unknown): never {
  throw new Error(
    `candidate ${id}: ${field} is missing or outside the contract: ${JSON.stringify(value)}`,
  );
}

function checkText(id: string, field: string, value: unknown): void {
  if (typeof value !== "string" || value === "") bad(id, field, value);
}

function checkUnions(id: string, snapshot: CandidateSnapshot): void {
  if (!CANDIDATE_TYPES.has(snapshot.candidate_type)) {
    bad(id, "candidate_type", snapshot.candidate_type);
  }
  if (!UNIT_KINDS.has(snapshot.unit_kind)) bad(id, "unit_kind", snapshot.unit_kind);
  if (snapshot.anchor_kind !== null && !ANCHOR_KINDS.has(snapshot.anchor_kind)) {
    bad(id, "anchor_kind", snapshot.anchor_kind);
  }
  if (snapshot.operator_text !== null && typeof snapshot.operator_text !== "string") {
    bad(id, "operator_text", snapshot.operator_text);
  }
}

/**
 * Reads a cohort row's frozen snapshot into the route contract's candidate.
 *
 * The snapshot's strings are unconstrained by its own type, so every union is
 * checked here rather than cast: a route run must never read a value the
 * contract does not name.
 *
 * @param row - One frozen cohort row.
 * @returns The candidate the route step reads.
 * @throws {Error} Naming the candidate id and the offending field.
 */
export function candidateOf(row: FrozenRow): RouteCandidate {
  const snapshot = row.snapshot;
  const id = snapshot.id;
  checkText(row.candidateId, "id", id);
  checkText(id, "namespace", snapshot.namespace);
  checkText(id, "content", snapshot.content);
  checkUnions(id, snapshot);
  return {
    id,
    namespace: snapshot.namespace,
    candidateType: snapshot.candidate_type as RouteCandidate["candidateType"],
    content: snapshot.content,
    operatorText: snapshot.operator_text,
    unitKind: snapshot.unit_kind as RouteCandidate["unitKind"],
    anchorKind: snapshot.anchor_kind as RouteCandidate["anchorKind"],
  };
}

/**
 * Renders a candidate as the record Jev is shown.
 *
 * The operator's own words lead when there are any, because the matrix says
 * the operator's words decide and the distilled content is a paraphrase.
 * The whole text goes in: the batch planner, not this, owns request sizing.
 *
 * @param candidate - The candidate to render.
 * @returns A record keyed by the candidate id.
 */
export function recordOf(candidate: RouteCandidate): JevClassifierRecord {
  const operator = candidate.operatorText;
  const content =
    operator !== null && operator.trim() !== ""
      ? `OPERATOR SAID: ${operator}\nITEM: ${candidate.content}`
      : `ITEM: ${candidate.content}`;
  return { key: candidate.id, content };
}

/**
 * Renders a candidate as a V2 Jev record carrying named state fields
 * (`_plans/1469-jev-matrix.md` section 4, `concepts_state.md:29`), so a
 * question can refer to `operator_said` or `said_by` by name instead of
 * parsing a prefixed blob. `recordOf` stays the V1 renderer.
 *
 * @param candidate - The candidate to render.
 * @returns A record keyed by the candidate id with named fields.
 */
export function recordOfV2(candidate: RouteCandidate): JevClassifierRecord {
  return {
    key: candidate.id,
    content: candidate.content,
    fields: {
      operator_said: candidate.operatorText,
      distilled_item: candidate.content,
      said_by:
        candidate.operatorText === null || candidate.operatorText.trim() === ""
          ? "not recorded"
          : "the operator",
      unit_kind: candidate.unitKind,
      anchor_kind: candidate.anchorKind,
    },
  };
}

/**
 * Reorders cohort rows so a neighbour sits directly after the row it came from.
 *
 * "Does this say the same thing as another item in this request" can only be
 * answered when the pair lands in the same batch, and the planner batches by
 * adjacency, so adjacency is how the pair is kept together. Rows whose
 * `neighbourOf` target is absent from the cohort are not neighbours of anything
 * here and keep their place. Deterministic: siblings follow their parent in
 * candidate id order.
 *
 * @param rows - The cohort rows, in ordinal order.
 * @returns The same rows, each exactly once, reordered.
 */
export function orderForBatches(rows: readonly FrozenRow[]): FrozenRow[] {
  const present = new Set(rows.map((row) => row.candidateId));
  const children = new Map<string, FrozenRow[]>();
  const roots: FrozenRow[] = [];
  for (const row of rows) {
    const parent = row.neighbourOf;
    if (parent !== null && parent !== row.candidateId && present.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(row);
      children.set(parent, siblings);
    } else {
      roots.push(row);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  }
  const ordered: FrozenRow[] = [];
  const emitted = new Set<string>();
  const emit = (row: FrozenRow): void => {
    if (emitted.has(row.candidateId)) return;
    emitted.add(row.candidateId);
    ordered.push(row);
    for (const child of children.get(row.candidateId) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  for (const row of rows) emit(row);
  return ordered;
}

/** What a plan is expected to cost, before anything is sent. */
export interface RouteCostProjection {
  readonly requests: number;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly estimatedUsd: number;
}

/**
 * Projects what a plan would cost to run.
 *
 * Bytes are the planner's own per-batch request estimate, so this never
 * re-serializes anything. Tokens and dollars are estimates from the two
 * exported constants and are not a quote.
 *
 * @param plan - The batch plan to price.
 * @returns Requests, bytes, and the token and dollar estimates.
 */
export function projectCost(plan: JevBatchPlan): RouteCostProjection {
  const bytes = plan.batches.reduce(
    (sum, batch) => sum + batch.estimatedRequestBytes,
    0,
  );
  const estimatedTokens = Math.ceil(bytes / CHARS_PER_TOKEN);
  return {
    requests: plan.batches.length,
    bytes,
    estimatedTokens,
    estimatedUsd: (estimatedTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS,
  };
}

/**
 * Splits a plan into sub-plans that can be executed concurrently.
 *
 * Round-robin rather than contiguous chunks, so a plan whose later batches are
 * bigger does not leave one lane running alone. Every batch appears exactly
 * once, no sub-plan is empty, and each carries the same classifier set.
 *
 * @param plan - The plan to split.
 * @param inFlight - The most sub-plans wanted, at least 1.
 * @returns Between 1 and `inFlight` non-empty plans.
 * @throws {Error} When `inFlight` is below 1.
 */
export function splitPlan(plan: JevBatchPlan, inFlight: number): JevBatchPlan[] {
  if (!Number.isInteger(inFlight) || inFlight < 1) {
    throw new Error(`inFlight must be an integer of at least 1, got ${inFlight}`);
  }
  const lanes = Math.min(inFlight, plan.batches.length);
  const buckets: JevBatch[][] = Array.from({ length: lanes }, () => []);
  plan.batches.forEach((batch, index) => {
    (buckets[index % lanes] as JevBatch[]).push(batch);
  });
  return buckets.map((batches) => ({ classifierSet: plan.classifierSet, batches }));
}

/** What the apply step would do with one decision, and why. */
export interface WouldApply {
  readonly action: "thought" | "rule_event" | "reinforce" | "none";
  readonly reason: string;
}

/**
 * Says what the apply step WOULD do with a decision, without doing it.
 *
 * This is the whole commit policy in one readable place: only agreement `high`
 * can commit, `steering` never commits, a restatement reinforces what is
 * already there rather than writing a second memory, and a rule earns the
 * always-known `rule_event` only when the operator's own words carry it.
 *
 * @param decision - The decision made from the answers.
 * @param row - The cohort row it belongs to; unused for the verdict, present so
 *   a caller cannot pair a decision with the wrong row by accident.
 * @param matrix - The matrix the decision was made against.
 * @returns The action and a plain-sentence reason.
 */
export function wouldApply(
  decision: RouteDecision,
  row: FrozenRow,
  matrix: RouteMatrix,
): WouldApply {
  void row;
  if (decision.agreement !== "high") {
    return {
      action: "none",
      reason: `agreement ${decision.agreement}, only high commits.`,
    };
  }
  const destination = matrix.rows.find((entry) => entry.name === decision.destination);
  if (destination === undefined || !destination.commits) {
    return { action: "none", reason: "steering is never committed." };
  }
  if (decision.restates) {
    return { action: "reinforce", reason: "restates another item in its batch." };
  }
  if (destination.name === "rule" && decision.authorityTier === "decided") {
    return {
      action: "rule_event",
      reason: "a rule in the operator's own words becomes always-known.",
    };
  }
  if (destination.name === "rule") {
    return {
      action: "thought",
      reason: "a rule not in the operator's words is searchable, never always-known.",
    };
  }
  return {
    action: "thought",
    reason: `a committed ${destination.name} is written as a searchable thought.`,
  };
}

/** One row's decision and the verdict it earned, before restatements resolve. */
export interface RoutedRow {
  readonly row: FrozenRow;
  readonly decision: RouteDecision;
  readonly wouldApply: WouldApply;
}

/** A verdict after the restatement groups have chosen their survivors. */
export interface ResolvedWouldApply extends WouldApply {
  /** The candidate id this row reinforces, or null when it reinforces nothing. */
  readonly reinforces: string | null;
}

const REINFORCEABLE = new Set(["reinforce", "thought", "rule_event"]);

function groupKeyOf(row: FrozenRow, present: ReadonlySet<string>): string {
  const parent = row.neighbourOf;
  return parent !== null && parent !== row.candidateId && present.has(parent)
    ? parent
    : row.candidateId;
}

/**
 * Every (item, member) pair the restates pass asks about: one per row whose
 * `neighbourOf` names another row present in `rows`, with that row as the
 * member. Same presence rule as the restatement groups. Ordered by item id.
 *
 * @param rows - The cohort rows.
 * @returns The pairs, in item candidate id order.
 */
export function neighbourPairs(
  rows: readonly FrozenRow[],
): { item: FrozenRow; member: FrozenRow }[] {
  const byId = new Map(rows.map((entry) => [entry.candidateId, entry]));
  const present = new Set(byId.keys());
  const pairs: { item: FrozenRow; member: FrozenRow }[] = [];
  for (const item of rows) {
    const key = groupKeyOf(item, present);
    const member = key === item.candidateId ? undefined : byId.get(key);
    if (member !== undefined) pairs.push({ item, member });
  }
  return pairs.sort((a, b) =>
    a.item.candidateId < b.item.candidateId
      ? -1
      : a.item.candidateId > b.item.candidateId
        ? 1
        : 0,
  );
}

function saidAt(row: FrozenRow): number {
  const raw = row.snapshot.first_said_at;
  if (raw === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Picks the survivor of a group: earliest said, ties broken by lowest id.
 *
 * Only members whose verdict would write something can survive, because a
 * `none` member writes nothing and so has nothing for a restatement to point
 * at.
 */
function survivorOf(members: readonly RoutedRow[]): RoutedRow | undefined {
  const eligible = members.filter((member) =>
    REINFORCEABLE.has(member.wouldApply.action),
  );
  let best: RoutedRow | undefined;
  for (const member of eligible) {
    if (best === undefined) {
      best = member;
      continue;
    }
    const delta = saidAt(member.row) - saidAt(best.row);
    if (delta < 0) best = member;
    else if (
      delta === 0 &&
      member.row.candidateId.localeCompare(best.row.candidateId) < 0
    ) {
      best = member;
    }
  }
  return best;
}

/**
 * Resolves restatements within each group to one survivor and its reinforcers.
 *
 * A group is a drawn row plus every row whose `neighbourOf` names it. Oldest
 * wins: the earliest-said eligible member is the one kept, and it is re-read
 * WITHOUT the restates flag so the survivor is written as what it really is
 * rather than as a reinforcement of itself. Every other `reinforce` member
 * points at the survivor.
 *
 * A lone `reinforce` row -- no group around it -- has nothing in this cohort to
 * reinforce, so it likewise falls back to its non-restating action. This is the
 * oldest-wins rule of
 * `docs/decisions/candidate-dedupe-merge-is-reversible-not-suppression.md:59-62`.
 *
 * @param routed - Every row's decision and first-pass verdict.
 * @param recompute - `wouldApply` with `restates` forced false.
 * @returns One resolved verdict per candidate id.
 */
export function resolveRestatementGroups(
  routed: readonly RoutedRow[],
  recompute: (entry: RoutedRow) => WouldApply,
): Map<string, ResolvedWouldApply> {
  const present = new Set(routed.map((entry) => entry.row.candidateId));
  const groups = new Map<string, RoutedRow[]>();
  for (const entry of routed) {
    const key = groupKeyOf(entry.row, present);
    const members = groups.get(key) ?? [];
    members.push(entry);
    groups.set(key, members);
  }
  const resolved = new Map<string, ResolvedWouldApply>();
  for (const [, members] of groups) {
    const survivor = members.length > 1 ? survivorOf(members) : undefined;
    for (const member of members) {
      const id = member.row.candidateId;
      if (member.wouldApply.action !== "reinforce") {
        resolved.set(id, { ...member.wouldApply, reinforces: null });
        continue;
      }
      if (survivor !== undefined && survivor.row.candidateId !== id) {
        resolved.set(id, {
          ...member.wouldApply,
          reinforces: survivor.row.candidateId,
        });
        continue;
      }
      const fallback = recompute(member);
      const tail =
        survivor !== undefined
          ? " It is the earliest-said member of its group, so it is the one kept."
          : " Nothing else in the cohort says it, so it is kept.";
      resolved.set(id, {
        action: fallback.action,
        reason: `${fallback.reason}${tail}`,
        reinforces: null,
      });
    }
  }
  return resolved;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

function textOf(value: string | JevStructuredText): string {
  if (typeof value === "string") return value;
  return Object.values(value)
    .flatMap((part) => (typeof part === "string" ? [part] : [...part]))
    .join(" ");
}

function recordTextFor(state: Record<string, unknown>, question: JevQuestion): string {
  const records = (state.records ?? []) as readonly JevClassifierRecord[];
  const judgeOnly =
    typeof question.instructions === "string"
      ? question.instructions
      : (question.instructions.judge_only ?? "");
  const source = typeof judgeOnly === "string" ? judgeOnly : judgeOnly.join(" ");
  const named = /record key (\S+) at records\[(\d+)\]/.exec(source);
  if (named === null) return "";
  const record =
    records.find((entry) => entry.key === named[1]) ?? records[Number(named[2])];
  if (record === undefined) return "";
  const fieldValues = Object.values(record.fields ?? {}).filter(
    (value): value is string => value !== null,
  );
  return [record.content, ...fieldValues].join(" ");
}

function fakeChoice(
  question: Extract<JevQuestion, { type: "choice" }>,
  text: string,
): JevAnswer {
  const recordWords = new Set(words(text));
  const keys = Object.keys(question.criteria);
  let best = keys[0] as string;
  let bestScore = -1;
  for (const key of keys) {
    const description = textOf(question.criteria[key] ?? "");
    const score = words(description).filter((word) => recordWords.has(word)).length;
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  const rest = keys.length > 1 ? (1 - 0.9) / (keys.length - 1) : 0;
  const probabilities = Object.fromEntries(
    keys.map((key) => [key, key === best ? 0.9 : rest]),
  );
  return { type: "choice", choice: best, probabilities, confidence: 0.9 };
}

function fakeNoul(
  question: Extract<JevQuestion, { type: "noul" }>,
  text: string,
): JevAnswer {
  const long = (word: string): boolean => word.length >= 4;
  const recordWords = new Set(words(text).filter(long));
  const shared = new Set(
    words(textOf(question.instructions)).filter(
      (word) => long(word) && recordWords.has(word),
    ),
  );
  return { type: "noul", noul: shared.size >= 3 ? 0.9 : 0.1 };
}

/**
 * A free local stand-in for the Jev endpoint, so the whole pipe can be proven
 * with no paid call and no network.
 *
 * It judges nothing. Answers are produced by counting shared words, which is
 * not a reading of the item and must never be read as one; its only contract is
 * that every answer is schema-valid and passes the batch validator, so the
 * plumbing around it -- batching, splitting, merging, deciding -- is exercised
 * for real.
 *
 * @returns A `fetch`-shaped function that answers a Jev request locally.
 */
export function fakeJevFetch(): JevFetch {
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const request = JSON.parse(bodyText) as {
      state: Record<string, unknown>;
      questions: Record<string, JevQuestion>;
    };
    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const text = recordTextFor(request.state, question);
      if (question.type === "choice") answers[id] = fakeChoice(question, text);
      else if (question.type === "noul") answers[id] = fakeNoul(question, text);
      else throw new Error(`fakeJevFetch does not answer ${question.type} questions`);
    }
    const body: JevResponse = {
      model: "local-fake",
      answers,
      usage: {
        input_tokens: Math.ceil(
          new TextEncoder().encode(bodyText).byteLength / CHARS_PER_TOKEN,
        ),
        output_tokens: 0,
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * The middle value, or the mean of the two middle values.
 *
 * @param values - Any numbers, in any order.
 * @returns The median, or 0 when there are none.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Counts items by a key, in key order.
 *
 * @param items - The items to count.
 * @param key - The name each item counts under.
 * @returns The counts, sorted by key.
 */
export function tally<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = key(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/** Everything a finished run has to say for itself. */
export interface RunSummary {
  readonly runId: string;
  readonly byDestinationAgreement: Map<string, number>;
  readonly byAction: Map<string, number>;
  readonly noSignal: number;
  readonly recordsPerRequest: { min: number; median: number; max: number };
  readonly inputTokens: number;
  readonly estimatedUsd: number;
  readonly actualUsd: number;
  readonly ms: number;
}

/**
 * Renders a finished run as the operator-facing report.
 *
 * @param summary - The finished run's numbers.
 * @returns The report lines, ending with the run id.
 */
export function formatRunReport(summary: RunSummary): string[] {
  const perRequest = summary.recordsPerRequest;
  return [
    ...[...summary.byDestinationAgreement].map(
      ([key, count]) => `destination x agreement ${key} : ${count}`,
    ),
    ...[...summary.byAction].map(([action, count]) => `action ${action} : ${count}`),
    `no signal     : ${summary.noSignal}`,
    `records/request: min ${perRequest.min}, median ${perRequest.median}, max ${perRequest.max}`,
    `input tokens  : ${summary.inputTokens}`,
    `estimated usd : ${summary.estimatedUsd.toFixed(6)}`,
    `actual usd    : ${summary.actualUsd.toFixed(6)}`,
    `wall clock ms : ${summary.ms}`,
    `run_id        : ${summary.runId}`,
  ];
}

/** A classifier set is only ever built from the matrix; re-exported for callers. */
export type { ClassifierSet };
