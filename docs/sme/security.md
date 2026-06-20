# Security SME Findings

Security reviewers focus on boundaries: namespaces, bearer tokens, secret
handling, trusted headers, redirect behavior, and plaintext transport.

## [2026-06-11] Namespace metadata must not bypass token/header authority

**Severity:** HIGH
**Source:** Issue #78, PR #73 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** active

### Pattern

`AgentMemory.remember_fact()` and `remember_decision()` accepted free-form
`namespace` metadata and forwarded it into tool arguments. That can conflict
with or attempt to override the server's token-derived namespace authority or
an explicit privileged `X-Namespace` delegation path.

### Review Questions

- Is `namespace` removed from generic metadata pass-through, or verified against
  the authenticated server-side namespace/delegation policy?
- If namespace override is required, is it an explicit privileged API rather
  than arbitrary metadata?
- Are there tests for `namespace="other"` on normal clients?
- Do docs explain bearer token, server policy, headers, and facade behavior?

## [2026-06-11] Redaction must protect diagnostics without corrupting data

**Severity:** HIGH
**Source:** Issue #77
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`python/openbrain-memory/src/openbrain_memory/policy.py`,
`python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

Redacting the payload before calling Open Brain can silently persist legitimate
memory content as `[REDACTED]`. Redacting before durable spool persistence can
make replay unable to restore the original write.

### Review Questions

- Are live writes preserving caller content?
- Are logs/errors redacted separately?
- Is spool data protected without pretending lossy redacted data is exact replay?
- Do tests prove successful live writes are not silently redacted?

## [2026-06-11] Redaction coverage must include common unlabeled credential shapes

**Severity:** MEDIUM
**Source:** Issue #82, PR #72/#74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/policy.py`
**Status:** active

### Pattern

Label-based redaction catches `token=` and `password:` but misses common
unlabelled shapes: AWS access key IDs, AWS secret-like values, Slack tokens,
Google API keys, and bare JWT-like strings.

### Review Questions

- Are there tests for AWS access key IDs and secret-like values?
- Are Slack token and Google API key shapes covered?
- Are bare JWT-like strings covered without over-redacting normal prose?
- Are test fixtures split to avoid secret scanner false positives?

## [2026-06-11] Bearer-token HTTP must be opt-in and non-redirecting

**Severity:** HIGH
**Source:** PR #72 review, PR #76 docs review
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, README
**Status:** active

### Pattern

Bearer-token MCP calls over non-local HTTP or through redirects leak credentials.
PR #72 fixed HTTPS enforcement and redirect disabling. PR #76 hardened docs to
default to HTTPS and require `OPENBRAIN_ALLOW_INSECURE_HTTP=1` for trusted lab
HTTP.

### Review Questions

- Are non-local `http://` URLs rejected unless explicitly allowed?
- Are redirects disabled for auth-bearing requests?
- Do docs avoid making plaintext HTTP the default copy-paste path?

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
