/**
 * The public capability list carried in the contract.
 *
 * Split out of `contract.ts` (issue 864). The array is spread into the hashed
 * payload unchanged, so the schema hash is unaffected.
 */
import type { ContractCapability } from "./contract-types.ts";

export const CONTRACT_CAPABILITIES: ContractCapability[] = [
  {
    name: "get_contract",
    version: 1,
    kind: "tool",
    description: "Read the canonical Open Brain public contract manifest.",
  },
  {
    name: "operator_doctor",
    version: 1,
    kind: "tool",
    description:
      "Read privileged operator doctor/status JSON for runtime, database, " +
      "migrations, optional providers, transport, and log/audit health. " +
      "Requires admin or ob-admin auth and never returns secrets or raw paths.",
  },
  {
    name: "get_entry",
    version: 2,
    kind: "tool",
    description:
      "Fetch one readable memory row by table and UUID. Defaults to full row " +
      "output; compact render returns a bounded exact-UUID preview envelope. " +
      "Server-side auth and namespace predicates remain the security boundary " +
      "for ID reads.",
  },
  {
    name: "decompose_entry",
    version: 1,
    kind: "tool",
    description:
      "Plan dry-run-first decomposition of an oversized readable entry into " +
      "smaller linked replacement thoughts. No writes occur unless the caller " +
      "explicitly sets dry_run=false with apply_mode=write_replacements.",
  },
  {
    name: "resolve_entry",
    version: 1,
    kind: "tool",
    description:
      "Resolve one UUID across readable Open Brain source families to its " +
      "source type, namespace, and get_entry fetch path without semantic search.",
  },
  {
    name: "upsert_repo_fact",
    version: 2,
    kind: "tool",
    description:
      "Record or update one curated, citation-backed fact about a code repository " +
      "(qmd-derived) into graph entity metadata. Use to persist durable repo " +
      "knowledge (how a module works, an invariant, a gotcha) with a source URL " +
      "that proves it; re-upsert with the same key to correct an existing fact.",
  },
  {
    name: "list_repo_facts",
    version: 2,
    kind: "tool",
    description:
      "Read back curated repository facts, scoped to your namespace and filtered " +
      "by repo, collection, path, fact_type, or subject. Use to recall what is " +
      "already known about a repo before re-deriving it.",
  },
  {
    name: "log_thought",
    version: 2,
    kind: "tool",
    description:
      "Write a single durable thought, observation, or note to long-term memory. " +
      "Use for free-form knowledge that is not tied to a session journal; it is " +
      "embedded for later semantic search. For session-scoped events use " +
      "append_session_event instead.",
  },
  {
    name: "search_all",
    version: 2,
    kind: "tool",
    description:
      "Primary recall tool. Semantic + keyword search across Open Brain memory " +
      "(thoughts, session events, facts) and optional qmd-backed code context. " +
      "Call this before answering from assumption to ground yourself in stored " +
      "knowledge.",
  },
  {
    name: "session_start",
    version: 2,
    kind: "tool",
    description:
      "Open or resume a durable session lane and get recent events back. First-class " +
      "callers supply agent/platform/server/channel/thread coordinates so the lane " +
      "is established once and asserted scope mismatches fail closed.",
  },
  {
    name: "session_context",
    version: 3,
    kind: "tool",
    description:
      "Read a session lane's current state and recent events without creating " +
      "one. Use to rehydrate context for an existing session (by session_key or " +
      "channel_id) before continuing work.",
  },
  {
    name: "lane_upsert",
    version: 2,
    kind: "tool",
    description:
      "Create or update the metadata and rolling context of a session lane " +
      "(status, project, agent, topic, current_context_md). Use to set or refresh " +
      "the lane's high-level state; use append_session_event for individual " +
      "journal entries.",
  },
  {
    name: "lane_load",
    version: 2,
    kind: "tool",
    description:
      "List session lanes matching filters (key, project, agent, channel, " +
      "status). Use to discover or pick up existing lanes; defaults to active " +
      "lanes when status is omitted.",
  },
  {
    name: "append_session_event",
    version: 8,
    kind: "tool",
    description:
      "Append one durable, typed event (fact, decision, blocker, action, etc.) " +
      "to a session lane's journal. Supports first-write lane creation and " +
      "atomically attaches supplied exact-scope coordinates to legacy lanes only " +
      "where those coordinates were previously unasserted; conflicts fail closed.",
  },
  {
    name: "citation_recall",
    version: 1,
    kind: "tool",
    description:
      "Read a session event's stored host-neutral transcript citation and " +
      "bounded neighboring exchanges, or explicitly report source_not_stored " +
      "for legacy evidence-less events.",
  },
  {
    name: "session_wrap",
    version: 2,
    kind: "tool",
    description:
      "Checkpoint a session lane with a durable summary, key decisions, and next " +
      "steps. Exact scope is validated before the session record and lane " +
      "current_context_md are updated transactionally for immediate recall.",
  },
  {
    name: "entity_graph",
    version: 2,
    kind: "schema",
    description:
      "Open Brain graph entities and links, including archived entity lifecycle.",
  },
  {
    name: "session_lanes",
    version: 2,
    kind: "schema",
    description:
      "Durable session lanes, events, context, wraps, and host-neutral transcript citations.",
  },
  // v3 since #678, when the published tool contract gained `repo`,
  // `prior_context`, and `continue_from`. `tool_contracts` moved
  // (contract-schemas.ts) and this capabilities entry did not, so the
  // manifest advertised 3 in one block and 2 in the other. The Python client
  // validates BOTH against FIRST_CLASS_RUNTIME_TOOL_VERSIONS (client.py:78)
  // and refuses a v2 manifest by design, so every direct capture returned
  // `status: lost` -- silently, since the runtime receipt reports the failure
  // and nothing was watching it. That is the same hand-maintained-mirror
  // drift this file's header comment describes.
  //
  // Keep name/version/kind on adjacent lines: the Python client's
  // test_required_contract_matches_server_source_of_truth parses this file
  // with a regex that expects them contiguous.
  {
    name: "agent_context_pack",
    version: 3,
    kind: "tool",
    description:
      "First-class realtime context-pack tool for Hermes and future agents. " +
      "It exposes exact-scope RAM working_set, explicitly opted-in quarantined " +
      "recovery, and explicitly requested bounded durable_lane_context over MCP; " +
      "the optional NATS bridge returns the same server-authoritative pack.",
  },
  {
    name: "agent_reflex_pointers",
    version: 1,
    kind: "tool",
    description:
      "Per-turn reflex projection over the single agent_context_pack durable " +
      "recall and pointer machinery. Returns budget-bounded, body-free, cited " +
      "resolvable pointers to durable records relevant to the current query, with " +
      "prior-context suppression applied; placement into the model prompt stays " +
      "client-owned and the tool returns an ordinary result envelope only.",
  },
  {
    name: "working_set_append",
    version: 1,
    kind: "tool",
    description:
      "Append one RAM-only working-context item for an exact active " +
      "namespace/agent/platform/server/channel/thread/session scope. This " +
      "does not create durable memory or shared-kb rows.",
  },
  {
    name: "recovery_wal_append",
    version: 1,
    kind: "tool",
    description:
      "Append one exact-scope quarantined recovery WAL record for interrupted " +
      "agent traces. Recovery WAL records are unreviewed, not durable memory, " +
      "and not searchable recall.",
  },
  {
    name: "recovery_wal_mark",
    version: 1,
    kind: "tool",
    description:
      "Mark or purge one exact-scope quarantined recovery WAL record after " +
      "review without promoting it into durable memory.",
  },
  {
    name: "agent_memory_adapter",
    version: 1,
    kind: "schema",
    description:
      "Draft local adapter contract for agent memory lifecycle clients. " +
      "Defines start, recall, append_event, compact, wrap, record_receipt, " +
      "nominate_shared, and export_disclosure_bundle without moving server " +
      "auth or namespace authority into clients.",
  },
  {
    name: "receipt_contract",
    version: 1,
    kind: "schema",
    description:
      "Lightweight citation-safe receipt metadata model for Open Brain " +
      "session events, with stricter Closed Brain fields marked separately.",
  },
  {
    name: "memory_promotion_lifecycle",
    version: 1,
    kind: "schema",
    description:
      "Explicit client-owned lifecycle for candidate memory, durable promotion, " +
      "relegation/discard, and shared-kb nomination. Candidate presence alone " +
      "does not write durable memory or shared-kb.",
  },
  {
    name: "streamable_http_auth",
    version: 1,
    kind: "transport",
    description:
      "Bearer-token identity establishes namespace boundaries for MCP sessions.",
  },
];
