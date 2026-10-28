/**
 * DREAM route pairwise restates pass: one Noul per candidate pair, asking
 * whether an item says the same lasting thing as the neighbour it was drawn
 * beside. The pair member rides in the structured `instructions`; the item is
 * the judged record in state; pairs come only from neighbour groups.
 *
 * Design sources: `_plans/1469-jev-matrix.md:272` and `:419` (section 4 step
 * 7), and the `same_as_record_N` pairwise Noul shape in
 * the TypeSafe docs, primitives: noul.
 *
 * Proven only against the fake backend (`run-core.ts` `fakeJevFetch`), which
 * counts shared words and judges nothing: its tests prove plumbing, not the
 * quality of the question.
 */

import {
  buildJevBatchPlan,
  executeJevBatchPlan,
  type ClassifierSet,
  type JevConfig,
  type JevFetch,
  type JevQuestion,
} from "../../integrations/jev.ts";
import { RESTATES_PAIR_ID } from "./decide-v2.ts";
import { recordOfV2 } from "./run-core.ts";
import type { RouteCandidate } from "./types.ts";

/**
 * The pairwise Noul for one pair member.
 *
 * @param member - The candidate the judged item might restate.
 * @returns A Noul question carrying the member in its instructions.
 */
export function restatesPairQuestion(member: RouteCandidate): JevQuestion {
  return {
    type: "noul",
    instructions: {
      potential_restatement_operator_said: member.operatorText ?? "not recorded",
      potential_restatement_item: member.content,
      question:
        "Does the operator's item in `records[0].fields` say the same lasting thing as `potential_restatement_operator_said` and `potential_restatement_item`, so that keeping both would store one memory twice?",
      focus:
        "Same substance in other words counts. A related item on the same topic that adds, narrows, or changes a rule, decision, or fact does not.",
    },
    criteria: {
      true: "Both say the same rule, decision, fact, or correction; one adds nothing the other lacks.",
      false:
        "They differ in what they would make someone do or believe, or one adds a detail the other lacks.",
    },
  };
}

/**
 * The one-question classifier set for a pair member.
 *
 * @param member - The pair member.
 * @returns The classifier set holding the pairwise Noul.
 */
export function restatesPairClassifierSet(member: RouteCandidate): ClassifierSet {
  return {
    name: "dream-route-restates-pair",
    version: "1",
    classifiers: { [RESTATES_PAIR_ID]: restatesPairQuestion(member) },
  };
}

/**
 * Asks the pairwise Noul once per pair, one pair at a time.
 *
 * @param args - The pairs, the Jev config, and an optional fetch.
 * @returns Item candidate id to the highest score over that item's pairs; a
 *   pair with a missing or non-Noul answer is not scored.
 */
export async function runRestatesPass(args: {
  pairs: readonly { item: RouteCandidate; member: RouteCandidate }[];
  config: JevConfig;
  fetchFn?: JevFetch;
}): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  for (const { item, member } of args.pairs) {
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [recordOfV2(item)],
      classifierSet: restatesPairClassifierSet(member),
      limits: args.config,
    });
    const { answers } = await executeJevBatchPlan(args.config, plan, args.fetchFn);
    const answer = answers.get(item.id)?.[RESTATES_PAIR_ID];
    if (answer?.type !== "noul") continue;
    scores.set(item.id, Math.max(scores.get(item.id) ?? 0, answer.noul));
  }
  return scores;
}
