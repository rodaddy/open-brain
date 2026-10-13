import { z } from "zod";

import { REVIEW_ACTIONS } from "../server/domain/candidate-review/types.ts";

/** Untrusted human label input; trusted provenance is bound by its caller. */
export const remFrozenHumanLabelSchema = z
  .object({
    candidate_id: z.string().uuid(),
    grade: z.enum(REVIEW_ACTIONS),
    note: z.string().optional(),
  })
  .strict();

export type RemFrozenHumanLabel = z.infer<typeof remFrozenHumanLabelSchema>;
