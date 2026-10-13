/**
 * Builds the V2 Jev question set for the route step: a two-level question set
 * per plan section 4 (`cookbooks_hierarchical_classification.md:12-15`), asked
 * over one record per request.
 *
 * Delta from plan step 2: the five yn_* Nouls and the in-request restates flag
 * are gone (`model-jaggedness_jev-1.13.md:137`). `none` is a synthetic sixth
 * Choice option, NOT a matrix row: a matrix byte change moves the fingerprint
 * (`matrix.ts:78`) and orphans the labelled cases keyed on it
 * (`scripts/dream-route-case-store.ts:279`).
 */

import type {
  ClassifierSet,
  JevQuestion,
  JevStructuredText,
} from "../../integrations/jev.ts";
import { DEST_V2_ID, LASTING_ID, NONE_OPTION } from "./decide-v2.ts";
import { DROVE_DECISION_ID } from "./questions.ts";
import type { Destination, RouteMatrix } from "./types.ts";

/** State path of the single record, as emitted by `recordOfV2`. */
const RECORD = "records[0].fields";

/** Backticked state path of one record field (`SKILL.md:109-110`). */
function path(field: string): string {
  return `\`${RECORD}.${field}\``;
}

const NOT_FOR: Readonly<Record<Destination, string>> = {
  rule: "A one-off instruction for the task in hand; that is `none`. A single choice already made; that is `decision`.",
  decision:
    "A rule for all future work; that is `rule`. A bare go-ahead such as 'go' or 'ok' that picks nothing; that is `none`.",
  fact: "A transient status such as what is currently running or failing; that is `none`.",
  correction: "Stating a preference without correcting anything; that is `rule`.",
  steering: "A standing rule about how work is always done; that is `rule`.",
};

const EXAMPLES: Readonly<Record<Destination, readonly string[]>> = {
  rule: ["always branch before you edit", "I never want auto-merge on"],
  decision: [
    "we are going with Forge, not GitHub",
    "yes, merge it that way",
    "yeah, that size works, keep it",
    "your call was right, leave it loose",
  ],
  fact: [
    "the service runs two workers behind that port",
    "the index config lives outside the tree",
  ],
  correction: ["no, that is not what I said", "you put it in the wrong repo"],
  steering: ["do the second one first", "stop there"],
};

const NONE_CRITERIA: JevStructuredText = {
  what: "None of the above. A bare go-ahead or acknowledgement that picks nothing, a passing question, a progress report, or a fragment with nothing lasting in it.",
  not_for:
    "Agreement that settles a choice, even when casual ('yeah, that works', 'your call was right', 'that is a real issue'); that is `decision`. Anything else that would still matter after this conversation ends.",
  examples: ["go", "ok thanks", "are those the new issues from today"],
};

/**
 * Names and versions the V2 set by the matrix fingerprint, so answers can
 * never be read against wording they were not produced under.
 */
export function buildRouteClassifierSetV2(matrix: RouteMatrix): ClassifierSet {
  const classifiers: Record<string, JevQuestion> = {
    [LASTING_ID]: {
      type: "noul",
      instructions: {
        question: `Does ${path("operator_said")} contain something worth remembering after this conversation ends?`,
        focus: `Judge ${path("operator_said")} only; when it is null judge ${path("distilled_item")} instead. ${path("distilled_item")} is a paraphrase and is evidence, not the subject.`,
      },
      criteria: {
        true: "It states a rule, a decision, a lasting fact, or a correction that would still matter weeks from now. Casual agreement that settles a choice counts as a decision.",
        false:
          "It is a bare go-ahead or acknowledgement that picks nothing, a passing question, a progress report, or a fragment that only made sense in the moment.",
      },
    },
    [DEST_V2_ID]: {
      type: "choice",
      instructions: {
        question: `Which one of these best describes what ${path("operator_said")} is?`,
        focus: `The operator's own words in ${path("operator_said")} decide; when it is null judge ${path("distilled_item")}. Agent and tool text is evidence only.`,
        rule: "Pick `none` when nothing here would still matter after this conversation ends.",
      },
      criteria: {
        ...Object.fromEntries(
          matrix.rows.map((row) => [
            row.name,
            {
              what: row.line,
              not_for: NOT_FOR[row.name],
              examples: EXAMPLES[row.name],
            },
          ]),
        ),
        [NONE_OPTION]: NONE_CRITERIA,
      },
    },
    [DROVE_DECISION_ID]: {
      type: "noul",
      instructions: {
        question: `Did ${path("operator_said")} cause or settle a decision about how the work or the system should be?`,
        focus: "Settling something counts even if the words are short.",
      },
      criteria: {
        true: "After this, the question it addressed is closed.",
        false: "It asks, reports, or acknowledges without settling anything.",
      },
    },
  };
  return {
    name: "dream-route",
    version: `dream-route-v2-${matrix.fingerprint}`,
    classifiers,
  };
}
