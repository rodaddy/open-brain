# Realtime Agent Memory Research

Status: research note, not an accepted architecture.
Date: 2026-06-27

This note grounds the realtime Open Brain memory direction in inspected source
instead of product guesses. It is meant to sharpen issues #220-#224.

## Strongest Constraint

NATS/JetStream can improve transport, but it does not by itself fix the "five
calls to get usable context" problem. The higher-value unit is a first-class
context pack: one bounded, scoped, prompt-ready response assembled from hot
working state, durable memory, repo/process facts, persona/process inputs, and
explicit gaps.

Transport should carry that pack and the working-trace events efficiently. It
should not make Hermes, Codex, or Claude own the orchestration logic in-turn.

## Evidence Matrix

| System | Confirmed implementation facts | Implication for Open Brain |
| --- | --- | --- |
| gbrain | Has a deterministic context engine that injects `systemPromptAddition` on every assemble call, explicitly delegates compaction to the host runtime, and uses zero LLM calls on that hot path. Retrieval Reflex detects entity mentions, resolves them to compact pointers, suppresses pointers already seen in prior context, carries source IDs, and injects synopsis-only pointer blocks rather than full page bodies. It also has a bounded per-session facts queue with drop counters and shutdown behavior, a Postgres-native durable job queue, dream verdict caches, and cycle locks. | The OB realtime surface should separate "pointer/context pack" from "body fetch." It needs source/session scope, prior-context suppression, confidence/provenance, hard caps, and queue health counters. Full raw memory dumps are the wrong hot-path primitive. |
| Honcho | Public model is store conversations/events synchronously, run background reasoning asynchronously, then query peer/session context, low-latency representations, search, or natural-language insights. Storage primitives are workspace, peer, session, message, and internal observer/observed collections. Message writes enqueue derivation tasks and also schedule immediate embedding so messages become searchable quickly while derivation catches up. | Fresh session trace and derived representation must be different tiers. A low-latency context pack should use precomputed representations where possible and explicitly mark what is fresh/unprocessed. |
| Hermes current | Hermes injects context through a `pre_llm_call` hook as user-message context, not as system-prompt mutation. rtech-Hermes already has an Open Brain provider with lane recall, triggered semantic search, background prefetch, explicit memory write mirroring, pre-compress/session-end wraps, degraded read/write windows, a local durable spool, contract validation, source-specific Discord lane keys, and narrow `ob_record` routes. NATS is documented as future direction only. | Realtime OB should present one Hermes-ready context pack and reuse the existing provider policy surface: fail-closed contract validation, degradation windows, spool/replay rules, route names, and lane keys. It must not bypass the existing write policy. |
| Codex local policy | Codex/Open Brain policy says OB is durable operational memory, not raw recall, not a behavior layer, and not Honcho. Codex lanes/events are short-term continuity; wraps are checkpoints; long-term memory is distilled decisions/facts/artifacts. Raw transcripts, secrets, private source bodies, and unvalidated guesses must not be promoted. | A raw realtime trace tier is allowed only if quarantined from durable recall and shared truth. Promotion must stay client-owned and explicit. |
| Claude local policy | Claude startup/wrap docs make Open Brain the durable target and local reports only fallback/buffer. Deep recovery can use Open Brain/qmd candidate recall, but source/live files remain first. | Claude-compatible recovery should read a compact briefing/context pack, not trawl raw local artifacts by default. |
| Open Brain current | Current OB contract has session lanes, append-only session events, session wraps, lane upsert/load, namespace isolation, shared-kb promotion discipline, source refs, known gaps, and uncertainty in `brain_answer`. | The realtime design should extend the existing lane/event model instead of inventing a separate memory product. New raw/working tiers need explicit namespace and scope predicates matching the existing security boundary. |

## Design Conclusions

### 1. Build The Context Pack First

The first real deliverable should be a contract for a single call such as
`agent_context_pack`:

- identity: agent, platform, server/guild, channel, thread, session, user,
  namespace, source namespace
- hot working set: last N turns or current rolling state for exactly that scope
- durable lane context: scoped lane events and current lane metadata
- durable memory: selected thoughts/decisions/repo facts/shared-kb items
- persona/process/code facts: explicit sections with source refs and staleness
- pointer block: entities/repo/service symbols worth fetching deliberately
- gaps/warnings: missing context, stale facts, degraded recall, unreadable
  namespace, confidence/uncertainty
- budget metadata: token estimate, truncation, source counts, freshness

The pack should be prompt-ready for Hermes and inspectable for Codex/Claude.
Clients should not need to call lane, semantic search, repo facts, entity graph,
and policy files separately on every live turn.

### 2. Keep A Separate Scoped Working Trace

The working trace should be scoped by:

```text
namespace + agent + platform + server_id + channel_id + thread_id + session_id
```

It should be usable only inside that exact scope unless an explicit promotion or
share action occurs. It should be excluded from ordinary `search_all`,
`brain_answer`, shared-kb, and durable thought/decision recall.

The practical shape:

- RAM-first rolling window for active sessions.
- Optional server-side WAL for crash recovery.
- Tiny durable index for "recoverable trace exists" and retention metadata.
- Destroy/overwrite after wrap/compact unless the client explicitly exports or
  promotes selected facts.
- No server-side auto-promotion from raw trace.

### 3. Treat Crash Recovery As Review, Not Memory Truth

If Hermes or another agent dies before compaction, the next agent needs enough
state to recover usefully. That does not mean the trace becomes trusted memory.

Recovery should produce:

- a quarantined recovery bundle for the same agent/channel/server/session
- a summary candidate
- candidate facts/corrections/promotion nominations
- a client-side decision step: keep, wrap, promote, relegate, or discard

This matches the existing OB rule that wraps are checkpoints and long-term
memory is distilled.

### 4. NATS/JetStream Belongs In The Initial Foundation

The initial NATS issue should include JetStream stubs/config even if the first
producer/consumer is small. Retrofitting stream names, durable consumer names,
retention policy, and replay semantics later will force contract churn.

Suggested initial streams:

- `OB_AGENT_TRACE`: scoped realtime trace events, short retention, not durable
  memory.
- `OB_CONTEXT_PACK_REQUESTS`: optional request/reply bridge for agents that can
  use NATS directly.
- `OB_CONTEXT_PACK_AUDIT`: lightweight receipts and pack build diagnostics.
- `OB_PROMOTION_CANDIDATES`: explicit client/agent nominations, not automatic
  shared truth.

Core01 should be the base NATS server because OB already runs there, and that
keeps the hot memory path close to the DB and embedding/runtime services.

### 5. Do Not Copy Honcho Blindly

Honcho's useful lesson is async reasoning plus low-latency representations.
Its peer psychology model is not the OB owning boundary. OB should stay
operational memory with source refs, namespace isolation, explicit promotion,
and repo/process facts. If we import the wrong abstraction, we risk making OB
less auditable and more "confident idiot" prone.

## Issue Updates To Make Next

1. #220 should become the parent contract issue for `agent_context_pack`.
2. #222 should define the scoped RAM working set and quarantined trace tier.
3. #221 should define WAL/recovery review behavior, not durable memory writes.
4. #224 should define client-owned promote/relegate actions over trace-derived
   candidates.
5. #223 should define NATS/JetStream as transport foundation after #220's pack
   envelope is stable enough to carry.

## Open Questions

- Exact retention: fixed event count, byte budget, TTL, or all three?
- Does a compact destroy only RAM, or also the server-side WAL after successful
  `session_wrap` receipt?
- Should context packs be built entirely server-side, or should Hermes supply
  local persona/process chunks for the server to merge by reference?
- How much of current Discord history should be included in the pack versus
  represented as a pointer requiring explicit fetch?
- Should JetStream replay be allowed to rebuild RAM state after service restart,
  or should WAL be the recovery source of truth?

## Source Pointers

- gbrain clone inspected at
  `/Volumes/ThunderBolt/_tmp/open-brain/research/gbrain`.
- Honcho clone inspected at
  `/Volumes/ThunderBolt/_tmp/open-brain/research/honcho`.
- Hermes source inspected at
  `/Volumes/ThunderBolt/Development/ai-agents/platforms/rtech-hermes`.
- Local Codex/Claude policy inspected under `/Users/rico/.codex` and
  `/Users/rico/.claude`.
