---
phase: 3
slug: secondary-tools
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-13
---

# Phase 3 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test (built-in) |
| **Config file** | bunfig.toml |
| **Quick run command** | `bun test --bail` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~1 second |

---

## Sampling Rate

- **After every task commit:** Run `bun test --bail`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 2 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 1 | TOOL-04, DATA-01 | unit + protocol | `bun test src/tools/ --bail` | W0 | pending |
| 3-02-01 | 02 | 1 | TOOL-05, TOOL-06, DATA-03 | unit + protocol | `bun test src/tools/ --bail` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements:
- bun:test configured with coverage thresholds
- TypeScript strict mode enabled
- Phase 2 tool patterns established (registerTool, ToolDeps, mock patterns)

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [x] All tasks have automated verify
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 2s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-13
