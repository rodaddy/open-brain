# Full-Send Ingest And Server-Side Derivation

Status: draft for review (2026-07-24)
Program: #320. Relates to #325, #331, #336, #342, #346, #347.

## Problem

Open Brain is currently the inverse of the intended design.

Intended (Honcho-shape): the client full-sends raw dialogue; the server does
the representation work — derive facts, build the user model, serve insights.

Actual, measured on 2026-07-24 against the local clone:

- The client sends almost nothing. A full working day produced **3**
  `ob_session_events`, all written because the assistant manually chose to run
  the capture command.
- `mcp_tool_audit_log` recorded 445 calls for the day but is **content-free by
  design** (`declared_parameter_keys`, `payload_size_bucket`, `duration_ms`;
  no content column). It cannot serve as a raw stream.
- Prompts and responses are persisted **nowhere**.
- The maintenance runner is fully wired (`maintenance-bootstrap.ts` ->
  `src/index.ts`) with two registered handlers (`embedding.repair`,
  `graph.derive`), but `OPEN_BRAIN_MAINTENANCE_ENABLED=0` on the local clone
  and the variable is **unset on deployment_host**. The server therefore runs no
  derivation on either box.
- Exactly one job has ever been enqueued, on both boxes: a canary
  `graph.derive` with an empty `{}` payload, `dead_letter` after one attempt,
  category `terminal`.

Net effect: the write path is manual and the derivation path is switched off.
Storage and retrieval work well; the intelligence layer never runs.

The consequence is not only sparse memory. On 2026-07-24 a captured design
decision was disproved twenty minutes later; because correction capture is
also manual, OB held a wrong fact as durable truth until corrected by hand.

## Principle

The client is a dumb pipe. It ships raw turns and decides nothing about
salience. All judgment is server-side, asynchronous, and re-runnable.

Rationale for server-side judgment:

- It runs when no session is open; the client is gone by then.
- It has the whole corpus for dedupe and supersession; a client sees one
  session.
- It survives a client crash mid-session.
- One implementation serves Claude, Codex, and the Python runtime instead of
  three divergent client heuristics.

Verbose first. Over-capture and over-propose, measure precision, then tighten.
A threshold that was never measured cannot be tuned.

## Scope

In scope:

1. A content-bearing raw turn table (`ob_raw_turns`).
2. A full-send ingest tool and its client hook wiring.
3. A redaction boundary applied **at write, before disk**.
4. A `memory.distill` maintenance job kind and handler.
5. A recurring sweep producer that enqueues work (the piece the existing
   handlers explicitly lack).
6. Enabling the maintenance runner, and fixing the dead-lettered canary.

Out of scope for this spec:

- Changing retrieval, `agent_context_pack` section shapes, or prompt
  placement. Placement stays client-owned.
- Changing namespace/scope isolation semantics. They remain a security
  boundary and apply unchanged to every new table and job.
- Dream planning behavior. It stays dry-run-safe.
- The deployment_host promotion path (tracked separately).

## 1. Raw turn table

```sql
CREATE TABLE ob_raw_turns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace         text NOT NULL,
  lane_id           uuid REFERENCES ob_session_lanes(id),
  session_ref       text,
  turn_index        integer NOT NULL,
  role              text NOT NULL,          -- 'user' | 'assistant' | 'tool'
  content           text NOT NULL,          -- redacted at write
  content_hash      text NOT NULL,
  token_estimate    integer,
  runtime           text,                   -- claude | codex | python
  redaction_applied jsonb NOT NULL DEFAULT '[]'::jsonb,
  distilled_at      timestamptz,
  distill_job_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ob_raw_turns_role_check
    CHECK (role IN ('user','assistant','tool'))
);

CREATE UNIQUE INDEX idx_ob_raw_turns_dedupe
  ON ob_raw_turns (namespace, lane_id, content_hash);
CREATE INDEX idx_ob_raw_turns_undistilled
  ON ob_raw_turns (namespace, created_at)
  WHERE distilled_at IS NULL;
```

Notes:

- `gen_random_uuid()` matches every other table, keeping cross-database merges
  collision-free by primary key.
- The partial index on `distilled_at IS NULL` is the sweep's work queue.
- `content_hash` gives idempotent re-send: a retried hook write conflicts and
  is ignored rather than duplicating a turn.
- Retention is mandatory, not optional — see section 7.

## 2. Full-send ingest

New tool `ingest_raw_turn` (agent role and above), namespace-bound by
auth-derived predicate exactly like every other write.

Client hooks:

| Hook | Sends |
|---|---|
| `UserPromptSubmit` | the user turn |
| `Stop` | the assistant turn |

Batching: a hook may send up to N turns per call to avoid per-turn latency on
the interactive path. The ingest call is fire-and-forget from the client's
perspective and must never block the turn; failures spool locally and replay
through the existing spool path (#296).

The client applies **no salience judgment**. It does not summarize, score, or
skip. It ships what happened.

## 3. Redaction boundary

Redaction runs server-side, before the row is written to disk, and is the one
place content is inspected on the write path.

Rejected/stripped before persistence:
secrets and credential values, auth headers and bearer tokens, private key
material, and any value matching the existing redaction patterns used by the
Python client's error redaction.

`redaction_applied` records **which** rule fired, never the removed value.

This preserves the standing rule that the spool and logs never store raw
secrets, while allowing prompt/response content — which is the entire point of
the table — to be stored under namespace isolation.

Explicit accepted risk to review: this table stores real dialogue content.
That is a deliberate reversal of the content-free posture of
`mcp_tool_audit_log`, justified because derivation is impossible without
content. Isolation, retention, and redaction are the compensating controls.

## 4. Distillation job

New job kind `memory.distill`, version 1, registered in
`composeMaintenanceHandlers` alongside the existing two.

Payload (bounded, validated, terminal on malformed — matching the
`graph.derive` contract):

```jsonc
{
  "namespace": "rico",
  "lane_id": "<uuid>",
  "turn_ids": ["<uuid>", "..."],   // bounded batch
  "batch_hash": "<hash of turn_ids + content hashes>"
}
```

Handler behavior, mirroring `graph.derive`'s proven discipline:

1. Reject a foreign `job.version` before parsing the payload.
2. Validate payload shape; malformed is terminal.
3. Confirm the job namespace is writable by the handler identity **and**
   matches the turns' namespace.
4. Re-read the turns under a snapshot guard in one transaction; drift
   (deleted turn, changed hash) is terminal, not a retry.
5. Call the generation model to propose candidates.
6. Write proposals to `candidate_memory` — **never** directly to
   `thoughts`/`decisions`.
7. Stamp `distilled_at` and `distill_job_id` on the consumed turns.

Idempotency key is `batch_hash`, so a re-enqueued identical batch is a no-op
via the queue's existing `ON CONFLICT (job_kind, idempotency_key) DO NOTHING`.

Nothing is auto-promoted to durable memory in v1. Distillation proposes;
promotion stays a separate, reviewable step. This is what makes verbose-first
safe: over-proposing costs review attention, not corpus integrity.

## 5. The missing producer

Both existing handlers are consumers with no producer. `graph-derivation-
handler.ts` states it directly: "the bootstrap enqueues nothing and defines no
recurring sweep, so there is no automatic continuous derivation."

Add a bounded recurring sweep in the maintenance bootstrap that, per tick:

1. Selects undistilled turns via the partial index, grouped by lane, capped at
   a configured batch size and a configured max batches per tick.
2. Enqueues one `memory.distill` job per batch.
3. Enqueues `graph.derive` for sources whose observed `content_hash` drifted
   (the sweep `graph.derive` was always waiting for).

The sweep is the difference between a queue that exists and a server that
works.

## 6. Generation model

Distillation needs a generation endpoint. The local MLX server at
`127.0.0.1:8791` currently serves **embeddings only**
(`embeddinggemma-300m-8bit`); there is no generation route configured.

Decision required (see Open Questions). Recommendation:

- **Validate the prompt** with Sol at low effort — one-off, cheap, high
  quality, proves the distillation prompt and output contract.
- **Run it permanently on a local generation endpoint.** Distillation runs on
  every session's raw content, continuously, forever. Routing that through a
  hosted model means the entire memory stream leaves the box and costs
  per-token indefinitely, and it makes the brain unable to think offline —
  which defeats the purpose of the local dogfood.

Port the Sol-proven prompt to local once the output contract is stable.

## 7. Capacity and retention

`ob_raw_turns` is the highest-volume table in the system by design. Bounding
it is not deferrable; unbounded raw dialogue is a disk-exhaustion path.

Required before enabling full-send in anger:

- A retention window for distilled turns (drop or archive once
  `distilled_at` is set and older than the window).
- A hard cap on undistilled backlog, with backpressure on ingest rather than
  silent drop.
- Content-free saturation metrics: ingest rate, undistilled depth, oldest
  undistilled age, distill throughput, dead-letter count.

This is exactly the envelope #300 asks for. Full-send makes #300 a
prerequisite rather than a P3.

## 8. Sequencing

1. Fix the dead-lettered canary; enable the runner on the local clone with a
   no-op sweep. Prove the loop runs and observes.
2. Land `ob_raw_turns` + `ingest_raw_turn` behind a flag; wire hooks; measure
   real ingest volume for one session.
3. Add retention/backpressure (section 7) before sustained use.
4. Land `memory.distill` with a Sol-low-validated prompt; write to
   `candidate_memory` only.
5. Add the sweep producer. Measure proposals per session and precision.
6. Establish the #330 EVAL-3 recall baseline, then tune thresholds against
   measured numbers.
7. Enable on deployment_host only after the local loop is measured and bounded.

## Open questions

1. **Generation model** — local endpoint vs hosted, per section 6. Blocks
   step 4 only; steps 1-3 proceed regardless.
2. **Retention window** — how long distilled raw turns are kept. Affects disk
   and the value of re-distillation with an improved prompt later.
3. **Tool turns** — whether `role='tool'` content is ingested in v1 or
   deferred. Ingesting it is the largest volume increase and the least likely
   to distill into durable memory.
4. **Epic disposition** — closing #331/#342 on child-completion would erase
   the visible record of this gap. Recommend they stay open until recall is
   measured.

## Success criteria

Not "it runs." The measurable claim is:

- A working day produces raw turns in the hundreds, not events in the single
  digits.
- The server proposes candidates without any manual capture command.
- A correction made in session supersedes the wrong fact **without** the
  assistant choosing to push it.
- Recall@k against the #330 gate improves over a recorded baseline.
