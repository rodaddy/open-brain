/**
 * `agent_context_pack` and `agent_reflex_pointers` — the realtime memory
 * surface.
 *
 * Design authority: `docs/agent-context-pack-contract.md`. Parent issue #220;
 * sections wired per #327 (one recall stack), #329 (pointers/candidates), #333
 * (prior-context suppression), #334 (reflex projection).
 *
 * One call returns one scoped, inspectable, prompt-ready bundle, so a runtime
 * does not stitch together lane reads, semantic search, repo facts, guidance,
 * and staleness warnings on every turn.
 *
 * THREE INVARIANTS GOVERN THIS FILE.
 *
 * 1. ONE RETRIEVAL STACK. `durable_memory`, `pointers`, and `candidate_memory`
 *    are fed by a SINGLE hybrid recall. Requesting durable_memory OR pointers
 *    runs it once; candidate_memory alone runs nothing at all. A second recall
 *    would double every pack's cost and could rank differently, so pointers
 *    would dedupe against rows durable_memory never saw.
 *
 * 2. SECTIONS NEVER EXCEED THE BUDGET. Allocation walks a fixed priority order,
 *    and each section sees only what its predecessors left. Under pressure a
 *    section is trimmed, then reduced to its empty envelope, then OMITTED
 *    entirely — the hard budget wins over envelope-shape preservation — and each
 *    of those outcomes records a `whole_pack_budget` truncation marker so a
 *    dropped section is never silently absent.
 *
 * 3. CITATIONS ARE A BIJECTION WITH EMITTED ITEMS. Every citation id maps to an
 *    emitted item's `citation_id` and back. After any trim, citations are
 *    reconciled to exactly what survived, so no citation points at evidence the
 *    caller cannot see, and no surviving item loses its provenance.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthIdentity } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import type { RecoveryWalContextPackFragment } from "../realtime/recovery-wal.ts";
import {
  normalizeWorkingSetScope,
  type WorkingSetContextPackFragment,
  type WorkingSetScope,
} from "../realtime/working-set.ts";
import {
  createAllocator,
  wholePackBudgetFor,
} from "./context-pack-allocator.ts";
import { admitAppendSection } from "./context-pack-append-sections.ts";
import {
  agentContextPackStrictSchema,
  agentReflexPointersStrictSchema,
  parseAgentContextPackArgs,
  parseAgentReflexPointersArgs,
  type AgentContextPackArgs,
  type AgentReflexPointersArgs,
} from "./context-pack-args.ts";
import {
  assembleBudget,
  assemblePackWarnings,
  buildRecallSections,
  buildStructuredSections,
} from "./context-pack-assembly.ts";
import { CONTEXT_PACK_SECTION_PRIORITY } from "./context-pack-budget.ts";
import { POINTERS_SECTION_NAME } from "./context-pack-pointers.ts";
import { assembleSections, sectionsReceipt } from "./context-pack-payload.ts";
import {
  selectSections,
  type SectionSelection,
} from "./context-pack-selection.ts";
import { canReadNamespace } from "./read-scope.ts";
import { recoveryWalStoreFor, workingSetStoreFor } from "./realtime-stores.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import { authIdentity, errorResult, textResult } from "./types.ts";
import type { MemoryToolDependencies } from "./types.ts";

export { SECTION_NAMES } from "./context-pack-args.ts";
export { CONTEXT_PACK_SECTION_PRIORITY };

export interface AgentContextPackBuildResult {
  payload: unknown;
  isError: boolean;
}

/**
 * Authorize the call, resolving the namespace it reads.
 *
 * Returns the content-free denial payload instead when either gate refuses.
 */
function authorizePack(
  args: AgentContextPackArgs,
  auth: AuthIdentity | undefined,
):
  { denial: AgentContextPackBuildResult } | { auth: AuthIdentity; ns: string } {
  if (!auth || !canRead(auth.role, "sessions")) {
    return {
      denial: {
        payload: { error: "Permission denied: cannot read agent context pack" },
        isError: true,
      },
    };
  }
  const ns = args.namespace ?? auth.clientId;
  // Gate BEFORE any query runs, so an unauthorized namespace argument is a
  // denial rather than an empty result set — the two are indistinguishable to a
  // caller, and only one of them is honest.
  if (!canReadNamespace(auth, ns)) {
    return {
      denial: {
        payload: {
          error: `Permission denied: cannot read namespace '${ns}'`,
        },
        isError: true,
      },
    };
  }
  return { auth, ns };
}

/** The two append-store fragments, built before any allocation is charged. */
function loadAppendStores(options: {
  selection: SectionSelection;
  scope: WorkingSetScope;
  dependencies: MemoryToolDependencies;
}): {
  workingSet: WorkingSetContextPackFragment | null;
  recovery: RecoveryWalContextPackFragment | null;
} {
  const { selection, scope, dependencies } = options;
  return {
    workingSet: selection.workingSet
      ? workingSetStoreFor(dependencies).buildContextPackFragment(scope)
      : null,
    recovery: selection.recovery
      ? recoveryWalStoreFor(dependencies).buildContextPackFragment(scope)
      : null,
  };
}

export async function buildAgentContextPackPayload(
  args: AgentContextPackArgs,
  auth: AuthIdentity | undefined,
  dependencies: MemoryToolDependencies,
): Promise<AgentContextPackBuildResult> {
  const authorized = authorizePack(args, auth);
  if ("denial" in authorized) return authorized.denial;
  const { auth: identity, ns } = authorized;

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
  const selection = selectSections(args);

  // The auth-derived physical namespace is the single isolation predicate every
  // structured-section read binds to. Authorization already passed above, so
  // reaching here means this namespace is permitted; `physicalNamespace` maps
  // the canonical shared alias to its physical partition exactly as every other
  // isolated read path does, so two namespaces sharing a scope key or repo slug
  // never bleed across the boundary.
  const readNamespace = physicalNamespace(ns);

  const allocator = createAllocator(
    wholePackBudgetFor(args.budget?.max_tokens),
  );
  const stores = loadAppendStores({ selection, scope, dependencies });

  // ---- working_set (priority 1), recovery (priority 2) --------------------
  const workingSetSection = admitAppendSection({
    allocator,
    key: "working_set",
    section:
      (stores.workingSet?.working_set as Record<string, unknown> | undefined) ??
      null,
    reconciledCounts: ["item_count"],
  });
  // Both counts reconcile: `pending_count` is what the caller acts on, so a
  // trimmed section reporting the pre-trim pending count would overstate what
  // it actually handed over.
  const recoverySection = admitAppendSection({
    allocator,
    key: "recovery",
    section:
      (stores.recovery?.recovery as Record<string, unknown> | undefined) ??
      null,
    reconciledCounts: ["item_count", "pending_count"],
  });

  const recall = await buildRecallSections({
    allocator,
    selection,
    args,
    auth: identity,
    ns,
    dependencies,
  });

  const structured = await buildStructuredSections({
    allocator,
    selection,
    args,
    readNamespace,
    dependencies,
    memoryContext: recall.memoryContext,
    memorySection: recall.memorySection,
  });

  const sections = assembleSections({
    workingSet: workingSetSection,
    recovery: recoverySection,
    durableLane: recall.laneSection as Record<string, unknown> | null,
    durableMemory: recall.memorySection as Record<string, unknown> | null,
    structured: structured.sections,
  });

  return {
    payload: {
      schema: "openbrain.agent_context_pack.v1",
      status: "ok",
      scope: { namespace_source: "authorization", ...normalizedScope },
      sections,
      sections_receipt: sectionsReceipt(
        args.requested_sections ?? null,
        Object.keys(sections),
      ),
      warnings: assemblePackWarnings({
        selection,
        workingSet: stores.workingSet,
        recovery: stores.recovery,
        recall,
        allocator,
        structured,
      }),
      budget: assembleBudget({
        args,
        allocator,
        selection,
        workingSet: stores.workingSet,
        recovery: stores.recovery,
        recall,
      }),
      citations: [
        ...recall.laneCitations,
        ...recall.memoryCitations,
        ...structured.citations,
      ],
      query: args.query ?? null,
    },
    isError: false,
  };
}

export interface AgentReflexPointersBuildResult {
  payload: unknown;
  isError: boolean;
}

/**
 * Build the reflex-pointer payload (#334).
 *
 * A PURE PROJECTION over {@link buildAgentContextPackPayload}: it forces
 * `requested_sections: ["pointers"]` — so the shared recall runs once to feed
 * pointers and the durable_memory body is suppressed — then narrows the pack to
 * the body-free cited pointers plus the pointer-relevant envelope.
 *
 * It owns NO retrieval, dedupe, identity, or pointer logic. That is the entire
 * design: a reflex that fired on every turn with its own recall path would be a
 * second stack to keep in sync with the first, and the two would diverge.
 * Placement into the prompt is the CLIENT's job — this returns a small
 * structured envelope, never an implicit MCP `_meta` injection.
 */
export async function buildAgentReflexPointersPayload(
  args: AgentReflexPointersArgs,
  auth: AuthIdentity | undefined,
  dependencies: MemoryToolDependencies,
): Promise<AgentReflexPointersBuildResult> {
  const packResult = await buildAgentContextPackPayload(
    { ...args, requested_sections: ["pointers"] },
    auth,
    dependencies,
  );

  if (packResult.isError) {
    // Permission/namespace denial already produced a content-free error payload;
    // pass it through unchanged so the reflex never invents its own auth message.
    return { payload: packResult.payload, isError: true };
  }

  const pack = packResult.payload as {
    schema: string;
    status: string;
    scope: Record<string, unknown>;
    sections: { pointers?: Record<string, unknown> };
    warnings: {
      truncation?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    budget: Record<string, unknown>;
    citations: Array<Record<string, unknown>>;
    query: string | null;
  };

  // The pointers section is always present for a pointers request UNLESS the
  // budget starved even its empty envelope out, in which case the pack omits the
  // body and records a starved truncation. Project that case to the reflex's own
  // empty shape, but derive `truncated`/`empty_reason` from the ACTUAL upstream
  // warning — fabricating `truncated: false` here would contradict the warning
  // the same response carries.
  const pointerBudgetStarvation = pack.warnings.truncation?.find(
    (warning) =>
      warning.source === POINTERS_SECTION_NAME &&
      warning.reason === "whole_pack_budget" &&
      warning.starved === true,
  );
  const pointers = pack.sections.pointers ?? {
    label: POINTERS_SECTION_NAME,
    namespace_scoped: true,
    resolvable_reference_only: true,
    items: [],
    item_count: 0,
    truncated: pointerBudgetStarvation !== undefined,
    ...(pointerBudgetStarvation ? { empty_reason: "whole_pack_budget" } : {}),
  };

  return {
    payload: {
      schema: "openbrain.agent_reflex_pointers.v1",
      status: pack.status,
      // Placement ownership is explicit and body-free: Open Brain returns
      // resolvable pointers; the client decides whether and how to place them.
      placement: "client_owned",
      resolvable_reference_only: true,
      scope: pack.scope,
      pointers,
      // Carried through so the reflex is honest about budget pressure and any
      // degraded or denied shared recall.
      warnings: pack.warnings,
      budget: pack.budget,
      // For a pointers-only request the pack's citation list is exactly the
      // emitted pointers' citations — the bijection holds through the projection.
      citations: pack.citations,
      query: pack.query,
    },
    isError: false,
  };
}

export function registerAgentContextPackTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "agent_context_pack",
    {
      description:
        "Build a scoped realtime agent context pack. working_set uses exact " +
        "active scope; recovery requires explicit unreviewed-recovery opt-in; " +
        "durable_lane_context is queried only when explicitly requested and " +
        "returns bounded lane/events only after all seven scope coordinates match. " +
        "pointers surfaces body-free resolvable references to durable records not " +
        "emitted as durable_memory items, reusing the single durable_memory recall; " +
        "candidate_memory is a truthful empty section (no candidate predicate yet) " +
        "that never drives its own recall.",
      // The STRICT object, not the raw shape: the SDK strips unknown keys from
      // a raw shape before dispatch, which is the #535 silent-default defect.
      // See `context-pack-args.ts` `rejectUnknownRequestKeys`.
      inputSchema: agentContextPackStrictSchema,
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
        authIdentity(extra.authInfo),
        dependencies,
      );
      return result.isError
        ? errorResult(JSON.stringify(result.payload))
        : textResult(result.payload);
    },
  );
}

export function registerAgentReflexPointersTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "agent_reflex_pointers",
    {
      description:
        "Per-turn reflex that returns budget-bounded, body-free, cited " +
        "resolvable pointers to durable records relevant to the current query. " +
        "It reuses the single agent_context_pack durable_memory hybrid recall and " +
        "pointer machinery (no second retrieval or pointer stack) with " +
        "prior-context suppression applied, and emits NO memory bodies — every " +
        "pointer carries identity/source_ref/structural metadata only, resolvable " +
        "through the authorized read path (get_entry, table = source_ref.type + " +
        '"s", id = source_ref.id). Placement into the model prompt is client-owned; ' +
        "this tool never performs implicit _meta injection.",
      inputSchema: agentReflexPointersStrictSchema,
      annotations: {
        title: "Agent Reflex Pointers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const result = await buildAgentReflexPointersPayload(
        parseAgentReflexPointersArgs(args),
        authIdentity(extra.authInfo),
        dependencies,
      );
      return result.isError
        ? errorResult(JSON.stringify(result.payload))
        : textResult(result.payload);
    },
  );
}
