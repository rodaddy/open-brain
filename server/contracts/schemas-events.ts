/**
 * Contract entries for session-event append and session wrap.
 */
import { SOURCE_REFS_CONTRACT } from "../../src/source-refs.ts";
import type { ToolContract } from "./tool-contract.ts";

export const EVENT_TOOL_CONTRACTS: Record<string, ToolContract> = {
  append_session_event: {
    version: 8,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to append to. With create_if_missing=true, " +
          "a missing lane is created first and the event is journaled under it.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the event. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      create_if_missing: {
        type: "boolean",
        required: false,
        description:
          "Create the session lane when it is missing, then append the event. " +
          "Use for first-write realtime agent scopes so callers do not have to " +
          "pre-provision lanes manually. Repeated calls with the same " +
          "namespace/session_key return or reuse the same lane.",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Agent identity to bind when create_if_missing creates a lane. On an " +
          "existing legacy lane, a previously null agent is atomically attached; " +
          "an asserted mismatch fails closed.",
      },
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Platform/source identity to bind when create_if_missing creates a " +
          "lane, such as discord. Stored as lane source; a previously null legacy " +
          "value is atomically attached and an asserted mismatch fails closed.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild identity for exact realtime scope. Stored in lane metadata; " +
          "a previously absent legacy value is atomically attached and an asserted " +
          "mismatch fails closed.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Channel identity to bind when create_if_missing creates a lane. On an " +
          "existing legacy lane, a previously null channel is atomically attached; " +
          "an asserted mismatch fails closed.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread identity to bind when create_if_missing creates a lane. On an " +
          "incompletely scoped legacy lane, a non-null thread may be atomically " +
          "attached; once the lane is otherwise exact, null means unthreaded and " +
          "an asserted mismatch fails closed.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Project name to set if create_if_missing creates the lane.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Human-readable topic to set if create_if_missing creates the lane.",
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
      transcript_ref: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 2000,
        description:
          "Host-neutral source conversation reference. Must use collab/... and must not contain /Volumes/ or /mnt/ host paths.",
      },
      transcript: {
        type: "string",
        required: false,
        maxLength: 50000,
        description:
          "Optional inline exchange from transcript_ref. transcript_ref is required when this is supplied.",
      },
      occurred_at: {
        type: "string",
        required: false,
        format: "date-time",
        description:
          "ISO 8601 timestamp with timezone for the cited exchange. transcript_ref is required when this is supplied.",
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
          "keys, 100KB JSON), plus the recognized explicit memory lifecycle " +
          "fields below.",
        fields: {
          memory_lifecycle_action: {
            type: "enum",
            required: false,
            values: ["candidate", "promote", "relegate", "discard", "nominate_shared"],
            description:
              "Client-owned lifecycle action for memory extracted from this " +
              "event. candidate marks review-only material; promote/relegate/" +
              "discard record explicit client handling; nominate_shared is the " +
              "only action eligible for the shared-kb promoter, and still " +
              "requires share_candidate=true plus server safety checks.",
          },
          candidate_type: {
            type: "enum",
            required: false,
            values: [
              "user_preference",
              "process_rule",
              "channel_server_rule",
              "code_repo_fact",
              "positive_example",
              "negative_example",
              "durable_decision",
              "shared_kb_nomination",
            ],
            description:
              "Candidate classification chosen by the client/runtime. User " +
              "corrections that should teach future behavior without immediate " +
              "durable promotion should use negative_example.",
          },
          candidate_reason: {
            type: "string",
            required: false,
            maxLength: 2000,
            description:
              "Explicit client reason for creating, promoting, relegating, " +
              "discarding, or nominating the candidate.",
          },
          candidate_confidence: {
            type: "number",
            required: false,
            min: 0,
            max: 1,
            description:
              "Client confidence that the candidate is useful and correctly " +
              "scoped. This is advisory; Open Brain still enforces auth and " +
              "safety.",
          },
          candidate_scope: {
            type: "object",
            required: false,
            description:
              "Client-declared scope for the candidate, such as repo, project, " +
              "agent, server_id, channel_id, thread_id, or session_key. It is " +
              "provenance, not an authorization override.",
          },
          candidate_staleness_policy: {
            type: "string",
            required: false,
            maxLength: 1000,
            description:
              "When the candidate should expire, be revalidated, or be treated " +
              "as historical context only.",
          },
          evidence_refs: {
            type: "array",
            required: false,
            items: "object",
            maxItems: 20,
            maxItemJsonBytes: 2000,
            maxTotalJsonBytes: 10000,
            description:
              "Citation-safe evidence references for the candidate, such as " +
              "event ids, issue URLs, repo paths, commit SHAs, or source refs. " +
              "The server bounds serialized evidence metadata and rejects " +
              "secret-like evidence refs. Do not include raw private transcripts " +
              "or secrets.",
          },
          share_candidate: {
            type: "boolean",
            required: false,
            description:
              "Shared-kb nomination marker. By itself this is candidate " +
              "metadata only and must not create a shared-kb write. The " +
              "promoter only considers rows where share_candidate=true AND " +
              "memory_lifecycle_action=nominate_shared. SYNCHRONOUSLY the " +
              "server refuses and strips the nomination if content looks like " +
              "a secret or person-private data; the event still saves and the " +
              "response carries share_candidate_rejected with the reason. Do " +
              "NOT set true for secrets, credentials, or private/personal content.",
          },
          sanitized_resubmit_of: {
            type: "string",
            required: false,
            description:
              "When resubmitting a sanitized replacement after a synchronous " +
              "share_candidate rejection, set this to reject_detail.resubmit_metadata." +
              "sanitized_resubmit_of from a resubmittable rejected event response.",
          },
          sanitized_resubmit_attempt: {
            type: "integer",
            required: false,
            min: 1,
            max: 2,
            description:
              "Bounded sanitized resend attempt count. Set this to " +
              "reject_detail.resubmit_metadata.sanitized_resubmit_attempt when " +
              "re-nominating a sanitized replacement. The server derives an " +
              "observed attempt from prior same-lane rejections and marks further " +
              "sync rejections non-resubmittable after the maximum attempt.",
          },
          okf: {
            type: "object",
            required: false,
            description:
              "Optional Open Knowledge Format compatibility metadata for future " +
              "edge export/import. Open Brain remains authoritative; this object " +
              "is only a disclosure/interchange hook. Use OKF-like keys such as " +
              "type, title, description, resource, tags, timestamp, citations, " +
              "and links. Unknown keys should be preserved by clients/exporters.",
          },
        },
      },
    },
    output_shape:
      "session event JSON text payload with lane_created, transcript_ref when supplied, " +
      "writer_identity, token_identity, delegated_agent_id, and namespace_source provenance " +
      "fields; sync share_candidate rejections include share_candidate_rejected " +
      "and reject_detail {category, matched_kind, span_count, redaction_hint, " +
      "resubmittable, resubmit_attempt, max_resubmit_attempts, optional " +
      "resubmit_blocked_reason, and resubmit_metadata only when resubmittable}; " +
      "reject_detail never echoes offending content; supplied exact-scope coordinates on an existing legacy lane " +
      "are atomically attached only where unasserted before the event insert, while any asserted scope conflict " +
      "returns scope_validation; other error classes are retryable_outage, auth_denied, unsupported_operation, " +
      "or conflict_retry",
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
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Agent identity for exact-scope checkpoint validation.",
      },
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Platform/source identity for exact-scope checkpoint validation.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild/workspace identity for exact-scope checkpoint validation.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Channel identity for exact-scope checkpoint validation.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread identity. When channel_id is supplied and thread_id is omitted, " +
          "the request asserts an unthreaded lane rather than a wildcard.",
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
        description: "Project this wrap belongs to, for scoping and later filtering.",
      },
      source_refs: SOURCE_REFS_CONTRACT,
    },
    output_shape:
      "session wrap checkpoint/source_refs JSON text payload; supplied exact scope is established and validated before the transactional session/current_context_md write; duplicate content_hash checkpoints do not merge later source_refs but still materialize the scoped lane summary",
  },
};
