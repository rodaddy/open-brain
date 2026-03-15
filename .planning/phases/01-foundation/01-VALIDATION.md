---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 1 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test (Bun built-in, Jest-compatible API) |
| **Config file** | bunfig.toml (Wave 0 -- needs creation) |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test --coverage` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | DB-01 | integration | `bun test src/db/migrations/001_init.test.ts -x` | No -- W0 | pending |
| 01-01-02 | 01 | 1 | DB-02 | unit | `bun test src/embedding.test.ts -x` | No -- W0 | pending |
| 01-02-01 | 02 | 1 | SRV-01 | HTTP | `bun test src/server.test.ts -x` | No -- W0 | pending |
| 01-02-02 | 02 | 1 | AUTH-01 | unit + HTTP | `bun test src/auth.test.ts -x` | No -- W0 | pending |
| 01-03-01 | 03 | 1 | DATA-02 | integration | `bun test src/db/migrations/001_init.test.ts -x` | No -- W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `bunfig.toml` -- test config with coverage thresholds (80% lines/functions/statements)
- [ ] `tsconfig.json` -- TypeScript configuration for Bun
- [ ] `src/db/migrations/001_init.test.ts` -- verify all 5 tables exist with correct columns, indexes, and constraints
- [ ] `src/embedding.test.ts` -- mock LiteLLM, verify 768-dim output, verify graceful NULL on failure, verify content hash
- [ ] `src/server.test.ts` -- start server on random port, test /health, test /mcp POST with auth
- [ ] `src/auth.test.ts` -- test token validation, role mapping, permission matrix, constant-time comparison
- [ ] `src/permissions.test.ts` -- test canRead/canWrite for all role x table combinations
- [ ] Pre-computed test embedding fixtures (768-dim vectors captured once from real API call)
- [ ] Test database setup: separate `open_brain_test` database or transaction rollback pattern

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| pgvector >= 0.8.0 on 10.71.20.49 | DB-01 | One-time infra check | SSH to host, run `SELECT extversion FROM pg_extension WHERE extname = 'vector'` |
| LiteLLM proxy accepts gemini-embedding-001 | DB-02 | External dependency | `curl -X POST http://10.71.20.53:4000/embeddings -H "Authorization: Bearer $TOKEN" -d '{"model":"embeddings","input":"test"}'` |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
