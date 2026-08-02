/**
 * Public argument schemas for `agent_context_pack` and `agent_reflex_pointers`.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Request Shape",
 * "Reflex Pointer Surface").
 *
 * These live in their own module, apart from the orchestrator, because every
 * section loader needs the parsed argument TYPE and none of them needs the
 * orchestrator. Putting the schemas here keeps the dependency arrows pointing
 * one way (loaders → args) instead of forming the loader↔orchestrator cycle that
 * co-locating them would create.
 */
import { z } from "zod";

/** The nine section names, in whole-pack allocation order. */
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

export type SectionName = (typeof SECTION_NAMES)[number];

/** The seven exact scope coordinates shared by both surfaces. */
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
 * pointer for a record already supplied to the model this turn.
 *
 * Only RESOLVABLE IDENTITY is accepted — never raw prior-context text — and at
 * least one of `citation_id`/`source_ref` must be present so the reference is
 * addressable without inspecting a body. `source_ref` accepts either the string
 * or the structural form the recall emits, so a caller can echo back an item's
 * own `source_ref` verbatim.
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

/**
 * Single source of truth for the whole-pack budget bounds. Both surfaces accept
 * the EXACT same budget contract, so the bounds live here once rather than being
 * duplicated — and silently drifting — in each tool's input schema.
 */
export const contextPackBudgetInputSchema = z
  .object({
    max_tokens: z.number().int().min(100).max(20000).optional(),
    max_latency_ms: z.number().int().min(1).max(10000).optional(),
  })
  .optional();

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
      "Sections to assemble. durable_lane_context is queried only when explicitly requested and requires all seven exact scope coordinates. profile_guidance, process_guidance, and repo_facts are each queried only when explicitly requested. " +
        'pointers returns resolvable-reference-only entries (identity/source_ref/structural metadata, never a body) for durable records not already emitted as durable_memory items; requesting pointers reuses the single durable_memory hybrid recall (no second retrieval stack) and needs a query. source_ref.type is the singular source_type, so resolve a pointer through get_entry with table = source_ref.type + "s" and id = source_ref.id. ' +
        "candidate_memory currently has no write-side candidate predicate, so it always returns a truthful empty section (items [], empty_reason candidate_predicate_unavailable, confidence unconfirmed, auto_promotable false) and never triggers recall on its own.",
    ),
  include_unreviewed_recovery: z
    .boolean()
    .optional()
    .describe("Explicitly include exact-scope quarantined recovery summary"),
  budget: contextPackBudgetInputSchema,
};

const agentContextPackArgsSchema = z.object(agentContextPackInputSchema);

export type AgentContextPackArgs = z.infer<typeof agentContextPackArgsSchema>;

export function parseAgentContextPackArgs(args: unknown): AgentContextPackArgs {
  return agentContextPackArgsSchema.parse(args);
}

/**
 * Reflex-pointer input: the smallest explicit per-turn reflex surface (#334).
 *
 * It reuses the EXACT pack scope, query, prior-context, and budget contract —
 * nothing new is invented on the retrieval side — but it is a body-free
 * cited-pointer reflex, not a whole pack. It deliberately OMITS
 * `requested_sections`, the section toggles, and the recovery opt-in, because
 * those select non-pointer sections a pointer reflex never emits. `query` is
 * REQUIRED here: recall has no meaning without one, and the pointer pool derives
 * entirely from that single durable_memory recall.
 */
export const agentReflexPointersInputSchema = {
  ...scopeInputSchema,
  query: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Current-turn query that drives the single durable_memory hybrid recall " +
        "the pointer pool is derived from. Required — a reflex with no query " +
        "has no pool to point at.",
    ),
  prior_context: z
    .array(priorContextReferenceInputSchema)
    .max(200)
    .optional()
    .describe(
      "Explicit identifiers/source refs already supplied to the model this " +
        "turn. The shared recall removes records already represented by these " +
        "references before any pointer is emitted, so the reflex points only at " +
        "net-new durable records. Raw prior-context text is never accepted.",
    ),
  budget: contextPackBudgetInputSchema,
};

const agentReflexPointersArgsSchema = z.object(agentReflexPointersInputSchema);

export type AgentReflexPointersArgs = z.infer<
  typeof agentReflexPointersArgsSchema
>;

export function parseAgentReflexPointersArgs(
  args: unknown,
): AgentReflexPointersArgs {
  return agentReflexPointersArgsSchema.parse(args);
}
