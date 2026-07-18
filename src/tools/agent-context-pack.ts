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
import {
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_STATUSES,
  RecoveryWalStore,
} from "../realtime/recovery-wal.ts";
import type { ToolDeps } from "./index.ts";
import { loadDurableLaneContext } from "./agent-context-pack-durable-lane.ts";

export const SECTION_NAMES = [
  "working_set",
  "recovery",
  "durable_lane_context",
  "durable_memory",
  "profile_guidance",
  "process_guidance",
  "repo_facts",
  "pointers",
  "candidate_memory",
] as const;

export const scopeInputSchema = {
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

export const agentContextPackInputSchema = {
  ...scopeInputSchema,
  query: z.string().max(4000).optional(),
  requested_sections: z
    .array(z.enum(SECTION_NAMES))
    .optional()
    .describe(
      "Sections to assemble. durable_lane_context is queried only when explicitly requested and requires all seven exact scope coordinates.",
    ),
  include_unreviewed_recovery: z
    .boolean()
    .optional()
    .describe("Explicitly include exact-scope quarantined recovery summary"),
  budget: z
    .object({
      max_tokens: z.number().int().min(100).max(20000).optional(),
      max_latency_ms: z.number().int().min(1).max(10000).optional(),
    })
    .optional(),
};

const agentContextPackArgsSchema = z.object(agentContextPackInputSchema);

export type AgentContextPackArgs = z.infer<typeof agentContextPackArgsSchema>;

export interface AgentContextPackBuildResult {
  payload: unknown;
  isError: boolean;
}

export function parseAgentContextPackArgs(args: unknown): AgentContextPackArgs {
  return agentContextPackArgsSchema.parse(args);
}

export async function buildAgentContextPackPayload(
  args: AgentContextPackArgs,
  auth: AuthInfo | undefined,
  deps: ToolDeps,
): Promise<AgentContextPackBuildResult> {
  if (!auth || !canRead(auth.role, "sessions")) {
    return {
      payload: { error: "Permission denied: cannot read agent context pack" },
      isError: true,
    };
  }

  const ns = args.namespace ?? auth.clientId;
  if (!canReadNamespace(auth, ns)) {
    return {
      payload: { error: `Permission denied: cannot read namespace '${ns}'` },
      isError: true,
    };
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
  const includeRecovery =
    args.include_unreviewed_recovery === true &&
    (!args.requested_sections ||
      args.requested_sections.includes("recovery"));
  const includeDurableLaneContext =
    args.requested_sections?.includes("durable_lane_context") === true;
  const workingSet = storeFor(deps).buildContextPackFragment(scope);
  const recovery = includeRecovery
    ? recoveryStoreFor(deps).buildContextPackFragment(scope)
    : null;
  const durableLaneContext = includeDurableLaneContext
    ? await loadDurableLaneContext(args, ns, deps)
    : null;

  return {
    payload: {
      schema: "openbrain.agent_context_pack.v1",
      status: "ok",
      scope: {
        namespace_source: "authorization",
        ...normalizedScope,
      },
      sections: {
        ...(includeWorkingSet
          ? { working_set: workingSet.working_set }
          : {}),
        ...(recovery ? { recovery: recovery.recovery } : {}),
        ...(durableLaneContext?.section
          ? { durable_lane_context: durableLaneContext.section }
          : {}),
      },
      warnings: {
        scope_denials: [
          ...(includeWorkingSet
            ? workingSet.warnings.scope_denials
            : []),
          ...(recovery ? recovery.warnings.scope_denials : []),
          ...(durableLaneContext?.scopeDenials ?? []),
        ],
        degraded_sources: durableLaneContext?.degradedSources ?? [],
        truncation: durableLaneContext?.truncation ?? [],
      },
      budget: {
        requested: args.budget ?? null,
        ...(includeWorkingSet ? workingSet.budget : {}),
        ...(recovery ? recovery.budget : {}),
        ...(durableLaneContext
          ? { durable_lane_context: durableLaneContext.budget }
          : {}),
      },
      citations: durableLaneContext?.citations ?? [],
      query: args.query ?? null,
    },
    isError: false,
  };
}

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

export function registerRecoveryWalAppend(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "recovery_wal_append",
    {
      description:
        "Append one quarantined recovery WAL record for the exact active " +
        "namespace/agent/platform/server/channel/thread/session. Recovery " +
        "records are unreviewed, not durable memory, and not searchable recall.",
      inputSchema: {
        ...scopeInputSchema,
        content: z
          .string()
          .min(1)
          .max(8000)
          .describe("Bounded quarantined recovery content, not durable memory"),
        status: z.enum(RECOVERY_WAL_STATUSES).optional(),
        trace_id: z.string().max(500).optional(),
        source_ref: z.string().max(1000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "Recovery WAL Append",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return textError("Permission denied: cannot write recovery WAL");
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return textError(nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`);
      }

      const result = recoveryStoreFor(deps).append({
        namespace: ns,
        agent: args.agent,
        platform: args.platform,
        server_id: args.server_id,
        channel_id: args.channel_id,
        thread_id: args.thread_id ?? null,
        session_key: args.session_key,
      }, {
        content: args.content,
        status: args.status,
        trace_id: args.trace_id ?? null,
        source_ref: args.source_ref ?? null,
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
              not_searchable_recall: true,
              unreviewed_quarantine: true,
            }),
          },
        ],
        isError: !result.accepted,
      };
    },
  );
}

export function registerRecoveryWalMark(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "recovery_wal_mark",
    {
      description:
        "Mark or purge one exact-scope quarantined recovery WAL record after " +
        "review. This never promotes recovery content into durable memory.",
      inputSchema: {
        ...scopeInputSchema,
        id: z.string().min(1).max(200),
        action: z.enum(RECOVERY_WAL_ACTIONS),
        status: z.enum(RECOVERY_WAL_STATUSES),
        purge: z
          .boolean()
          .optional()
          .describe("When true, remove the exact recovery record after review"),
      },
      annotations: {
        title: "Recovery WAL Mark",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return textError("Permission denied: cannot mark recovery WAL");
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return textError(nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`);
      }

      const result = recoveryStoreFor(deps).mark(
        {
          namespace: ns,
          agent: args.agent,
          platform: args.platform,
          server_id: args.server_id,
          channel_id: args.channel_id,
          thread_id: args.thread_id ?? null,
          session_key: args.session_key,
        },
        args.id,
        args.action,
        args.status,
        { purge: args.purge ?? false },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              accepted: result.accepted,
              reason: result.reason ?? null,
              item: result.item ?? null,
              purged: result.purged ?? false,
              counters: result.counters,
              not_durable_memory: true,
              not_searchable_recall: true,
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
        "Build a scoped realtime agent context pack. working_set uses exact " +
        "active scope; recovery requires explicit unreviewed-recovery opt-in; " +
        "durable_lane_context is queried only when explicitly requested and " +
        "returns bounded lane/events only after all seven scope coordinates match.",
      inputSchema: agentContextPackInputSchema,
      annotations: {
        title: "Agent Context Pack",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const result = await buildAgentContextPackPayload(
        parseAgentContextPackArgs(args),
        extra.authInfo as AuthInfo | undefined,
        deps,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.payload),
          },
        ],
        isError: result.isError,
      };
    },
  );
}

function storeFor(deps: ToolDeps): WorkingSetStore {
  deps.workingSetStore ??= new WorkingSetStore();
  return deps.workingSetStore;
}

function recoveryStoreFor(deps: ToolDeps): RecoveryWalStore {
  deps.recoveryWalStore ??= new RecoveryWalStore({
    walPath: process.env.OPENBRAIN_RECOVERY_WAL_PATH ?? null,
  });
  return deps.recoveryWalStore;
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
