/**
 * DREAM route V2: turns one item's Jev answers into a routing decision, in code.
 *
 * One item per request. Four cutoffs decide, each with a distinct job -- the
 * choice must not be `none`, the item must hold anything lasting, the model
 * must be confident, and the winning probability must clear its bar -- and
 * every one of them fails toward no commit, so a wrong model costs a missed
 * commit, never a wrong one.
 *
 * Agreement scoring over three voters is retired per `_plans/1469-jev-matrix.md`
 * section 4 and
 * the TypeSafe docs, model jaggedness: jev-1.13.
 */

import type { JevAnswer } from "../../integrations/jev.ts";
import { authorityTierOf } from "./authority.ts";
import { DROVE_DECISION_ID } from "./questions.ts";
import type {
  Destination,
  RouteCandidate,
  RouteDecision,
  RouteMatrix,
} from "./types.ts";

export const LASTING_ID = "anything_lasting";
export const DEST_V2_ID = "destination";
export const NONE_OPTION = "none";

/** The Noul answer key the pairwise restates pass writes (issue 1519). */
export const RESTATES_PAIR_ID = "restates_pair";

/**
 * `restates_pair` counts at or above this. A guess, unmeasured: it is NOT
 * covered by `DEFAULT_THRESHOLDS_V2.measuredIn`, and is to be set from the
 * labelled pair set of issue 1519.
 */
export const RESTATES_AT_V2 = 0.7;

/** Every V2 cutoff in one place. All guesses until a run record sets them. */
export interface RouteThresholdsV2 {
  /** "anything lasting" counts at or above this. */
  readonly lastingAt: number;
  /** The Choice's confidence must be at least this to commit. */
  readonly confidenceAt: number;
  /** The Choice's winning probability must be at least this to commit. */
  readonly pickAt: number;
  /** "this drove a decision" counts at or above this. */
  readonly droveDecisionAt: number;
  /** The run record that measured these, or "" while they are guesses. */
  readonly measuredIn: string;
}

/**
 * Measured on the 2026-09-25 paid run after the wording delta (35 labelled
 * cases): golden 26/35, false_commit 0, lost_commit 9 at these cutoffs
 * (defaults before the sweep scored 25/35, false_commit 2). confidenceAt is
 * inert on that data (0.05-0.5 score the same) and stays at 0.5;
 * droveDecisionAt is unmeasured and still a guess. The cutoffs are fitted on
 * the same 35 cases they are scored on.
 */
export const DEFAULT_THRESHOLDS_V2: RouteThresholdsV2 = {
  lastingAt: 0.55,
  confidenceAt: 0.5,
  pickAt: 0.75,
  droveDecisionAt: 0.7,
  measuredIn: "1469-paid-v2/ledger-20260925T141623",
};

function noulAnswer(answers: Record<string, JevAnswer>, id: string): number | null {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

function isDestination(matrix: RouteMatrix, name: string): name is Destination {
  return matrix.rows.some((row) => row.name === name);
}

function flattenAnswers(
  answers: Record<string, JevAnswer>,
): Record<string, number | string> {
  const raw: Record<string, number | string> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") raw[id] = answer.noul;
    else if (answer.type === "choice") {
      raw[id] = answer.choice;
      raw[`${id}.p`] = answer.probabilities[answer.choice] ?? 0;
      raw[`${id}.conf`] = answer.confidence;
    }
  }
  return raw;
}

interface Gate {
  readonly destination: Destination | null;
  readonly reason: string;
}

function gate(
  choice: Extract<JevAnswer, { type: "choice" }>,
  lasting: number,
  matrix: RouteMatrix,
  thresholds: RouteThresholdsV2,
): Gate {
  const pWin = choice.probabilities[choice.choice] ?? 0;
  const conf = choice.confidence;
  const blocked = (reason: string): Gate => ({ destination: null, reason });
  if (choice.choice === NONE_OPTION) {
    return blocked(`the choice picked none at ${pWin}, so nothing is committed.`);
  }
  if (!isDestination(matrix, choice.choice)) {
    return blocked(
      `the choice picked ${choice.choice}, which is not a matrix row, so nothing is committed.`,
    );
  }
  if (lasting < thresholds.lastingAt) {
    return blocked(
      `anything lasting was ${lasting}, below the ${thresholds.lastingAt} cutoff, so nothing is committed.`,
    );
  }
  if (conf < thresholds.confidenceAt) {
    return blocked(
      `confidence was ${conf}, below the ${thresholds.confidenceAt} cutoff, so nothing is committed.`,
    );
  }
  if (pWin < thresholds.pickAt) {
    return blocked(
      `the choice picked ${choice.choice} at ${pWin}, below the ${thresholds.pickAt} cutoff, so nothing is committed.`,
    );
  }
  return {
    destination: choice.choice,
    reason: `the choice picked ${choice.choice} at ${pWin} with confidence ${conf} and anything lasting ${lasting}; every cutoff passed.`,
  };
}

function noSignalDecision(
  candidate: RouteCandidate,
  raw: Record<string, number | string>,
  present: Readonly<Record<string, unknown>>,
): RouteDecision {
  const missing = Object.entries(present)
    .filter(([, value]) => value === null)
    .map(([id]) => id);
  return {
    candidateId: candidate.id,
    destination: null,
    agreement: "none",
    authorityTier: authorityTierOf(candidate),
    restates: false,
    droveDecision: false,
    reasons: [`no signal: ${missing.join(", ")} missing or of the wrong type.`],
    raw,
  };
}

/**
 * Reads the pairwise restates answer. Absent means the pass did not run:
 * restates is false and no reason is added.
 */
function restatesOf(answers: Record<string, JevAnswer>): {
  restates: boolean;
  restatesReason: string | null;
} {
  const pair = noulAnswer(answers, RESTATES_PAIR_ID);
  if (pair === null) return { restates: false, restatesReason: null };
  const restates = pair >= RESTATES_AT_V2;
  return {
    restates,
    restatesReason: `restates pair ${pair} ${restates ? ">=" : "<"} ${RESTATES_AT_V2}.`,
  };
}

/**
 * Never throws on a missing or wrong-typed answer: that is reported as
 * agreement `none` with a reason starting `no signal:`.
 */
export function decideRouteV2(
  candidate: RouteCandidate,
  answers: Record<string, JevAnswer>,
  matrix: RouteMatrix,
  thresholds: RouteThresholdsV2,
): RouteDecision {
  const raw = flattenAnswers(answers);
  const lasting = noulAnswer(answers, LASTING_ID);
  const destAnswer = answers[DEST_V2_ID];
  const choice = destAnswer?.type === "choice" ? destAnswer : null;
  const drove = noulAnswer(answers, DROVE_DECISION_ID);
  if (lasting === null || choice === null || drove === null) {
    return noSignalDecision(candidate, raw, {
      [LASTING_ID]: lasting,
      [DEST_V2_ID]: choice,
      [DROVE_DECISION_ID]: drove,
    });
  }
  const { destination, reason } = gate(choice, lasting, matrix, thresholds);
  const droveDecision = drove >= thresholds.droveDecisionAt;
  const { restates, restatesReason } = restatesOf(answers);
  const reasons = [
    reason,
    `drove decision ${drove} ${droveDecision ? ">=" : "<"} ${thresholds.droveDecisionAt}.`,
  ];
  if (restatesReason !== null) reasons.push(restatesReason);
  return {
    candidateId: candidate.id,
    destination,
    /** V2 has no vote counting; "high" means every cutoff passed, so the apply step's contract is unchanged. */
    agreement: destination === null ? "none" : "high",
    authorityTier: authorityTierOf(candidate),
    /** From the pairwise restates pass (plan section 4 step 7); absent means the pass did not run, so false. */
    restates,
    droveDecision,
    reasons,
    raw,
  };
}
