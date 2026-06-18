---
name: brain
description: Query, write, and manage your Open Brain knowledge base with automatic namespace resolution. USE WHEN logging thoughts, decisions, searching brain, session saves, or any OB interaction. All OB calls MUST go through this skill for proper namespace tagging.
metadata:
  version: 0.4.0
  author: Rico
  source: https://github.com/rodaddy/open-brain
  category: utility
triggers:
  - /brain
  - search brain
  - what do I know about
  - how did I handle
  - find in kb
  - log thought
  - log decision
  - save to brain
  - push to ob
  - remember this
  - my brain
  - personal brain
  - collab brain
---

# Brain - Open Brain with Namespace Awareness

All Open Brain interactions MUST go through this skill. Direct `mcp2cli open-brain` calls without namespace resolution will be blocked by hooks.

## Namespace Resolution (CRITICAL)

Before ANY write to OB, resolve the namespace. See [references/namespace-guide.md](references/namespace-guide.md) for full rules.

**Quick version:**
1. **Explicit intent** -- user says "personal"/"my brain" -> `<caller_identity>`; says "collab"/"team"/"king" -> `collab`
2. **Host type** -- `cc-*` LXC -> `collab`; `*.local` -> `<caller_identity>`
3. **Directory** -- personal machines only: `king*` dirs -> `collab`
4. **Fallback** -- `<caller_identity>` from auth token

## Tools Available

| Tool | Use For | Namespace Required |
|------|---------|-------------------|
| `search_brain` | Semantic search across all tables (supports `tier`, `offset`) | Optional (filter) |
| `search_all` | Federated OB + qmd search (supports `tier`, `offset`) | Optional (filter) |
| `find_person` | Lookup people by name or context (supports `offset`) | No |
| `log_thought` | Save a new thought/learning/note | **Yes** |
| `log_decision` | Record a decision with rationale | **Yes** |
| `session_save` | Save session summary | **Yes** |
| `session_load` | Load previous session context | No |
| `list_recent` | Browse recent entries (supports `tier`, `offset`) | Optional (filter) |
| `update_entry` | Modify existing entry | No (inherits) |
| `rate_entry` | Rate entry usefulness | No |
| `archive_entry` | Soft-delete entry | No |
| `set_tier` | Set entry cognitive tier (hot/warm/cold) | No |
| `upsert_person` | Create/update contact | **Yes** |
| `upsert_entity` | Create/update graph entity | **Yes** |
| `get_entity` | Fetch active graph entity by UUID | No |
| `list_entities` | List active graph entities | Optional (filter) |
| `link_entities` | Link graph nodes | **Yes** |
| `unlink_entities` | Soft-delete one graph edge | **Yes** |
| `archive_entity` | Soft-delete graph entity and active links | No |
| `hydrate_entities` | Refresh graph entity embeddings immediately | Optional (filter) |

## Pagination

All read tools support `offset` (skip N entries) and `limit` (max 250 per page, default varies by tool). Use these together to page through large result sets:

```bash
# Page 1: first 100 entries
mcp2cli open-brain list_recent --params '{"limit": 100, "days": 30}'

# Page 2: next 100
mcp2cli open-brain list_recent --params '{"limit": 100, "offset": 100, "days": 30}'

# Page 3: next 100
mcp2cli open-brain list_recent --params '{"limit": 100, "offset": 200, "days": 30}'
```

This applies to `list_recent`, `search_brain`, `search_all`, and `find_person`.

## Graph Entity Lifecycle

Use graph tools for rows in `ob_entities`, not legacy `projects` rows:

```bash
mcp2cli open-brain upsert_entity --params '{"namespace":"collab","entity_type":"project","name":"open-brain"}'
mcp2cli open-brain link_entities --params '{"namespace":"collab","from_type":"entity","from_id":"<uuid>","to_type":"entity","to_id":"<uuid>","relation":"depends_on"}'
mcp2cli open-brain unlink_entities --params '{"namespace":"collab","from_type":"entity","from_id":"<uuid>","to_type":"entity","to_id":"<uuid>","relation":"depends_on"}'
mcp2cli open-brain archive_entity --params '{"id":"<entity-uuid>"}'
```

If entity search must be available immediately after bulk imports or schema
changes, push hydration instead of waiting for future upserts:

```bash
mcp2cli open-brain hydrate_entities --params '{"namespace":"collab","only_missing_embedding":true,"limit":100}'
```

## Graceful Degradation

If `mcp2cli open-brain` fails (server down, network issue):
1. Log a warning: "Open Brain unavailable, falling back to local search"
2. Run `scripts/search-kb.ts <query>` for local JSON-based search
3. Present results in the same output format

## Reference Docs

- [Namespace Guide](references/namespace-guide.md) -- full mapping table, host detection, intent keywords
- [Agent Usage](references/agent-usage.md) -- how autonomous agents should use this skill
- [Cognitive Tiering](references/cognitive-tiering.md) -- hot/warm/cold tiers, set_tier, filtering, dream cycle
- [Search Guide](references/search-guide.md) -- search modes, output format, auto-tagging
