# Agent Context Pack Contract

Status: locally runtime-available over MCP for scoped working-set context,
explicit quarantined recovery summaries, explicitly requested exact-scope durable
lane context, the query-driven `durable_memory`, `profile_guidance`,
`process_guidance`, and `repo_facts` sections, and the body-free `pointers` and
truthful-empty `candidate_memory` sections — all wired into the whole-pack
allocation order. A dedicated per-turn `agent_reflex_pointers` MCP tool projects
that same single recall + pointer stack down to a budget-bounded, cited,
body-free pointer reflex (#334). An opt-in server-side NATS request/reply bridge
can expose the same pack when explicitly enabled.
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
section from RAM-first working context; the exact-scope `recovery` section only
for explicit unreviewed-recovery requests; and bounded exact-scope
`durable_lane_context` only when that section is explicitly requested. The NATS
bridge maps `ob.memory.context_pack` request/reply traffic to that same
server-authoritative pack path only when `OPENBRAIN_TRANSPORT=nats`,
`OPENBRAIN_NATS_ENABLE_BRIDGE=true`, and an allowed `OPENBRAIN_NATS_URL` are
configured.
The query-driven `durable_memory`, `profile_guidance`, `process_guidance`, and
`repo_facts` sections are assembled server-side and wired into the whole-pack
allocation order. The `pointers` section (body-free resolvable references) and
the truthful-empty `candidate_memory` section are also wired: both are pure
transforms over the single `durable_memory` hybrid recall — no second retrieval
or pointer stack. The `agent_reflex_pointers` tool (see "Reflex Pointer Surface")
is a thin projection over that same pointers path.

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
  "warnings": {
    "scope_denials": [],
    "degraded_sources": [],
    "truncation": []
  },
  "budget": { "requested": null },
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

### Durable Lane Context Boundary

`durable_lane_context` is opt-in: the server does not query durable lane tables
unless `requested_sections` explicitly includes it. The lane lookup requires an
exact match on namespace, session key, agent, platform/source, server id,
channel id, and thread id. Missing `thread_id` is an asserted unthreaded scope
once the other exact coordinates are present; it is not a wildcard for a later
threaded caller. A mismatch returns one generic `exact_scope` denial and does
not query lane events.

The section may contain bounded lane metadata, `current_context_md`, and up to
eight recent durable events. The server selects that recent subset by
`created_at DESC, id DESC`, fetches one extra row to detect omissions, and
returns the selected events in deterministic chronological order by
`created_at ASC, id ASC`. Content defaults are capped at 12,000 total
characters, 6,000 checkpoint characters, and 1,000 characters per event.
Truncation is declared in `warnings.truncation`. When `budget.max_latency_ms`
is requested, durable lane reads run on one checked-out PostgreSQL client with
transaction-local statement timeouts derived from the remaining budget; a
timed-out statement is rolled back before the client is released. Database
failure or timeout degrades to a redacted `warnings.degraded_sources` entry.
Returned lane/event references are listed in `citations`.

First-class `session_start`, scoped `append_session_event`, and `session_wrap`
carry the same agent/platform/server/channel/thread coordinates. Start creates
or conditionally attaches the exact lane scope; append attaches before inserting
the event; wrap validates/attaches before atomically writing the session record
and materializing the summary in `current_context_md`. Predicate-bound updates
never overwrite an asserted coordinate, concurrent conflicts fail closed, and a
fully asserted null thread remains unthreaded. A fresh checkpoint/wrap is
therefore immediately recallable through this section.

### Whole-Pack Budget Boundary

When the request sets `budget.max_tokens`, the pack enforces one shared
whole-pack character budget across the assembled sections instead of letting
each section spend its own independent per-section cap. The budget is derived
as `max_tokens * 4` serialized characters (`CHARS_PER_TOKEN = 4`) minus a fixed
`1200`-character envelope reserve for the surrounding response frame, clamped at
zero. Absent `max_tokens`, there is no whole-pack bound and every section keeps
its historical independent per-section behavior; `budget.whole_pack` is then
omitted entirely.

Sections are allocated in a fixed, deterministic priority order — highest value
first:

1. `working_set` — exact-scope hot active state;
2. `recovery` — explicit opt-in interrupted-session trace;
3. `durable_lane_context` — broader recallable exact-scope lane context;
4. `durable_memory` — query-driven hybrid recall over durable brain records;
5. `profile_guidance` — promoted user-preference standing guidance;
6. `process_guidance` — promoted process-rule standing guidance;
7. `repo_facts` — exact-repo curated facts with source refs and staleness.

Each lower-priority section is only fitted against whatever whole-pack budget the
higher-priority sections leave behind, so a large low-priority section can never
starve a higher-value one. This order is stable for identical inputs and is
echoed back in `budget.whole_pack.allocation_order`. `pointers` and
`candidate_memory` are the lowest-priority members, admitted last after
`repo_facts` through the same whole-pack fitter: `pointers` is a pure transform
over the `durable_memory` recall's already-authorized, already-suppressed surplus
pool (deduped against the durable identities that recall retained), and
`candidate_memory` drives no recall of its own (no candidate predicate exists
yet, so it is truthfully empty).

**Serialized section accounting.** The budget bounds the *serialized* size of the
emitted `sections` object — `JSON.stringify(payload.sections)` — not merely the
summed per-section content bodies. The enclosing `{}` of the `sections` object is
reserved once, and each retained section additionally charges its own object
framing against the running budget. That framing is position-aware, matching how
JSON writes object members (`{"a":…,"b":…}`): the **first** admitted section
charges only its quoted key plus the colon (`"key":`), and each **subsequent**
admitted section additionally charges the one leading comma that separates it from
the previous member. "First" tracks actual admission, so a starved-out or omitted
candidate never consumes the comma-free first-member slot — the next admitted
section still frames as the first. (Charging a comma for the first member would
overcount one character and could falsely truncate content sitting on the exact
boundary.) Item-bearing sections (`working_set`, `recovery`) and the durable-lane
section are each fitted by their full serialized length, so per-item wrappers,
ids, lane metadata, event wrappers, and citation ids all count against the
whole-pack budget rather than being allowed to overshoot it.

**Recency-preserving trim.** The `working_set` and `recovery` append stores order
items oldest-first, and store trimming removes the oldest (index 0), so the newest
highest-value items live at the tail. Whole-pack pressure matches that recency
ordering: it drops the oldest items/events from the front first and preserves the
newest suffix. For `working_set` the retained `item_count` is reconciled to the
surviving items; for `recovery` both `item_count` and `pending_count` are
reconciled to the surviving items; for `durable_lane_context` the oldest events
are dropped first (then the checkpoint is trimmed), `event_count`/`truncated` are
reconciled, and citations for dropped events are removed so no citation references
unemitted evidence.

The `durable_memory`, `profile_guidance`, `process_guidance`, and `repo_facts`
sections instead emit their items current/highest-value first — `durable_memory`
is relevance-ordered, and the three structured sections are newest-first
(`created_at DESC` / `updated_at DESC`), so the current head is the most valuable
item. For these, whole-pack pressure drops the lowest-priority items from the
**tail** and preserves the current head, so a tight budget never sheds the newest
standing guidance or most-recently-updated repo fact to retain stale older ones.
Retained counts are reconciled to the surviving items, and citations are
reconciled to exactly the surviving item set.

**Starvation and omission.** A requested item-bearing section that is fully
starved (all item bodies dropped) keeps its defined empty envelope
(`items: []`, counts `0`) only when that empty envelope still fits the surviving
budget, so the caller still receives its scope/budget/counter shape. If even the
empty envelope would overflow the whole-pack budget, the section is omitted
entirely — the hard "sections never exceed the budget" contract wins over
envelope-shape preservation. In either case a `warnings.truncation` marker of
`{ "source": <section>, "reason": "whole_pack_budget", "starved": true }` is
recorded so the caller knows the requested section was fully dropped rather than
silently absent. A durable-lane section that is starved out reports
`budget.durable_lane_context.content_chars_used = 0` and drops its lane/event
citations, and its loader-derived per-section truncation markers are suppressed
so no marker references an unemitted section.

When `budget.max_tokens` is set, the envelope carries:

```json
{
  "budget": {
    "requested": { "max_tokens": 4000 },
    "whole_pack": {
      "content_char_limit": 14800,
      "content_chars_used": 9213,
      "allocation_order": [
        "working_set",
        "recovery",
        "durable_lane_context",
        "durable_memory",
        "profile_guidance",
        "process_guidance",
        "repo_facts"
      ]
    }
  }
}
```

`content_char_limit` is the derived whole-pack serialized-section limit: the
`max_tokens * 4` minus `1200`-reserve budget, but never below `2` because
`JSON.stringify(payload.sections)` always emits at least the irreducible empty
object `{}` (2 characters). At tiny budgets that clamp the member budget to zero,
`content_char_limit` is therefore `2` and no section member is admitted, yet the
declared limit still bounds the serialized `sections` object with no slack.
`content_chars_used` is the portion of that budget consumed by emitted section
members (never greater than `content_char_limit`), and `allocation_order` is the
fixed priority order above. Every section that is trimmed, starved, or omitted by
the whole-pack budget adds a `whole_pack_budget` entry to `warnings.truncation`.

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

## Reflex Pointer Surface

`agent_reflex_pointers` (#334) is the smallest explicit per-turn reflex API for
cited pointers. It is a thin PROJECTION over the same `agent_context_pack`
pointers path — it forces `requested_sections: ["pointers"]`, runs the single
`durable_memory` hybrid recall exactly once (which #332 concept keys can drive and
#333 prior-context suppression prunes), reuses the #329 pointer machinery, and
then narrows the whole-pack payload down to just the body-free cited pointer
references plus the pointer-relevant envelope. It owns no retrieval, dedupe,
identity, or pointer logic of its own; it never issues a second retrieval or
pointer stack.

Request shape mirrors the pack scope contract plus a required `query` (a reflex
with no query has no pool to point at), optional `prior_context`, and optional
`budget`. It omits `requested_sections`, section toggles, and recovery opt-in,
because a pointer reflex never emits non-pointer sections.

Response shape:

```json
{
  "schema": "openbrain.agent_reflex_pointers.v1",
  "status": "ok",
  "placement": "client_owned",
  "resolvable_reference_only": true,
  "scope": { "namespace_source": "authorization", "...": "..." },
  "pointers": {
    "label": "pointers",
    "namespace_scoped": true,
    "resolvable_reference_only": true,
    "items": [],
    "item_count": 0,
    "truncated": false
  },
  "warnings": { "scope_denials": [], "degraded_sources": [], "truncation": [] },
  "budget": {},
  "citations": []
}
```

Guarantees, all inherited from the shared pack path:

- **Budget-bounded.** When `budget.max_tokens` is set, pointers are fitted under
  the same whole-pack budget and `budget.whole_pack` reports the accounting;
  budget pressure appears in `warnings.truncation`.
- **Every pointer resolvable, no bodies.** Each pointer carries identity
  (`brain_record:${source_type}:${id}`), a structural `source_ref`
  (source/type/id/namespace only), and lightweight structural metadata — never
  `content`, `content_preview`, `label`, or `preview`. Resolve through the
  authorized read path: `get_entry` with `table = source_ref.type + "s"` and
  `id = source_ref.id`. `citations` is a bijection with the emitted pointers.
- **Prior-context suppression.** Records already represented in `prior_context`
  are dropped by the shared recall before any pointer is emitted.
- **Namespace isolation.** The auth-derived namespace predicate binds the single
  recall; an unauthorized explicit `namespace` override is denied content-free
  through the same path as the pack, before recall runs.
- **Placement is client-owned.** The response carries `placement:
  "client_owned"` and resolvable references only. Open Brain performs NO implicit
  MCP `_meta` injection and NO prompt placement — the client decides whether and
  how to place the pointers. This is the same owning boundary as the rejected
  `_meta` alternative in "Hot Memory Boundary Decision (#271)".
- **Fail-open.** A degraded shared recall surfaces content-free in
  `warnings.degraded_sources` with an empty pointer set; the reflex itself does
  not error. Only auth/namespace denial returns an error payload.

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
client-pulled, exact-scope `working_set` section with explicit opt-in `recovery`
and, as added by issue #293, explicitly requested bounded
`durable_lane_context` inside the same pack envelope. Open Brain does not
implement gbrain-style server-side `_meta.brain_hot_memory` injection into
ordinary MCP tool responses or any implicit prompt-placement behavior.

The original #271 decision shipped no runtime change and deferred pack-owned
expansion behind the preconditions below. Issue #293 is a later, separately
validated expansion of that pull boundary; it does not reopen the rejected
`_meta` alternative.

Re-reading this contract after graph retrieval merged (#266 PR #273, #267
PR #274)
does not change the boundary. The relational graph arm lives inside
`search_brain` retrieval fusion (`relationalGraphSearch` in
`src/tools/search-brain.ts`) behind namespace/read-policy predicates. It
strengthens the future `durable_memory` section's evidence quality; it creates
no need for response-level injection. Graph-expanded evidence on answer/search
surfaces is owned by #268, not by hot memory.

### Rejected Alternative: MCP `_meta` Response Injection

This rejection is permanent, not deferred. The preconditions below gate only
pack-owned expansion; they do not apply to `_meta` response injection and do
not convert it into a future option.

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
  parsing changes with no schema to validate against. The pack path keeps the
  integration explicit and schema-driven, but pack expansion is still a public
  downstream change when advertised. Issue #293 advances the required contract
  to v22, advertises `agent_context_pack` v2 with `durable_lane_context`, and
  therefore requires the rollout classified below.

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

These preconditions gate pack-owned expansion only (new sections, transport
exposure, explicit pull surfaces). They are not a path to the rejected `_meta`
response injection, which stays out of bounds regardless of whether every
precondition is met. Any new pack-owned hot-memory behavior (new sections,
transport exposure, or any prompt-placement change) must land with all of the
following, per the Acceptance Fixtures section:

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

`get_contract` advertises `agent_context_pack` v2 with the exact-scope
`working_set`, explicit `recovery`, and opt-in bounded `durable_lane_context`
boundaries. It does not advertise any `_meta` injection capability, and never
will: `_meta` response injection is permanently out of bounds, and no
precondition or rollout step converts it into an advertisable capability. Any
further pack-owned advertisement (sections, transport exposure, explicit pull
surfaces) requires the preconditions above plus explicitly scoped downstream
rollout.
`src/tools/__tests__/get-contract.test.ts` guards this with positive-shape
assertions — it pins the exact top-level contract key set and asserts
`agent_context_pack` is the only advertised context-bundle surface — plus a
recursive tripwire walk over every contract key and string value using
normalized case-insensitive injection patterns with an exact-match allowlist
for legitimate terms, and a response-level regression test asserting ordinary
MCP tool results carry no `_meta` hot-memory injection payload. The walk and
the response test are tripwires, not enforcement; enforcement is the
permanent `_meta` rejection above, the pack-owned preconditions, and human
review of any contract-surface change.

### Downstream Rollout Classification

Downstream rollout classification for issue #293: applicable. The required
contract advances to `2026-07-17.memory-tools.v22`, `agent_context_pack` advances
to v2, `append_session_event` advances to v8, and the shared HTTP/NATS pack
behavior changes. `openbrain-memory` 0.1.8 fails closed on v21 and on manifests
that advertise earlier context-pack or append semantics; v21 is not represented
by a v22-shaped compatibility fixture. The post-merge sequence in
`docs/downstream-rollout.md`
therefore applies: deploy through the current gated core01 workflow, verify the
hosted v22 manifest and changed operations, complete the authoritative rtech-mcps
handoff, then refresh and verify mcp2cli through the documented local-direct and
daemon-credential paths, regenerate skills when agent guidance changes, and
complete applicable rtech-hermes and Hermes canaries. Daemon-routed `mcp2cli cache warm open-brain --force` remains a
known-broken path under `rodaddy/mcp2cli#60` and is not a required command while
that issue is open. Those live mutations are intentionally deferred from this
local candidate.
