---
lane: correctness
order: 23
---
## [2026-07-21] Contract-parity gates must pin sets, ranges, and reasons

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/check-parity.ts`, `contracts/memory/parity-manifest.json`, `.github/workflows/ci.yml`, `scripts/validate-pr-body.ts`
**Status:** fixed-pre-merge

- Fixture discovery without an expected-id set lets the fixture corpus silently shrink; the manifest must pin the exact fixture-id set and the validator must fail on missing OR extra fixtures.
- CI's contract-parity change detection fell back to `HEAD^` on zero/empty push `before` SHAs, checking a narrower range than the pre-push hook; derive the base from the merge-base with `origin/main` instead.
- Empty-string checks alone accept placeholder runtime-specific reasons (`n/a`, `na`, `none`, `todo`, `tbd`); reason validation must reject the placeholder set case-insensitively in both the PR-body gate and the manifest validator.
