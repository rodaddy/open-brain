# Open Brain Operational Memory Contract

## What Open Brain Is

Open Brain is the **durable operational memory** for PAI agents. It stores:
- **Session lanes**: persistent threads of work tied to agent + platform + context
- **Session events**: append-only facts, decisions, blockers, artifacts during active work
- **Sessions**: checkpointed summaries of completed work phases
- **Thoughts**: learnings, observations, insights
- **Decisions**: choices made with rationale
- **Relationships**: people and contacts
- **Projects**: project metadata
- **Entities & Links**: explicit knowledge graph adjacency. Graph entities live
  in `ob_entities`; `entity_type: "project"` is not a row in the legacy
  `projects` table.

## What Open Brain Is NOT

- **Not a behavior layer.** Rules, routing, and personality live in CLAUDE.md / skill files.
- **Not raw recall.** Session transcripts and logs are separate from OB entries.
- **Not a dumping ground.** Store distilled facts, decisions, blockers,
  artifacts, validation receipts, and checkpoint summaries. Do not store raw
  transcripts, secrets, or long command output.
- **Not Honcho.** OB is the authoritative source for operational state. Honcho/session vibes are not canonical.

## Memory Tiers

| Tier | Meaning | Access Pattern |
|------|---------|---------------|
| **Hot** | Front of mind — actively used | Direct lane/event lookup |
| **Warm** | Accessible — searchable, not preloaded | Semantic search via search_brain |
| **Cold** | Deep storage — rarely accessed | Explicit query with tier filter |

## Agent Workflow

### Starting Work
1. Call `session_start` with your session_key → get lane + recent events
2. Lane persists across compactions. Wrap is a checkpoint, not an ending.

### During Work
1. Log events via `append_session_event` (facts, decisions, blockers, artifacts)
2. Update lane context via `lane_upsert` when the working state changes
3. Link related entities via `link_entities`

### At Compaction
1. Call `session_context` to gather current state
2. Distill summary locally via LLM
3. Call `session_wrap` to checkpoint the summary to durable storage
4. Context compacts. Lane persists.

### Resuming After Compaction
1. Call `session_start` → lane + events are immediately available
2. Search OB for related past work if needed

## Namespace Convention

- Namespace defaults to `auth.clientId` (agent identity)
- Namespace isolation is a security boundary. ID-based reads and mutations must
  include auth-derived namespace predicates unless a token-sourced global role
  is intentionally broad.
- `shared-kb` namespace is for shared/cross-agent Open Brain knowledge. Agents should promote
  into `shared-kb` through promotion flows. The legacy `collab` shared namespace is retired
  (#167): it is no longer a default legacy shared namespace, is not canonicalized to
  `shared-kb`, and has no default read fallback. It remains valid only as an explicit,
  operator-configured migration source (`SHARED_NAMESPACE_LEGACY`).

## Tool Reference

| Tool | Purpose | Auth |
|------|---------|------|
| session_start | Find/create lane, return context | write |
| session_context | Read lane + events | read |
| session_wrap | Checkpoint summary to durable storage | write |
| append_session_event | Log event to lane | write |
| recovery_wal_append | Append exact-scope quarantined recovery evidence, not durable memory/search | write |
| recovery_wal_mark | Review, mark, or purge exact-scope recovery WAL evidence | write |
| lane_upsert | Update lane metadata/context | write |
| lane_load | Query lanes by filters | read |
| upsert_entity | Create/update graph entity | write |
| get_entity | Fetch a graph entity by ID | read |
| list_entities | List graph entities by type/name/namespace | read |
| link_entities | Create relationship between entries | write |
| adjacent_context | Traverse link graph from a node | read |
| get_contract | Read the public Open Brain contract manifest | read |
| get_entry | Fetch a readable memory row by table and ID; use `render: "compact"` for bounded exact-UUID recall | read |
| upsert_repo_fact | Store curated qmd-derived repo fact metadata | write |
| list_repo_facts | Read curated qmd-derived repo facts | read |
| search_brain | Semantic search across all tables | read |
| search_all | Federated search (OB + qmd) | read |
| brain_answer | Extractive cited evidence bullets from Open Brain | read |
| log_thought | Record a learning/insight | write |
| log_decision | Record a decision with rationale | write |

## Codex Durable Memory Flow

Codex should use Open Brain through daemon-mode `mcp2cli open-brain`, not direct
MCP server config.

### Quickstart

Start or resume a lane:

```bash
mcp2cli open-brain session_start --params '{"session_key":"<stable-key>","project":"open-brain","agent":"codex","topic":"<short topic>"}'
```

Read current lane context without writing a new event:

```bash
mcp2cli open-brain session_context --params '{"session_key":"<stable-key>","include_events":true,"event_limit":50}'
```

Append only high-signal events:

```bash
mcp2cli open-brain append_session_event --params '{"session_key":"<stable-key>","event_type":"decision","content":"<distilled decision and rationale>","source":"codex","importance":"warm"}'
```

Checkpoint a compact durable summary:

```bash
mcp2cli open-brain session_wrap --params '{"session_key":"<stable-key>","project":"open-brain","summary":"<checkpoint>","key_decisions":["<decision>"],"next_steps":["<next action>"]}'
```

Search before answering when prior context matters:

```bash
mcp2cli open-brain search_all --params '{"query":"<query>","limit":10}'
```

Ask for extractive, cited memory evidence when Codex needs a concise rendered
answer surface instead of raw hits:

```bash
mcp2cli open-brain brain_answer --params '{"query":"what did we decide about codex memory?","limit":5}'
```

Dry-run the Codex lifecycle command sequence without writing memory:

```bash
bun run codex-memory-smoke
```

Execute the disposable live smoke only when intentionally validating the
configured Open Brain service:

```bash
OPEN_BRAIN_CODEX_SMOKE_WRITE=1 bun run codex-memory-smoke
```

Run the memory eval suite when changing retrieval, synthesis, citation, or
Codex workflow fixtures:

```bash
bun run eval:memory
bun run eval:memory -- --fixture eval/open-brain/fixtures/codex-workflows.json
```

Treat eval failures as contract failures. Recall and precision failures mean the
retriever is not surfacing the right evidence; temporal, contradiction, and
namespace failures mean Codex cannot safely trust the answer surface; citation
failures mean user-facing memory answers are not auditable.

### Short-Term Versus Long-Term Memory

Short-term Codex memory is the active session lane plus recent session events.
Use `session_start`, `append_session_event`, `session_context`, and
`session_wrap` for active work, compaction recovery, and checkpoint summaries.

Long-term memory is distilled project knowledge: decisions, reusable facts,
relationships, validated artifacts, and promoted shared knowledge. Use
`log_decision`, `log_thought`, entity/link tools, and promotion flows when a
fact should survive beyond the current lane. Do not promote raw chat logs,
secrets, private source identifiers, or unvalidated guesses.

### Repo Knowledge From qmd

qmd is the local GPU-backed code knowledge compiler. It can index source, embed
chunks, and attach context to paths. Agents that do not run on that machine
cannot depend on qmd during normal memory flow, so required qmd-derived repo
facts must be promoted into Open Brain.

Use `upsert_repo_fact` for curated, durable operating knowledge such as
ownership, gotchas, dependency rules, import rules, validation notes, and source
pointers. The fact must include source provenance and staleness metadata:
`repo`, `collection`, `path`, `source_commit`, `verified_at`, `fact_type`,
`staleness_policy`, and either `symbol` or `subject` when applicable.

Do not mirror raw qmd chunks or full code excerpts into Open Brain by default.
For volatile implementation details, store a stable fact plus a source pointer
and verify the live source through `gh` or a checkout before editing.

### Optional Remote qmd Deep Lookup

Remote qmd lookup is optional and best-effort. It is not part of the required
Open Brain/Hermes memory contract. Normal startup, recall, writes, current
memory, session lanes, and repo facts must continue to work when qmd is
unavailable.

Issue #137 is dispositioned in
`docs/roadmap/optional-qmd-deep-lookup.md`: implementation of a controlled
remote qmd wrapper is deferred until the owning mcp2cli/qmd/host-routing
boundary is explicitly approved. Until then, required qmd-derived knowledge must
be promoted into Open Brain with `upsert_repo_fact`, and remote qmd may only be
treated as a future deep-lookup escape hatch.

### Citation And Answering Rules

Memory-derived facts should be cited with the returned source identity: for
Open Brain entries, cite `source_ref.source`, `source_ref.type`,
`source_ref.id`, and when useful `source_ref.namespace`; for qmd results, cite
`source_ref.path` and `source_ref.collection`.

Search result `source_ref` values intentionally expose only citation-safe
identity, label/preview, creator, namespace, and timestamps for the readable row.
They do not expose raw promotion provenance such as a private source namespace
or source id.

`brain_answer` renders only citable snippets from readable Open Brain rows. It
cites every bullet with a `source_ref`, and returns `known_gaps` / `uncertainty`
when evidence is missing, stale, mixed, or unsafe to cite. When no readable or
citable evidence is available, `answer` is `null`; the tool must not fabricate
uncited facts.

`get_entry` defaults to the full readable row for exact UUID fetches. For large
entries, callers can pass `render: "compact"` and optional `max_chars`
(80-2000, default 500) to receive a bounded envelope with `content_preview`,
`content_length`, `content_truncated`, `source_ref`, and a `fetch_path` for the
full row. The same server-side auth and namespace predicates apply to both
renders. `content_length` and `content_truncated` describe the readable compact
projection used for `content_preview`; callers that need every raw stored column
should follow `fetch_path` with `render: "full"`.

### Transcript Citation Contract

`append_session_event` may store a memory/summary with `transcript_ref`, an
optional inline `transcript`, and optional `occurred_at`. A supplied transcript
(including an empty transcript) or occurred time requires `transcript_ref`.
`transcript_ref` is a durable host-neutral `collab/...` path with canonical
alphanumeric-starting segments containing only alphanumerics, `.`, `_`, and
`-`; absolute, host, backslash, colon, empty, `.` and `..` segments are
rejected. The event's `source` is the cited speaker/agent.

Use `citation_recall` with the readable session-event UUID to return the fact,
conversation ref, speaker, date, and the stored exchange. Its bounded
`before`/`after` context comes from neighboring transcript-bearing events in
the same lane and conversation ref; callers may explicitly raise
`context_limit` or `max_transcript_chars` within the server bounds. Existing
events without a transcript ref remain readable and return
`citation.status: "source_not_stored"`; callers must not infer a source.

### OKF Compatibility Hooks

Open Brain does not implement OKF as its storage model. Treat OKF as an edge
profile for disclosure, export, import staging, and portable review bundles.
The canonical memory record remains the Open Brain lane/event/entity row, and
Closed Brain provenance receipts remain stricter than OKF frontmatter.

Clients may add optional `metadata.okf` objects to session events, lane
metadata, and curated repo facts when the record should later export cleanly to
an OKF-like bundle. The compatibility shape should use OKF vocabulary where it
fits: `type`, `title`, `description`, `resource`, `tags`, `timestamp`,
`links`, and `citations`. Unknown keys are allowed and should be preserved by
clients and exporters. The `get_contract` manifest advertises this as the
`interchange_profiles.okf` profile so thin clients can discover the hook without
guessing.

Export mapping is intentionally one-way until an importer exists:
- Concept bodies: distilled OB thoughts, entities, repo facts, or important
  session events become non-reserved Markdown files with YAML frontmatter.
- `index.md`: generated from lane/project/repo grouping metadata and used only
  as a progressive-disclosure navigation surface.
- `log.md`: generated from scoped session events and wraps.
- `# Citations`: generated from `source_ref`, `artifact_path`, receipt metadata,
  repo fact source URLs, and Closed Brain receipt entries.

Do not auto-promote imported OKF content into `shared-kb`. Imports should create
candidate lane events, entities, or repo facts first, then use the normal
promotion and namespace checks. Do not store secrets, raw transcripts, or
private source bodies merely because an OKF bundle contains them.

### Difference From Hermes Agents

Hermes agents are long-running services that can keep platform state, channels,
and event loops warm. Codex sessions are bounded coding runs that may compact or
end abruptly. Codex should therefore treat Open Brain as an explicit durable
handoff layer: read it when prior decisions matter, write only distilled events
and checkpoints, and cite memory-derived claims in final answers.

Hermes can react continuously to messages and scheduled work. Codex should not
auto-write every turn or treat memory as live truth. It must verify drift-prone
facts when cheap, surface stale or conflicting evidence, and keep repo-local
policy files as the behavior source of truth.

### Contract Parity

Runtime-neutral scenarios live in `contracts/memory/`. The parity gate validates
that every fixture maps to `parity-manifest.json` and that every `both` or
`python` fixture is consumed by the Python suite. The TypeScript peer
(`clients/ts/`, #312) consumes the same fixture set through
`clients/ts/tests/contract-fixtures.test.ts`; its manifest capabilities are
`implemented` only where that runner proves them, and a `ts`-implemented
capability without a ts-consumed fixture fails `check-parity`.

Intentional asymmetry must be declared as `runtime-specific` with a concrete
reason (currently only `receipt-shapes`: the TS client owns the bounded public
`error_category` taxonomy and does not implement the Python `AgentMemory`
agent-receipt surface). Client or contract changes run
`bun contracts/check-parity.ts` plus the fixture-consuming pytest subset in
the repository pre-push hook, and the hook's full `bun test` now includes the
TS fixture runner.
Python and TypeScript MCP requests both declare the reviewed contract
id/schema hash in `X-OB-Contract`; the server logs a structured mismatch
warning but does not yet reject the request.

### Failure-Mode Checklist

- `mcp2cli` or Open Brain unavailable: do not invent memory state; continue from
  repo/live evidence and note that durable memory lookup or capture failed.
- Missing readable evidence: return a known gap instead of synthesizing an
  answer from vibes or unrelated search hits.
- Stale evidence: mention that the memory may be outdated and verify live state
  when the fact is likely to drift.
- Contradictory evidence: surface uncertainty and cite both sides when safe.
- Namespace denial or unreadable source: respect the denial; do not broaden
  namespace access unless the caller's token and policy allow it.
- Secret or raw transcript content: do not store it. Save a redacted decision,
  artifact path, or validation receipt instead.
- Eval regression: fix retrieval, citation, fixture, or policy behavior before
  forcing the memory protocol in AGENTS or skills.

## Capability Audit Gate

Before planning Open Brain architecture, creating issues, changing schema/tools,
or deciding what Codex memory already supports, inspect current capabilities:

```bash
mcp2cli open-brain --help
mcp2cli schema open-brain.search_all
mcp2cli schema open-brain.brain_answer
mcp2cli schema open-brain.session_start
mcp2cli schema open-brain.append_session_event
mcp2cli schema open-brain.session_context
mcp2cli schema open-brain.session_wrap
mcp2cli open-brain get_stats --params '{}'
mcp2cli open-brain list_namespaces --params '{}'
```

In this repo, also inspect `src/tools/` and `src/db/migrations/` before
proposing new primitives. State what exists, what is missing, and what should be
docs/protocol instead of code.

## Operational-Path Isolation Disposition (#297)

Namespace and exact-scope enforcement per operational surface, with the
authority for each. Every ID-based read or mutation carries an auth-derived
namespace predicate unless the surface is named below as intentionally global
or the token-sourced role is intentionally global (bare admin/ob-admin/promoter
identities, which by design carry no restrictive namespace predicate — only
frozen-namespace/shared-kb exclusions). Header-scoped identities
(`namespaceSource === "header"`) are always bound to their own namespace,
regardless of role.

| Surface | State | Authority |
|---|---|---|
| Spool replay | Enforced client-side: units replay under their parked exact scope, with `_parked_namespace` provenance stamped on **every** replayable record (`session_start` since #314; extended to lone/non-start records by the PR #317 review swarm); foreign-namespace units are retained with zero dispatches and zero retry/quarantine accounting (#309, #310, #314). Honest carve-out: records already on disk without the marker — spooled before #314 provenance stamping for `session_start`, before PR #317 for the other replayable operations, or by a namespace-less runtime config — carry no `_parked_namespace` and drain under the replaying runtime's namespace; exposure is bounded to pre-existing spool leftovers | `python/openbrain-memory/src/openbrain_memory/runtime.py`, `_runtime_spool.py`; regressions in `tests/test_runtime.py` |
| Deletion / archive | Enforced server-side across the full delete-capable surface: `archive_entry`, `bulk_archive`, `archive_entity` (`appendWriteNamespacePredicate` on every UPDATE), `unlink_entities` (`canWriteNamespace` gate + explicit `namespace = $1` binding), `demote_entry`, `curate_entries` auto-archive, and the REST demote route (per-tool predicate tests). On the denial/no-op path the response is content-free and indistinguishable from not-found; the `bulk_archive` transaction-failure path was sanitized in this PR to a stable content-free message with code/name-only logging | `src/namespace-policy.ts`; mock negative matrix in `src/tools/__tests__/namespace-isolation-matrix.test.ts` + live-Postgres negative test in `src/tools/__tests__/namespace-isolation-matrix-live.test.ts` |
| Export (disclosure bundle) | Enforced: fail-closed on lane-identity conflicts and namespace-tagged items with an immutable session-derived isolation stamp (#305); the formatter itself is local-only with no server path. TypeScript enforcement: `validateDisclosureScope` in `src/disclosure-bundle.ts` rejects any namespace-tagged item ("namespace cannot be verified by the export lane") and `assertDisclosureLaneIdentity` in `src/agent-memory.ts` rejects lane-identity conflicts with the active session | `src/disclosure-bundle.ts`, `src/agent-memory.ts`; `python/openbrain-memory` disclosure tests |
| Migration | Schema migrations (`scripts/migrate.ts`) are not data-boundary operations; `scripts/retire-collab-migration.ts` is **intentionally global** — an operator-only one-time script, per the issue's global-authorization carve-out. Real controls: dry-run by default, `--execute` required to mutate, the `COLLAB_RETIRE_APPROVAL_ENV` approval value required for execute, and the same approval forced for any non-local `DB_HOST` (`dbHostRequiresReleaseApproval`); `DB_HOST`/`DB_USER` are connection prerequisites only, not gates. Legacy-lane normalization landed in #301 | `scripts/retire-collab-migration.ts` (`assertExecuteApproval`, `dbHostRequiresReleaseApproval`) |
| Diagnostics (operator doctor) | **Intentionally global** operator surface: role-gated (`canReadDoctor`) and content-free by construction (`last_error` is literally "redacted") | `src/operator-doctor.ts` |
| Audit log | Facts-only rows, no payloads; fail-open under saturation is a documented deliberate trade on LAN-local infra | `src/audit-log.ts`, `docs/operator-audit-log.md`, `docs/memory-limits.md` |
| Backup / restore | **Enforced (#298)**: `scripts/backup-verify.ts` runs the full integrity + runtime-compatibility pass BEFORE any mutation anywhere (migration compatibility is PREFIX-based: the backup's sorted applied list must be an exact prefix of the repo list; interleaved gaps fail closed as `incompatible_interleaved`), and `scripts/restore.ts` refuses to proceed on any failed verdict, refuses targets carrying user tables in any non-public schema outright (the approved wipe drops schema `public` only), refuses a non-empty public schema without `--wipe-target` + approval env, and requires remote-host approval for non-local targets. Backups retain namespace/scope metadata inside the dump (every row keeps its `namespace` column); manifests and receipts are content-free by construction — distinct-namespace COUNT only, never namespace names; child `pg_dump`/`pg_restore` stderr is sanitized to exit code + error class (raw COPY/CONTEXT/DETAIL lines can carry literal row data) and validation failure details are pg-code/name-only — and restore re-validates namespace predicate columns, distinct-namespace count, and archived-row survival post-restore. Proven end-to-end by the live drill (`scripts/__tests__/backup-restore-live.test.ts`, run in CI's `db-integration` job). Honest carve-outs: local at-rest encryption intentionally not applied (LAN-local policy; off-host copies must be encrypted), and scheduled stale-backup alerting is operator-runbook wiring (`backup-verify --max-age-hours` is the tested hook) | `scripts/backup.ts`, `scripts/backup-verify.ts`, `scripts/restore.ts`, `docs/backup-restore.md` |
| Source registry / ingestion gate | **Enforced (#337)**: the `ob_sources` registry is the server-side allowlist for ingestion. Every identity/read/update/delete is namespace-qualified: a write resolves to the caller's own namespace by default, or to an explicitly requested `target_namespace` authorized server-side by `canWriteNamespace` (`effectiveWriteNamespace`) — so a bare token-sourced global admin/ob-admin can register/approve/update a specifically requested namespace without impersonating it, while a header-scoped identity stays bound to its header namespace and cannot broaden. Reads are constrained by `readableNamespaces`, and the immutable external identity is unique per `(namespace, source_kind, external_id)` so the same external location in two namespaces never collides or resolves across the boundary; an identical re-registration is idempotent (returns the stored row unchanged) while a divergent one conflicts. `approved=true` from a caller is **not** authorization — approval is honored only for a token-sourced admin/ob-admin identity (header-delegated sessions cannot grant it), and ingestion eligibility (`resolveIngestionEligibility`) derives purely from durable `approval_state='approved' AND lifecycle_state='active'`, never a request flag. Updates are guarded by `id + namespace + expected_revision` with stale-vs-not-found disambiguation; remove is a namespace-qualified soft-retire. Collectors compute the content digest from real bytes via the deterministic `hashSourceContent` envelope helper rather than asserting an unproven digest. The registry MCP operations (`register_source`, `list_sources`, `update_source`, `remove_source`, `source_ingestion_eligibility`) are wired through `src/tools/index.ts` with strict schemas, content-free error envelopes, and permission annotations. Metadata extraction runs behind a bounded, injected provider whose output is strictly re-validated, normalized/deduped, and capped, and always fails open to no metadata without blocking or reversing the durable write; the background enrichment UPDATE is bound to `id + effective namespace + archived_at IS NULL` (via an allowlisted table) so a UUID collision can never enrich a row across the namespace boundary. Extraction and registry logs are content-free (length + error class/name only, never source text). Non-goals (collectors, scheduling, embeddings, reconciliation) are out of scope for #337 | `src/source-registry.ts`, `src/extraction.ts`, `src/db/migrations/027_source_registry.sql`; unit matrix in `src/__tests__/source-registry.test.ts` + live-Postgres isolation/migration test in `src/db/migrations/027_source_registry.test.ts` (CI `db-integration`) |

If a new operational surface (restore, bulk export, cross-namespace tooling)
lands without a row here, that is a review finding — add the surface and its
predicate or its explicit global carve-out in the same PR.

### Spool Replay: Quarantine and Delivery Semantics (#296)

Automated spool replay is fully receipted and content-free:

- **Delivery semantics — at-least-once.** A replayed record is only removed
  from the spool by the rewrite that follows the replay pass. A crash after
  the dispatch succeeded but before that rewrite persists re-delivers the same
  record (same `idempotency_key`) on the next drain. Records carry stable
  `idempotency_key` values for exactly this linkage, but server-side dedup is
  NOT currently guaranteed for every replayable operation — consumers that
  need exactly-once must dedupe on `idempotency_key`.
- **Drain receipts.** Every drain produces a `DrainReport` (counts + linked
  receipts, no payloads, no error bodies) on the triggering operation's
  `RuntimeOutput.drain` and on `last_drain_report`: `REPLAYED` per replayed
  record, `QUARANTINED` per quarantined unit. Both statuses are additive
  within the pinned `openbrain.runtime_receipt.v1` schema.
- **Quarantine.** A unit that fails 5 consecutive drain attempts (default,
  `JsonlSpool(quarantine_threshold=...)`) moves atomically to the
  `<spool>.quarantine.jsonl` sidecar — a content-free envelope (unit spool
  keys, retry count, first/last failure unix times, error class name only)
  followed by the unit's original redacted lines — and is never retried
  automatically. Poison units never block replay of valid units. Retry counts
  survive restarts via the `<spool>.retry-state.json` sidecar (losing that
  sidecar loses only counters, never records).
- **Re-quarantine replaces; success reconciles.** Quarantining a unit whose
  `unit_key` already has a sidecar entry REPLACES that entry's envelope and
  lines with the fresh copy (one envelope per unit key per pass, last write
  wins) — idempotent across the crash window between the sidecar append and
  the main-spool rewrite, and preserving current (possibly operator-edited)
  lines when a restored unit re-fails to threshold. Conversely, a unit that
  replays successfully has any stale sidecar entry (left by that crash
  window) removed in the same locked commit, so no phantom quarantine
  entries survive a crash-then-success sequence.
- **Operator restore procedure.** To restore a quarantined unit: copy the
  unit's record lines — never the envelope line — from
  `<spool>.quarantine.jsonl` back into the main spool file, then delete the
  envelope line plus its record lines from the sidecar. A restored unit
  restarts with a fresh retry budget (its retry counters were cleared at
  quarantine time). If the restore is left incomplete (sidecar entry not
  deleted) nothing is lost: a re-failing restored unit re-quarantines with
  fresh lines and counts under the replace semantics above, and a
  successfully replayed one removes the leftover entry automatically.
- **#314 retention is not failure.** Units parked under another namespace —
  any replayable operation, since provenance is stamped on every spooled
  record — stay parked in the main spool with zero dispatches, zero
  retry-count increments, and are never quarantined.
