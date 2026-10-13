/**
 * `promote_reviewed_candidate`: explicitly copy a human-promoted DREAM
 * candidate into the caller-authorized namespace's durable thoughts.
 *
 * Distillation and REM never call this tool. `review_action = 'promoted'` is
 * the required human label, and `dry_run` defaults to true so a caller must
 * opt into the durable write. Candidate facts and decisions use the thoughts
 * table because candidate_memory carries one content field and no structured
 * decision title/rationale; corrections and preferences remain review-only
 * until their promotion shape is settled.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTransaction } from "../db/transaction.ts";
import { createReviewedCandidatePromotionRepository } from "../db/reviewed-candidate-promotion-repository.ts";
import {
  promoteReviewedCandidate,
  ReviewedCandidateNotFoundError,
  UnsupportedReviewedCandidateTypeError,
} from "../domain/reviewed-candidate-promotion.ts";
import { physicalNamespace, canonicalNamespace } from "./shared-namespace.ts";
import { authorize } from "./memory-helpers.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

const reviewedCandidateInputSchema = {
  candidate_id: z.string().uuid().describe("UUID of the candidate_memory proposal"),
  namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Candidate namespace (defaults to the auth-derived clientId)"),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview without writing a durable thought (default true)"),
};

const reviewedCandidateAnnotations = {
  title: "Promote Reviewed Candidate",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

interface ReviewedCandidateArgs {
  readonly candidate_id: string;
  readonly namespace?: string;
  readonly dry_run?: boolean;
}

interface HandlerExtra {
  authInfo?: Parameters<typeof authIdentity>[0];
}

function logFailure(
  dependencies: MemoryToolDependencies,
  namespace: string,
  dryRun: boolean,
  error: unknown,
): void {
  dependencies.logger.error(
    {
      tool: "promote_reviewed_candidate",
      namespace,
      dryRun,
      errorName: error instanceof Error ? error.name : "unknown",
    },
    "reviewed_candidate_promotion_failed",
  );
}

function respondFailure(
  dependencies: MemoryToolDependencies,
  namespace: string,
  dryRun: boolean,
  error: unknown,
): ReturnType<typeof errorResult> {
  if (error instanceof ReviewedCandidateNotFoundError) {
    return errorResult(error.message);
  }
  if (error instanceof UnsupportedReviewedCandidateTypeError) {
    return errorResult(error.message);
  }
  logFailure(dependencies, namespace, dryRun, error);
  return errorResult("Database error during reviewed candidate promotion");
}

async function handleReviewedCandidatePromotion(
  dependencies: MemoryToolDependencies,
  args: ReviewedCandidateArgs,
  extra: HandlerExtra,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const auth = authorize(authIdentity(extra.authInfo), {
    operation: "write",
    table: "thoughts",
    permissionMessage: "cannot promote reviewed candidates",
    requestedNamespace: args.namespace,
  });
  if (!auth.ok) return auth.response;

  const namespace = physicalNamespace(
    auth.namespace,
    dependencies.sharedNamespaceNames,
  );
  const dryRun = args.dry_run ?? true;
  const input = {
    candidateId: args.candidate_id,
    namespace,
    promotedBy: auth.identity.tokenClientId,
    dryRun,
  };

  try {
    const result = dryRun
      ? await promoteReviewedCandidate(
          createReviewedCandidatePromotionRepository(dependencies.pool),
          input,
        )
      : await withTransaction({
          pool: dependencies.pool,
          run: async (tx) =>
            promoteReviewedCandidate(
              createReviewedCandidatePromotionRepository(tx),
              input,
            ),
        });
    const response = {
      ...result,
      namespace: canonicalNamespace(namespace, dependencies.sharedNamespaceNames),
    };
    dependencies.logger.info(
      {
        tool: "promote_reviewed_candidate",
        namespace: response.namespace,
        candidateId: result.candidate_id,
        status: result.status,
        dryRun: result.dry_run,
        isNew: result.is_new,
      },
      "tool_result",
    );
    return textResult(response);
  } catch (error) {
    return respondFailure(dependencies, namespace, dryRun, error);
  }
}

export function registerReviewedCandidatePromotionTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "promote_reviewed_candidate",
    {
      description:
        "Copy a human-promoted DREAM fact or decision candidate into the " +
        "caller-authorized durable thoughts namespace. Machine grades do not " +
        "qualify. Dry-run by default; explicit review_action='promoted' is required.",
      inputSchema: reviewedCandidateInputSchema,
      annotations: reviewedCandidateAnnotations,
    },
    async (args, extra) => handleReviewedCandidatePromotion(dependencies, args, extra),
  );
}
