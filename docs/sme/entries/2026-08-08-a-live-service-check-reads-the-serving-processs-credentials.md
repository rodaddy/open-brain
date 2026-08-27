---
lane: security
order: 94
---
## [2026-08-08] A live-service check reads the serving process's credentials, never the checkout's

**Severity:** HIGH
**Source:** PR #657 (#654 namespace-scope lane) and its verify run, Tightenings round 15
**Scope:** `scripts/done-means/654-namespace-scope-proof.sh`, live-service clauses, `python/openbrain-memory` delegation
**Status:** active

### Pattern

The repo `.env` has carried an empty `AUTH_TOKEN_ADMIN` since the #645 scrub, so a check built on it 401s BY DESIGN — and the transcript reads as a service fault.

Round 12's which-tree-runs rule, extended to IDENTITY: name where the credential comes from in the check header, and refuse LOUDLY when it is absent instead of falling through to a misleading auth failure.

### Corollary: a security control is unproven until something REQUESTS the dangerous thing

The server role-gates `X-Namespace`, but the Python client had `delegate_namespace=False` hardcoded since #294 — the header was never sent, so the 403 path had NEVER executed in any run. A refusal branch that has never refused is decoration.

The done-means now sends the forbidden request and asserts both the refusal (clause c) and that the refusal NAMES the actionable cause (clause d).

### Corollary: silent-default identity is tenant mis-scope, not cosmetics

With delegation hardcoded off, every delegated-intent session landed in namespace `admin` — a real cross-tenant landing, STRONGER than the issue as filed.

Any config key that selects identity is REQUIRED config: loud on absence, never silently defaulted (ledger item 28).

### Corollary: errors must name what the caller can change

#646 (scope errors naming response vocabulary the validator rejects) and #654 (a silent wrong-namespace landing with no signal at all) are the same dead-end-error defect at different volumes. A refusal that does not name the acting cause, and a mis-scope that says nothing, both strand the caller. Checks assert the error TEXT, not just the status.

### Corollary: a red anchor that inverts at the fix must be bound to the PR head

Clause (a)'s PASS proves the fix ONLY because verify-lane pinned the worktree to the head SHA and re-read it after the run (`recheck-head`). Any check whose RED lives on main and whose GREEN lives on the branch inherits this binding requirement — without it, the inversion could come from either tree.
