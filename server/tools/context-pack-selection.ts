/**
 * Section selection for `agent_context_pack`.
 *
 * Absent `requested_sections` means working_set AND durable_memory; every other
 * section is opt-in, because each one costs a query and a caller that wanted
 * the whole brain would have said so.
 *
 * WHY durable_memory IS IN THE DEFAULT (#744, operator decision 2026-08-25).
 * It used to be opt-in with the rest, on the reasoning above. That reasoning
 * holds for sections a caller might not want; it does not hold for the durable
 * corpus, because a caller who asks for "context" and silently gets none has no
 * way to tell. Measured against the local service with the installed client:
 *
 *   bare recall                  -> served [working_set],                citations 0
 *   durable_memory asked for     -> served [working_set,durable_memory], citations 10
 *
 * The corpus is reachable and the query works. Only the default was wrong.
 * The Python client never sets requested_sections at all
 * (python/openbrain-memory/src/openbrain_memory/runtime.py
 * context_pack_arguments), so EVERY bare recall took the working-set-only
 * branch and reported success -- which is what an agent that "remembers
 * nothing" actually looks like from the inside.
 *
 * The asymmetry was the tell: working_set treated an absent requested_sections
 * as INCLUDED and durable_memory as EXCLUDED, one line apart, with nothing in
 * the contract asking for that split. docs/agent-context-pack-contract.md names
 * durable_lane_context as opt-in explicitly and says nothing equivalent for
 * durable_memory.
 *
 * Cost is one hybrid recall per default-shaped call. That is the price of a
 * default that means what a caller reading it would assume.
 */
import type { AgentContextPackArgs } from "./context-pack-args.ts";

/** One declared section name, as `requested_sections` spells it. */
type SectionName = NonNullable<
  AgentContextPackArgs["requested_sections"]
>[number];

/** Which sections this call will build. */
export interface SectionSelection {
  workingSet: boolean;
  recovery: boolean;
  durableLaneContext: boolean;
  /** Whether the durable_memory SECTION BODY is emitted. */
  durableMemorySection: boolean;
  /** Whether the shared recall RUNS (see INVARIANT 1). */
  durableMemory: boolean;
  profileGuidance: boolean;
  processGuidance: boolean;
  repoFacts: boolean;
  pointers: boolean;
  candidateMemory: boolean;
}

export function selectSections(args: AgentContextPackArgs): SectionSelection {
  const requested = args.requested_sections;
  const optIn = (name: SectionName): boolean =>
    requested?.includes(name) === true;

  const durableMemorySection =
    !requested || requested.includes("durable_memory");
  const pointers = optIn("pointers");

  return {
    workingSet: !requested || requested.includes("working_set"),
    recovery:
      args.include_unreviewed_recovery === true &&
      (!requested || requested.includes("recovery")),
    durableLaneContext: optIn("durable_lane_context"),
    durableMemorySection,
    // INVARIANT 1. pointers derives from the durable_memory recall, so
    // requesting EITHER runs that single recall -- its net-new pool and emitted
    // identities are then available even when the durable_memory SECTION BODY
    // is not requested for output. candidate_memory does NOT drive recall: it
    // has no predicate, so a candidate-only request must issue zero recall
    // queries.
    durableMemory: durableMemorySection || pointers,
    profileGuidance: optIn("profile_guidance"),
    processGuidance: optIn("process_guidance"),
    repoFacts: optIn("repo_facts"),
    pointers,
    candidateMemory: optIn("candidate_memory"),
  };
}
