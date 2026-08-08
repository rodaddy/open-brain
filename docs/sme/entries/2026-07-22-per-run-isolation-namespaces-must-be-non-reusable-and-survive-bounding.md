---
lane: adversarial
order: 19
---
## [2026-07-22] Per-run isolation namespaces must be non-reusable AND survive bounding

**Severity:** MEDIUM (P2)
**Source:** PR #348 terminal audit, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/config.ts` (`makeRunId`, `runNamespaces`,
`boundRunId`), any per-run throwaway namespace/tenant derived from an
operator-supplied id that is later truncated to a length bound
**Status:** fixed-pre-merge

### Pattern

The gate isolates each run in a unique namespace so teardown can only touch this
run's rows. Two ways that uniqueness silently collapsed:

1. **Reusable explicit id.** `OPEN_BRAIN_LIVE_EVAL_RUN_ID` was returned verbatim
   as the run id ("reproducible namespace"). Reusing it re-entered a prior run's
   namespace — where a stranded prior seed still lived. The seed then upserted
   (`ON CONFLICT`) onto that row and returned `merged: true`, which the seeder
   adopted as a current-run creation (see the correctness seed-proof entry) and
   would archive on teardown. A "reproducible" isolation namespace is a
   contradiction: isolation requires non-reuse. Fix: the explicit id is now a
   human-readable LABEL; a per-invocation crypto nonce is ALWAYS appended, so the
   namespace can never be reused even with a fixed label.

2. **Truncation-collision.** `runNamespaces` bounded the id with
   `.slice(0, 80)`. A long label plus a trailing nonce puts the nonce PAST the
   cut, so two runs sharing an 80-char prefix mapped to the SAME namespace — the
   nonce that was supposed to guarantee uniqueness was thrown away by the length
   bound. Fix: `boundRunId` keeps a truncated prefix and appends a deterministic
   short hash of the FULL sanitized id, so distinct long ids stay distinct while
   still fitting the bound. The hash is SHA-256 (pure/deterministic — no
   Date.now/random), keeping the helper pinnable.

### Review Questions

- Does any "unique per run" identifier have a mode (explicit id, reused label,
  fixed seed) where two invocations can produce the SAME value? For an isolation
  boundary, the uniqueness source (nonce) must be mandatory and always mixed in.
- Does a length/format bound (`slice`, hash-to-fixed-width, sanitize) run AFTER
  the uniqueness suffix in a way that can DROP it? Two inputs sharing the bounded
  prefix must still map to different outputs — bound with a hash of the full
  input, not a prefix cut.
- Is the collision case tested directly: two ids sharing the max-length prefix
  (and a reused label across invocations) asserting distinct final namespaces?
- If the boundary doubles as a destructive-teardown scope, does reuse let one
  run's teardown touch another run's / a real namespace's rows?
