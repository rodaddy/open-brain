# Conversation-fact ingestion contract (`ingest_conversation_facts`)

Issue #340. A narrow server-side contract for writing **approved, distilled
conversation-derived facts, decisions, and receipts** into the durable session
journal. It is **not** a transcript store and it does **not** auto-capture: the
caller distills the durable statements client-side, and the tool only accepts
small bounded distilled units bound to an already-approved conversation source.

## What it accepts

- `namespace` (optional) — the isolation boundary. Defaults to the caller's own
  clientId. The exact namespace the approved source and the target lane are
  bound to.
- `scope` — the six non-namespace coordinates of the exact seven-coordinate
  durable-lane scope: `agent`, `platform`, `server_id`, `channel_id`,
  `thread_id` (nullable), `session_key`. Kept in lockstep with the durable-lane
  scope predicate.
- `source_ref` — a structural reference to the conversation source the facts
  were distilled from: `{ source_kind: "conversation", external_id }`.
  Identity-only; never a body.
- `facts` — 1..20 distilled units, each `{ event_type, content, source_locator?,
  importance? }`. `event_type` is one of `fact | decision | receipt`. `content`
  is a single bounded statement (≤ 4000 chars).

## Server-side gates (all enforced before any write)

1. **Authorization.** `canWrite(role, "sessions")` and `canWriteNamespace` on
   the exact namespace. A caller cannot bypass either via any input flag.
2. **Explicit approval + structural source.** The cited `source_ref` is resolved
   through the existing source-registry authority
   (`resolveIngestionEligibility`, bound to the exact namespace). Ingestion
   proceeds only when a matching `conversation` source is **approved** and
   **active**. A caller-supplied approval flag never reaches this path; approval
   is derived purely from durable server-side state.
3. **Exact seven-coordinate scope.** The target lane is located by namespace +
   `session_key` + all five other coordinates (thread_id null-safe). No matching
   lane → rejected. The tool never creates lanes and never auto-captures.
4. **Raw-payload rejection.** Raw transcript bodies, turn/message arrays, and
   arbitrary bulk conversation payloads are rejected before any write:
   - Each unit and the `source_ref` are `.strict()` objects, so any unknown key
     (including a raw-body key) is a hard schema reject.
   - The declared input schema does not accept a top-level transcript/turns
     field, so such a top-level key is stripped by the transport and can never
     reach the write path.
   - A defense-in-depth runtime scan rejects any known raw-transcript key
     (`transcript`, `turns`, `messages`, `conversation`, `history`, `raw`, …)
     found anywhere in the request, including nested values.
   - A low per-call cap (20 units) and a per-unit content bound (4000 chars)
     reject bulk dumps and probable message pastes.
5. **Secret rejection.** Every distilled unit's content and locator are checked
   with `containsSecret`; a credential-bearing unit is rejected. Content is
   never logged.

## Durable write

Accepted units land in the existing `ob_session_events` durable journal via the
same conventions as `append_session_event`: `content_hash` dedup (identical
distilled content is a no-op duplicate, not a second row), writer provenance in
`metadata._openbrain.writer`, and an embedding filled from the distilled
content. The `transcript` column is **never** written by this tool.

## Receipt

The response is content-free: it reports `namespace`, `lane_id`, `source_id`,
`submitted`, `ingested`, `duplicates`, per-unit `events` (id + type +
duplicate), and writer provenance. It never echoes the distilled content back.

## Out of scope (explicitly not provided)

- No raw transcript persistence and no transcript-storage column.
- No automatic capture and no lane creation.
- No auto-promotion into shared-kb or candidate memory.
- No client/Hermes integration or quality-model tuning.
