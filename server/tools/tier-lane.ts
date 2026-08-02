/**
 * `tier_lane`: graduate substantive session-lane events into durable thoughts.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` and
 * `docs/identity-boundary.md` (token-derived lane identity). `_plans/issues/
 * 433-brain-answer-cannot-see-session-events-and-nothing-promotes-.md` records
 * what happens when this path does not run: recall answered from months-old
 * data because session events accumulated and nothing graduated them.
 *
 * ## Dry-run is the default, and that is the point
 *
 * `dry_run` defaults to TRUE. A caller that wants durable thoughts written must
 * say `dry_run: false` explicitly. This matches `promote_shared` in
 * `promotion.ts` and the DreamEngine contract the repo standards name: a tool
 * that graduates content into long-term memory must not do so because someone
 * called it to look. The receipt shape is identical either way -- same counts,
 * same fields, with `dry_run` stating which it was -- so a caller can preview
 * and then commit without re-reading the response format.
 *
 * ## Namespace
 *
 * A lane is addressed by `(namespace, session_key)`, and the namespace is
 * checked for WRITE authority even though the lane read is a SELECT: the whole
 * purpose of the call is to write thoughts into that namespace, so read
 * authority over the lane is not the permission that matters. Graduated
 * thoughts land in the SAME namespace as the lane -- this tool never moves
 * content across the boundary, which is what `promote_entry` is for.
 *
 * Classification, duplicate detection, and the write itself are reused from
 * `src/tiering.ts`. What counts as a graduating event is one rule; a second
 * implementation here would let the two servers disagree about which events
 * become durable memory.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../auth/permissions.ts";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import {
  canonicalNamespace,
  physicalNamespace,
} from "../../src/shared-namespace.ts";
import {
  newTierReceipt,
  tierLaneEvent,
  type LaneEventRow,
} from "../../src/tiering.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

/** Lane events scanned when the caller names no preference. */
const DEFAULT_EVENTS_SCANNED = 100;

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
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe("Stable lane identifier to tier"),
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
      },
      annotations: {
        title: "Tier Session Lane",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      // Graduation writes THOUGHTS, so the thoughts write permission is the
      // authority -- not a session or lane permission.
      if (!identity || !canWrite(identity.role, "thoughts")) {
        return errorResult("Permission denied: cannot write to thoughts");
      }

      const requested = args.namespace ?? identity.clientId;
      if (!canTargetNamespace(identity, "write", requested)) {
        dependencies.logger.warn(
          { tool: "tier_lane", role: identity.role, namespace: requested },
          "tier_lane_denied",
        );
        return errorResult(
          `Permission denied: ${identity.role} role cannot write to namespace '${requested}'`,
        );
      }

      const namespace = physicalNamespace(requested);
      // Mutation is OPT-IN. Reading this as `?? false` would make every
      // exploratory call write durable memory.
      const dryRun = args.dry_run ?? true;
      const scanLimit = args.limit ?? DEFAULT_EVENTS_SCANNED;

      try {
        // Events are joined to their lane so each row carries the lane's own
        // namespace and agent; the lane is what the namespace predicate binds
        // to, because events hold no namespace of their own.
        const { rows } = await dependencies.pool.query(
          `SELECT e.id, e.lane_id, l.namespace, l.agent, l.session_key,
                  e.event_type, e.content, e.importance, e.content_hash,
                  e.created_at, e.metadata
             FROM ob_session_events e
             JOIN ob_session_lanes l ON e.lane_id = l.id
            WHERE l.namespace = $1 AND l.session_key = $2
            ORDER BY e.created_at ASC, e.id ASC
            LIMIT $3`,
          [namespace, args.session_key, scanLimit],
        );

        const receipt = newTierReceipt(dryRun);
        for (const row of rows as LaneEventRow[]) {
          await tierLaneEvent(row, receipt, {
            pool: dependencies.pool,
            embedFn: dependencies.embedFn,
            namespace,
            createdBy: identity.clientId,
            dryRun,
          });
        }

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
          namespace: canonicalNamespace(namespace),
          ...receipt,
        });
      } catch (error) {
        // Only a stable class reaches the log; the raw driver message can carry
        // lane content and namespace names.
        dependencies.logger.error(
          {
            tool: "tier_lane",
            sessionKey: args.session_key,
            errorName: error instanceof Error ? error.name : "unknown",
            errorCode: (error as { code?: string } | null | undefined)?.code,
          },
          "tier_lane_db_error",
        );
        return errorResult("Database error during lane tiering");
      }
    },
  );
}
