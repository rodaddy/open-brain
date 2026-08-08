---
lane: adversarial
order: 13
---
## [2026-07-21] Standing design rejections the adversarial lane must not relitigate

**Severity:** N/A (standing design rejection)
**Source:** PR development#44 review swarm 2026-07-21, operator decision (Rico)
**Scope:** Provider/adapter spawn paths
**Status:** rejected-by-design — see security.md entries of the same date

Two recurring adversarial recommendations are permanently rejected for this
codebase and must not be re-raised as findings (raise only if the facts change,
e.g. the adapter stops being user-writable or the tool stops being
operator-upgraded):

1. Hash-pinning fast-moving external tool binaries (uv/bun/git). Recreates the
   venv-pin upgrade-kill-shot: every tool upgrade strands live sessions.
   Behavioral probe receipts + per-sha cache isolation are the accepted control.
2. fd/inode TOCTOU pinning between artifact hash and spawn. The verifier
   itself is user-writable in this deployment; a local writer edits the checker
   before racing the window. Wrong trust boundary; accident classes are already
   fail-closed.

If a future finding matches one of these shapes, cite this entry and mark it
rejected-by-design instead of reporting it as MEDIUM+.
