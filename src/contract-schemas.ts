import {
  REPO_FACT_METADATA_CONTRACT,
  REPO_FACT_VALIDATION_CONTRACT,
} from "./tools/repo-facts.ts";

export interface ToolContract {
  version: number;
  input_schema: unknown;
  output_shape: string;
}

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  get_contract: {
    version: 1,
    input_schema: {},
    output_shape: "OpenBrainContract JSON text payload",
  },
  get_entry: {
    version: 1,
    input_schema: {
      table: {
        type: "enum",
        required: true,
        values: ["thoughts", "decisions", "relationships", "projects", "sessions"],
        description:
          "Readable table containing the target row. Use the plural table " +
          "name derived from search result source_type.",
      },
      id: {
        type: "string",
        required: true,
        format: "uuid",
        description:
          "Entry UUID to fetch. The server applies auth-derived namespace " +
          "predicates before returning any row.",
      },
    },
    output_shape: "full readable entry row JSON text payload",
  },
  log_thought: {
    version: 2,
    input_schema: {
      content: {
        type: "string",
        required: true,
        minLength: 1,
        description:
          "The thought text to store. Write a complete, self-contained " +
          "statement that will still make sense out of context later — this " +
          "is what gets embedded and returned by future searches.",
      },
      tags: {
        type: "array",
        required: false,
        items: "string",
        description:
          "Optional freeform labels for grouping and filtering (e.g. topic, " +
          "project, or category). Use consistent tag names so related " +
          "thoughts cluster together.",
      },
      namespace: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 500,
        description:
          "Memory partition to write into. Defaults to your own " +
          "auth-derived namespace; leave unset unless a global/admin token " +
          "is intentionally writing into another namespace (e.g. shared-kb).",
      },
    },
    output_shape: "thought id/namespace/embedded/merged JSON text payload",
  },
  search_all: {
    version: 2,
    input_schema: {
      query: {
        type: "string",
        required: true,
        minLength: 1,
        description:
          "What you are looking for, in natural language. Phrase it as the " +
          "concept or question you want to recall; hybrid/vector modes match " +
          "on meaning, not just exact words.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Which memory partition to search. Defaults to your own " +
          "auth-derived namespace; override only to read another namespace " +
          "you are authorized for (e.g. shared-kb for shared knowledge).",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 250,
        description:
          "Maximum number of results to return (1-250). Start small (e.g. " +
          "10-20) for focused recall; raise it when you need broad coverage.",
      },
      offset: {
        type: "integer",
        required: false,
        min: 0,
        description:
          "Number of results to skip before returning, for paging through a " +
          "large result set. Leave at 0 for the first page.",
      },
      sources: {
        type: "enum",
        required: false,
        values: ["all", "brain", "qmd"],
        description:
          "Which corpora to search: all (default, both), brain (only stored " +
          "memory — thoughts, session events, facts), qmd (only indexed code " +
          "context). Narrow this when you know which corpus you need.",
      },
      collection: {
        type: "string",
        required: false,
        minLength: 1,
        description:
          "Optional qmd collection filter. Use with sources='qmd' or " +
          "sources='all' when you need code/document context from one indexed " +
          "collection such as open-brain-runtime.",
      },
      search_mode: {
        type: "enum",
        required: false,
        values: ["hybrid", "vector", "keyword"],
        description:
          "How to match: hybrid (default, blends vector + keyword — use " +
          "unless you have a reason not to), vector (semantic similarity " +
          "only — best for fuzzy/conceptual recall), keyword (exact-term " +
          "only — best for identifiers, error strings, or exact phrases).",
      },
      tier: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Optional importance/recency tier filter: hot (most recent/most " +
          "important), warm (mid), cold (archival). Omit to search all " +
          "tiers; set only when you want to restrict by significance.",
      },
    },
    output_shape: "unified search results JSON text payload",
  },
  session_start: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Stable identifier for this session lane. Reuse the same key to " +
          "resume an existing lane; pick a new one to start a fresh lane. " +
          "Use a deterministic value you can reconstruct later (e.g. a " +
          "channel/thread id or task slug), not a random string.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized to operate in another.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project this session belongs to. Set it to scope and later " +
          "filter lanes by project (e.g. in lane_load).",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Which agent owns this session (e.g. hermes, bilby, skippy). Set " +
          "so lanes can be attributed and filtered by agent.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating channel id (e.g. Discord/Slack channel). Set for " +
          "chat-driven sessions so the lane can later be looked up by channel.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating thread id within the channel, if the conversation is " +
          "threaded. Set to distinguish parallel threads in one channel.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Short human-readable subject for the session. Helps identify the " +
          "lane at a glance when listing or resuming.",
      },
    },
    output_shape: "session lane plus recent events JSON text payload",
  },
  session_context: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: "session_key_or_channel_id",
        maxLength: 500,
        description:
          "Identifier of the lane to read. Either session_key OR channel_id " +
          "is required — provide session_key when you know the lane's key; " +
          "otherwise resolve by channel_id.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read from. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      channel_id: {
        type: "string",
        required: "session_key_or_channel_id",
        maxLength: 500,
        description:
          "Originating channel id to resolve the lane by. Either " +
          "channel_id OR session_key is required — use this when you have " +
          "the chat channel but not the lane's session_key.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread id to disambiguate when a single channel_id maps to " +
          "multiple threaded lanes.",
      },
      include_events: {
        type: "boolean",
        required: false,
        default: true,
        description:
          "Whether to include the lane's recent journal events (default " +
          "true). Set false for a lightweight read of just lane metadata.",
      },
      event_limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 200,
        default: 50,
        description:
          "Maximum recent events to return (1-200, default 50). Lower it " +
          "for a quick peek; raise it to rehydrate more history.",
      },
      event_types: {
        type: "array",
        required: false,
        items: "session_event_type",
        description:
          "Optional filter to only these event types (e.g. decision, " +
          "blocker). Omit to return all types; set to focus on a category.",
      },
      importance: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Optional filter by event importance tier: hot (most important), " +
          "warm, cold. Omit to include all tiers.",
      },
    },
    output_shape: "session lane plus recent events JSON text payload",
  },
  lane_upsert: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to create or update. Reuse an existing " +
          "key to update that lane in place; a new key creates a new lane.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      status: {
        type: "enum",
        required: false,
        values: ["active", "wrapped", "archived"],
        description:
          "Lifecycle state: active (in progress, default for new lanes), " +
          "wrapped (checkpointed/handed off), archived (closed out). Set to " +
          "transition a lane; usually session_wrap manages this for you.",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Owning agent for the lane (e.g. hermes, bilby, skippy). Set so " +
          "lanes can be attributed and filtered by agent.",
      },
      source: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Where the lane originated (e.g. cli, discord, cron). Set for " +
          "provenance when a lane can come from multiple entry points.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating channel id, for chat-driven lanes. Set so the lane " +
          "can later be resolved by channel.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating thread id within the channel, when threaded.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project the lane belongs to, for scoping and filtering.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Short human-readable subject for the lane.",
      },
      current_context_md: {
        type: "string",
        required: false,
        maxLength: 100000,
        description:
          "Rolling working-context summary in Markdown — the lane's " +
          '"where we are right now" scratchpad. Overwrite it as the session ' +
          "evolves so a resuming agent gets the current picture without " +
          "replaying every event.",
      },
      metadata: {
        type: "object",
        required: false,
        propertyNames: { type: "string", maxLength: 100 },
        maxKeys: 50,
        maxJsonBytes: 100000,
        description:
          "Arbitrary structured key/value metadata for the lane (max 50 " +
          "keys, 100KB JSON). Use for machine-readable tags or pointers; " +
          "keep human narrative in current_context_md.",
      },
    },
    output_shape: "session lane JSON text payload",
  },
  lane_load: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: false,
        description:
          "Filter to a single lane by its exact key. Omit to list by other " +
          "filters instead.",
      },
      namespace: {
        type: "string",
        required: false,
        description:
          "Memory partition to list lanes from. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      project: {
        type: "string",
        required: false,
        description:
          "Filter to lanes for this project. Combine with status to find " +
          "active work on a given project.",
      },
      agent: {
        type: "string",
        required: false,
        description:
          "Filter to lanes owned by this agent (e.g. hermes, bilby).",
      },
      channel_id: {
        type: "string",
        required: false,
        description:
          "Filter to lanes from this originating chat channel.",
      },
      status: {
        type: "enum",
        required: false,
        default: "active",
        values: ["active", "wrapped", "archived"],
        description:
          "Lifecycle filter (default active). Use active to find in-progress " +
          "lanes to resume, wrapped/archived to review past sessions.",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 50,
        description:
          "Maximum lanes to return (1-50). Lanes come back most-recent " +
          "first, so a small limit gives you the latest activity.",
      },
    },
    output_shape: "session lane array JSON text payload",
  },
  append_session_event: {
    version: 4,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to append to. Must match a lane you " +
          "started or upserted; the event is journaled under this lane.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the event. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      event_type: {
        type: "enum",
        required: true,
        values: [
          "fact",
          "decision",
          "blocker",
          "action",
          "artifact",
          "receipt",
          "question",
          "correction",
          "handoff",
        ],
        description:
          "What kind of event this is — choose the closest: fact (something " +
          "learned/true), decision (a choice made), blocker (something " +
          "stopping progress), action (a step taken), artifact (a file/output " +
          "produced), receipt (proof/result of an action), question (an open " +
          "unknown), correction (fixes a prior event), handoff (context " +
          "passed to the next session/agent). Pick accurately — type drives " +
          "filtering and recall.",
      },
      content: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 50000,
        description:
          "The event text. Write a complete, self-contained statement that " +
          "will make sense when recalled later without surrounding context.",
      },
      source: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Where this event came from (e.g. tool name, user, agent). Set " +
          "for provenance when it aids later attribution.",
      },
      artifact_path: {
        type: "string",
        required: false,
        maxLength: 2000,
        description:
          "Path or URI to a produced/referenced artifact (file, doc, URL). " +
          "Set especially for artifact events so the output can be located.",
      },
      importance: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Significance tier: hot (high — surfaces first in recall), warm " +
          "(normal), cold (low/archival). Use hot for pivotal " +
          "facts/decisions, cold for routine noise.",
      },
      metadata: {
        type: "object",
        required: false,
        maxKeys: 50,
        maxJsonBytes: 100000,
        description:
          "Arbitrary structured key/value metadata for the event (max 50 " +
          "keys, 100KB JSON), plus the recognized share_candidate flag below.",
        fields: {
          share_candidate: {
            type: "boolean",
            required: false,
            description:
              "Nominate this event for shared-kb promotion (shared truth every " +
              "agent reads). Set true on a substantive fact/decision/handoff worth " +
              "sharing. Adjudication is two-stage: SYNCHRONOUSLY the server refuses " +
              "and strips the nomination if the content looks like a secret or " +
              "person-private data — when that happens the event still saves but the " +
              "response carries share_candidate_rejected with the reason. " +
              "ASYNCHRONOUSLY a promoter-gated sweep re-classifies worthiness, " +
              "de-duplicates against shared-kb, and promotes survivors. Do NOT set " +
              "true for secrets, credentials, or private/personal content.",
          },
        },
      },
    },
    output_shape:
      "session event JSON text payload with writer_identity, token_identity, " +
      "delegated_agent_id, and namespace_source provenance fields",
  },
  session_wrap: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to checkpoint. Must match the lane you " +
          "have been working in.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      summary: {
        type: "string",
        required: true,
        maxLength: 100000,
        description:
          "Narrative recap of what happened this session — enough that a " +
          "fresh agent could resume without replaying the journal. Cover " +
          "what was done, current state, and anything important learned.",
      },
      key_decisions: {
        type: "array",
        required: false,
        items: "string",
        maxItems: 20,
        maxItemLength: 2000,
        description:
          "The notable decisions made this session, one per item (max 20). " +
          "Capture choices a future session must respect or might revisit.",
      },
      next_steps: {
        type: "array",
        required: false,
        items: "string",
        maxItems: 20,
        maxItemLength: 2000,
        description:
          "Concrete follow-up actions for the next session, one per item " +
          "(max 20). Write them as actionable items so a resuming agent " +
          "knows exactly what to pick up.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project this wrap belongs to, for scoping and later filtering.",
      },
    },
    output_shape: "session wrap checkpoint JSON text payload",
  },
  upsert_repo_fact: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to write the fact into. Defaults to your own " +
          "auth-derived namespace; override only when authorized (e.g. " +
          "promoting into shared-kb).",
      },
      metadata: REPO_FACT_METADATA_CONTRACT,
      validation: REPO_FACT_VALIDATION_CONTRACT,
    },
    output_shape: "ob_entities repo_fact row JSON text payload",
  },
  list_repo_facts: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read facts from. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      repo: {
        type: "string",
        required: false,
        maxLength: 300,
        description:
          "Filter to facts about this repository slug (e.g. owner/repo).",
      },
      collection: {
        type: "string",
        required: false,
        maxLength: 300,
        description:
          "Filter to facts derived from this qmd collection.",
      },
      path: {
        type: "string",
        required: false,
        maxLength: 1000,
        description:
          "Filter to facts about this repo-relative file path.",
      },
      fact_type: {
        type: "enum",
        required: false,
        values: REPO_FACT_METADATA_CONTRACT.fact_type.values,
        description:
          "Filter to one fact category. Omit to return all types.",
      },
      subject: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Filter to facts whose subject/symbol matches this value.",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 250,
        description:
          "Maximum facts to return (1-250). Keep small for focused recall.",
      },
      offset: {
        type: "integer",
        required: false,
        min: 0,
        description:
          "Number of facts to skip, for paging. Leave at 0 for the first " +
          "page.",
      },
    },
    output_shape: "repo_fact ob_entities row array JSON text payload",
  },
};
