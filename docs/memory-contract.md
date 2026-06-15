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
- **Entities & Links**: explicit knowledge graph adjacency

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
- `collab` namespace is for shared/cross-agent knowledge. Agents should promote
  into `collab` through promotion flows rather than hard-coding `collab` as the
  only destination.

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
| link_entities | Create relationship between entries | write |
| adjacent_context | Traverse link graph from a node | read |
| search_brain | Semantic search across all tables | read |
| search_all | Federated search (OB + qmd) | read |
| brain_answer | Extractive cited evidence bullets from Open Brain | read |
| log_thought | Record a learning/insight | write |
| log_decision | Record a decision with rationale | write |

## Codex Durable Memory Flow

Codex should use Open Brain through daemon-mode `mcp2cli open-brain`, not direct
MCP server config.

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
