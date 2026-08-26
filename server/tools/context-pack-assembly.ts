/**
 * The middle of the `agent_context_pack` build: the two recall sections, the
 * structured sections, and the two envelope blocks composed from what they all
 * produced.
 *
 * This is where the pack's SHAPE is decided — which sections are loaded, in
 * what order they are charged against the running allocation, and which of them
 * contributes to each warnings channel. The entry point keeps only the scope,
 * the authorization, and the finished envelope.
 */
import type { AuthIdentity } from "../auth/types.ts";
import type { RecoveryWalContextPackFragment } from "../realtime/recovery-wal.ts";
import type { WorkingSetContextPackFragment } from "../realtime/working-set.ts";
import {
  sectionServing,
  type PackAllocator,
} from "./context-pack-allocator.ts";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import type {
  DurableLaneSection,
  DurableMemorySection,
} from "./context-pack-budget.ts";
import {
  admitGuidanceSections,
  admitPointerSections,
  admitRepoFactsSection,
  loadLaneContext,
  loadMemoryContext,
  retainedDurableIdentities,
  structuredSectionQueryFor,
  type DurableLaneContext,
  type DurableMemoryContext,
} from "./context-pack-loaders.ts";
import {
  assembleWarnings,
  wholePackReport,
  type WarningSource,
} from "./context-pack-payload.ts";
import {
  admitDurableLaneSection,
  admitDurableMemorySection,
  durableLaneContentChars,
  durableMemoryContentChars,
  reconcileSectionBudget,
} from "./context-pack-recall-sections.ts";
import type { SectionSelection } from "./context-pack-selection.ts";
import {
  createStructuredAccumulator,
  type StructuredSectionAccumulator,
} from "./context-pack-structured-sections.ts";
import type { MemoryToolDependencies } from "./types.ts";

/** One recall section's loaded context, fitted section, and reconciled block. */
interface RecallSection<TSection> {
  context: unknown;
  section: TSection | null;
  citations: Array<Record<string, unknown>>;
  budget: Record<string, unknown> | undefined;
}

/** Everything the two recall sections contribute to the finished pack. */
export interface RecallSectionsResult {
  laneContext: DurableLaneContext | null;
  laneSection: DurableLaneSection | null;
  laneCitations: Array<Record<string, unknown>>;
  laneBudget: Record<string, unknown> | undefined;
  memoryContext: DurableMemoryContext | null;
  memorySection: DurableMemorySection | null;
  memoryCitations: Array<Record<string, unknown>>;
  memoryBudget: Record<string, unknown> | undefined;
}

/**
 * Load and admit `durable_lane_context` (priority 3).
 *
 * The loader trims raw content chars, but the serialized section also carries
 * lane metadata, per-event wrappers, and citation ids. To keep the SERIALIZED
 * section within the allowance, the loader is seeded with a content allowance
 * and the result is then re-fitted.
 */
async function buildLaneSection(options: {
  allocator: PackAllocator;
  include: boolean;
  args: AgentContextPackArgs;
  ns: string;
  dependencies: MemoryToolDependencies;
}): Promise<
  RecallSection<DurableLaneSection> & { context: DurableLaneContext | null }
> {
  const { allocator, include, args, ns, dependencies } = options;
  const serving = sectionServing(allocator, "durable_lane_context");
  const context = await loadLaneContext({
    include,
    args,
    namespace: ns,
    dependencies,
    contentLimit: serving.contentLimit,
  });
  const loadedSection = context?.section ?? null;
  const admitted = admitDurableLaneSection({
    allocator,
    section: loadedSection,
    citations: loadedSection ? (context?.citations ?? []) : [],
    frame: serving.frame,
    serving: serving.serving,
  });
  return {
    context,
    section: admitted.section,
    citations: admitted.citations,
    budget: reconcileSectionBudget({
      allocator,
      loaded: context?.budget,
      section: admitted.section,
      starvedOut: admitted.starvedOut,
      contentChars: durableLaneContentChars,
    }),
  };
}

/**
 * Run the shared recall and admit `durable_memory` (priority 4).
 *
 * The SECTION is only fitted/emitted/charged when explicitly requested. When
 * the recall ran ONLY to feed pointers, the body is suppressed here while its
 * pool and identities still flow to the pointer builders.
 */
async function buildMemorySection(options: {
  allocator: PackAllocator;
  selection: SectionSelection;
  args: AgentContextPackArgs;
  auth: AuthIdentity;
  ns: string;
  dependencies: MemoryToolDependencies;
}): Promise<
  RecallSection<DurableMemorySection> & { context: DurableMemoryContext | null }
> {
  const { allocator, selection, args, auth, ns, dependencies } = options;
  const serving = sectionServing(allocator, "durable_memory");
  const context = await loadMemoryContext({
    include: selection.durableMemory,
    args,
    auth,
    namespace: ns,
    dependencies,
    contentLimit: serving.contentLimit,
  });
  const requested = selection.durableMemorySection
    ? ((context?.section ?? null) as DurableMemorySection | null)
    : null;
  const admitted = admitDurableMemorySection({
    allocator,
    section: requested,
    citations: requested ? (context?.citations ?? []) : [],
    frame: serving.frame,
    serving: serving.serving,
  });
  return {
    context,
    section: admitted.section,
    citations: admitted.citations,
    budget: reconcileSectionBudget({
      allocator,
      loaded: context?.budget,
      section: admitted.section,
      starvedOut: admitted.starvedOut,
      contentChars: durableMemoryContentChars,
    }),
  };
}

/** Admit the two recall sections in priority order. */
export async function buildRecallSections(options: {
  allocator: PackAllocator;
  selection: SectionSelection;
  args: AgentContextPackArgs;
  auth: AuthIdentity;
  ns: string;
  dependencies: MemoryToolDependencies;
}): Promise<RecallSectionsResult> {
  const lane = await buildLaneSection({
    allocator: options.allocator,
    include: options.selection.durableLaneContext,
    args: options.args,
    ns: options.ns,
    dependencies: options.dependencies,
  });
  const memory = await buildMemorySection(options);
  return {
    laneContext: lane.context,
    laneSection: lane.section,
    laneCitations: lane.citations,
    laneBudget: lane.budget,
    memoryContext: memory.context,
    memorySection: memory.section,
    memoryCitations: memory.citations,
    memoryBudget: memory.budget,
  };
}

/**
 * Load and admit the self-contained structured sections (priorities 5-9), in
 * their fixed order.
 */
export async function buildStructuredSections(options: {
  allocator: PackAllocator;
  selection: SectionSelection;
  args: AgentContextPackArgs;
  readNamespace: string;
  dependencies: MemoryToolDependencies;
  memoryContext: DurableMemoryContext | null;
  memorySection: DurableMemorySection | null;
}): Promise<StructuredSectionAccumulator> {
  const { allocator, selection, args, readNamespace, dependencies } = options;
  const accumulator = createStructuredAccumulator();
  const query = structuredSectionQueryFor(dependencies);

  await admitGuidanceSections({
    accumulator,
    allocator,
    selection,
    readNamespace,
    query,
    dependencies,
  });

  if (selection.repoFacts) {
    await admitRepoFactsSection({
      accumulator,
      allocator,
      args,
      readNamespace,
      query,
      dependencies,
    });
  }

  admitPointerSections({
    accumulator,
    allocator,
    selection,
    memoryContext: options.memoryContext,
    durableIdentities: retainedDurableIdentities(options.memorySection),
  });

  return accumulator;
}

/** The reported allocation block, one member per section that reports one. */
export function assembleBudget(options: {
  args: AgentContextPackArgs;
  allocator: PackAllocator;
  selection: SectionSelection;
  workingSet: WorkingSetContextPackFragment | null;
  recovery: RecoveryWalContextPackFragment | null;
  recall: RecallSectionsResult;
}): Record<string, unknown> {
  const { args, allocator, selection, workingSet, recovery, recall } = options;
  return {
    requested: args.budget ?? null,
    ...wholePackReport(allocator),
    ...(workingSet ? workingSet.budget : {}),
    ...(recovery ? recovery.budget : {}),
    ...(recall.laneSection || recall.laneContext
      ? { durable_lane_context: recall.laneBudget }
      : {}),
    // Reported only when the section was requested for output. A recall that
    // ran solely to feed pointers reports no durable_memory block, because that
    // section is absent.
    ...(selection.durableMemorySection && recall.memoryContext
      ? { durable_memory: recall.memoryBudget }
      : {}),
  };
}

/** The lane section's contribution to the three warnings channels. */
function laneWarnings(recall: RecallSectionsResult): WarningSource {
  return {
    scopeDenials: recall.laneContext?.scopeDenials ?? [],
    degradedSources: recall.laneContext?.degradedSources ?? [],
    truncation: recall.laneSection
      ? (recall.laneContext?.truncation ?? [])
      : [],
  };
}

/**
 * The durable_memory section's contribution.
 *
 * Its denials and degraded sources are emitted here ONLY when the section was
 * requested for output; when the recall ran solely for pointers/candidates
 * they are folded into those fragments instead, so they surface exactly once.
 */
function memoryWarnings(
  recall: RecallSectionsResult,
  selection: SectionSelection,
): WarningSource {
  return {
    scopeDenials: selection.durableMemorySection
      ? (recall.memoryContext?.scopeDenials ?? [])
      : [],
    degradedSources: selection.durableMemorySection
      ? (recall.memoryContext?.degradedSources ?? [])
      : [],
    truncation: recall.memorySection
      ? (recall.memoryContext?.truncation ?? [])
      : [],
  };
}

/** Compose the three warnings channels from every contributing section. */
export function assemblePackWarnings(options: {
  selection: SectionSelection;
  workingSet: WorkingSetContextPackFragment | null;
  recovery: RecoveryWalContextPackFragment | null;
  recall: RecallSectionsResult;
  allocator: PackAllocator;
  structured: StructuredSectionAccumulator;
}): Record<string, unknown> {
  const { selection, workingSet, recovery, recall, allocator, structured } =
    options;
  return assembleWarnings([
    { scopeDenials: workingSet ? workingSet.warnings.scope_denials : [] },
    { scopeDenials: recovery ? recovery.warnings.scope_denials : [] },
    laneWarnings(recall),
    memoryWarnings(recall, selection),
    { truncation: allocator.truncation },
    {
      scopeDenials: structured.scopeDenials,
      degradedSources: structured.degradedSources,
      truncation: structured.truncation,
    },
  ]);
}
