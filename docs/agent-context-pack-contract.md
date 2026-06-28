# Agent Context Pack Contract

Status: planned contract, not runtime-available yet.
Parent issue: #220.
Research receipt: PR #225, `docs/realtime-agent-memory-research.md`.

## Purpose

`agent_context_pack` is the planned first-class realtime memory surface for
Hermes and future agents. It returns one scoped, inspectable, prompt-ready
context bundle so a runtime does not have to stitch together lane reads, broad
semantic search, repo facts, profile guidance, and stale-evidence warnings on
every turn.

This contract defines the envelope and scope rules before transport or runtime
implementation. It must not be advertised as an available tool until server
code, tests, and downstream client support exist.

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
- `requested_sections`: subset of known response sections.
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

Known section names:

- `working_set`: exact-scope hot state only; labeled working context, not
  durable memory.
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
  durable write or shared-kb promotion.

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
    "pointers",
    "warnings"
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

- No NATS/JetStream implementation. #223 owns transport.
- No recovery WAL implementation. #221 owns recovery.
- No RAM working-set implementation. #222 owns hot state.
- No promote/relegate implementation. #224 owns lifecycle actions.
- No server-side auto-promotion from working trace, recovery evidence, or
  candidate memory.
- No replacement of HTTP/MCP compatibility paths.

## Acceptance Fixtures

Implementation must include fixtures that prove:

- same namespace/agent/platform/server/channel/session can receive working-set
  context;
- different agent is denied working-set context;
- different server/guild is denied working-set context;
- different channel is denied working-set context;
- different thread is denied working-set context;
- different session key is denied working-set context;
- denied working/recovery sources appear in `warnings.scope_denials`;
- durable memory and repo facts remain citation-backed and readable only under
  server auth predicates;
- candidate memory is labeled as candidate-only and does not create a durable
  memory row or shared-kb nomination.

## Contract Availability

`get_contract` exposes this as:

```json
{
  "agent_context_pack": {
    "status": "planned-contract",
    "availability": "not_runtime_available",
    "contract_doc": "docs/agent-context-pack-contract.md"
  }
}
```

It must not appear in `tool_contracts` or in required client tool lists until
the runtime tool exists.
