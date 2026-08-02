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
  agentContextPackInputSchema,
  agentReflexPointersInputSchema,
  parseAgentContextPackArgs,
  parseAgentReflexPointersArgs,
  type AgentContextPackArgs,
  type AgentReflexPointersArgs,
} from "./context-pack-args.ts";
import {
  CHARS_PER_TOKEN,
  CONTEXT_PACK_SECTION_PRIORITY,
  durableLaneContentChars,
  durableMemoryContentChars,
  fitDurableLaneSection,
  fitItemSection,
  fitRankedItemSection,
  reconcileCitedItemCitations,
  reconcileDurableMemoryCitations,
  sectionFrameCost,
  serializedLength,
  type DurableLaneSection,
  type DurableMemorySection,
} from "./context-pack-budget.ts";
import {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  loadDurableLaneContext,
} from "./context-pack-durable-lane.ts";
import { loadDurableMemoryContext } from "./context-pack-durable-memory.ts";
import {
  loadGuidanceSection,
  type GuidanceSectionName,
} from "./context-pack-guidance.ts";
import {
  buildCandidateSection,
  buildPointerSection,
  POINTERS_SECTION_NAME,
} from "./context-pack-pointers.ts";
import { loadRepoFactsSection } from "./context-pack-repo-facts.ts";
import type { SectionFragment } from "./context-pack-sections.ts";
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

export async function buildAgentContextPackPayload(
  args: AgentContextPackArgs,
  auth: AuthIdentity | undefined,
  dependencies: MemoryToolDependencies,
): Promise<AgentContextPackBuildResult> {
  if (!auth || !canRead(auth.role, "sessions")) {
    return {
      payload: { error: "Permission denied: cannot read agent context pack" },
      isError: true,
    };
  }

  const ns = args.namespace ?? auth.clientId;
  // Gate BEFORE any query runs, so an unauthorized namespace argument is a
  // denial rather than an empty result set — the two are indistinguishable to a
  // caller, and only one of them is honest.
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

  // Section selection. Absent `requested_sections` means working_set only;
  // every other section is opt-in, because each one costs a query and a caller
  // that wanted the whole brain would have said so.
  const includeWorkingSet =
    !args.requested_sections || args.requested_sections.includes("working_set");
  const includeRecovery =
    args.include_unreviewed_recovery === true &&
    (!args.requested_sections || args.requested_sections.includes("recovery"));
  const includeDurableLaneContext =
    args.requested_sections?.includes("durable_lane_context") === true;
  const includeDurableMemorySection =
    args.requested_sections?.includes("durable_memory") === true;
  const includeProfileGuidance =
    args.requested_sections?.includes("profile_guidance") === true;
  const includeProcessGuidance =
    args.requested_sections?.includes("process_guidance") === true;
  const includeRepoFacts =
    args.requested_sections?.includes("repo_facts") === true;
  const includePointers = args.requested_sections?.includes("pointers") === true;
  const includeCandidateMemory =
    args.requested_sections?.includes("candidate_memory") === true;

  // INVARIANT 1. pointers derives from the durable_memory recall, so requesting
  // EITHER runs that single recall — its net-new pool and emitted identities are
  // then available even when the durable_memory SECTION body is not requested
  // for output. candidate_memory does NOT drive recall: it has no predicate, so
  // a candidate-only request must issue zero recall queries.
  const includeDurableMemory = includeDurableMemorySection || includePointers;

  // The auth-derived physical namespace is the single isolation predicate every
  // structured-section read binds to. Authorization already passed above, so
  // reaching here means this namespace is permitted; `physicalNamespace` maps
  // the canonical shared alias to its physical partition exactly as every other
  // isolated read path does, so two namespaces sharing a scope key or repo slug
  // never bleed across the boundary.
  const readNamespace = physicalNamespace(ns);

  // Whole-pack char budget. Absent max_tokens => no whole-pack bound, and every
  // section keeps its independent per-section behavior.
  const wholePackBudget =
    args.budget?.max_tokens !== undefined
      ? Math.max(
          0,
          args.budget.max_tokens * CHARS_PER_TOKEN -
            CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
        )
      : null;
  // The declared limit must always admit the irreducible two-character `{}` that
  // JSON.stringify emits even when every section is omitted. At tiny budgets the
  // budget clamps to 0, so the REPORTED limit is raised to that floor; section
  // MEMBERS still get zero of it (see remainingChars), so no body is admitted.
  const wholePackSerializedLimit =
    wholePackBudget !== null ? Math.max(2, wholePackBudget) : null;
  // Reserve the enclosing `{}` once, so the running budget bounds the serialized
  // `sections` object rather than merely the summed bodies.
  let remainingChars =
    wholePackBudget !== null
      ? Math.max(0, wholePackBudget - 2)
      : Number.POSITIVE_INFINITY;
  // Object framing is position-sensitive: the first admitted member costs
  // `"key":<body>`, each subsequent one adds a comma. This flips only when a
  // section is ACTUALLY admitted, so a starved candidate never consumes the
  // comma-free first slot and mis-charge the next section.
  let firstSectionAdmitted = true;
  const wholePackTruncation: Array<Record<string, unknown>> = [];

  const workingSet: WorkingSetContextPackFragment | null = includeWorkingSet
    ? workingSetStoreFor(dependencies).buildContextPackFragment(scope)
    : null;
  const recovery: RecoveryWalContextPackFragment | null = includeRecovery
    ? recoveryWalStoreFor(dependencies).buildContextPackFragment(scope)
    : null;

  // ---- working_set (priority 1) -------------------------------------------
  let workingSetSection: Record<string, unknown> | null =
    (workingSet?.working_set as Record<string, unknown> | undefined) ?? null;
  if (workingSetSection) {
    const frame = sectionFrameCost("working_set", firstSectionAdmitted);
    const serving = Math.max(0, remainingChars - frame);
    const fitted = fitItemSection(
      workingSetSection as unknown as {
        items: Array<{ id: string }>;
        item_count: number;
      },
      ["item_count"],
      serving,
    );
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      // Even the empty envelope does not fit: omit the section to hold the hard
      // budget. Not admitted, so the first-member slot stays available.
      workingSetSection = null;
    } else {
      workingSetSection = fitted.section as unknown as Record<string, unknown>;
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

  // ---- recovery (priority 2) ----------------------------------------------
  let recoverySection: Record<string, unknown> | null =
    (recovery?.recovery as Record<string, unknown> | undefined) ?? null;
  if (recoverySection) {
    const frame = sectionFrameCost("recovery", firstSectionAdmitted);
    const serving = Math.max(0, remainingChars - frame);
    // Both counts reconcile: `pending_count` is what the caller acts on, so a
    // trimmed section reporting the pre-trim pending count would overstate what
    // it actually handed over.
    const fitted = fitItemSection(
      recoverySection as unknown as {
        items: Array<{ id: string }>;
        item_count: number;
        pending_count: number;
      },
      ["item_count", "pending_count"],
      serving,
    );
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      recoverySection = null;
    } else {
      recoverySection = fitted.section as unknown as Record<string, unknown>;
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

  // ---- durable_lane_context (priority 3) ----------------------------------
  // The loader trims raw content chars, but the serialized section also carries
  // lane metadata, per-event wrappers, and citation ids. To keep the SERIALIZED
  // section within budget, seed the loader with a content limit and then re-fit
  // the result, dropping oldest events and finally trimming the checkpoint.
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
    ? await loadDurableLaneContext(
        args,
        ns,
        dependencies,
        durableLaneContentLimit,
      )
    : null;
  let durableLaneSection = durableLaneContext?.section ?? null;
  let durableCitations = durableLaneSection
    ? (durableLaneContext?.citations ?? [])
    : [];
  // True only when a LOADED section is dropped by the re-fit, so the reconciled
  // budget can report zero content emitted rather than the loader's pre-fit
  // selection.
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
      // Even the trimmed section overflows: omit it AND drop its citations, so
      // the pack stays in budget and no citation references an unemitted section.
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

  // Reconcile content_chars_used to what actually survived. A starved-out
  // section reports zero, so the budget never claims usage for content the
  // caller did not receive.
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

  // ---- durable_memory (priority 4) ----------------------------------------
  const durableMemoryFrame = sectionFrameCost(
    "durable_memory",
    firstSectionAdmitted,
  );
  const durableMemoryServingChars =
    wholePackBudget === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, remainingChars - durableMemoryFrame);
  const durableMemoryContentLimit =
    wholePackBudget === null
      ? undefined
      : Number.isFinite(durableMemoryServingChars)
        ? Math.floor(durableMemoryServingChars)
        : undefined;
  const durableMemoryContext = includeDurableMemory
    ? await loadDurableMemoryContext(
        args,
        auth,
        ns,
        dependencies,
        durableMemoryContentLimit,
      )
    : null;
  // The SECTION is only fitted/emitted/charged when explicitly requested. When
  // the recall ran ONLY to feed pointers, the body is suppressed here while its
  // pool and identities still flow to the builders below.
  let durableMemorySection = includeDurableMemorySection
    ? (durableMemoryContext?.section ?? null)
    : null;
  let durableMemoryCitations = durableMemorySection
    ? (durableMemoryContext?.citations ?? [])
    : [];
  let durableMemoryStarvedOut = false;
  if (durableMemorySection && wholePackBudget !== null) {
    // Relevance-ordered: drop the LOWEST-ranked tail, preserving the best recall.
    const fitted = fitRankedItemSection(
      durableMemorySection as {
        items: Array<{ citation_id?: unknown }>;
        item_count: number;
      },
      ["item_count"],
      durableMemoryServingChars,
    );
    if (
      fitted.starved &&
      serializedLength(fitted.section) > durableMemoryServingChars
    ) {
      durableMemorySection = null;
      durableMemoryCitations = [];
      durableMemoryStarvedOut = true;
      wholePackTruncation.push({
        source: "durable_memory",
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
        starved: true,
      });
    } else {
      durableMemorySection = fitted.section;
      durableMemoryCitations = reconcileDurableMemoryCitations(
        durableMemoryCitations,
        (durableMemorySection as DurableMemorySection).items ?? [],
      );
      remainingChars = Math.max(
        0,
        remainingChars -
          serializedLength(durableMemorySection) -
          durableMemoryFrame,
      );
      firstSectionAdmitted = false;
      if (fitted.truncated) {
        wholePackTruncation.push({
          source: "durable_memory",
          reason: "whole_pack_budget",
          max_chars: wholePackBudget,
        });
      }
    }
  } else if (durableMemorySection) {
    remainingChars = Math.max(
      0,
      remainingChars -
        serializedLength(durableMemorySection) -
        durableMemoryFrame,
    );
    firstSectionAdmitted = false;
  }

  const durableMemoryBudget =
    wholePackBudget !== null && durableMemoryContext?.budget
      ? durableMemorySection
        ? {
            ...durableMemoryContext.budget,
            content_chars_used: durableMemoryContentChars(
              durableMemorySection as DurableMemorySection,
            ),
          }
        : durableMemoryStarvedOut
          ? { ...durableMemoryContext.budget, content_chars_used: 0 }
          : durableMemoryContext.budget
      : durableMemoryContext?.budget;

  // ---- structured sections (priorities 5-9) -------------------------------
  // guidance, repo_facts, pointers, candidate_memory are all self-contained
  // fragments admitted through ONE fitter, so they share a single whole-pack
  // budget, citation, and truncation reconciliation. Each binds `readNamespace`,
  // derives selection only from explicit typed metadata (never inferred from raw
  // conversation), returns a defined empty state, and degrades content-free.
  const structuredSectionQuery = async (
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    const result = await dependencies.pool.query(sql, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };

  const structuredScopeDenials: Array<Record<string, unknown>> = [];
  const structuredDegradedSources: Array<Record<string, unknown>> = [];
  const structuredTruncation: Array<Record<string, unknown>> = [];
  const structuredCitations: Array<Record<string, unknown>> = [];
  const structuredSections: Array<{
    key: string;
    section: Record<string, unknown>;
  }> = [];

  /**
   * Fit one assembled fragment into the surviving budget, reconcile its
   * citations to the surviving items, and record its warnings.
   *
   * Trim direction is `"tail"` here, unlike working_set/recovery. Those append
   * stores are oldest-first so the front sheds; these loaders emit
   * newest/current first (`ORDER BY ... DESC`), so the head must survive.
   * Front-dropping would keep stale older guidance and shed the newest rules.
   */
  const admitStructuredSection = (
    key: string,
    fragment: SectionFragment,
  ): void => {
    // Content-free denials and degraded sources ALWAYS propagate: they carry no
    // body, only a reason, and the caller needs them even when the section is
    // omitted (e.g. no_active_repo, database_unavailable).
    structuredScopeDenials.push(...fragment.scopeDenials);
    structuredDegradedSources.push(...fragment.degradedSources);

    const body = fragment.section;
    // Hard internal error path: no body to fit; the degraded marker above is the
    // whole story.
    if (!body) return;

    const citations = fragment.citations;

    if (wholePackBudget === null) {
      structuredSections.push({ key, section: body });
      structuredTruncation.push(...fragment.truncation);
      structuredCitations.push(...citations);
      firstSectionAdmitted = false;
      return;
    }

    const frame = sectionFrameCost(key, firstSectionAdmitted);
    const serving = Math.max(0, remainingChars - frame);
    const fitted = fitItemSection(
      body as { items: Array<{ id: string }>; item_count: number },
      ["item_count"],
      serving,
      "tail",
    );
    // A downstream reader trusts the section body, not just the warnings
    // channel, so a trimmed body must say so on its OWN `truncated` flag. When
    // the trim empties it but the envelope still fits, stamp
    // `empty_reason='whole_pack_budget'` so the empty state reads as
    // budget-starved rather than as a genuine no-data result. Reconciled BEFORE
    // the overflow checks so the extra keys count against the budget.
    if (fitted.truncated) {
      const survivedBody = fitted.section as Record<string, unknown>;
      survivedBody.truncated = true;
      if ((survivedBody.item_count as number) === 0) {
        survivedBody.empty_reason = "whole_pack_budget";
      }
    }
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      structuredTruncation.push({
        source: key,
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
        starved: true,
      });
      return;
    }

    const survived = fitted.section as Record<string, unknown>;
    structuredSections.push({ key, section: survived });
    remainingChars = Math.max(
      0,
      remainingChars - serializedLength(survived) - frame,
    );
    firstSectionAdmitted = false;
    // INVARIANT 3: citations reconciled to exactly the surviving items.
    structuredCitations.push(
      ...reconcileCitedItemCitations(citations, survived),
    );
    // A section's own truncation notices only make sense when its body was
    // emitted; a fully-starved section is covered by the starved marker above.
    structuredTruncation.push(...fragment.truncation);
    if (fitted.truncated) {
      structuredTruncation.push({
        source: key,
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
      });
    }
  };

  const guidanceRequests: Array<{
    include: boolean;
    section: GuidanceSectionName;
  }> = [
    { include: includeProfileGuidance, section: "profile_guidance" },
    { include: includeProcessGuidance, section: "process_guidance" },
  ];
  for (const request of guidanceRequests) {
    if (!request.include) continue;
    const fragment = await loadGuidanceSection(
      { section: request.section, namespace: readNamespace },
      { query: structuredSectionQuery },
      dependencies.logger,
    );
    admitStructuredSection(request.section, fragment);
  }

  if (includeRepoFacts) {
    // `nowMs` is captured ONCE so staleness dispositions are deterministic
    // across one pack build. `repo` absent -> the loader's no-active-repo empty
    // state; it never falls back to another repository.
    const repoFactsFragment = await loadRepoFactsSection(
      { namespace: readNamespace, repo: args.repo ?? null, nowMs: Date.now() },
      { query: structuredSectionQuery },
      dependencies.logger,
    );
    admitStructuredSection("repo_facts", repoFactsFragment);
  }

  const durablePool = durableMemoryContext?.pointerCandidatePool ?? [];
  // Pointer eligibility is decided against the identities ACTUALLY RETAINED in
  // the FINAL fitted durable_memory output — not the loader's pre-fit set. When
  // the section is suppressed (pointers-only) this is empty, so every authorized
  // row is pointer-eligible; when the re-fit trimmed durable rows, those rows
  // are absent here and stay pointer-eligible instead of being silently lost.
  const retainedDurableIdentities: string[] = [];
  if (durableMemorySection) {
    const retainedItems =
      (durableMemorySection as { items?: Array<{ citation_id?: unknown }> })
        .items ?? [];
    for (const item of retainedItems) {
      if (typeof item.citation_id === "string") {
        retainedDurableIdentities.push(item.citation_id);
      }
    }
  }

  // When the durable_memory section is suppressed for output but its recall ran,
  // its content-free warnings attach to the FIRST admitted #329 section, so a
  // failed shared recall surfaces exactly once instead of being swallowed.
  let sharedRecallWarningsPending =
    includeDurableMemory && !includeDurableMemorySection;
  const foldSharedRecallWarnings = (fragment: SectionFragment): void => {
    if (!sharedRecallWarningsPending) return;
    sharedRecallWarningsPending = false;
    fragment.scopeDenials.push(...(durableMemoryContext?.scopeDenials ?? []));
    fragment.degradedSources.push(
      ...(durableMemoryContext?.degradedSources ?? []),
    );
  };

  if (includePointers) {
    const pointerFragment = buildPointerSection({
      pool: durablePool,
      durableIdentities: retainedDurableIdentities,
    });
    foldSharedRecallWarnings(pointerFragment);
    admitStructuredSection(POINTERS_SECTION_NAME, pointerFragment);
  }

  if (includeCandidateMemory) {
    // Takes no pool and drives no recall (see INVARIANT 1).
    const candidateFragment = buildCandidateSection();
    foldSharedRecallWarnings(candidateFragment);
    admitStructuredSection("candidate_memory", candidateFragment);
  }

  const sections: Record<string, unknown> = {};
  if (workingSetSection) sections.working_set = workingSetSection;
  if (recoverySection) sections.recovery = recoverySection;
  if (durableLaneSection) sections.durable_lane_context = durableLaneSection;
  if (durableMemorySection) sections.durable_memory = durableMemorySection;
  for (const { key, section } of structuredSections) sections[key] = section;

  return {
    payload: {
      schema: "openbrain.agent_context_pack.v1",
      status: "ok",
      scope: { namespace_source: "authorization", ...normalizedScope },
      sections,
      warnings: {
        scope_denials: [
          ...(workingSet ? workingSet.warnings.scope_denials : []),
          ...(recovery ? recovery.warnings.scope_denials : []),
          ...(durableLaneContext?.scopeDenials ?? []),
          // Emitted here ONLY when the section was requested for output; when
          // the recall ran solely for pointers/candidates these are folded into
          // those fragments instead, so they surface exactly once.
          ...(includeDurableMemorySection
            ? (durableMemoryContext?.scopeDenials ?? [])
            : []),
          ...structuredScopeDenials,
        ],
        degraded_sources: [
          ...(durableLaneContext?.degradedSources ?? []),
          ...(includeDurableMemorySection
            ? (durableMemoryContext?.degradedSources ?? [])
            : []),
          ...structuredDegradedSources,
        ],
        truncation: [
          ...(durableLaneSection ? (durableLaneContext?.truncation ?? []) : []),
          ...(durableMemorySection
            ? (durableMemoryContext?.truncation ?? [])
            : []),
          ...wholePackTruncation,
          ...structuredTruncation,
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
        // Reported only when the section was requested for output. A recall that
        // ran solely to feed pointers reports no durable_memory budget block,
        // because that section is absent.
        ...(includeDurableMemorySection && durableMemoryContext
          ? { durable_memory: durableMemoryBudget }
          : {}),
      },
      citations: [
        ...durableCitations,
        ...durableMemoryCitations,
        ...structuredCitations,
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
      inputSchema: agentReflexPointersInputSchema,
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
