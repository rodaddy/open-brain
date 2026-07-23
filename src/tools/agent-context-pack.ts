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
import { loadDurableMemoryContext } from "./agent-context-pack-durable-memory.ts";
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
} from "./agent-context-pack-budget.ts";
import { physicalNamespace } from "../shared-namespace.ts";
import {
  loadGuidanceSection,
  type GuidanceSectionName,
} from "./agent-context-pack-guidance.ts";
import { loadRepoFactsSection } from "./agent-context-pack-repo-facts.ts";
import {
  buildCandidateSection,
  buildPointerSection,
} from "./agent-context-pack-pointers-candidates.ts";
import type { SectionFragment } from "./agent-context-pack-sections.ts";

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

/**
 * One explicit prior-context reference: an identifier or structural source
 * pointer for a record already supplied to the model this turn. Only resolvable
 * identity is accepted — never raw prior-context text — and at least one of
 * `citation_id`/`source_ref` must be present so the reference is addressable
 * without inspecting a body. `source_ref` accepts the string or structural form
 * the recall emits, so a caller can echo back an item's own `source_ref`.
 */
export const priorContextReferenceInputSchema = z
  .object({
    citation_id: z.string().trim().min(1).max(500).optional(),
    source_ref: z
      .union([
        z.string().trim().min(1).max(1000),
        z
          .object({
            source: z.string().trim().min(1).max(200),
            type: z.string().trim().min(1).max(200),
            id: z.string().trim().min(1).max(500),
            namespace: z.string().trim().min(1).max(200).optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.citation_id !== undefined || value.source_ref !== undefined,
    {
      message: "prior_context reference requires citation_id or source_ref",
      path: ["citation_id"],
    },
  );

export const agentContextPackInputSchema = {
  ...scopeInputSchema,
  query: z.string().max(4000).optional(),
  repo: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Active repository slug (e.g. owner/name) that repo_facts binds to exactly. " +
        "When absent, repo_facts returns its defined no-active-repo empty state; " +
        "repo_facts never falls back to any other repository.",
    ),
  prior_context: z
    .array(priorContextReferenceInputSchema)
    .max(200)
    .optional()
    .describe(
      "Explicit identifiers/source refs already supplied to the model this " +
        "turn. durable_memory recall removes records already represented by " +
        "these references and returns only net-new results. Raw prior-context " +
        "text is never accepted; references carry resolvable identity only.",
    ),
  requested_sections: z
    .array(z.enum(SECTION_NAMES))
    .optional()
    .describe(
      "Sections to assemble. durable_lane_context is queried only when explicitly requested and requires all seven exact scope coordinates. profile_guidance, process_guidance, and repo_facts are each queried only when explicitly requested.",
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
  const includeDurableMemorySection =
    args.requested_sections?.includes("durable_memory") === true;
  const includeProfileGuidance =
    args.requested_sections?.includes("profile_guidance") === true;
  const includeProcessGuidance =
    args.requested_sections?.includes("process_guidance") === true;
  const includeRepoFacts =
    args.requested_sections?.includes("repo_facts") === true;
  const includePointers =
    args.requested_sections?.includes("pointers") === true;
  const includeCandidateMemory =
    args.requested_sections?.includes("candidate_memory") === true;
  // pointers and candidate_memory are derived from the durable_memory hybrid
  // recall — the single retrieval stack. Requesting either runs that recall so
  // its net-new surplus pool and emitted-identity set are available, even when
  // the durable_memory SECTION itself was not requested for output. The
  // durable_memory section body is still only ADDED to the pack when it was
  // explicitly requested (includeDurableMemorySection).
  const includeDurableMemory =
    includeDurableMemorySection || includePointers || includeCandidateMemory;

  // The auth-derived physical namespace is the single isolation predicate every
  // structured-section read binds to. `canReadNamespace(auth, ns)` above already
  // failed an unauthorized explicit namespace override BEFORE any query runs, so
  // reaching here means this namespace is authorized. `physicalNamespace` maps
  // the canonical shared alias to its physical partition exactly as every other
  // namespace-isolated read-policy path does, so two namespaces sharing a scope
  // key or repo slug never bleed across the boundary.
  const readNamespace = physicalNamespace(ns);

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
      // durable_memory frames after durable_lane_context, so record that a
      // member was admitted to keep the first-member framing invariant honest
      // for the section that follows.
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

  // durable_memory is the lowest-priority section: query-driven hybrid recall
  // over the caller's readable durable brain records, isolated to the
  // auth-derived namespace. It is assembled against whatever budget survives the
  // higher-priority sections, seeded with a content limit and then re-fit against
  // remainingChars by dropping the lowest-ranked (tail) records so the highest
  // RRF-ranked recall is preserved under pressure. Counts, citations, and
  // truncation are reconciled to whatever survives. Without a whole-pack budget
  // the loader keeps its historical per-section derivation and no re-fit runs.
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
        deps,
        durableMemoryContentLimit,
      )
    : null;
  // The durable_memory SECTION is only fitted/emitted/charged when it was
  // explicitly requested. When the recall ran ONLY to feed pointers/candidates
  // (includeDurableMemory true via includePointers/includeCandidateMemory but
  // includeDurableMemorySection false), the section body is suppressed here while
  // its surplus pool and identities still flow to the pointer/candidate builders
  // below.
  let durableMemorySection = includeDurableMemorySection
    ? (durableMemoryContext?.section ?? null)
    : null;
  let durableMemoryCitations = durableMemorySection
    ? (durableMemoryContext?.citations ?? [])
    : [];
  let durableMemoryStarvedOut = false;
  if (durableMemorySection && wholePackBudget !== null) {
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
      // Even the empty durable-memory envelope overflows the surviving budget:
      // omit it and drop its citations so the whole pack stays within budget and
      // no citation references an unemitted section. The starved truncation
      // marker still signals that the requested section was dropped.
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

  // Reconcile durable_memory content_chars_used to the content that survived the
  // whole-pack re-fit, mirroring the durable-lane reconciliation. Without a
  // whole-pack budget the loader's own accounting is authoritative.
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

  // Structured guidance / repo_facts sections (post-#353 integration).
  //
  // These three sections are the lowest-priority members: they are assembled
  // only after every higher-value section has claimed the budget, so under
  // whole-pack pressure a higher-priority section always survives while these are
  // the first to be trimmed or starved. Each is a self-contained item-bearing
  // fragment (loadGuidanceSection / loadRepoFactsSection) that:
  //   - binds the auth-derived `readNamespace` predicate (isolation boundary),
  //   - derives selection only from explicit typed durable metadata (promoted
  //     user_preference / process_rule; exact-repo repo_fact) — never inferred
  //     from raw conversation content,
  //   - returns a defined empty state (never fabricated guidance/facts),
  //   - degrades content-free on database failure,
  //   - carries a citation_id + bounded source_ref on every item.
  //
  // Fitting is item-bearing sections keyed by `id`, fit by serialized length,
  // with citations reconciled to the surviving items after the re-fit so the
  // citation set stays a bijection of the emitted items. When there is no
  // whole-pack budget the loader's per-section item budget is authoritative and
  // no re-fit runs.
  //
  // Trim direction differs from working_set/recovery: those append stores are
  // oldest-first (newest at the tail), so fitItemSection drops the front. These
  // three loaders emit newest/current items first (ORDER BY created_at DESC /
  // updated_at DESC), so the current head must survive and the oldest/lowest-
  // priority tail is dropped — fitItemSection(..., "tail"). Front-dropping here
  // would keep stale older guidance/facts and shed the newest current ones.
  //
  // A section-level SectionQuery wrapper adapts the shared read pool to the
  // section modules' minimal query surface.
  const structuredSectionQuery = async (
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    const result = await deps.pool.query(sql, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };

  // Accumulators for the structured-section warnings/citations merged into the
  // envelope below. Each entry is the fragment plus the section body that
  // actually survived the whole-pack re-fit (null when omitted to hold budget).
  const structuredScopeDenials: Array<Record<string, unknown>> = [];
  const structuredDegradedSources: Array<Record<string, unknown>> = [];
  const structuredTruncation: Array<Record<string, unknown>> = [];
  const structuredCitations: Array<Record<string, unknown>> = [];
  const structuredSections: Array<{
    key: string;
    section: Record<string, unknown>;
  }> = [];

  // Fit one already-assembled structured fragment into the surviving whole-pack
  // budget, reconcile its citations to the surviving items, and record its
  // warnings. Returns nothing; it mutates the shared budget/framing state and the
  // accumulators above, exactly like the higher-priority section blocks.
  const admitStructuredSection = (
    key: string,
    fragment: SectionFragment,
  ): void => {
    // Content-free scope denials / degraded sources always propagate: they carry
    // no body, only a reason, and the caller needs them even when the section
    // itself is omitted (e.g. no_active_repo, database_unavailable).
    structuredScopeDenials.push(...fragment.scopeDenials);
    structuredDegradedSources.push(...fragment.degradedSources);

    const body = fragment.section;
    if (!body) {
      // Hard internal error path (database_unavailable): no section body to fit;
      // the degraded-source marker above is the whole story.
      return;
    }

    const citations = fragment.citations;

    if (wholePackBudget === null) {
      // No whole-pack budget: the loader's own item budget is authoritative.
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
    // Whole-pack truth: when the re-fit drops any item the emitted body must say
    // so on its own `truncated` flag — a downstream reader trusts the section
    // body, not just the warnings channel. When the trim empties the retained
    // items but the empty envelope is still admitted, stamp
    // `empty_reason='whole_pack_budget'` so the emitted empty state truthfully
    // states the budget starved it rather than reading as a genuine no-data
    // empty. Reconcile before the serving/overflow checks below so the extra
    // keys are counted against the surviving whole-pack budget. `fitted.section`
    // is a fresh object unless nothing was trimmed (fitted.truncated === false),
    // so this never mutates the loader's genuine-empty body.
    if (fitted.truncated) {
      const survivedBody = fitted.section as Record<string, unknown>;
      survivedBody.truncated = true;
      if ((survivedBody.item_count as number) === 0) {
        survivedBody.empty_reason = "whole_pack_budget";
      }
    }
    if (fitted.starved && serializedLength(fitted.section) > serving) {
      // Even the empty envelope overflows the surviving budget: omit the section
      // to hold the hard whole-pack budget, and drop its citations so no citation
      // references an unemitted section. The starved marker still tells the
      // caller the requested section was fully dropped.
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
    // Reconcile citations to exactly the items that survived the re-fit.
    structuredCitations.push(
      ...reconcileCitedItemCitations(citations, survived),
    );
    // The section's own truncation notices only make sense when its body was
    // emitted; a fully-starved (omitted) section is covered by the starved
    // marker above instead.
    structuredTruncation.push(...fragment.truncation);
    if (fitted.truncated) {
      structuredTruncation.push({
        source: key,
        reason: "whole_pack_budget",
        max_chars: wholePackBudget,
      });
    }
  };

  // Assemble in priority order (profile_guidance, then process_guidance, then
  // repo_facts) so the deterministic allocation order matches
  // CONTEXT_PACK_SECTION_PRIORITY and each sees only the budget its predecessors
  // leave behind.
  const guidanceRequests: Array<{
    include: boolean;
    section: GuidanceSectionName;
  }> = [
    { include: includeProfileGuidance, section: "profile_guidance" },
    { include: includeProcessGuidance, section: "process_guidance" },
  ];
  for (const req of guidanceRequests) {
    if (!req.include) continue;
    const fragment = await loadGuidanceSection(
      { section: req.section, namespace: readNamespace },
      { query: structuredSectionQuery },
    );
    admitStructuredSection(req.section, fragment);
  }

  if (includeRepoFacts) {
    // repo_facts binds the requested active repository exactly. `nowMs` is
    // captured once so staleness dispositions are deterministic for one pack
    // build. `repo` absent -> the loader's defined no-active-repo empty state;
    // it never falls back to another repository.
    const repoFactsFragment = await loadRepoFactsSection(
      {
        namespace: readNamespace,
        repo: args.repo ?? null,
        nowMs: Date.now(),
      },
      { query: structuredSectionQuery },
    );
    admitStructuredSection("repo_facts", repoFactsFragment);
  }

  // pointers + candidate_memory (#329): the lowest-priority members, admitted
  // LAST after repo_facts. Both are pure transforms over the durable_memory
  // recall's already-authorized, already-suppressed surplus pool — no second
  // retrieval stack. Pointers dedupe against the durable identities the recall
  // already emitted; candidates dedupe against durable identities AND the
  // pointers just emitted. Each is admitted through the SAME structured-section
  // fitter so it shares one whole-pack budget, citation, and truncation
  // reconciliation with guidance/repo_facts.
  //
  // The recall pool is empty (and dedupe/identity sets empty) when durable
  // recall did not run, returned nothing, or degraded — the builders then emit
  // their defined empty envelopes. When the durable_memory SECTION itself was
  // not requested for output, the shared recall's content-free scope-denial /
  // degraded-source warnings are surfaced through these sections instead (folded
  // in once) so a failed shared recall is never silently swallowed.
  const durablePool = durableMemoryContext?.pointerCandidatePool ?? [];
  // Pointer eligibility is decided against the durable identities ACTUALLY
  // retained in the FINAL fitted durable_memory output — not the loader's
  // pre-fit emitted set. When the durable_memory section is suppressed for output
  // (pointers-only request) this is empty, so every authorized recalled row is
  // pointer-eligible. When the whole-pack re-fit trimmed or starved out durable
  // rows, those rows are absent here and stay pointer-eligible instead of being
  // silently lost. `citation_id` on each retained item is the canonical
  // `brain_record:${source_type}:${id}` identity.
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
  // Identities the pointer builder actually emitted, so candidates dedupe
  // against durable memory AND pointers. Populated during pointer admission.
  const pointerEmittedIdentities: string[] = [];
  // When the durable_memory section is suppressed for output but its recall ran
  // for pointers/candidates, its recall warnings attach to the first admitted
  // #329 section so they are emitted exactly once.
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
    // Capture the canonical identities pointers emitted so candidate dedupe can
    // exclude them, BEFORE admission trims the section for budget (dedupe is a
    // semantic identity relationship, independent of whole-pack budget survival).
    // Each pointer's `citation_id` IS the canonical
    // `brain_record:${source_type}:${id}` identity — never a bare source_type:id.
    const pointerItems =
      (pointerFragment.section?.items as
        Array<{ citation_id?: unknown }> | undefined) ?? [];
    for (const item of pointerItems) {
      if (typeof item.citation_id === "string") {
        pointerEmittedIdentities.push(item.citation_id);
      }
    }
    foldSharedRecallWarnings(pointerFragment);
    admitStructuredSection("pointers", pointerFragment);
  }

  if (includeCandidateMemory) {
    const candidateFragment = buildCandidateSection({
      pool: durablePool,
      excludedIdentities: [
        ...retainedDurableIdentities,
        ...pointerEmittedIdentities,
      ],
    });
    foldSharedRecallWarnings(candidateFragment);
    admitStructuredSection("candidate_memory", candidateFragment);
  }

  const sections: Record<string, unknown> = {};
  if (workingSetSection) sections.working_set = workingSetSection;
  if (recoverySection) sections.recovery = recoverySection;
  if (durableLaneSection) sections.durable_lane_context = durableLaneSection;
  if (durableMemorySection) sections.durable_memory = durableMemorySection;
  for (const { key, section } of structuredSections) {
    sections[key] = section;
  }

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
          // durable_memory recall warnings are emitted here ONLY when the section
          // was requested for output; when the recall ran solely for
          // pointers/candidates they are folded into those sections' fragments
          // instead (see foldSharedRecallWarnings) so they surface exactly once.
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
        // durable_memory budget is reported only when the section was requested
        // for output. A recall that ran solely to feed pointers/candidates does
        // not report a durable_memory budget block (the section is absent).
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
