---
phase: 05-consumer-integration
plan: 01
subsystem: infra
tags: [mcp2cli, vaultwarden, bearer-auth, cli-tooling]

# Dependency graph
requires:
  - phase: 04-operational-hardening
    provides: "Production-ready server with auth middleware and 5-role token system"
provides:
  - "mcp2cli open-brain HTTP service registration"
  - "Per-consumer auth tokens in vaultwarden"
  - "agent-reference.md for downstream agent prompts"
  - "Token verification/rotation script"
affects: [05-consumer-integration]

# Tech tracking
tech-stack:
  added: [mcp2cli-http-backend]
  patterns: [vaultwarden-token-storage, fetch-secrets-retrieval]

key-files:
  created:
    - scripts/generate-tokens.sh
    - .planning/agent-reference.md
  modified:
    - ~/.config/mcp2cli/services.json

key-decisions:
  - "Used existing vaultwarden tokens instead of generating new ones -- user directive to 'use skippy/secondBrain keys'"
  - "Token script is a reference/verification tool (--verify, --rotate) not a one-shot generator"
  - "mcp2cli uses AUTH_TOKEN_AGENT role for CLI access -- admin too broad, readonly can't write"

patterns-established:
  - "fetch-secrets.sh retrieval pattern: ./fetch-secrets.sh AUTH_TOKEN_<ROLE>"
  - "mcp2cli HTTP backend registration with Bearer auth from vaultwarden"

requirements-completed: [INT-01]

# Metrics
duration: 4min
completed: 2026-03-13
---

# Phase 5 Plan 1: Consumer Integration Setup Summary

**mcp2cli open-brain registered as HTTP backend with existing vaultwarden auth tokens and agent-reference.md for downstream consumers**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-13T22:26:30Z
- **Completed:** 2026-03-13T22:30:30Z
- **Tasks:** 3 (2 auto + 1 checkpoint auto-approved)
- **Files modified:** 3

## Accomplishments
- Verified all 5 per-consumer auth tokens exist in vaultwarden under "Open Brain - Auth Tokens"
- Registered open-brain as mcp2cli HTTP backend service with Bearer auth (agent role)
- Created agent-reference.md with endpoints, tool list, and example commands
- Created token verification/rotation script with --verify and --rotate modes

## Task Commits

Each task was committed atomically:

1. **Task 1: Token verification and reference script** - `cae7784` (feat)
2. **Task 2: mcp2cli registration and agent-reference.md** - `41ce853` (feat)
3. **Task 3: Checkpoint auto-approved** - No commit (verification checkpoint)

## Files Created/Modified
- `scripts/generate-tokens.sh` - Token reference/verification/rotation script (not a generator -- tokens pre-exist)
- `.planning/agent-reference.md` - Non-secret reference data for agent prompts (endpoints, tools, examples)
- `~/.config/mcp2cli/services.json` - Added open-brain HTTP backend entry (external, not committed)

## Decisions Made
- Used existing vaultwarden tokens per user directive instead of generating new ones via openssl
- Token script provides --verify (check all 5 tokens present) and --rotate (generate new + store) modes
- mcp2cli registered with AUTH_TOKEN_AGENT role -- appropriate scope for CLI tool access

## Deviations from Plan

### Adapted Tasks (User Override)

**1. [User Override] Skipped token generation, used existing vaultwarden tokens**
- **Found during:** Task 1 (token generation)
- **Issue:** Plan called for `openssl rand -hex 32` to generate new tokens; user said "use the skippy/secondBrain keys"
- **Adaptation:** Verified existing "Open Brain - Auth Tokens" entry in vaultwarden already has all 5 tokens populated
- **Impact:** Simplified Task 1 from generation+storage to verification+reference-script

**2. [Rule 3 - Blocking] Restarted mcp2cli daemon after config update**
- **Found during:** Task 2 (mcp2cli registration)
- **Issue:** Adding open-brain to services.json was picked up by `mcp2cli services` but not by tool calls due to daemon caching
- **Fix:** Killed daemon PID, daemon auto-restarted on next call
- **Verification:** Service resolved correctly after restart (connection error = server down, not config issue)

---

**Total deviations:** 1 user override, 1 auto-fixed blocking issue
**Impact on plan:** User override simplified token handling. Daemon restart was a straightforward ops fix.

## Issues Encountered
- Open Brain server at 10.71.20.49:3100 is not running -- mcp2cli registration is correct but end-to-end verification and skill generation (`mcp2cli generate-skills open-brain`) requires the server to be deployed and started
- Skill file at ~/.config/mcp2cli/skills/open-brain/SKILL.md will be auto-generated once server is reachable

## User Setup Required

**Server deployment required before mcp2cli works end-to-end:**
1. SSH to 10.71.20.49
2. Deploy Open Brain server code
3. Populate .env with tokens from vaultwarden: `./scripts/generate-tokens.sh` (shows values for copy-paste)
4. Start service: `sudo systemctl restart open-brain` (or equivalent)
5. Verify: `curl http://10.71.20.49:3100/health`
6. Then run: `mcp2cli generate-skills open-brain` to auto-generate skill files

## Next Phase Readiness
- mcp2cli config is wired -- once server is deployed, `mcp2cli open-brain --help` will list all 6 tools
- agent-reference.md is ready for downstream plan prompts
- Skill generation deferred until server is reachable
- Remaining 05-consumer-integration plans can proceed with the mcp2cli service name and agent-reference.md

## Self-Check: PASSED

- FOUND: scripts/generate-tokens.sh
- FOUND: .planning/agent-reference.md
- FOUND: 05-01-SUMMARY.md
- FOUND: commit cae7784 (Task 1)
- FOUND: commit 41ce853 (Task 2)
- FOUND: open-brain in mcp2cli services

---
*Phase: 05-consumer-integration*
*Completed: 2026-03-13*
