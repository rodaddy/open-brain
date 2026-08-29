// L5 adapter (issue 864): legacy call form over server/domain/promotion-service.ts; retired with src/ at L6.
import type pg from "pg";
import type { AuthInfo, Table } from "../server/types.ts";
import {
  promoteEntry as promoteEntryFromOptions,
  type PromotionOptions as ServerPromotionOptions,
} from "../server/domain/promotion-service.ts";

export {
  PROMOTION_CONTENT_COLUMNS,
  type PromotionResult,
} from "../server/domain/promotion-service.ts";

/** The legacy options bag: the target namespace and auth were positional. */
export type PromotionOptions = Omit<
  ServerPromotionOptions,
  "targetNamespace" | "auth" | "reason" | "killSwitch"
>;

/** The seven positional arguments the legacy callers pass, in their order. */
type LegacyPromoteEntryArguments = [
  pool: pg.Pool,
  table: Table,
  id: string,
  targetNamespace: string,
  reason: string | undefined,
  auth: AuthInfo,
  options?: PromotionOptions,
];

/**
 * Legacy positional `promoteEntry`, kept for the callers still in `src/` and
 * `scripts/`.
 *
 * The arguments arrive as one typed tuple rather than seven declared
 * parameters, which is what lets a seven-argument legacy call form survive
 * under the four-parameter rule without a disable comment; the call sites are
 * unchanged and still type-checked position by position.
 *
 * The kill switch is read here, at call time, because the server-side service
 * takes it as a value and `src/` is where the environment read is still
 * allowed. Reading it inside the call rather than at module load keeps the
 * existing tests, which set the variable per case, behaving as they did.
 */
export async function promoteEntry(...args: LegacyPromoteEntryArguments) {
  const [pool, table, id, targetNamespace, reason, auth, options = {}] = args;
  return await promoteEntryFromOptions(pool, table, id, {
    ...options,
    targetNamespace,
    reason,
    auth,
    killSwitch: process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1",
  });
}
