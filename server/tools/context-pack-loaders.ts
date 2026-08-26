/**
 * The retrieval calls the pack builder makes, and the small reconciliations
 * that belong with them.
 *
 * Each loader here is the ONE place its section is fetched. Keeping them
 * together with `structuredSectionQuery` is what stops a second query path
 * appearing for a section that already has one.
 */
import type { AuthIdentity } from "../auth/types.ts";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import { loadDurableLaneContext } from "./context-pack-durable-lane.ts";
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
import {
  admitStructuredSection,
  type StructuredSectionAccumulator,
} from "./context-pack-structured-sections.ts";
import type { PackAllocator } from "./context-pack-allocator.ts";
import type { SectionSelection } from "./context-pack-selection.ts";
import type { MemoryToolDependencies } from "./types.ts";

export type StructuredSectionQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export function structuredSectionQueryFor(
  dependencies: MemoryToolDependencies,
): StructuredSectionQuery {
  return async (sql, params) => {
    const result = await dependencies.pool.query(sql, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
}

export type DurableLaneContext = Awaited<
  ReturnType<typeof loadDurableLaneContext>
>;
export type DurableMemoryContext = Awaited<
  ReturnType<typeof loadDurableMemoryContext>
>;

/** Load `durable_lane_context`, seeded with its content allowance. */
export function loadLaneContext(options: {
  include: boolean;
  args: AgentContextPackArgs;
  namespace: string;
  dependencies: MemoryToolDependencies;
  contentLimit: number | undefined;
}): Promise<DurableLaneContext> | null {
  return options.include
    ? loadDurableLaneContext(
        options.args,
        options.namespace,
        options.dependencies,
        options.contentLimit,
      )
    : null;
}

/** Run the single shared hybrid recall behind durable_memory and pointers. */
export function loadMemoryContext(options: {
  include: boolean;
  args: AgentContextPackArgs;
  auth: AuthIdentity;
  namespace: string;
  dependencies: MemoryToolDependencies;
  contentLimit: number | undefined;
}): Promise<DurableMemoryContext> | null {
  return options.include
    ? loadDurableMemoryContext({
        args: options.args,
        auth: options.auth,
        namespace: options.namespace,
        dependencies: options.dependencies,
        contentCharLimit: options.contentLimit,
      })
    : null;
}

/** Admit the two guidance sections, in their fixed order. */
export async function admitGuidanceSections(options: {
  accumulator: StructuredSectionAccumulator;
  allocator: PackAllocator;
  selection: SectionSelection;
  readNamespace: string;
  query: StructuredSectionQuery;
  dependencies: MemoryToolDependencies;
}): Promise<void> {
  const requests: Array<{ include: boolean; section: GuidanceSectionName }> = [
    { include: options.selection.profileGuidance, section: "profile_guidance" },
    { include: options.selection.processGuidance, section: "process_guidance" },
  ];
  for (const request of requests) {
    if (!request.include) continue;
    const fragment = await loadGuidanceSection(
      { section: request.section, namespace: options.readNamespace },
      { query: options.query },
      options.dependencies.logger,
    );
    admitStructuredSection({
      accumulator: options.accumulator,
      allocator: options.allocator,
      key: request.section,
      fragment,
    });
  }
}

/** Admit `repo_facts` when requested. */
export async function admitRepoFactsSection(options: {
  accumulator: StructuredSectionAccumulator;
  allocator: PackAllocator;
  args: AgentContextPackArgs;
  readNamespace: string;
  query: StructuredSectionQuery;
  dependencies: MemoryToolDependencies;
}): Promise<void> {
  // `nowMs` is captured ONCE so staleness dispositions are deterministic across
  // one pack build. `repo` absent -> the loader's no-active-repo empty state; it
  // never falls back to another repository.
  const fragment = await loadRepoFactsSection(
    {
      namespace: options.readNamespace,
      repo: options.args.repo ?? null,
      nowMs: Date.now(),
    },
    { query: options.query },
    options.dependencies.logger,
  );
  admitStructuredSection({
    accumulator: options.accumulator,
    allocator: options.allocator,
    key: "repo_facts",
    fragment,
  });
}

/**
 * The identities ACTUALLY RETAINED in the FINAL fitted durable_memory output.
 *
 * Pointer eligibility is decided against these, not the loader's pre-fit set.
 * When the section is suppressed (pointers-only) this is empty, so every
 * authorized row is pointer-eligible; when the re-fit trimmed durable rows,
 * those rows are absent here and stay pointer-eligible instead of being
 * silently lost.
 */
export function retainedDurableIdentities(
  section: { items?: Array<{ citation_id?: unknown }> } | null,
): string[] {
  const retained: string[] = [];
  for (const item of section?.items ?? []) {
    if (typeof item.citation_id === "string") retained.push(item.citation_id);
  }
  return retained;
}

/**
 * Admit `pointers` and `candidate_memory` (#329).
 *
 * When the durable_memory section is suppressed for output but its recall ran,
 * its content-free warnings attach to the FIRST admitted #329 section, so a
 * failed shared recall surfaces exactly once instead of being swallowed.
 */
export function admitPointerSections(options: {
  accumulator: StructuredSectionAccumulator;
  allocator: PackAllocator;
  selection: SectionSelection;
  memoryContext: DurableMemoryContext | null;
  durableIdentities: string[];
}): void {
  const { accumulator, allocator, selection, memoryContext } = options;
  let warningsPending =
    selection.durableMemory && !selection.durableMemorySection;
  const foldSharedRecallWarnings = (fragment: SectionFragment): void => {
    if (!warningsPending) return;
    warningsPending = false;
    fragment.scopeDenials.push(...(memoryContext?.scopeDenials ?? []));
    fragment.degradedSources.push(...(memoryContext?.degradedSources ?? []));
  };

  if (selection.pointers) {
    const fragment = buildPointerSection({
      pool: memoryContext?.pointerCandidatePool ?? [],
      durableIdentities: options.durableIdentities,
    });
    foldSharedRecallWarnings(fragment);
    admitStructuredSection({
      accumulator,
      allocator,
      key: POINTERS_SECTION_NAME,
      fragment,
    });
  }

  if (selection.candidateMemory) {
    // Takes no pool and drives no recall (see INVARIANT 1).
    const fragment = buildCandidateSection();
    foldSharedRecallWarnings(fragment);
    admitStructuredSection({
      accumulator,
      allocator,
      key: "candidate_memory",
      fragment,
    });
  }
}
