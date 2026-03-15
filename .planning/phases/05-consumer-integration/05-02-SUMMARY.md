---
phase: 05-consumer-integration
plan: 02
subsystem: infra
tags: [claude-code-hooks, n8n, discord, session-continuity, mcp-handshake]

# Dependency graph
requires:
  - phase: 05-consumer-integration
    provides: "mcp2cli registration, vaultwarden auth tokens, agent-reference.md"
provides:
  - "PreCompact hook for automatic session save to Open Brain"
  - "SessionStart hook for automatic session load from Open Brain"
  - "n8n Discord thought capture workflow (active)"
  - "Updated agent-reference.md with all consumer integration details"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [mcp-two-step-handshake-in-hooks, silent-failure-hooks, n8n-mcp-integration]

key-files:
  created:
    - hooks/open-brain-session-save.ts
    - hooks/open-brain-session-load.ts
  modified:
    - ~/.claude/settings.json
    - .planning/agent-reference.md

key-decisions:
  - "Command hooks (not HTTP) for both PreCompact and SessionStart -- PreCompact only supports command type, SessionStart needs stdout for context injection"
  - "Silent exit 0 on all errors -- hooks must never block compaction or session start"
  - "Single-line jsCode in n8n Code nodes to avoid mcp2cli control character validation issue"
  - "Two-step MCP handshake in n8n (initialize + tools/call with session ID) rather than adding REST endpoint"

patterns-established:
  - "MCP handshake pattern: POST initialize -> extract mcp-session-id header -> POST tools/call with session header"
  - "Hook error handling: try/catch wrapping entire script body, catch exits 0 silently"
  - "n8n MCP integration: Code node extracts session ID from HTTP response headers between chained requests"

requirements-completed: [INT-02]

# Metrics
duration: 6min
completed: 2026-03-13
---

# Phase 5 Plan 2: Consumer Integration Hooks and Discord Capture Summary

**PreCompact/SessionStart hooks for automatic session continuity plus n8n Discord thought capture workflow with two-step MCP handshake**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-13T23:03:04Z
- **Completed:** 2026-03-13T23:09:10Z
- **Tasks:** 3 (2 auto + 1 checkpoint auto-approved)
- **Files modified:** 4

## Accomplishments
- Created PreCompact hook that auto-saves session state (project, tags, custom_instructions) to Open Brain before context compaction
- Created SessionStart hook that loads and formats previous session context (decisions, blockers, next steps) into Claude's context on startup/resume
- Built 6-node n8n workflow for Discord thought capture: webhook trigger -> extract/filter -> MCP initialize -> session ID extraction -> log_thought -> respond
- Updated global ~/.claude/settings.json with both hook entries (PreCompact array created, SessionStart entry appended)
- Updated agent-reference.md with consumer integration details (hook paths, workflow ID, webhook URL)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Claude Code hook scripts for session continuity** - `0bb5b97` (feat)
2. **Task 2: Build n8n Discord thought capture workflow** - `4b691fe` (feat)
3. **Task 3: Checkpoint auto-approved** - No commit (verification checkpoint)

## Files Created/Modified
- `hooks/open-brain-session-save.ts` - PreCompact hook: reads stdin JSON, performs MCP handshake, calls session_save (70 lines)
- `hooks/open-brain-session-load.ts` - SessionStart hook: performs MCP handshake, calls session_load, outputs formatted markdown context (93 lines)
- `~/.claude/settings.json` - Added PreCompact hook entry and SessionStart hook entry (external, not committed)
- `.planning/agent-reference.md` - Added Consumer Integrations section with hook paths and n8n workflow details

## Decisions Made
- Used command hooks (not HTTP) for both PreCompact and SessionStart -- PreCompact only supports command type per official docs, SessionStart needs stdout control for context formatting
- Both hooks silently exit 0 on any error (missing token, server down, parse failure) -- hooks must never block Claude Code operations
- Used absolute paths in settings.json hook commands (`/Volumes/ThunderBolt/Development/open-brain/hooks/...`) to avoid path resolution issues
- Built n8n workflow with two-step MCP handshake rather than adding a REST endpoint -- keeps server code unchanged, matches the established MCP protocol pattern
- Used single-line JavaScript in n8n Code nodes to work around mcp2cli control character validation limitation

## Deviations from Plan

### Adapted Tasks

**1. [Rule 3 - Blocking] mcp2cli control character rejection in jsCode**
- **Found during:** Task 2 (n8n workflow creation)
- **Issue:** mcp2cli rejects JSON payloads containing control characters (newlines in jsCode strings)
- **Fix:** Wrote all Code node JavaScript as single-line statements with semicolons instead of newlines
- **Impact:** No functional difference -- Code nodes execute identically

**2. [Rule 3 - Blocking] mcp2cli missing activate_workflow tool**
- **Found during:** Task 2 (workflow activation)
- **Issue:** No `n8n_activate_workflow` tool exists in mcp2cli n8n backend
- **Fix:** Used `n8n_update_partial_workflow` with `activateWorkflow` operation type
- **Impact:** None -- workflow activated successfully

---

**Total deviations:** 2 auto-fixed blocking issues
**Impact on plan:** Both were mcp2cli API shape mismatches, resolved with alternative approaches. No scope creep.

## Issues Encountered
- Open Brain server at 10.71.20.49:3100 is not yet deployed -- hooks and n8n workflow are configured but end-to-end verification requires server to be running
- The OPEN_BRAIN_AGENT_TOKEN env var must be set in the user's shell profile for hooks to function

## User Setup Required

**Before hooks work end-to-end:**
1. Deploy Open Brain server to 10.71.20.49 and start it
2. Set OPEN_BRAIN_AGENT_TOKEN in shell profile:
   ```bash
   export OPEN_BRAIN_AGENT_TOKEN="$(./fetch-secrets.sh AUTH_TOKEN_AGENT)"
   ```
3. Verify: `curl http://10.71.20.49:3100/health`
4. Test PreCompact: run `/compact` in any Claude Code session, then search for "auto-save pre-compact"
5. Test SessionStart: start a new session and verify "Open Brain: Previous Session Context" appears

**For Discord thought capture:**
1. Configure Discord bot to POST messages to `https://n8n.rodaddy.live/webhook/open-brain-thought`
2. Test: send a message, then search via `mcp2cli open-brain search_brain --params '{"query":"<message text>"}'`

## Next Phase Readiness
- All three consumer integration paths are wired: mcp2cli (Plan 01), Claude Code hooks (Plan 02), Discord/n8n (Plan 02)
- Phase 5 is complete -- this is the final plan of the final phase
- v1.0 milestone is feature-complete pending server deployment and end-to-end verification

## Self-Check: PASSED

- FOUND: hooks/open-brain-session-save.ts
- FOUND: hooks/open-brain-session-load.ts
- FOUND: agent-reference.md
- FOUND: 05-02-SUMMARY.md
- FOUND: commit 0bb5b97 (Task 1)
- FOUND: commit 4b691fe (Task 2)
- FOUND: PreCompact hook in settings.json
- FOUND: SessionStart open-brain hook in settings.json
- FOUND: n8n workflow Open Brain - Discord Thought Capture - active: true

---
*Phase: 05-consumer-integration*
*Completed: 2026-03-13*
