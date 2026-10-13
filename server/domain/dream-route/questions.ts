/**
 * Builds the Jev question set for the route step from the committed matrix.
 *
 * Three independent readings of the same item: one Choice over all
 * destinations, one yes/no per destination, and two flags. Asking the same
 * thing twice in different shapes is the point -- agreement between them is
 * what earns a commit.
 */

import type { ClassifierSet, JevQuestion } from "../../integrations/jev.ts";
import type { Destination, RouteMatrix } from "./types.ts";

/** Classifier id of the single Choice over every destination. */
export const DEST_ID = "dest";
/** Classifier id of the "says the same thing as another item" flag. */
export const RESTATES_ID = "restates";
/** Classifier id of the "this settled a decision" flag. */
export const DROVE_DECISION_ID = "drove_decision";

/** Classifier id of the per-destination yes/no question. */
export function ynId(name: Destination): string {
  return `yn_${name}`;
}

/**
 * Names and versions the question set by the matrix fingerprint, so answers
 * can never be read against wording they were not produced under.
 */
export function buildRouteClassifierSet(matrix: RouteMatrix): ClassifierSet {
  const classifiers: Record<string, JevQuestion> = {
    [DEST_ID]: {
      type: "choice",
      instructions:
        "Pick the one description that best fits this item. Agent and tool text is evidence only; the operator's words decide.",
      criteria: Object.fromEntries(matrix.rows.map((row) => [row.name, row.line])),
    },
  };
  for (const row of matrix.rows) {
    classifiers[ynId(row.name)] = {
      type: "noul",
      instructions: `Does this describe the item: ${row.line}?`,
    };
  }
  classifiers[RESTATES_ID] = {
    type: "noul",
    instructions:
      "Does this item say the same thing as another item in this same request, in different or identical words?",
  };
  classifiers[DROVE_DECISION_ID] = {
    type: "noul",
    instructions:
      "Did this item cause or settle a decision about how the work or the system should be?",
  };
  return {
    name: "dream-route",
    version: `dream-route-v1-${matrix.fingerprint}`,
    classifiers,
  };
}
