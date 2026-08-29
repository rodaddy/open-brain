// L5 adapter (issue 864): legacy call form over server/realtime/working-set.ts; retired with src/ at L6.

import {
  WorkingSetStore as ServerWorkingSetStore,
  type WorkingSetBudget,
} from "../../server/realtime/working-set.ts";

export {
  DEFAULT_WORKING_SET_BUDGET,
  WORKING_SET_ITEM_KINDS,
  WORKING_SET_LABEL,
  WORKING_SET_SCHEMA,
  compareWorkingSetScope,
  normalizeWorkingSetScope,
  workingSetScopeHash,
  workingSetScopeKey,
} from "../../server/realtime/working-set.ts";

export type {
  NormalizedWorkingSetScope,
  WorkingSetAppendResult,
  WorkingSetBudget,
  WorkingSetContextPackFragment,
  WorkingSetContextSection,
  WorkingSetCounters,
  WorkingSetItem,
  WorkingSetItemInput,
  WorkingSetItemKind,
  WorkingSetScope,
  WorkingSetScopeDenial,
} from "../../server/realtime/working-set.ts";

/** Legacy positional-budget constructor over the server options-object form. */
export class WorkingSetStore extends ServerWorkingSetStore {
  constructor(budget: Partial<WorkingSetBudget> = {}) {
    super({ budget });
  }
}
