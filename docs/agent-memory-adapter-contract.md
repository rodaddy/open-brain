# Agent Memory Adapter Contract

## Purpose

This document defines the local Open Brain adapter contract for Codex, Hermes,
thin clients, and future Closed Brain workflows. It is the issue-sized contract
for #207 and #210. Runtime adapters may wrap these calls, but Open Brain remains
the server authority for auth, namespace isolation, storage, promotion policy,
and public contract discovery.

## Ownership Boundary

Server-owned behavior:

- Bearer-token identity, role checks, and namespace predicates.
- Session lane and session event storage.
- Shared knowledge promotion policy, secret rejection, deduplication, and
  provenance stamped from trusted auth context after an explicit client
  nomination action.
- Public contract discovery through `get_contract`.

Client-owned behavior:

- Local distillation before writes.
- Context-window compaction strategy.
- Retry/spool behavior for unavailable memory service calls.
- Receipt assembly from local file, command, artifact, and channel evidence.
- OKF-like disclosure bundle export until a server exporter exists.
- Memory lifecycle decisions: candidate extraction, candidate type, promote,
  relegate, discard, and shared-kb nomination intent.

Clients must not treat convenience checks as security controls. Any ID-based
read or mutation still depends on server-side auth-derived namespace checks.
Candidate presence is inert storage metadata: it does not create a durable
thought/decision, and it does not create or queue a shared-kb write unless the
client explicitly records `memory_lifecycle_action=nominate_shared` together
with `share_candidate=true`.

The TypeScript wrapper in `src/agent-memory.ts` uses a caller-provided
`callTool(name, args)` transport and validates local call shape and metadata
safety. The Python package exposes the same Hermes-facing facade through
`openbrain_memory.AgentMemory`, including session start/recall/write,
compaction, receipt recording, repo fact helpers, and OKF-like disclosure bundle
export. Normal convenience methods do not expose caller-selected namespace
overrides; namespace delegation stays in the authenticated transport/header
layer. The thin wrappers intentionally defer transport construction; callers
that need custom HTTP/MCP/NATS routing or offline retry provide that outside the
adapter facade.

## Adapter Methods

| Method | Owner | Maps to | Status | Contract |
| --- | --- | --- | --- | --- |
| `start` | client + server | `session_start`, optional `lane_upsert` | available | Open or resume a lane using stable `session_key`, `project`, `agent`, optional `channel_id`, `thread_id`, `topic`, color, and metadata. |
| `recall` | client + server | `session_context`, `search_all`, `brain_answer` | available | Retrieve lane context and cited memory evidence. Clients choose prompt shaping; Open Brain returns readable, namespace-safe rows only. |
| `append_event` | client + server | `append_session_event` | available | Write distilled `fact`, `decision`, `blocker`, `action`, `artifact`, `receipt`, `question`, `correction`, or `handoff` events. Realtime agents may set `create_if_missing=true` with exact scope fields so the first scoped append creates the lane instead of requiring manual setup. |
| `compact` | client | `session_context`, caller-provided local distillation, `session_wrap` | client-wrapper | Read current context, distill it through caller policy or an explicit summary, then checkpoint via `session_wrap`. Open Brain does not store raw compaction transcripts. |
| `wrap` | client + server | `session_wrap` | available | Checkpoint a completed work phase with summary, key decisions, next steps, and optional receipt references. Use `compact` when the adapter should read current session context before wrapping. |
| `record_receipt` | client + server | `append_session_event` with `event_type=receipt` | client-wrapper | Assemble citation-safe receipt metadata locally and write it as a receipt event. |
| `candidate_memory` | client | `append_session_event.metadata.memory_lifecycle_action=candidate` | client-wrapper | Record review-only candidate memory with candidate type, scope, confidence, evidence refs, staleness policy, and reason. This is not a durable memory write or shared-kb nomination. |
| `promote_candidate` | client | `append_session_event.metadata.memory_lifecycle_action=promote` | client-wrapper | Record the explicit client/user promotion decision with provenance. The durable write itself is a separate explicit client action such as `remember_fact`, `remember_decision`, or a repo-fact write. |
| `relegate_candidate` | client | `append_session_event.metadata.memory_lifecycle_action=relegate` | client-wrapper | Record that a candidate was intentionally kept out of durable/shared promotion, with reason and evidence. |
| `discard_candidate` | client | `append_session_event.metadata.memory_lifecycle_action=discard` | client-wrapper | Record that a candidate was intentionally discarded, with reason and evidence. |
| `nominate_shared` | client + server | `append_session_event.metadata.share_candidate` + `append_session_event.metadata.memory_lifecycle_action=nominate_shared` | available | Explicitly nominate only non-private, durable facts or decisions for server-side shared-kb promotion. Server rejection and promoter adjudication remain authoritative. |
| `export_disclosure_bundle` | client | `interchange_profiles.okf` | client-wrapper | Generate an OKF-like bundle from readable lane events, repo facts, citations, and receipt metadata without changing Open Brain storage. |

## Candidate Promotion Lifecycle

`append_session_event` is the lifecycle journal for candidate memory. The client
must choose one of these explicit actions in `metadata.memory_lifecycle_action`:

- `candidate`: review-only candidate; no durable memory or shared-kb write.
- `promote`: explicit client/user promotion decision recorded in the lifecycle
  journal. This marker does not itself create durable memory; the durable write
  remains a separate explicit client action such as a reviewed `log_thought`,
  `log_decision`, or repo fact write.
- `relegate`: intentionally keep out of durable/shared promotion.
- `discard`: intentionally drop as not useful or unsafe.
- `nominate_shared`: explicit shared-kb nomination; the shared promoter may
  consider it only when `share_candidate=true` is also present.

Candidate metadata should include:

- `candidate_type`: `user_preference`, `process_rule`, `channel_server_rule`,
  `code_repo_fact`, `positive_example`, `negative_example`,
  `durable_decision`, or `shared_kb_nomination`.
- `candidate_scope`: citation-safe scope/provenance such as repo, project,
  agent, server/channel/thread ids, or session key. It is never an auth
  override.
- `candidate_confidence`: client confidence from 0 to 1.
- `evidence_refs`: citation-safe ids, issue URLs, repo paths, commits, or
  source refs. The server bounds each reference and rejects secret-like
  evidence metadata.
- `candidate_staleness_policy`: expiry or revalidation policy.
- `candidate_reason`: explicit reason for the action.

A user correction that should teach future behavior starts as
`memory_lifecycle_action=candidate` and `candidate_type=negative_example`.
It must not also set `share_candidate=true` unless the client/user explicitly
chooses the shared nomination workflow. A context pack may include candidate
sections, but that presence alone remains read-only context.

## Payload Expectations

All adapter calls should carry:

- `session_key`: stable lane key chosen by the runtime.
- `agent`: local agent identity, such as `codex`, `bilby`, or `skippy`.
- `project`: repository or project slug when known.
- `namespace`: optional override only when the token is authorized.
- `source`: runtime source, such as `codex`, `hermes`, `mcp2cli`, or `n8n`.
- `channel_id` and `thread_id`: external conversation identifiers when
  available.
- `metadata`: bounded JSON for color, display labels, OKF hooks, caller version,
  and local runtime facts.

For realtime first-write lane creation, `append_session_event` accepts
`create_if_missing=true` plus exact-scope fields:

- `agent`;
- `platform`;
- `server_id`;
- `channel_id`;
- `thread_id`.

When the lane is missing, Open Brain creates it and appends the event in the
same tool call. When the lane already exists, any supplied exact-scope field
must match the stored lane scope; mismatches fail with a structured
`scope_validation` error instead of silently spilling events across agents,
servers, channels, threads, or sessions.

Structured append failures use the `error` classes `retryable_outage`,
`auth_denied`, `scope_validation`, `unsupported_operation`, and
`conflict_retry`, plus `retryable` so Hermes can decide whether to spool/retry
or stop. Clients should not parse generic text such as "lane not found" for
control flow.

## Disclosure Export

`export_disclosure_bundle` is a deterministic edge exporter. It emits an
OKF-like progressive disclosure bundle from caller-supplied lane context, scoped
events, repo facts, citations, and receipts:

- `index.md`: lane/project/topic summary plus links into the bundle.
- `log.md`: timestamp-sorted scoped session events.
- `concepts/*.md`: repo fact/concept pages.
- `citations.md`: citations derived from `source_ref`, `artifact_path`, repo
  fact source URLs/paths, explicit citations, and receipt ids.
- `receipts.md`: receipt appendices with sources, outputs, and validations.

Open Brain remains the storage model. OKF metadata is preserved as an
edge-profile compatibility hook under `metadata.okf`, including unknown keys,
but imports are staging-only until a separate reviewer/promoter chooses what is
safe to store or share.

Hermes adapters should also preserve platform identity, Discord channel/thread
mapping, and agent profile metadata. Codex adapters should preserve current
branch, dirty state, validation receipts, and next-step handoff context when
wrapping.

### Codex Lifecycle Profile

Codex uses the same adapter methods, but its runtime is bounded and may compact
or stop abruptly. A Codex adapter should:

- call `start` at task/session start with a stable `session_key`;
- call `refreshLane`/`lane_upsert` when branch, dirty state, current context,
  or next action changes materially;
- call `record_receipt` after validation or artifact-producing work;
- call `compact` before context loss, preserving summary, current context,
  dirty state, decisions, next steps, and receipt pointers;
- avoid raw transcript, secret, token, and long command-log storage.

`scripts/codex-memory-smoke.ts` is the repo-local dry-run/live smoke for this
profile. Dry-run mode prints command JSON without writing memory.

### Hermes Lifecycle Profile

Hermes remains the owner of live platform loops, profile policy, Discord
gateway state, and deployment. The Open Brain-side contract requires a Hermes
adapter to map platform identity into lane metadata without importing Hermes
runtime code into this repo:

- `agent`: Hermes agent identity such as `bilby` or `skippy`;
- `platform`: platform label such as `discord` — stored as the lane `source`
  column and compared on subsequent scoped appends;
- `server_id`: server/guild identity — stored in `metadata.server_id` and
  compared on subsequent scoped appends;
- `channel_id` and `thread_id`: Discord channel/thread identifiers;
- `metadata.agent_profile`: profile/config identifier safe to store;
- `metadata.transport`: `openbrain-memory`, `mcp2cli`, or direct provider path;
- `record_receipt`: external channel, spool, validation, and handoff receipts.

Scope comparison treats a null/absent stored value as unconstrained: a lane
created by `session_start`/`lane_upsert` (which do not record `source` or
`metadata.server_id`) accepts a first scoped append instead of failing
`scope_validation`. Only a non-null mismatch on agent, platform, server_id,
channel_id, or thread_id is rejected as a cross-scope spill.

For Nagatha-style realtime Discord writes, Hermes should call
`append_session_event` with `create_if_missing=true` and the Discord exact scope.
Missing lanes are normal first-write state. Hermes should spool and retry
`retryable_outage` failures, stop on `auth_denied` or `scope_validation`, and
avoid falling back from scoped session events to unscoped `log_thought`.

Open Brain local tests may fixture these call shapes through fake transports.
Actual rtech-hermes runtime/plugin changes, hosted verification, and live
Hermes canaries belong to the consuming Hermes issue (rtech-hermes#276) unless
Rico explicitly approves that rollout phase.

## Lightweight Receipt Schema

Open Brain receipts are session events with `event_type=receipt`. The event
`content` should be a short human-readable summary. Structured receipt metadata
belongs under `metadata.receipt`.

Required `metadata.receipt` fields:

- `schema`: stable schema label, currently `openbrain.receipt.v1`.
- `action`: short action name, such as `report_generation`,
  `source_inspection`, `contract_update`, or `validation`.
- `agent`: runtime identity that assembled the receipt.
- `session_key`: lane key for the work.
- `timestamp`: ISO-8601 time when the receipt was assembled.
- `sources`: citation-safe source references read or used.
- `outputs`: files, artifacts, issue comments, PRs, or memory entries produced.
- `validations`: commands, tests, canaries, or manual checks and their result.

Recommended fields:

- `namespace`, `project`, and `branch`.
- `commands` with command name, purpose, exit status, and redacted summary.
- `external_channels` with platform, channel/thread identifiers, and purpose.
- `artifact_hashes` for generated durable outputs.
- `source_refs` for issue URLs, repo paths, commit SHAs, qmd collection names,
  or Open Brain source refs.
- `residual_risk` for known gaps, skipped checks, or stale evidence.

Secret-safe rules:

- Do not store raw transcripts, secrets, tokens, credential names with values,
  private source bodies, or long command logs.
- Prefer hashes, paths, issue URLs, source refs, and short redacted summaries.
- If a receipt would expose sensitive content, store a redacted blocker or
  validation summary instead.

## Examples

Report generation receipt:

```json
{
  "schema": "openbrain.receipt.v1",
  "action": "report_generation",
  "agent": "codex",
  "session_key": "open-brain-memory-substrate",
  "timestamp": "2026-06-26T16:00:00.000Z",
  "sources": [
    {"kind": "repo_path", "path": "docs/agent-memory-substrate-plan.md"},
    {"kind": "issue", "url": "https://github.com/rodaddy/open-brain/issues/207"}
  ],
  "outputs": [
    {"kind": "repo_path", "path": "docs/agent-memory-adapter-contract.md"}
  ],
  "validations": [
    {"kind": "test", "command": "bun test src/contract.test.ts", "status": "passed"}
  ]
}
```

Source inspection receipt:

```json
{
  "schema": "openbrain.receipt.v1",
  "action": "source_inspection",
  "agent": "codex",
  "session_key": "open-brain-memory-substrate",
  "timestamp": "2026-06-26T16:10:00.000Z",
  "sources": [
    {"kind": "repo_path", "path": "src/contract.ts"},
    {"kind": "repo_path", "path": "python/openbrain-memory/src/openbrain_memory/agent.py"}
  ],
  "outputs": [],
  "validations": [
    {"kind": "manual", "status": "passed", "summary": "Confirmed Python AgentMemory covers start/recall/write, compaction, receipt capture, and disclosure export."}
  ]
}
```

Base document/template receipt:

```json
{
  "schema": "openbrain.receipt.v1",
  "action": "template_use",
  "agent": "codex",
  "session_key": "open-brain-memory-substrate",
  "timestamp": "2026-06-26T16:20:00.000Z",
  "sources": [
    {"kind": "base_document", "path": "reports/template.md", "sha256": "redacted-or-hash"}
  ],
  "outputs": [
    {"kind": "artifact", "path": "reports/generated.md", "sha256": "redacted-or-hash"}
  ],
  "validations": [
    {"kind": "manual", "status": "passed", "summary": "Generated report preserves required headings."}
  ]
}
```

## Closed Brain Strict Deltas

Closed Brain may consume this shape, but privileged Closed Brain receipts need
stricter evidence than Open Brain requires. These fields are explicitly not
required for normal Open Brain receipt writes yet:

- `preimage_hashes` and `postimage_hashes` for every mutated file or object.
- `base_document_hashes` for source PDFs, templates, and imported bundles.
- `tool_call_ids` or equivalent non-repudiation references.
- `approval_chain` for privileged actions or human-gated publication.
- `redaction_policy` explaining removed sensitive content.
- Tamper-evident storage outside normal session event rows.

Until those strict hooks exist, do not claim Open Brain receipts satisfy Closed
Brain privileged audit requirements.
