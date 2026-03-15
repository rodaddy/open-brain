---
phase: 04
slug: operational-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test (built into Bun 1.3.9) |
| **Config file** | None (Bun discovers `*.test.ts` automatically) |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test && bunx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | SC-1 | unit | `bun test scripts/backfill.test.ts` | No -- Wave 0 | ⬜ pending |
| 04-01-02 | 01 | 1 | SC-3 | unit | `bun test src/middleware/request-logger.test.ts` | No -- Wave 0 | ⬜ pending |
| 04-02-01 | 02 | 2 | SC-2 | CI workflow | Push to branch, observe GHA | No -- Wave 0 | ⬜ pending |
| 04-02-02 | 02 | 2 | SC-4 | manual | `systemctl status open-brain` | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/backfill.test.ts` -- stubs for SC-1 (backfill logic with mocked pool/embed)
- [ ] `src/middleware/request-logger.test.ts` -- stubs for SC-3 (middleware captures fields, omits bodies)
- [ ] `.github/workflows/ci.yml` -- covers SC-2 (the CI config IS the deliverable)
- [ ] `.env.example` -- covers SC-4 (documents all required vars)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Server runs as systemd service with auto-restart | SC-4 | Requires live LXC environment | `systemctl status open-brain`, verify restart after `kill` |
| CI pipeline passes on push | SC-2 | Requires GitHub Actions runner | Push branch, check GHA status |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
