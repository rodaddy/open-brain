---
lane: correctness
order: 63
section: harvest-522
---
## [2026-08-07] Starting a global producer makes other suites' leftover fixtures live

**Severity:** MEDIUM
**Source:** PR #609 CI failure (#384 maintenance producer), self-caught
**Scope key:** `review.producer_activation_promotes_inert_fixtures`
**Status:** active

### Pattern

Turning on a background PRODUCER changes the meaning of every row already in the test database. The maintenance sweep selects across ALL namespaces by design (`selectSourcesNeedingDerivation` receives `undefined` writable namespaces, because a server-owned sweep must serve every namespace), so a test that composes an autostarted runtime derives from every approved/active `ob_sources` row present — not only the one it seeded. Other suites leave such fixtures behind (`parity-source-registry-*`); on `main` they sit inert with zero `maintenance_jobs` because nothing was producing. The new test converted them into real queued `graph.derive` rows, and its namespace-scoped `DELETE` could not see them.

The victim is a DIFFERENT suite: `026 maintenance queue > allows only one concurrent runner to claim a due job` races two claims and expects exactly one due job to exist ANYWHERE. `claimDueJobs` filters on `state`/`run_after` only — no namespace and no job-kind predicate — so any stray due row is claimable and both racers win one (`Expected: 1, Received: 2`).

Guards, in order of importance:

1. A test that starts a producer cleans up by the DIMENSION THE PRODUCER USES, not the dimension the test seeds. Namespace-scoped cleanup is wrong for a cross-namespace producer; delete by `job_kind` for every kind the sweep can emit.
2. Stop the runtime BEFORE deleting, or a tick landing between the `DELETE` and the halt re-enqueues what was just removed.
3. **Do not conclude "pre-existing" from a single-file run.** This failure passes when its file runs alone and only appears after the full suite, because the defect is ordering-dependent leakage. The claim was made once on this branch and was wrong. The proof that actually settles it is the FULL suite run against clean `origin/main` in a separate worktree and a separate freshly-created database, compared against the same run on the branch — here, main 3701/0 versus branch 3701/1.
