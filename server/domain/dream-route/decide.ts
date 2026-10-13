/**
 * Turns one candidate's Jev answers into a routing decision, in code.
 *
 * Three picks are made independently -- the Choice, the strongest yes/no, and
 * the distiller's own candidate type -- and agreement between them decides.
 * No single answer can commit a memory, so a wrong model costs a missed
 * commit, never a wrong one.
 */

import type { JevAnswer } from "../../integrations/jev.ts";
import { authorityTierOf } from "./authority.ts";
import { DEST_ID, DROVE_DECISION_ID, RESTATES_ID, ynId } from "./questions.ts";
import type {
  Agreement,
  Destination,
  RouteCandidate,
  RouteDecision,
  RouteMatrix,
  RouteThresholds,
} from "./types.ts";

/** Guesses until a run record measures them; `measuredIn` says so. */
export const DEFAULT_THRESHOLDS: RouteThresholds = {
  pickAt: 0.5,
  yesAt: 0.5,
  restatedAt: 0.7,
  droveDecisionAt: 0.7,
  measuredIn: "",
};

const DISTILLER_DESTINATION: Readonly<
  Record<RouteCandidate["candidateType"], Destination>
> = {
  decision: "decision",
  correction: "correction",
  fact: "fact",
  preference: "rule",
};

function noulAnswer(answers: Record<string, JevAnswer>, id: string): number | null {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

function isDestination(matrix: RouteMatrix, name: string): name is Destination {
  return matrix.rows.some((row) => row.name === name);
}

interface Pick {
  readonly destination: Destination | null;
  readonly reason: string;
}

function choicePick(
  answers: Record<string, JevAnswer>,
  matrix: RouteMatrix,
  thresholds: RouteThresholds,
): Pick | null {
  const answer = answers[DEST_ID];
  if (answer?.type !== "choice" || !isDestination(matrix, answer.choice)) return null;
  const probability = answer.probabilities[answer.choice] ?? 0;
  if (probability < thresholds.pickAt) {
    return {
      destination: null,
      reason: `the choice question picked ${answer.choice} at ${probability}, below the ${thresholds.pickAt} cutoff, so it did not vote.`,
    };
  }
  return {
    destination: answer.choice,
    reason: `the choice question picked ${answer.choice} at ${probability} and voted for it.`,
  };
}

function yesNoPick(
  answers: Record<string, JevAnswer>,
  matrix: RouteMatrix,
  thresholds: RouteThresholds,
): Pick | null {
  const scored: { name: Destination; probability: number }[] = [];
  for (const row of matrix.rows) {
    const probability = noulAnswer(answers, ynId(row.name));
    if (probability === null) return null;
    scored.push({ name: row.name, probability });
  }
  const best = Math.max(...scored.map(({ probability }) => probability));
  const leaders = scored.filter(({ probability }) => probability === best);
  if (leaders.length !== 1) {
    return {
      destination: null,
      reason: `the yes/no questions tied at ${best} between ${leaders.map(({ name }) => name).join(", ")}, so they did not vote.`,
    };
  }
  const leader = leaders[0] as { name: Destination; probability: number };
  if (leader.probability < thresholds.yesAt) {
    return {
      destination: null,
      reason: `the strongest yes/no was ${leader.name} at ${leader.probability}, below the ${thresholds.yesAt} cutoff, so it did not vote.`,
    };
  }
  return {
    destination: leader.name,
    reason: `the strongest yes/no was ${leader.name} at ${leader.probability} and voted for it.`,
  };
}

function distillerPick(candidate: RouteCandidate): Pick {
  const destination = DISTILLER_DESTINATION[candidate.candidateType];
  return {
    destination,
    reason: `the distiller called this a ${candidate.candidateType}, which votes for ${destination}.`,
  };
}

function agreementOf(picks: readonly Pick[]): {
  agreement: Agreement;
  destination: Destination | null;
} {
  const votes = picks
    .map(({ destination }) => destination)
    .filter((destination): destination is Destination => destination !== null);
  for (const destination of new Set(votes)) {
    const count = votes.filter((vote) => vote === destination).length;
    if (count === 3) return { agreement: "high", destination };
    if (count === 2) return { agreement: "low", destination };
  }
  return { agreement: "none", destination: null };
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
    }
  }
  return raw;
}

function missingIds(present: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(present)
    .filter(([, value]) => value === null)
    .map(([id]) => id);
}

function noSignalDecision(
  candidate: RouteCandidate,
  raw: Record<string, number | string>,
  missing: readonly string[],
): RouteDecision {
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
 * Never throws on a missing or wrong-typed answer: that is reported as
 * agreement `none` with a reason starting `no signal:`, because a candidate
 * with no signal must stay a candidate rather than be guessed at.
 */
export function decideRoute(
  candidate: RouteCandidate,
  answers: Record<string, JevAnswer>,
  matrix: RouteMatrix,
  thresholds: RouteThresholds,
): RouteDecision {
  const authorityTier = authorityTierOf(candidate);
  const raw = flattenAnswers(answers);
  const choice = choicePick(answers, matrix, thresholds);
  const yesNo = yesNoPick(answers, matrix, thresholds);
  const restatedAt = noulAnswer(answers, RESTATES_ID);
  const droveAt = noulAnswer(answers, DROVE_DECISION_ID);
  const missing = missingIds({
    [DEST_ID]: choice,
    "the per-destination yes/no answers": yesNo,
    [RESTATES_ID]: restatedAt,
    [DROVE_DECISION_ID]: droveAt,
  });
  if (choice === null || yesNo === null || restatedAt === null || droveAt === null) {
    return noSignalDecision(candidate, raw, missing);
  }
  const distiller = distillerPick(candidate);
  const { agreement, destination } = agreementOf([choice, yesNo, distiller]);
  const outcome =
    agreement === "high"
      ? `all three picks named ${destination as Destination}, so agreement is high.`
      : agreement === "low"
        ? `two picks named ${destination as Destination}, so agreement is low.`
        : "no two picks named the same destination, so nothing is committed.";
  return {
    candidateId: candidate.id,
    destination,
    agreement,
    authorityTier,
    restates: restatedAt >= thresholds.restatedAt,
    droveDecision: droveAt >= thresholds.droveDecisionAt,
    reasons: [choice.reason, yesNo.reason, distiller.reason, outcome],
    raw,
  };
}
