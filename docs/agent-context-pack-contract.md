# Agent Context Pack Contract

Status: locally runtime-available over MCP for scoped working-set context and
explicit quarantined recovery summaries; an opt-in server-side NATS
request/reply bridge can expose the same pack when explicitly enabled. Broader
section assembly remains planned.
Parent issue: #220.
Research receipt: PR #225, `docs/realtime-agent-memory-research.md`.

## Purpose

`agent_context_pack` is the planned first-class realtime memory surface for
Hermes and future agents. It returns one scoped, inspectable, prompt-ready
context bundle so a runtime does not have to stitch together lane reads, broad
semantic search, repo facts, profile guidance, and stale-evidence warnings on
every turn.

This contract defines the envelope and scope rules. The MCP
`agent_context_pack` tool currently exposes the exact-scope `working_set`
section from RAM-first working context and, only when explicitly requested,
the exact-scope `recovery` section from the quarantined recovery WAL. The NATS
bridge maps `ob.memory.context_pack` request/reply traffic to that same
server-authoritative pack path only when `OPENBRAIN_TRANSPORT=nats`,
`OPENBRAIN_NATS_ENABLE_BRIDGE=true`, and an allowed `OPENBRAIN_NATS_URL` are
configured.
Broader durable section assembly remains planned until its owning issues land.

## Ownership Boundary

Open Brain owns:

- bearer-token identity and namespace predicates;
- exact-scope filtering before vector or ranking behavior;
- server-side assembly of readable lane, memory, repo fact, pointer, warning,
  budget, and citation sections;
- source refs, staleness markers, and scope-denial metadata;
- public contract discovery through `get_contract`.

Clients own:

- the active agent/platform/session identity they send;
- prompt placement and model-specific shaping after the pack is returned;
- client-owned promotion, relegation, discard, or shared-kb nomination actions;
- retry/spool behavior when Open Brain is unavailable.

Open Brain remains durable operational memory. It is not raw transcript storage,
not a behavior layer, and not the authority for Hermes profile policy.

## Request Shape

Required fields:

```json
{
  "agent": "bilby",
  "platform": "discord",
  "server_id": "guild-id",
  "channel_id": "channel-id",
  "session_key": "stable-session-key",
  "query": "what the user just asked",
  "budget": {
    "max_tokens": 4000,
    "max_latency_ms": 500
  }
}
```

Optional fields:

- `thread_id`: distinguishes Discord threads or equivalent platform threads.
- `user_id`: caller/user identity when safe and useful for profile scoping.
- `requested_sections`: subset of the known section names listed under
  "Response Shape". It selects `sections` members only; it does not toggle the
  always-present envelope fields (`warnings`, `budget`, `citations`).
- `repo`: repo slug for repo-fact filtering, such as `rodaddy/open-brain`.
- `task`: short current task label for ranking and warnings.
- `include_unreviewed_recovery`: false by default; true only for explicit
  recovery flows defined by #221.
- `client_context_refs`: client-side profile/process/doc references for
  source-aware merge. Raw private source bodies should not be sent.
- `metadata`: bounded JSON for runtime version, route name, and trace ids.

`namespace` may be accepted only when the caller token is authorized for that
namespace. Normal clients should rely on auth-derived namespace identity.

## Exact Scope Predicate

The scope key is:

```text
namespace + agent + platform + server_id + channel_id + thread_id + session_key
```

`session_key` is the canonical, contract-pinned name for the per-session scope
element that the #225 research note (`docs/realtime-agent-memory-research.md`)
refers to as `session_id`; they denote the same element.

Exact-scope filters must run before semantic search, ranking, or truncation.
Working-set and recovery sections require an exact match. Missing `thread_id`
matches only unthreaded scope; it must not match every thread in a channel.

The pack must never leak working or recovery data across:

- namespaces;
- agents;
- platforms/sources;
- servers/guilds;
- channels;
- threads;
- sessions.

Durable shared memory and repo facts may be broader than the active scope, but
they still require readable auth scope and source refs. Any denied source should
be reported as metadata, not silently ignored when it affects answer quality.

## Response Shape

Top-level fields:

```json
{
  "schema": "openbrain.agent_context_pack.v1",
  "status": "ok",
  "scope": {
    "namespace_source": "authorization",
    "agent": "bilby",
    "platform": "discord",
    "server_id": "guild-id",
    "channel_id": "channel-id",
    "thread_id": null,
    "session_key": "stable-session-key"
  },
  "sections": {},
  "warnings": [],
  "budget": {},
  "citations": []
}
```

Known section names (the `sections` object members; this list is what
`requested_sections` selects from, and it is mirrored by
`get_contract().agent_context_pack.sections`):

- `working_set`: exact-scope hot state only; labeled working context, not
  durable memory.
- `recovery`: explicit unreviewed recovery summary from the quarantined WAL.
- `durable_lane_context`: lane metadata, current context, and selected recent
  events for the scoped lane.
- `durable_memory`: cited thoughts, decisions, session wraps, and shared facts
  that are readable under auth.
- `profile_guidance`: profile/persona pointers or summaries safe for this
  agent/runtime.
- `process_guidance`: SOP or operating-rule pointers relevant to the request.
- `repo_facts`: curated repo facts with source URLs, commits, and staleness
  policies.
- `pointers`: entities, repos, services, files, or receipts worth deliberate
  follow-up fetching.
- `candidate_memory`: explicit candidates only; presence in the pack is not a
  durable write, durable memory promotion, shared-kb nomination, or shared-kb
  promotion. A client must record a separate lifecycle action before anything
  moves.

### Working Set Local Runtime Boundary

#222 defines the first RAM-first working-set boundary in
`src/realtime/working-set.ts`. The MCP `working_set_append` tool adds scoped
RAM-only entries, and the MCP `agent_context_pack` tool returns them in the
`working_set` section only on exact-scope match. This does not make NATS
transport available.

Working-set items are labeled `working_context` and set
`not_durable_memory=true`. They must not be inserted into `thoughts`,
`decisions`, `sessions`, shared-kb, search indexes, or normal durable recall
unless a later explicit client-owned lifecycle action promotes or nominates
separate candidate memory.

Default RAM budget:

- TTL: 30 minutes (`ttl_ms=1800000`);
- per-session cap: 24 items;
- global in-process cap: 1024 items;
- active-session cap: 128 sessions;
- per-item content cap: 4000 characters;
- per-item metadata cap: 2000 serialized JSON characters.

The working-set boundary exposes counters for dropped, expired, and trimmed
items. Dropped items are rejected before inclusion, expired items leave RAM
after TTL, and trimmed items are evicted by per-session/global/session-count
budget pressure.

### Recovery WAL Quarantine Boundary

#221 defines the quarantined recovery WAL in
`src/realtime/recovery-wal.ts`. The MCP `recovery_wal_append` tool records a
bounded interrupted-session trace for the exact active scope, and
`recovery_wal_mark` records review actions or purges exact records after review.
The MCP `agent_context_pack` tool returns recovery only when
`include_unreviewed_recovery=true` and the requested sections include
`recovery` or omit `requested_sections`.

Recovery items are labeled `quarantined_recovery` and set
`not_durable_memory=true` and `not_searchable_recall=true`. They must not be
inserted into `thoughts`, `decisions`, `sessions`, shared-kb, search indexes,
`search_all`, `brain_answer`, or normal session-context event reads. A recovery
record can inform the current local session only after explicit review, and any
durable memory promotion still requires a separate client-owned lifecycle action.

Recovery status values: `active`, `wrapped`, `recovery_pending`, `reviewed`,
`compacted`, `discarded`, and `expired`.

Recovery review actions: `review`, `use_for_current_session`,
`compact_to_wrap`, `promote_candidates`, `discard`, and `defer`.

Default recovery budget:

- TTL: 24 hours (`ttl_ms=86400000`);
- per-session cap: 50 items;
- global in-process cap: 2048 items;
- active-session cap: 128 sessions;
- per-item content cap: 8000 characters;
- per-item metadata cap: 2000 serialized JSON characters;
- context-pack preview cap: 1000 characters.

The store writes an append-only JSONL WAL when
`OPENBRAIN_RECOVERY_WAL_PATH` is configured. Without that env var it remains
in-memory for local tests and no hidden repo state is created. Hosted/core01
deployment of this WAL path is release-gated separately and must not happen
until deploy is explicitly approved.

`warnings`, `budget`, and `citations` are always-present top-level envelope
fields, not section members. They are mirrored by
`get_contract().agent_context_pack.envelope_fields` and cannot be toggled
through `requested_sections`.

Warning fields:

- `missing_facts`;
- `stale_sources`;
- `degraded_sources`;
- `scope_denials`;
- `truncation`;
- `uncertainty`.

Budget metadata should include requested token/latency limits, estimated output
tokens, omitted section counts, and truncation decisions.

Every included durable fact, repo fact, lane event, pointer, or candidate should
carry a citation or source ref. Working context may cite trace ids or event ids;
it must be labeled as unpromoted working state.

## Hermes One-Call Example

Hermes should be able to request:

```json
{
  "agent": "nagatha",
  "platform": "discord",
  "server_id": "rodaddy-live",
  "channel_id": "ob-dev",
  "thread_id": null,
  "session_key": "discord:rodaddy-live:ob-dev:nagatha",
  "query": "what is the actual current state of OB?",
  "requested_sections": [
    "working_set",
    "durable_lane_context",
    "durable_memory",
    "repo_facts",
    "pointers"
  ],
  "budget": {
    "max_tokens": 3500,
    "max_latency_ms": 750
  }
}
```

The response must make the source boundary explicit:

- contract/tool availability is contract evidence;
- live repo, PR, issue, and runtime state still require live verification;
- broad semantic search is fallback evidence, not authority for current state.

## Non-Goals For This Contract

- No MCP `_meta` hot-memory response injection. #271 decided the owning
  boundary; see "Hot Memory Boundary Decision (#271)" below.
- No NATS/JetStream runtime implementation. #223 owns the planned transport
  foundation in `docs/nats-jetstream-foundation.md`.
- No NATS `agent_context_pack` tool availability. #222 owns the local MCP
  working-set append/read path; transport exposure remains planned under #223.
- No promote/relegate implementation. #224 owns lifecycle actions.
- No server-side auto-promotion from working trace, recovery evidence, or
  candidate memory.
- No replacement of HTTP/MCP compatibility paths.

## Acceptance Fixtures

Implementation must include the fixtures below. Working-set/recovery denial
coverage MUST include one explicit denial case per scope key (all seven keys
from "Exact Scope Predicate"), not a subset:

- same namespace/agent/platform/server/channel/session can receive working-set
  context;
- different namespace is denied working-set context;
- different agent is denied working-set context;
- different platform/source is denied working-set context;
- different server/guild is denied working-set context;
- different channel is denied working-set context;
- different thread is denied working-set context;
- different session key is denied working-set context;
- denied working/recovery sources appear in `warnings.scope_denials`;
- durable memory and repo facts remain citation-backed and readable only under
  server auth predicates;
- candidate memory is labeled as candidate-only and does not create a durable
  memory row or shared-kb nomination.
- user correction candidate memory is labeled
  `memory_lifecycle_action=candidate` and `candidate_type=negative_example`
  until a client/user explicitly chooses promote, relegate, discard, or
  nominate_shared.

## Contract Availability

`get_contract` exposes this as (abbreviated; the emitted object also carries
`parent_issue`, `exact_scope_required`, `scope_keys`, `sections`,
`envelope_fields`, and `warning_fields` — see `src/contract.ts` for the full
authoritative shape):

```json
{
  "agent_context_pack": {
    "status": "runtime-available",
    "availability": "mcp_tool_available",
    "contract_doc": "docs/agent-context-pack-contract.md",
    "working_set": {
      "status": "local-runtime-boundary",
      "availability": "mcp_tool_available",
      "implementation": "src/realtime/working-set.ts",
      "item_label": "working_context",
      "not_durable_memory": true,
      "counters": ["dropped", "expired", "trimmed"]
    }
  }
}
```

It appears in `tool_contracts` for MCP clients once the runtime tool exists.
NATS subjects and downstream rollout are still release-gated separately.

## Hot Memory Boundary Decision (#271)

Decision date: 2026-07-07. Refs #271 (sprint #265,
`docs/plan-3f-gbrain-sprint.md`). Closing #271 on this decision requires
explicit Rico approval because the outcome is a documented boundary plus
deferred implementation, not shipped runtime behavior.

### Decision

`agent_context_pack` is the owning boundary for hot memory. Hot memory stays a
client-pulled, exact-scope `working_set` section (plus explicit opt-in
`recovery`) inside the pack envelope. Open Brain does not implement
gbrain-style server-side `_meta.brain_hot_memory` injection into ordinary MCP
tool responses, and #271 ships no new prompt-placement runtime behavior. The
already-runtime-available exact-scope pull path (#221/#222) is the lightweight
hot-memory path; any expansion beyond it (durable section assembly, transport
exposure, push-style delivery) stays deferred behind the preconditions below.
This PR itself ships no runtime change: it assigns ownership of hot memory to
`agent_context_pack` and gates all future hot-memory work behind those
preconditions.

Re-reading this contract after graph retrieval merged (#266 PR #273, #267
PR #274)
does not change the boundary. The relational graph arm lives inside
`search_brain` retrieval fusion (`relationalGraphSearch` in
`src/tools/search-brain.ts`) behind namespace/read-policy predicates. It
strengthens the future `durable_memory` section's evidence quality; it creates
no need for response-level injection. Graph-expanded evidence on answer/search
surfaces is owned by #268, not by hot memory.

### Rejected Alternative: MCP `_meta` Response Injection

- Privacy blast radius: `_meta` piggybacks memory onto every tool response, so
  a single scope bug leaks working context to every caller of every tool
  across namespaces, agents, platforms, servers, channels, threads, and
  sessions. The pack path exposes hot state only to a caller that explicitly
  requested one exact scope.
- Exact-scope filtering before ranking: response middleware sits outside the
  pack path, so the "exact-scope filters run before semantic search, ranking,
  or truncation" invariant would need a second parallel enforcement point that
  can silently drift from the pack implementation.
- Citations and source refs: `_meta` payloads have no contract-pinned
  envelope, so citation/source-ref preservation and `warnings.scope_denials`
  reporting would be ad hoc per response instead of the pack's always-present
  envelope fields.
- Fail-open requirement: ordinary tool calls must never fail because context
  injection failed. A response-mutation layer puts injection in the critical
  path of every tool call and inverts that guarantee.
- Contract advertisement: `get_contract` advertises tools and the pack
  envelope. A side-channel `_meta` capability is invisible to schema-driven
  clients (mcp2cli, generated skills, Hermes runtimes) and bypasses
  `requested_sections`/budget negotiation.
- Downstream client impact: every downstream runtime would need `_meta`
  parsing changes with no schema to validate against. The pack path requires
  zero downstream changes because nothing new is advertised.

### Rejected Alternative: Defer Server-Side Hot Memory Entirely

- The exact-scope RAM-first `working_set` boundary (#222) and quarantined
  `recovery` boundary (#221) already exist, are runtime-available over MCP,
  and carry scope-key denial tests: the working-set store covers all seven
  scope keys per key (`src/realtime/working-set.test.ts`), and the MCP pack
  tool exercises namespace, channel, and thread denial
  (`src/tools/__tests__/agent-context-pack.test.ts`). Recovery denial
  coverage is currently a single adjacent-scope case
  (`src/realtime/recovery-wal.test.ts`); the preconditions below require full
  per-key coverage before any new hot-memory behavior lands. Declaring "no
  server-side hot memory" would misstate shipped reality and would push
  clients back to stitching lane reads plus broad semantic search per turn.
- Leaving hot memory without a named owner invites exactly the `_meta`-style
  drift this decision rejects; naming `agent_context_pack` as owner keeps
  future work inside one contract with one scope predicate.

### Preconditions For Any Future Hot-Memory Implementation

Any new hot-memory behavior (new sections, transport exposure, or any
prompt-placement change) must land with all of the following, per the
Acceptance Fixtures section:

- Exact-scope denial tests for every scope key named in this contract —
  `namespace`, `agent`, `platform`, `server_id`, `channel_id`, `thread_id`,
  `session_key` — one explicit denial case per key, not a subset, with denials
  reported in `warnings.scope_denials`.
- Budget bounding: payload bounded by the requested `budget`
  (`max_tokens`/`max_latency_ms`), with truncation decisions reported in
  `warnings.truncation` and budget metadata.
- Citations: every durable item carries a citation/source ref; working context
  cites trace/event ids and stays labeled as unpromoted `working_context`.
- Fail-open: hot-memory assembly failure degrades to pack-level warnings or a
  pack error; it never fails, blocks, or mutates ordinary tool calls.

### `get_contract` Advertisement

`get_contract` continues to advertise `agent_context_pack` with the
`working_set` and `recovery` boundaries exactly as shipped. It does not
advertise any `_meta` injection or hot-memory push capability, and must not
until the preconditions above are met and downstream rollout is explicitly
scoped (per the plan-3f merge gate: no new contract capability advertisement
before server code, tests, and downstream client support are ready).
`src/tools/__tests__/get-contract.test.ts` guards this with positive-shape
assertions — it pins the exact top-level contract key set and asserts
`agent_context_pack` is the only advertised context-bundle surface — plus a
negative substring scan over the serialized contract. The substring scan is a
tripwire for the known injection names, not enforcement; enforcement is the
preconditions above plus human review of any contract-surface change.

### Downstream Rollout Classification

Downstream rollout classification: not applicable — docs plus contract-level
tests only; no MCP tool, schema, output envelope, transport, or client-facing
behavior change, so no mcp2cli, rtech-mcps, rtech-hermes, or Hermes canary
steps are required.
