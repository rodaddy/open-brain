/**
 * Contract entries for the agent-facing surface: the contract itself, the
 * operator doctor, the RAM working set, and the agent context/reflex packs.
 */
import type { ToolContract } from "./tool-contract.ts";

export const AGENT_TOOL_CONTRACTS: Record<string, ToolContract> = {
  get_contract: {
    version: 1,
    input_schema: {},
    output_shape: "OpenBrainContract JSON text payload",
  },
  operator_doctor: {
    version: 1,
    input_schema: {},
    output_shape:
      "privileged operator doctor/status JSON text payload with stable " +
      "runtime, database, migrations, optional provider, transport, and " +
      "log/audit health fields; secrets and raw paths are redacted/omitted",
  },
  working_set_append: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to the auth-derived clientId; " +
          "the server enforces write authority before accepting RAM working context.",
      },
      agent: { type: "string", required: true, minLength: 1, maxLength: 200 },
      platform: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      channel_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Optional thread id. Missing means unthreaded scope only.",
      },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      kind: {
        type: "enum",
        required: true,
        values: [
          "recent_event",
          "structured_event",
          "current_intent",
          "active_correction",
          "task_state",
          "linked_durable_ref",
          "next_turn_guidance",
        ],
      },
      content: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 4000,
        description:
          "Bounded RAM-only working context. This does not create durable " +
          "memory, shared-kb, or searchable recall rows.",
      },
      confidence: { type: "number", required: false, min: 0, max: 1 },
      stale_at: { type: "string", required: false, maxLength: 100 },
      trace_id: { type: "string", required: false, maxLength: 500 },
      source_ref: { type: "string", required: false, maxLength: 1000 },
      durable_ref: {
        type: "object",
        required: false,
        fields: {
          table: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 100,
          },
          id: { type: "string", required: true, minLength: 1, maxLength: 200 },
        },
      },
      metadata: {
        type: "object",
        required: false,
        maxSerializedChars: 2000,
        description:
          "Optional bounded JSON metadata. Serialized metadata larger than " +
          "2000 characters is rejected before retention.",
      },
    },
    output_shape:
      "RAM-only working-set append receipt with accepted/reason/item/counters/not_durable_memory",
  },
  agent_context_pack: {
    // v3 (#678): the mirror now advertises `repo`, `prior_context`, and
    // `continue_from`, which the live Zod schema has accepted since the
    // #543/#563 work. The version bump is the client-visible half of the drift
    // receipt — the schema_hash moves on its own because TOOL_CONTRACTS is in
    // the hashed payload, but a hash tells a client only THAT something moved.
    version: 3,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces read authority before returning any scoped context.",
      },
      agent: { type: "string", required: true, minLength: 1, maxLength: 200 },
      platform: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      channel_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      thread_id: { type: "string", required: false, maxLength: 500 },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      query: { type: "string", required: false, maxLength: 4000 },
      repo: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 300,
        description:
          "Active repository slug (e.g. owner/name) that repo_facts binds to " +
          "exactly. When absent, repo_facts returns its defined no-active-repo " +
          "empty state; repo_facts never falls back to any other repository.",
      },
      prior_context: {
        type: "array",
        required: false,
        maxItems: 200,
        description:
          "Explicit identifiers/source refs already supplied to the model this " +
          "turn. durable_memory recall removes records already represented by " +
          "these references and returns only net-new results. Raw prior-context " +
          "text is never accepted; each reference carries resolvable identity " +
          "only (citation_id or source_ref).",
        items: {
          type: "object",
          fields: {
            citation_id: {
              type: "string",
              required: "citation_id_or_source_ref",
              minLength: 1,
              maxLength: 500,
            },
            source_ref: {
              type: "union",
              required: "citation_id_or_source_ref",
              description:
                "The recalled item's own resolvable source ref: either the " +
                "string form (<=1000) or the structural {source,type,id," +
                "namespace?} form. At least one of citation_id/source_ref is " +
                "required per reference.",
              variants: [
                { type: "string", minLength: 1, maxLength: 1000 },
                {
                  type: "object",
                  additionalProperties: true,
                  fields: {
                    source: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    type: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    id: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 500,
                    },
                    namespace: {
                      type: "string",
                      required: false,
                      minLength: 1,
                      maxLength: 200,
                    },
                  },
                },
              ],
            },
          },
        },
      },
      requested_sections: {
        type: "array",
        required: false,
        description:
          "Sections to assemble. durable_lane_context is opt-in and returns " +
          "bounded lane checkpoint/event data only after all seven exact scope " +
          "coordinates match; omitted sections are not queried.",
        items: {
          type: "enum",
          values: [
            "working_set",
            "recovery",
            "durable_lane_context",
            "durable_memory",
            "profile_guidance",
            "process_guidance",
            "repo_facts",
            "pointers",
            "candidate_memory",
          ],
        },
      },
      include_unreviewed_recovery: {
        type: "boolean",
        required: false,
        default: false,
        description:
          "Explicit opt-in to include exact-scope quarantined recovery " +
          "summary. Recovery records are not durable memory or searchable recall.",
      },
      continue_from: {
        type: "object",
        required: false,
        description:
          "Resume a durable_memory walk: pass back the `next` object from the " +
          "previous reply to receive the following burst of the same ranked " +
          "recall. Absent, delivery starts at the top of the ranking. It is a " +
          "delivery position, never a filter — nothing about it narrows what " +
          "the query matches, and a walk run to completion has received every " +
          "record the query found.",
        fields: {
          offset: { type: "integer", required: true, min: 0 },
        },
      },
      budget: {
        type: "object",
        required: false,
        fields: {
          max_tokens: {
            type: "integer",
            required: false,
            min: 100,
            max: 20000,
          },
          max_latency_ms: {
            type: "integer",
            required: false,
            min: 1,
            max: 10000,
          },
        },
      },
    },
    output_shape:
      "agent_context_pack envelope with exact-scope working_set, explicitly opted-in recovery, and explicitly requested bounded durable_lane_context sections; durable_memory is delivered in bounded bursts and carries a `next` continuation handle whenever undelivered records remain (#563); warnings include generic exact-scope denials/degraded sources/truncation, budget declares per-source bounds and recalled_net_new, and citations identify returned durable lane/events",
  },
  agent_reflex_pointers: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces read authority before returning any scoped pointers.",
      },
      agent: { type: "string", required: true, minLength: 1, maxLength: 200 },
      platform: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      channel_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      thread_id: { type: "string", required: false, maxLength: 500 },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      query: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 4000,
        description:
          "Current-turn query that drives the single durable_memory hybrid " +
          "recall the pointer pool is derived from. Required — a reflex with " +
          "no query has no pool to point at.",
      },
      prior_context: {
        type: "array",
        required: false,
        maxItems: 200,
        description:
          "Explicit identifiers/source refs already supplied to the model this " +
          "turn. The shared recall removes records already represented by these " +
          "references before any pointer is emitted, so the reflex points only " +
          "at net-new durable records. Raw prior-context text is never accepted; " +
          "each reference carries resolvable identity only (citation_id or " +
          "source_ref).",
        items: {
          type: "object",
          fields: {
            citation_id: {
              type: "string",
              required: "citation_id_or_source_ref",
              minLength: 1,
              maxLength: 500,
            },
            source_ref: {
              type: "union",
              required: "citation_id_or_source_ref",
              description:
                "The recalled item's own resolvable source ref: either the " +
                "string form (<=1000) or the structural {source,type,id," +
                "namespace?} form. At least one of citation_id/source_ref is " +
                "required per reference.",
              variants: [
                { type: "string", minLength: 1, maxLength: 1000 },
                {
                  type: "object",
                  additionalProperties: true,
                  fields: {
                    source: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    type: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    id: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 500,
                    },
                    namespace: {
                      type: "string",
                      required: false,
                      minLength: 1,
                      maxLength: 200,
                    },
                  },
                },
              ],
            },
          },
        },
      },
      budget: {
        type: "object",
        required: false,
        fields: {
          max_tokens: {
            type: "integer",
            required: false,
            min: 100,
            max: 20000,
          },
          max_latency_ms: {
            type: "integer",
            required: false,
            min: 1,
            max: 10000,
          },
        },
      },
    },
    output_shape:
      "ordinary agent_reflex_pointers.v1 result envelope (schema/status/scope/query, placement=client_owned, resolvable_reference_only=true) carrying a single body-free pointers section: namespace-scoped resolvable pointers with identity/source_ref/structural metadata only and NO memory bodies, deduped against retained durable identities with prior-context suppression applied and whole-pack budget bounded; citations are a bijection with the emitted pointers (kind=pointer), and warnings/budget are carried through from the shared pack so budget starvation and degraded/denied shared recall stay honest",
  },
};
