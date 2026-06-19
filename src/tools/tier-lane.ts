import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import {
  canonicalNamespace,
  physicalNamespace,
} from "../shared-namespace.ts";
import {
  newTierReceipt,
  tierLaneEvent,
  type LaneEventRow,
} from "../tiering.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerTierLane(server: McpServer, deps: ToolDeps): void {
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
          .describe("Max lane events to scan (default 100)"),
      },
      annotations: {
        title: "Tier Session Lane",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "thoughts")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to thoughts",
            },
          ],
          isError: true,
        };
      }

      const requestedNamespace = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, requestedNamespace);
      if (!nsCheck.allowed) {
        logger.warn("tier_lane_denied", {
          role: auth.role,
          clientId: auth.clientId,
          namespace: requestedNamespace,
          reason: nsCheck.reason,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: ${nsCheck.reason}`,
            },
          ],
          isError: true,
        };
      }

      const ns = physicalNamespace(requestedNamespace);
      const dryRun = args.dry_run ?? true;
      const limit = args.limit ?? 100;

      try {
        // Lane is resolved by (namespace, session_key); events are joined to
        // their lane so each row carries the lane's namespace + agent.
        const { rows } = await deps.pool.query(
          `SELECT
             e.id, e.lane_id, l.namespace, l.agent, l.session_key,
             e.event_type, e.content, e.importance, e.content_hash, e.created_at
           FROM ob_session_events e
           JOIN ob_session_lanes l ON e.lane_id = l.id
           WHERE l.namespace = $1 AND l.session_key = $2
           ORDER BY e.created_at ASC, e.id ASC
           LIMIT $3`,
          [ns, args.session_key, limit],
        );

        const receipt = newTierReceipt(dryRun);
        for (const row of rows as LaneEventRow[]) {
          await tierLaneEvent(row, receipt, {
            pool: deps.pool,
            embedFn: deps.embedFn,
            namespace: ns,
            createdBy: auth.clientId,
            dryRun,
          });
        }

        logger.info("tier_lane_ok", {
          session_key: args.session_key,
          namespace: ns,
          ...receipt,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                session_key: args.session_key,
                namespace: canonicalNamespace(ns),
                ...receipt,
              }),
            },
          ],
        };
      } catch (err) {
        logger.error("tier_lane_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during lane tiering: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
