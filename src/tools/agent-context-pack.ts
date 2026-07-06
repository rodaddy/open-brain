import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { canReadNamespace } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import {
  WORKING_SET_ITEM_KINDS,
  WorkingSetStore,
  normalizeWorkingSetScope,
  type WorkingSetScope,
} from "../realtime/working-set.ts";
import type { ToolDeps } from "./index.ts";

const SECTION_NAMES = [
  "working_set",
  "durable_lane_context",
  "durable_memory",
  "profile_guidance",
  "process_guidance",
  "repo_facts",
  "pointers",
  "candidate_memory",
] as const;

const scopeInputSchema = {
  namespace: z
    .string()
    .max(500)
    .optional()
    .describe("Namespace for isolation; defaults to auth-derived clientId"),
  agent: z.string().min(1).max(200).describe("Active agent identity"),
  platform: z
    .string()
    .min(1)
    .max(200)
    .describe("Runtime platform/source, such as discord"),
  server_id: z.string().min(1).max(500).describe("Server/guild/workspace id"),
  channel_id: z.string().min(1).max(500).describe("Channel/conversation id"),
  thread_id: z
    .string()
    .max(500)
    .optional()
    .describe("Optional thread id; missing means unthreaded only"),
  session_key: z
    .string()
    .min(1)
    .max(500)
    .describe("Stable active-session key"),
};

export function registerWorkingSetAppend(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "working_set_append",
    {
      description:
        "Append one RAM-only scoped working-set item for the exact active " +
        "namespace/agent/platform/server/channel/thread/session. This does " +
        "not write durable memory or shared-kb.",
      inputSchema: {
        ...scopeInputSchema,
        kind: z.enum(WORKING_SET_ITEM_KINDS).describe("Working-set item kind"),
        content: z
          .string()
          .min(1)
          .max(4000)
          .describe("Bounded working context content, not durable memory"),
        confidence: z.number().min(0).max(1).optional(),
        stale_at: z.string().max(100).optional(),
        trace_id: z.string().max(500).optional(),
        source_ref: z.string().max(1000).optional(),
        durable_ref: z
          .object({
            table: z.string().min(1).max(100),
            id: z.string().min(1).max(200),
          })
          .optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "Working Set Append",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return textError("Permission denied: cannot write working set");
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return textError(nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`);
      }

      const result = storeFor(deps).append({
        namespace: ns,
        agent: args.agent,
        platform: args.platform,
        server_id: args.server_id,
        channel_id: args.channel_id,
        thread_id: args.thread_id ?? null,
        session_key: args.session_key,
      }, {
        kind: args.kind,
        content: args.content,
        confidence: args.confidence,
        stale_at: args.stale_at ?? null,
        trace_id: args.trace_id ?? null,
        source_ref: args.source_ref ?? null,
        durable_ref: args.durable_ref ?? null,
        metadata: args.metadata,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              accepted: result.accepted,
              reason: result.reason ?? null,
              item: result.item ?? null,
              counters: result.counters,
              not_durable_memory: true,
            }),
          },
        ],
        isError: !result.accepted,
      };
    },
  );
}

export function registerAgentContextPack(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "agent_context_pack",
    {
      description:
        "Build a scoped realtime agent context pack. The working_set section " +
        "is included only for the exact namespace/agent/platform/server/" +
        "channel/thread/session scope.",
      inputSchema: {
        ...scopeInputSchema,
        query: z.string().max(4000).optional(),
        requested_sections: z.array(z.enum(SECTION_NAMES)).optional(),
        budget: z
          .object({
            max_tokens: z.number().int().min(100).max(20000).optional(),
            max_latency_ms: z.number().int().min(1).max(10000).optional(),
          })
          .optional(),
      },
      annotations: {
        title: "Agent Context Pack",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        return textError("Permission denied: cannot read agent context pack");
      }

      const ns = args.namespace ?? auth.clientId;
      if (!canReadNamespace(auth, ns)) {
        return textError(`Permission denied: cannot read namespace '${ns}'`);
      }

      const scope: WorkingSetScope = {
        namespace: ns,
        agent: args.agent,
        platform: args.platform,
        server_id: args.server_id,
        channel_id: args.channel_id,
        thread_id: args.thread_id ?? null,
        session_key: args.session_key,
      };
      const normalizedScope = normalizeWorkingSetScope(scope);
      const includeWorkingSet =
        !args.requested_sections ||
        args.requested_sections.includes("working_set");
      const workingSet = storeFor(deps).buildContextPackFragment(scope);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema: "openbrain.agent_context_pack.v1",
              status: "ok",
              scope: {
                namespace_source: "authorization",
                ...normalizedScope,
              },
              sections: includeWorkingSet
                ? { working_set: workingSet.working_set }
                : {},
              warnings: includeWorkingSet
                ? workingSet.warnings
                : { scope_denials: [] },
              budget: {
                requested: args.budget ?? null,
                ...workingSet.budget,
              },
              citations: [],
              query: args.query ?? null,
            }),
          },
        ],
      };
    },
  );
}

function storeFor(deps: ToolDeps): WorkingSetStore {
  deps.workingSetStore ??= new WorkingSetStore();
  return deps.workingSetStore;
}

function textError(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
