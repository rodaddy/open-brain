/**
 * Contract entries for session lifecycle, citation recall, and lane state.
 */
import type { ToolContract } from "./tool-contract.ts";

export const SESSION_TOOL_CONTRACTS: Record<string, ToolContract> = {
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
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Platform/source identity for exact-scope lanes, such as discord. " +
          "A supplied value is attached only when unasserted and mismatches fail closed.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild/workspace identity for exact-scope lanes. Stored in lane metadata; " +
          "a supplied mismatch fails closed.",
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
    output_shape:
      "session lane plus recent events JSON text payload; when all exact-scope fields are supplied, previously unasserted coordinates are attached and asserted mismatches fail closed; null thread is unthreaded rather than wildcard",
  },
  session_context: {
    version: 3,
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
    output_shape:
      "session lane plus recent events JSON text payload; events may include " +
      "transcript_ref, transcript, and occurred_at citation fields",
  },
  citation_recall: {
    version: 1,
    input_schema: {
      event_id: {
        type: "string",
        required: true,
        format: "uuid",
        description: "Readable session event UUID to cite.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read. Defaults to the auth-derived namespace and is enforced server-side.",
      },
      context_limit: {
        type: "integer",
        required: false,
        min: 0,
        max: 10,
        default: 2,
        description:
          "Neighboring transcript exchanges returned before and after the cited event.",
      },
      max_transcript_chars: {
        type: "integer",
        required: false,
        min: 100,
        max: 50000,
        default: 2000,
        description:
          "Maximum characters from each returned source exchange; raise explicitly to expand context.",
      },
    },
    output_shape:
      "citation JSON text payload with fact and either citation.status=stored " +
      "(host-neutral conversation_ref, speaker, date, optional transcript, bounded before/after context) " +
      "or citation.status=source_not_stored for legacy evidence-less events",
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
        description: "Originating thread id within the channel, when threaded.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Project the lane belongs to, for scoping and filtering.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Short human-readable subject for the lane.",
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
        description: "Filter to lanes owned by this agent (e.g. hermes, bilby).",
      },
      channel_id: {
        type: "string",
        required: false,
        description: "Filter to lanes from this originating chat channel.",
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
};
