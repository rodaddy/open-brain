---
name: brain
description: Query, write, and manage your Open Brain knowledge base with automatic namespace resolution. USE WHEN logging thoughts, decisions, searching brain, session saves, or any OB interaction. All OB calls MUST go through this skill for proper namespace tagging.
metadata:
  version: 0.3.0
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
| `search_brain` | Semantic search across all tables (supports `tier` filter) | Optional (filter) |
| `search_all` | Federated OB + qmd search (supports `tier` filter) | Optional (filter) |
| `find_person` | Lookup people by name or context | No |
| `log_thought` | Save a new thought/learning/note | **Yes** |
| `log_decision` | Record a decision with rationale | **Yes** |
| `session_save` | Save session summary | **Yes** |
| `session_load` | Load previous session context | No |
| `list_recent` | Browse recent entries (supports `tier` filter) | Optional (filter) |
| `update_entry` | Modify existing entry | No (inherits) |
| `rate_entry` | Rate entry usefulness | No |
| `archive_entry` | Soft-delete entry | No |
| `set_tier` | Set entry cognitive tier (hot/warm/cold) | No |
| `upsert_person` | Create/update contact | **Yes** |

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
