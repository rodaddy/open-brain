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
| lane_upsert | Update lane metadata/context | write |
| lane_load | Query lanes by filters | read |
| upsert_entity | Create/update graph entity | write |
| get_entity | Fetch a graph entity by ID | read |
| list_entities | List graph entities by type/name/namespace | read |
| link_entities | Create relationship between entries | write |
| adjacent_context | Traverse link graph from a node | read |
| get_contract | Read the public Open Brain contract manifest | read |
| get_entry | Fetch a full readable memory row by table and ID | read |
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
