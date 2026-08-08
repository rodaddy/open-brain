---
lane: security
order: 4
---
## [2026-06-19] ReDoS: bounding inner segments does not fix an unanchored `*` prefix

**Severity:** HIGH
**Source:** PR #175 (post-merge swarm on #174), found after #174 merged
**Scope:** `src/sharing.ts` SECRET_PATTERNS, `python/openbrain-memory/.../policy.py`, any regex run on user/agent content
**Status:** active

### Pattern

`URL_USERINFO_CRED_RE` was `[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s@/]+@...`. A first
fix bounded the userinfo segments to `{1,256}` and was declared fixed — but the
O(n^2) blowup is the **unanchored `*`-quantified scheme prefix**, which the
regex engine restarts and rescans at every input position (it triggers even on
input with no `://` at all). Bounding the *inner* segments does nothing. This
runs on the promoter secret gate (`containsSecret`) over agent-influenceable
lane content → a DoS on the gate.

### Review Questions

- Does any secret/validation regex have an unanchored `*`/`+`-quantified prefix
  before the first required literal? That is the restart-rescan O(n^2) source.
- Was a ReDoS fix verified with a SCALING test (10k/20k/40k/80k) on input that
  hits the specific backtracking path — not a single small/"big" string?
- Is there a regression test asserting sub-second scan of large (≥80k) input?

### Prior Fix

PR #175 replaced the wildcard scheme prefix with a fixed alternation
`(?:https?|ftp|postgres|...)://`, removing the restartable prefix. Linear after:
80k chars ~2ms (TS) / ~17ms (Python). Regression test added both sides.
