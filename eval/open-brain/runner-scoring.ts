import type { EvalProbe } from "./types.ts";

// Failure/uncertainty collectors for a single scored probe.
//
// Split out of runner.ts (issue 752) so `scoreProbe` stays under the repo
// complexity rule value. Every check below is a verbatim lift out of the
// original function body -- same predicate, same message text, same order --
// so the failure list a probe produces is byte-identical and no verdict or
// score moves. `scoreProbe` is now composition over these plus its existing
// retrieval/metric helpers.
//
// These take already-computed values rather than re-deriving anything: staleness
// and contradiction detection stay in runner.ts next to the retrieval logic they
// belong to, and their boolean results are passed in.
//
// These are internal helpers of the runner module. runner.ts does NOT re-export
// them, so no import specifier anywhere in the repo moves.

/** The retrieval facts a probe's checks are evaluated against. */
export interface ProbeObservation {
  retrievedIds: string[];
  citationIds: string[];
  answer: string;
  recall: number;
  precision: number;
  latencyMs: number;
}

/**
 * Threshold failures: recall and precision below their declared minimums.
 * Defaults match the originals -- recall defaults to 1, precision to 0.
 */
export function collectMetricFailures(
  probe: EvalProbe,
  observed: Pick<ProbeObservation, "recall" | "precision">,
): string[] {
  const failures: string[] = [];
  if (observed.recall < (probe.min_recall_at_k ?? 1)) {
    failures.push(`recall ${observed.recall.toFixed(3)} below threshold`);
  }
  if (observed.precision < (probe.min_precision_at_k ?? 0)) {
    failures.push(`precision ${observed.precision.toFixed(3)} below threshold`);
  }
  return failures;
}

/**
 * Retrieval-hygiene failures: forbidden namespace evidence, a probe that
 * expected nothing but got something, and declared junk that surfaced anyway.
 */
export function collectRetrievalFailures(
  probe: EvalProbe,
  retrievedIds: string[],
): string[] {
  const failures: string[] = [];
  const forbiddenIds = probe.expected_forbidden_ids ?? [];
  if (forbiddenIds.some((id) => retrievedIds.includes(id))) {
    failures.push("retrieved forbidden namespace evidence");
  }
  if (probe.expect_no_results && retrievedIds.length > 0) {
    failures.push("expected no retrievable evidence");
  }
  for (const junkId of probe.junk_ids ?? []) {
    if (retrievedIds.includes(junkId)) {
      failures.push(`retrieved declared junk ${junkId}`);
    }
  }
  return failures;
}

/**
 * Citation failures: expected citations and required source refs that never
 * appeared among the retrieved entries' source refs.
 */
export function collectCitationFailures(
  probe: EvalProbe,
  citationIds: string[],
): string[] {
  const failures: string[] = [];
  for (const expectedCitation of probe.expected_citation_ids ?? []) {
    if (!citationIds.includes(expectedCitation)) {
      failures.push(`missing expected citation ${expectedCitation}`);
    }
  }
  for (const expectedSourceRef of probe.required_source_ref_ids ?? []) {
    if (!citationIds.includes(expectedSourceRef)) {
      failures.push(`missing required source ref ${expectedSourceRef}`);
    }
  }
  return failures;
}

/** Answer failures: expected terms absent from the composed answer text. */
export function collectAnswerFailures(probe: EvalProbe, answer: string): string[] {
  const failures: string[] = [];
  for (const expectedTerm of probe.expected_answer_terms ?? []) {
    if (!answer.toLowerCase().includes(expectedTerm.toLowerCase())) {
      failures.push(`missing expected answer term ${expectedTerm}`);
    }
  }
  return failures;
}

/**
 * The uncertainty signals a probe surfaced, in the original order: staleness
 * first, then contradiction. Detection itself stays in runner.ts; this composes
 * the already-computed booleans into the reported list.
 */
export function collectUncertainty(opts: {
  stale: boolean;
  contradiction: boolean;
}): string[] {
  const uncertainty: string[] = [];
  if (opts.stale) uncertainty.push("stale");
  if (opts.contradiction) uncertainty.push("contradiction");
  return uncertainty;
}

/** Expected uncertainty signals the probe did NOT surface. */
export function collectUncertaintyFailures(
  probe: EvalProbe,
  uncertainty: string[],
): string[] {
  const failures: string[] = [];
  for (const expected of probe.expected_uncertainty ?? []) {
    if (!uncertainty.includes(expected)) {
      failures.push(`missing expected uncertainty ${expected}`);
    }
  }
  return failures;
}

/** Latency failure, checked only when the probe declares a maximum. */
export function collectLatencyFailures(probe: EvalProbe, latencyMs: number): string[] {
  if (probe.max_latency_ms && latencyMs > probe.max_latency_ms) {
    return [`latency ${latencyMs.toFixed(3)}ms above threshold`];
  }
  return [];
}
