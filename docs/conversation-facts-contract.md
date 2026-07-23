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
   - The **top-level input schema is a single `.strict()` object** (not a raw
     shape). This is the owning public boundary: the MCP SDK validates the
     unmodified arguments against it and rejects any unrecognized top-level key
     — including a raw `transcript` / `turns` / `messages` body — with a
     caller-visible input-validation error **before the handler runs**, so
     nothing is written and no transaction is opened. (A raw shape would instead
     silently strip unknown top-level keys, which is why the strict object is
     used.)
   - Each unit and the `source_ref` are also `.strict()` objects, so any unknown
     nested key (including a raw-body key) is a hard schema reject.
   - A defense-in-depth runtime scan over the parsed shape rejects any known
     raw-transcript key (`transcript`, `turns`, `messages`, `conversation`,
     `history`, `raw`, …) should a future permissive field ever carry one
     nested. It is no longer the sole or primary defense.
   - A low per-call cap (20 units) and a per-unit content bound (4000 chars)
     reject bulk dumps and probable message pastes.
5. **Secret rejection.** Every distilled unit's content and locator are checked
   with `containsSecret`; a credential-bearing unit is rejected. Content is
   never logged.

## Durable write

Accepted units land in the existing `ob_session_events` durable journal via the
same conventions as `append_session_event`: `content_hash` dedup, writer
provenance in `metadata._openbrain.writer`, and an embedding filled from the
distilled content. The `transcript` column is **never** written by this tool.

**Atomicity.** The whole batch is written in a single all-or-nothing pg
transaction (`BEGIN` → inserts + duplicate readback + any evidence-merge →
`COMMIT`/`ROLLBACK`). A mid-batch failure rolls back every prior insert, so the
receipt can never claim partial progress that was actually discarded. Embeddings
are computed **before** the transaction opens (embedding is a slow network call)
and only the durable rows are persisted atomically; an embedding failure is
non-fatal for a unit — the row is still written without a vector. A transactional
pg pool is required; the tool never autocommits a partial batch.

**Duplicate content with new evidence.** When a unit's content matches an
existing row (same lane + `content_hash`) but carries a *distinct* structural
evidence pointer — a new `source_locator` or `event_type` the stored row does
not already have — that pointer is preserved on the existing row's
`metadata.additional_evidence` (a bounded, content-free list) rather than being
silently dropped. When no new evidence is present it is a plain duplicate. When
the evidence cannot be safely preserved (the conflicting row cannot be read back,
or the bounded evidence list is full) the caller is told explicitly via an
`evidence_not_stored` disposition instead of a benign success. Only structural
pointers are ever read or written here; distilled content is never touched.

## Receipt

The response is content-free: it reports `namespace`, `lane_id`, `source_id`,
`submitted`, `ingested`, `duplicates`, `evidence_merged`, `evidence_not_stored`,
per-unit `events` (id + type + `duplicate` flag + `disposition`), and writer
provenance. Each per-unit `disposition` is one of `stored`, `duplicate`,
`duplicate_evidence_merged`, or `evidence_not_stored`. It never echoes the
distilled content back.

## Error logging

Database and embedding failures are logged with an **allowlisted, content-free
error class only** (a pg SQLSTATE class or the `Error` constructor name mapped to
a fixed label, falling back to `unknown`). Raw `err.message` / `String(err)` is
never logged, so a provider/pg message can never echo submitted content, row
values, or pg `DETAIL`/`CONTEXT` into the logs, response, or receipt.

## Out of scope (explicitly not provided)

- No raw transcript persistence and no transcript-storage column.
- No automatic capture and no lane creation.
- No auto-promotion into shared-kb or candidate memory.
- No client/Hermes integration or quality-model tuning.
