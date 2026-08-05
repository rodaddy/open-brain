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

/**
 * Build the strict registration schema for a tool surface.
 *
 * The `.strict()` alone rejects the key but its stock message names only the
 * offending key. The issue's requirement (and the #431/PR #532 pattern) is that
 * a failure names the ACCEPTED VOCABULARY too, so the caller has something to
 * correct toward rather than a bare "no". The accepted set is derived from the
 * shape, never re-listed, so it cannot drift from the schema it describes.
 *
 * The message must carry the vocabulary itself, not rely on a formatter: the
 * serving entrypoint (`server/main.ts`) does NOT install
 * `installValidationSummaryFormatter` — only `src/server.ts` does — so anything
 * that lives only in the formatter is invisible on the surface that actually
 * runs.
 */
function strictRequestSchema<Shape extends z.ZodRawShape>(
  shape: Shape,
  toolName: string,
) {
  const accepted = Object.keys(shape).sort().join(", ");
  return z
    .object(shape, {
      error: (issue: { code?: string; keys?: string[] }) =>
        issue.code === "unrecognized_keys"
          ? `Unrecognized key(s) for ${toolName}: ${(issue.keys ?? []).join(", ")}. ` +
            `Accepted keys: ${accepted}.`
          : undefined,
    } as z.core.$ZodObjectParams)
    .strict();
}

/**
 * Reject an unknown top-level request key by NAME, listing the accepted set.
 *
 * THE DEFECT (#535). The MCP SDK builds its validating schema from a raw shape
 * with a plain `z.object()`, which STRIPS undeclared keys instead of rejecting
 * them, and it strips them BEFORE the handler runs. So `sections: [...]` — the
 * near-miss spelling of `requested_sections` — never reached the tool at all:
 * the pack saw no section selection, fell back to its working_set-only default,
 * and returned `status: "ok"` on a near-empty answer. A typo in one key looked
 * exactly like a correct minimal request, and it cost real debugging time at
 * least twice (#439, #526).
 *
 * THE FIX. Registration passes the `.strict()` object below as `inputSchema`
 * instead of the raw shape, so the SDK's own pre-dispatch validator does the
 * rejecting. That is the only layer that still sees the raw arguments — a
 * handler-side check cannot work, because by then the key is already gone. It
 * also makes the advertised JSON schema honest: `additionalProperties: false`
 * now appears in `tools/list`, so a caller can see the rule before breaking it.
 *
 * REJECT, don't tolerate — for THIS surface specifically. An unknown key here
 * is always a caller mistake, never forward-tolerance: every key the pack
 * accepts selects work it must do, so an ignored one silently changes the
 * answer. That is the opposite of the capture lane (#464/PR #533), where
 * genuinely future lifecycle keys are expected and naming what was ignored in
 * the receipt is the right shape. Forward tolerance is a per-surface decision,
 * and this surface does not want it.
 *
 * This function stays as defense in depth for the DIRECT callers of
 * `parseAgentContextPackArgs` (tests, the NATS bridge, any non-MCP entrypoint),
 * which never pass through the SDK validator. Its error is a real `ZodError`,
 * so `summarizeValidationError` renders it through the same
 * `input_validation_failed` envelope as every other field error and names the
 * accepted vocabulary (#431/PR #532) so the caller has something to correct
 * toward.
 */
function rejectUnknownRequestKeys(
  args: unknown,
  acceptedKeys: readonly string[],
  toolName: string,
): void {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return;

  const record = args as Record<string, unknown>;
  const accepted = new Set(acceptedKeys);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length === 0) return;

  const sorted = [...acceptedKeys].sort();
  throw new z.ZodError(
    unknown.map((key) => ({
      code: "unrecognized_keys" as const,
      keys: [key],
      path: [key],
      message:
        `Unrecognized key "${key}" for ${toolName}. ` +
        `Accepted keys: ${sorted.join(", ")}.`,
      input: record,
    })),
  );
}

const agentContextPackArgsSchema = z.object(agentContextPackInputSchema);

/**
 * The registration-time schema: identical fields, but unknown top-level keys
 * are REJECTED rather than stripped. Register this, never the raw shape.
 */
export const agentContextPackStrictSchema = strictRequestSchema(
  agentContextPackInputSchema,
  "agent_context_pack",
);

/** The exact accepted top-level key set, derived from the schema — never re-listed. */
export const AGENT_CONTEXT_PACK_REQUEST_KEYS = Object.keys(
  agentContextPackInputSchema,
) as readonly string[];

export type AgentContextPackArgs = z.infer<typeof agentContextPackArgsSchema>;

export function parseAgentContextPackArgs(args: unknown): AgentContextPackArgs {
  rejectUnknownRequestKeys(
    args,
    AGENT_CONTEXT_PACK_REQUEST_KEYS,
    "agent_context_pack",
  );
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

/** The reflex's registration-time schema; see {@link agentContextPackStrictSchema}. */
export const agentReflexPointersStrictSchema = strictRequestSchema(
  agentReflexPointersInputSchema,
  "agent_reflex_pointers",
);

/**
 * The reflex surface's accepted keys. Deliberately NARROWER than the pack's —
 * it omits `requested_sections` and the section toggles — so passing a pack key
 * here is exactly the near-miss #535 is about and must be named, not stripped.
 */
export const AGENT_REFLEX_POINTERS_REQUEST_KEYS = Object.keys(
  agentReflexPointersInputSchema,
) as readonly string[];

export type AgentReflexPointersArgs = z.infer<
  typeof agentReflexPointersArgsSchema
>;

export function parseAgentReflexPointersArgs(
  args: unknown,
): AgentReflexPointersArgs {
  rejectUnknownRequestKeys(
    args,
    AGENT_REFLEX_POINTERS_REQUEST_KEYS,
    "agent_reflex_pointers",
  );
  return agentReflexPointersArgsSchema.parse(args);
}
