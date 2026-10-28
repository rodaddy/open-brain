/**
 * `tier_lane`: graduate substantive session-lane events into durable thoughts.
 *
 * `dry_run` defaults to TRUE, so a caller that wants durable thoughts written
 * must say `dry_run: false`. Classification, duplicate detection, and the write
 * are reused from `server/domain/tiering.ts`, and graduated thoughts stay in
 * the lane's own namespace.
 *
 * See docs/decisions/tier-lane-dry-run-and-namespace.md
 * See docs/decisions/cognitive-tiering-dream-cycle.md
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthIdentity } from "../auth/types.ts";
import { canWrite } from "../auth/permissions.ts";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import { canonicalNamespace, physicalNamespace } from "./shared-namespace.ts";
import { newTierReceipt, tierLaneEvent, type LaneEventRow } from "../domain/tiering.ts";
import { writeThoughtChunks } from "../capture/chunk-write.ts";
import { createTieringRepository } from "../db/tiering-repository.ts";
import { createContextPackRepository } from "../db/context-pack-repository.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

/** Lane events scanned when the caller names no preference. */
const DEFAULT_EVENTS_SCANNED = 100;

const tierLaneInputSchema = {
  session_key: z.string().min(1).max(500).describe("Stable lane identifier to tier"),
  namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Namespace of the lane (defaults to caller's clientId)"),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview without writing durable thoughts (default true)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(`Max lane events to scan (default ${DEFAULT_EVENTS_SCANNED})`),
};

const tierLaneAnnotations = {
  title: "Tier Session Lane",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

export function registerTierLaneTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "tier_lane",
    {
      description:
        "Graduate substantive events from a single session lane into the agent's " +
        "OWN durable thoughts (same namespace). Classifies each event, skips " +
        "duplicates, and graduates facts/decisions/handoffs. Dry-run by default. " +
        "An agent may only tier a lane in a namespace it can write.",
      inputSchema: tierLaneInputSchema,
      annotations: tierLaneAnnotations,
    },
    async (args, extra) => handleTierLane(dependencies, args, extra),
  );
}

/** Minimal shape of the handler `extra` argument this tool reads. */
interface HandlerExtra {
  authInfo?: Parameters<typeof authIdentity>[0];
}

/** Caller-supplied arguments after Zod validation. */
interface TierLaneArgs {
  readonly session_key: string;
  readonly namespace?: string | undefined;
  readonly dry_run?: boolean | undefined;
  readonly limit?: number | undefined;
}

/** A tiering request that cleared identity and target-namespace checks. */
interface TierLaneTarget {
  readonly identity: AuthIdentity;
  readonly namespace: string;
}

/**
 * Check that the caller may write thoughts into the lane's namespace.
 *
 * Graduation writes THOUGHTS, so the thoughts write permission is the
 * authority -- not a session or lane permission. The namespace denial is
 * LOGGED, which is why this stays a local helper rather than the shared
 * `authorize` in `memory-helpers.ts`: that helper emits no `tier_lane_denied`
 * event, so calling it would drop this tool's denial log line.
 *
 * @returns The authorized target, or the error result that refused it.
 */
function authorizeTierLane(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity | undefined,
  requestedNamespace: string | undefined,
): TierLaneTarget | ReturnType<typeof errorResult> {
  if (!identity || !canWrite(identity.role, "thoughts")) {
    return errorResult("Permission denied: cannot write to thoughts");
  }

  const requested = requestedNamespace ?? identity.clientId;
  if (!canTargetNamespace(identity, "write", requested)) {
    dependencies.logger.warn(
      { tool: "tier_lane", role: identity.role, namespace: requested },
      "tier_lane_denied",
    );
    return errorResult(
      `Permission denied: ${identity.role} role cannot write to namespace '${requested}'`,
    );
  }

  return {
    identity,
    namespace: physicalNamespace(requested, dependencies.sharedNamespaceNames),
  };
}

/** @returns True when authorization returned a refusal rather than a target. */
function isRefusal(
  outcome: TierLaneTarget | ReturnType<typeof errorResult>,
): outcome is ReturnType<typeof errorResult> {
  return !("identity" in outcome);
}

/**
 * Read one lane's events, newest last.
 *
 * Events are joined to their lane so each row carries the lane's own namespace
 * and agent; the lane is what the namespace predicate binds to, because events
 * hold no namespace of their own.
 */
async function readLaneEvents(
  dependencies: MemoryToolDependencies,
  namespace: string,
  sessionKey: string,
  scanLimit: number,
): Promise<LaneEventRow[]> {
  const repository = createContextPackRepository(dependencies.pool);
  const { rows } = await repository.selectLaneEvents({
    namespace,
    sessionKey,
    scanLimit,
  });
  return rows as unknown as LaneEventRow[];
}

/** One graduation pass over a lane's events. */
interface TierLaneRun {
  readonly dependencies: MemoryToolDependencies;
  readonly rows: readonly LaneEventRow[];
  readonly namespace: string;
  readonly createdBy: string;
  readonly dryRun: boolean;
}

/**
 * Classify and graduate each event, accumulating the receipt.
 *
 * Sequential by design: `tierLaneEvent` deduplicates against what the same run
 * has already written, so concurrent passes would each miss the other's writes.
 */
async function tierLaneEvents(
  run: TierLaneRun,
): Promise<ReturnType<typeof newTierReceipt>> {
  const receipt = newTierReceipt(run.dryRun);
  const repository = createTieringRepository(run.dependencies.pool);
  for (const row of run.rows) {
    await tierLaneEvent(row, receipt, {
      repository,
      embedFn: run.dependencies.embedFn,
      namespace: run.namespace,
      createdBy: run.createdBy,
      dryRun: run.dryRun,
      writeChunks: writeThoughtChunks,
    });
  }
  return receipt;
}

/**
 * Log the driver failure without leaking its message.
 *
 * Only a stable class reaches the log; the raw driver message can carry lane
 * content and namespace names.
 */
function logLaneTieringFailure(
  dependencies: MemoryToolDependencies,
  sessionKey: string,
  error: unknown,
): void {
  dependencies.logger.error(
    {
      tool: "tier_lane",
      sessionKey,
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: (error as { code?: string } | null | undefined)?.code,
    },
    "tier_lane_db_error",
  );
}

async function handleTierLane(
  dependencies: MemoryToolDependencies,
  args: TierLaneArgs,
  extra: HandlerExtra,
): Promise<ReturnType<typeof textResult>> {
  const authorized = authorizeTierLane(
    dependencies,
    authIdentity(extra.authInfo),
    args.namespace,
  );
  if (isRefusal(authorized)) {
    return authorized;
  }

  const { identity, namespace } = authorized;
  // Mutation is OPT-IN. Reading this as `?? false` would make every
  // exploratory call write durable memory.
  const dryRun = args.dry_run ?? true;
  const scanLimit = args.limit ?? DEFAULT_EVENTS_SCANNED;

  try {
    const rows = await readLaneEvents(
      dependencies,
      namespace,
      args.session_key,
      scanLimit,
    );
    const receipt = await tierLaneEvents({
      dependencies,
      rows,
      namespace,
      createdBy: identity.clientId,
      dryRun,
    });

    dependencies.logger.info(
      {
        tool: "tier_lane",
        sessionKey: args.session_key,
        namespace,
        dryRun,
        ...receipt,
      },
      "tool_result",
    );
    return textResult({
      session_key: args.session_key,
      namespace: canonicalNamespace(namespace, dependencies.sharedNamespaceNames),
      ...receipt,
    });
  } catch (error) {
    logLaneTieringFailure(dependencies, args.session_key, error);
    return errorResult("Database error during lane tiering");
  }
}
