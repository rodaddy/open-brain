# Phase 6: PAI Integration -- Context

**Gathered:** 2026-03-13
**Status:** Ready for planning
**Source:** Deep investigation during v1.0 deployment session

<domain>
## Phase Boundary

Integrate Open Brain into the PAI ecosystem as the unified knowledge backend. Replace fragmented knowledge stores (JSON files, markdown exports, old PostgreSQL KB) with Open Brain's semantic search. Rewire hooks and skills to use Open Brain. Preserve the separate-repo architecture (skippy-agentspace + Open Brain are independently publishable).

This phase does NOT restructure PAI's directory layout or merge repos. It wires the existing pieces together.
</domain>

<decisions>
## Implementation Decisions

### Architecture (locked)
- Open Brain and skippy-agentspace stay as separate repos
- Both are independently publishable -- someone can use either alone
- PAI (private config at ~/.config/pai/) is the integration glue
- Skills detect Open Brain availability at runtime -- graceful degradation if absent
- Deployment model: hybrid (skills local, knowledge server remote)

### What gets replaced (locked)
- `inject-brain-context.ts` hook -> replaced by Open Brain semantic search
- `query-knowledge.ts` hook -> replaced by Open Brain tag/semantic search
- `/brain` skill -> rewritten to use `mcp2cli open-brain search_brain`
- `/capture-session` skill -> rewritten to call Open Brain `session_save` directly
- JSON KB files (decisions-v2.json, learnings-v2.json, patterns-v2.json) -> archived, not imported (stale data from 2026-02-01, would pollute vector space)
- Markdown exports (/Volumes/ThunderBolt/Exports/pai/) -> deprecated, no longer needed

### What stays unchanged (locked)
- `load-core-context.ts` hook -> MANDATORY, injects PAI LAWs (never touch)
- Claude Code project memory (MEMORY.md) -> orthogonal, per-project operational gotchas
- `~/.config/pai-private/memory/` -> personal context, low-frequency manual edits
- `Development/.reports/` session files -> keep for human-readable audit trail
- `capture-all-events.ts` -> observability JSONL, complementary not competing
- Git tracking hooks -> orthogonal to knowledge system

### What gets enhanced (locked)
- `open-brain-session-save.ts` -> richer capture (files modified, commands, decisions, blockers, active project state)
- `open-brain-session-load.ts` -> richer output, coordinated with load-core-context.ts
- `capture-session-summary.ts` -> keep markdown + ALSO push to Open Brain

### Claude's Discretion
- Whether to create an enforcement hook (e.g., "if user mentions a decision, auto-log to Open Brain")
- Whether `/kb-extraction` skill gets rewritten or deprecated entirely
- Whether `/Notes` skill integrates with Open Brain thoughts table
- Exact hook execution ordering in settings.json
- Whether to add a `/brain` alias that calls mcp2cli directly vs wrapping in a skill
</decisions>

<specifics>
## Current System Map (from deep investigation)

### 5 Knowledge Stores (BEFORE migration)

| Store | Location | Format | Entries | Status |
|-------|----------|--------|---------|--------|
| PostgreSQL KB (CT 200) | 10.71.20.49 `knowledge` table | Rows + GIN | Active | REPLACE with Open Brain |
| JSON KB | ~/.config/pai-private/knowledge/*.json | JSON arrays | ~2,000 | ARCHIVE (stale) |
| Markdown exports | /Volumes/ThunderBolt/Exports/pai/ | Markdown | 324 KB | DEPRECATE |
| Claude Code memory | ~/.claude/projects/*/memory/MEMORY.md | Markdown | Per-project | KEEP |
| Open Brain | 10.71.20.15 (LXC 208) | PG + pgvector | Growing | PRIMARY |

### 4 Context Injection Hooks (SessionStart order)

1. `initialize-session.ts` -- session marker files, tab title, persona (KEEP)
2. `load-core-context.ts` -- PAI LAWs + skills + recent KB (KEEP -- MANDATORY)
3. `inject-brain-context.ts` -- queries /Exports/pai/ markdown by tag (REPLACE)
4. `query-knowledge.ts` -- PostgreSQL tag/full-text with 2s timeout (REPLACE)
5. [startup|resume|compact matcher]
6. `open-brain-session-load.ts` -- loads previous session from Open Brain (ENHANCE)

### 3 Capture Pipelines

1. `/capture-session` -> Fabric extract -> Mattermost -> n8n -> PostgreSQL (REPLACE with direct Open Brain)
2. `/session-wrap` -> markdown files in .reports/ (KEEP + mirror to Open Brain)
3. PreCompact hook -> Open Brain session_save (ENHANCE)

### Skills That Need Changes

| Skill | Location | Current Backend | Action |
|-------|----------|-----------------|--------|
| `/brain` | ~/.config/pai/Skills/brain/ | PostgreSQL + JSON fallback | REWRITE -> Open Brain |
| `/capture-session` | ~/.config/pai/Skills/capture-session/ | Fabric -> Mattermost -> n8n | REWRITE -> Open Brain direct |
| `/kb-extraction` | ~/.config/pai/Skills/kb-extraction/ | JSON files | EVALUATE -- maybe deprecate |
| `/kb-load` | ~/.config/pai/Skills/kb-load/ | architecture-v2.json files | EVALUATE -- maybe integrate |
| `/Notes` | ~/.config/pai/Skills/Notes/ | Markdown + n8n | EVALUATE -- maybe integrate |

### Key File Paths

**Hooks to modify:**
- `/Users/rico/.config/pai/hooks/inject-brain-context.ts` -> replace with Open Brain search
- `/Users/rico/.config/pai/hooks/query-knowledge.ts` -> replace with Open Brain search
- `/Volumes/ThunderBolt/Development/open-brain/hooks/open-brain-session-save.ts` -> enhance
- `/Volumes/ThunderBolt/Development/open-brain/hooks/open-brain-session-load.ts` -> enhance

**Skills to rewrite:**
- `/Users/rico/.config/pai/Skills/brain/SKILL.md` + supporting files
- `/Users/rico/.config/pai/Skills/capture-session/SKILL.md` + supporting files

**Config to update:**
- `/Users/rico/.claude/settings.json` -> hook ordering, possibly merge/remove hooks
- Shell profile -> `OPEN_BRAIN_AGENT_TOKEN` env var (already set during v1.0)

**Files to archive/deprecate:**
- `~/.config/pai-private/knowledge/decisions-v2.json` (19K lines)
- `~/.config/pai-private/knowledge/learnings-v2.json` (20K lines)
- `~/.config/pai-private/knowledge/patterns-v2.json` (2K lines)
- `/Volumes/ThunderBolt/Exports/pai/all-session-learnings-*.md`

### skippy-agentspace Context

**Repo:** /Volumes/ThunderBolt/Development/skippy-agentspace
**Status:** v1.2 complete (39 plans, 16 phases, 3 milestones shipped)
**Installer:** `bash tools/install.sh --all` (symlinks into ~/.claude/skills/)
**Skills:** 12 (core, skippy-dev, add-todo, check-todos, correct, session-wrap, update-todo, browser, excalidraw, fabric, vaultwarden, deploy-service)
**Important:** Installs to ~/.claude/skills/, NOT ~/.config/pai/Skills/. The 72 existing PAI skills live in the latter. Only 12 overlap.
**Pre-req:** Before modifying skills for Open Brain integration, run the skippy-agentspace install to establish the source-of-truth for the 12 portable skills. The other 60 skills stay in ~/.config/pai/Skills/ for now.

### Open Brain Server Details

| Property | Value |
|----------|-------|
| LXC | 208 on proxmox01 (10.71.1.5) |
| IPs | 10.71.1.15 / 10.71.20.15 |
| URL | https://open-brain.rodaddy.live |
| Port | 3100 |
| Database | open_brain on 10.71.20.49 |
| Embedding | LiteLLM at 10.71.20.53:4000 (key: LITELLM_API_KEY) |
| Auth tokens | Vaultwarden "Open Brain - Auth Tokens" (5 consumers) |
| mcp2cli | Registered, all 6 tools working |
| Agent token | bafa17a... (OPEN_BRAIN_AGENT_TOKEN env var) |
</specifics>

<deferred>
## Deferred Ideas

### Structural reorganization
- Merge ~/.config/pai/ and ~/.config/pai-private/ into unified structure
- Absorb the 60 orphaned PAI skills into skippy-agentspace (or a new repo)
- Resolve ~/.claude/skills/ vs ~/.config/pai/Skills/ discovery path conflict
- These are organizational concerns, not functional. Do AFTER integration works.

### Data migration
- Bulk import of JSON KB entries was considered and rejected -- data is stale (last extracted 2026-02-01), would pollute the vector space
- If needed later, a one-time import script can be written
- Better approach: let Open Brain accumulate organically via enhanced hooks and skill usage

### Additional tools
- Code review findings from v1.0: ILIKE ESCAPE clause, input bounds, try/catch, systemd user
- Health check fix (LiteLLM API key in health endpoint)
- mcp2cli skill file generation (SSE transport issue)

### Enforcement
- Auto-log decisions to Open Brain when user discusses trade-offs
- Hook that reminds user to use `/brain` instead of asking questions that Open Brain could answer
</deferred>

---

*Phase: 06-pai-integration*
*Context gathered: 2026-03-13 via deep investigation during v1.0 deployment session*
