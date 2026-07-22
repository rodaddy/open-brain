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
import {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  loadDurableLaneContext,
} from "./agent-context-pack-durable-lane.ts";
import {
  CHARS_PER_TOKEN,
  CONTEXT_PACK_SECTION_PRIORITY,
  durableLaneContentChars,
  fitDurableLaneSection,
  fitItemSection,
  sectionFrameCost,
  serializedLength,
  type DurableLaneSection,
} from "./agent-context-pack-budget.ts";

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
  session_key: z.string().min(1).max(500).describe("Stable active-session key"),
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

// Whole-pack budget allocation/fitting helpers and their shared
// types/constants (CHARS_PER_TOKEN, CONTEXT_PACK_SECTION_PRIORITY,
// serializedLength, sectionFrameCost, fitItemSection, fitDurableLaneSection,
// durableLaneContentChars, DurableLaneSection) live in
// ./agent-context-pack-budget.ts and are imported above.

/**
 * Re-exported for backward compatibility with callers that imported the
 * whole-pack allocation order from this module.
 */
export { CONTEXT_PACK_SECTION_PRIORITY };

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
    !args.requested_sections || args.requested_sections.includes("working_set");
  const includeRecovery =
    args.include_unreviewed_recovery === true &&
    (!args.requested_sections || args.requested_sections.includes("recovery"));
  const includeDurableLaneContext =
    args.requested_sections?.includes("durable_lane_context") === true;

  // Total whole-pack char budget. Absent max_tokens => no whole-pack bound, and
  // every section keeps its historical independent per-section behavior.
  const wholePackBudget =
    args.budget?.max_tokens !== undefined
      ? Math.max(
          0,
          args.budget.max_tokens * CHARS_PER_TOKEN -
            CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
        )
      : null;
  // The declared serialized-section limit must always admit the irreducible
  // two-character empty object `{}`, which JSON.stringify(payload.sections)
  // emits even when every section is omitted. At tiny budgets wholePackBudget
  // clamps to 0, but "{}" is 2 chars, so the reported limit is raised to that
  // floor; section *members* still get zero of it (remainingChars below), so no
  // section body is ever admitted at those budgets.
  const wholePackSerializedLimit =
    wholePackBudget !== null ? Math.max(2, wholePackBudget) : null;
  // Reserve the enclosing `{}` of the serialized `sections` object once, so the
  // running budget bounds JSON.stringify(payload.sections), not just the summed
  // section bodies. Each retained section additionally charges its own framing
  // (quoted key + delimiter) via sectionFrameCost.
  let remainingChars =
    wholePackBudget !== null
      ? Math.max(0, wholePackBudget - 2)
      : Number.POSITIVE_INFINITY;
  // Object framing is position-sensitive: the first admitted member costs only
  // `"key":<body>`, each subsequent member adds one leading `,`. This flips to
  // false the moment a section is actually admitted, so a starved/omitted
  // candidate never consumes the first-member (comma-free) slot.
  let firstSectionAdmitted = true;
  const wholePackTruncation: Array<Record<string, unknown>> = [];

  const workingSet = includeWorkingSet
    ? storeFor(deps).buildContextPackFragment(scope)
    : null;
  const recovery = includeRecovery
    ? recoveryStoreFor(deps).buildContextPackFragment(scope)
    : null;

  // Allocate in fixed priority order. Each section only sees the serialized
  // budget that higher-priority sections leave behind, so a large low-priority
  // section can never starve a higher-value one.
  //
  // A requested item-bearing section that is fully starved keeps its defined
  // empty envelope (items: [], count 0) *only when that envelope fits the
  // surviving budget*, so the caller still gets its scope/budget/counter shape.
  // If even the empty envelope would overflow the whole-pack budget, the section
  // is omitted entirely — the hard "sections never exceed the budget" contract
  // wins over envelope-shape preservation — and a `starved` truncation marker is
  // still recorded so the caller knows the requested section was fully dropped.
  let workingSetSection = workingSet?.working_set ?? null;
  if (workingSetSection) {
    const frame = sectionFrameCost("working_set", firstSectionAdmitted);
    const serving = Math.max(0, remainingChars - frame);
    const fitted = fitItemSection(workingSetSection, ["item_count"], serving);
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      // Empty envelope does not fit: omit the section to hold the budget. It is
      // not admitted, so the first-member slot stays available for a later one.
      workingSetSection = null;
    } else {
      workingSetSection = fitted.section;
      remainingChars = Math.max(
        0,
        remainingChars - serializedLength(fitted.section) - frame,
      );
      firstSectionAdmitted = false;
    }
    if (fitted.truncated) {
      wholePackTruncation.push({
        source: "working_set",
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
        ...(fitted.starved ? { starved: true } : {}),
      });
    }
  }

  let recoverySection = recovery?.recovery ?? null;
  if (recoverySection) {
    const frame = sectionFrameCost("recovery", firstSectionAdmitted);
    const serving = Math.max(0, remainingChars - frame);
    const fitted = fitItemSection(
      recoverySection,
      ["item_count", "pending_count"],
      serving,
    );
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      recoverySection = null;
    } else {
      recoverySection = fitted.section;
      remainingChars = Math.max(
        0,
        remainingChars - serializedLength(fitted.section) - frame,
      );
      firstSectionAdmitted = false;
    }
    if (fitted.truncated) {
      wholePackTruncation.push({
        source: "recovery",
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
        ...(fitted.starved ? { starved: true } : {}),
      });
    }
  }

  // durable_lane_context content is bounded by the pack budget that survives the
  // higher-priority sections. The loader trims raw content chars, but its
  // serialized section also carries lane metadata, per-event wrappers, and
  // citation ids. To keep the *serialized* section — not merely its content
  // body — within the surviving whole-pack budget, seed the loader with a
  // content limit and then re-fit the returned section against remainingChars,
  // dropping the oldest events and finally trimming the checkpoint until the
  // serialized section fits. Counts, citations, and truncation are reconciled
  // to whatever survives. When there is no whole-pack budget the loader keeps
  // its historical per-section derivation and no re-fit runs.
  const durableLaneFrame = sectionFrameCost(
    "durable_lane_context",
    firstSectionAdmitted,
  );
  const durableLaneServingChars =
    wholePackBudget === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, remainingChars - durableLaneFrame);
  const durableLaneContentLimit =
    wholePackBudget === null
      ? undefined
      : Number.isFinite(durableLaneServingChars)
        ? Math.floor(durableLaneServingChars)
        : undefined;
  const durableLaneContext = includeDurableLaneContext
    ? await loadDurableLaneContext(args, ns, deps, durableLaneContentLimit)
    : null;
  let durableLaneSection = durableLaneContext?.section ?? null;
  let durableCitations = durableLaneSection
    ? (durableLaneContext?.citations ?? [])
    : [];
  // True only when a loaded durable-lane section is dropped by the whole-pack
  // re-fit (its trimmed envelope still overflowed the surviving budget), so the
  // reconciled budget can report zero content emitted rather than the loader's
  // pre-refit selection.
  let durableLaneStarvedOut = false;
  if (durableLaneSection && wholePackBudget !== null) {
    const fitted = fitDurableLaneSection(
      durableLaneSection,
      durableCitations,
      durableLaneServingChars,
    );
    if (
      fitted.truncated &&
      serializedLength(fitted.section) > durableLaneServingChars
    ) {
      // Even the trimmed (possibly empty) durable-lane section overflows the
      // surviving budget: omit it and drop its citations so the whole pack stays
      // within budget and no citation references an unemitted section. The
      // starved truncation marker still signals that the requested section was
      // dropped.
      durableLaneSection = null;
      durableCitations = [];
      durableLaneStarvedOut = true;
      wholePackTruncation.push({
        source: "durable_lane_context",
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
        starved: true,
      });
    } else {
      durableLaneSection = fitted.section;
      durableCitations = fitted.citations;
      remainingChars = Math.max(
        0,
        remainingChars -
          serializedLength(durableLaneSection) -
          durableLaneFrame,
      );
      // durable_lane_context is last in priority, so this only keeps the
      // first-member invariant honest; no later section frames after it.
      firstSectionAdmitted = false;
      if (fitted.truncated) {
        wholePackTruncation.push({
          source: "durable_lane_context",
          reason: "whole_pack_budget",
          max_chars: wholePackBudget,
        });
      }
    }
  } else if (durableLaneSection) {
    remainingChars = Math.max(
      0,
      remainingChars - serializedLength(durableLaneSection) - durableLaneFrame,
    );
    firstSectionAdmitted = false;
  }

  // Reconcile the durable-lane budget's content_chars_used to the content that
  // actually survived the whole-pack re-fit. When the section survives, count its
  // retained content body. When it was starved out entirely, report zero content
  // emitted so the budget never claims usage for an unemitted section. Without a
  // whole-pack budget the loader's own accounting is authoritative and passes
  // through unchanged.
  const durableLaneBudget =
    wholePackBudget !== null && durableLaneContext?.budget
      ? durableLaneSection
        ? {
            ...durableLaneContext.budget,
            content_chars_used: durableLaneContentChars(
              durableLaneSection as DurableLaneSection,
            ),
          }
        : durableLaneStarvedOut
          ? { ...durableLaneContext.budget, content_chars_used: 0 }
          : durableLaneContext.budget
      : durableLaneContext?.budget;

  const sections: Record<string, unknown> = {};
  if (workingSetSection) sections.working_set = workingSetSection;
  if (recoverySection) sections.recovery = recoverySection;
  if (durableLaneSection) sections.durable_lane_context = durableLaneSection;

  return {
    payload: {
      schema: "openbrain.agent_context_pack.v1",
      status: "ok",
      scope: {
        namespace_source: "authorization",
        ...normalizedScope,
      },
      sections,
      warnings: {
        scope_denials: [
          ...(workingSet ? workingSet.warnings.scope_denials : []),
          ...(recovery ? recovery.warnings.scope_denials : []),
          ...(durableLaneContext?.scopeDenials ?? []),
        ],
        degraded_sources: durableLaneContext?.degradedSources ?? [],
        truncation: [
          ...(durableLaneSection ? (durableLaneContext?.truncation ?? []) : []),
          ...wholePackTruncation,
        ],
      },
      budget: {
        requested: args.budget ?? null,
        ...(wholePackBudget !== null
          ? {
              whole_pack: {
                content_char_limit: wholePackSerializedLimit,
                content_chars_used:
                  wholePackBudget - Math.max(0, remainingChars),
                allocation_order: [...CONTEXT_PACK_SECTION_PRIORITY],
              },
            }
          : {}),
        ...(workingSet ? workingSet.budget : {}),
        ...(recovery ? recovery.budget : {}),
        ...(durableLaneSection || durableLaneContext
          ? { durable_lane_context: durableLaneBudget }
          : {}),
      },
      citations: durableCitations,
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
        return textError(
          nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`,
        );
      }

      const result = storeFor(deps).append(
        {
          namespace: ns,
          agent: args.agent,
          platform: args.platform,
          server_id: args.server_id,
          channel_id: args.channel_id,
          thread_id: args.thread_id ?? null,
          session_key: args.session_key,
        },
        {
          kind: args.kind,
          content: args.content,
          confidence: args.confidence,
          stale_at: args.stale_at ?? null,
          trace_id: args.trace_id ?? null,
          source_ref: args.source_ref ?? null,
          durable_ref: args.durable_ref ?? null,
          metadata: args.metadata,
        },
      );

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
        return textError(
          nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`,
        );
      }

      const result = recoveryStoreFor(deps).append(
        {
          namespace: ns,
          agent: args.agent,
          platform: args.platform,
          server_id: args.server_id,
          channel_id: args.channel_id,
          thread_id: args.thread_id ?? null,
          session_key: args.session_key,
        },
        {
          content: args.content,
          status: args.status,
          trace_id: args.trace_id ?? null,
          source_ref: args.source_ref ?? null,
          metadata: args.metadata,
        },
      );

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
        return textError(
          nsCheck.reason ?? `Permission denied: cannot write namespace '${ns}'`,
        );
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
