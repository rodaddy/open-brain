---
phase: 05
slug: consumer-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test (built into Bun) |
| **Config file** | None (Bun discovers `*.test.ts` automatically) |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test && bunx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green + manual smoke tests
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | INT-01 | smoke | `mcp2cli open-brain --help` | N/A (CLI) | ⬜ pending |
| 05-01-02 | 01 | 1 | SC-3 | smoke | vaultwarden token lookup | N/A (CLI) | ⬜ pending |
| 05-02-01 | 02 | 2 | SC-4 | smoke | Manual -- trigger /compact, verify DB | N/A (manual) | ⬜ pending |
| 05-02-02 | 02 | 2 | INT-02 | smoke | `mcp2cli n8n n8n_test_workflow` | N/A (CLI) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- No new test files needed in src/ -- Phase 5 is configuration/integration, not server code changes
- If REST endpoint added for n8n, needs unit test for the new route

*Existing infrastructure covers most phase requirements -- this phase is primarily configuration.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| mcp2cli returns tool list | INT-01 | Requires live server + mcp2cli config | `mcp2cli open-brain --help` |
| search_brain via mcp2cli | INT-01 | Requires live server + data | `mcp2cli open-brain search_brain --params '{"query":"test"}'` |
| Discord webhook triggers log_thought | INT-02 | Requires Discord + n8n + live server | Send message in channel, verify in DB |
| PreCompact hook saves session | SC-4 | Requires Claude Code context compaction | Run /compact, verify session_save called |
| SessionStart hook loads context | SC-4 | Requires new Claude Code session | Start session, verify context injected |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
