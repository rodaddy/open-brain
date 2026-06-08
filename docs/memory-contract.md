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
- Cross-namespace access is allowed for coordination (not a security boundary)
- `collab` namespace for shared/cross-agent knowledge

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
| log_thought | Record a learning/insight | write |
| log_decision | Record a decision with rationale | write |
