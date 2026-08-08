---
lane: adversarial
order: 21
---
## [2026-07-22] Registering a maintenance handler is not "continuous derivation"; a server-owned identity is not a namespace bypass

**Severity:** MEDIUM
**Source:** Issue #346 (MAINT-4), graph-derivation bootstrap wiring
**Scope:** `src/maintenance-bootstrap.ts`, `src/graph-derivation-handler.ts`,
any handler registered under a server-owned global maintenance identity
**Status:** active

### Pattern

Two adversarial traps in wiring a maintenance handler into the production
bootstrap:

1. **Phantom recurrence.** The maintenance queue has no recurrence primitive —
   the runner only claims and dispatches *already-enqueued* jobs. Registering
   `graph.derive` makes the server able to *run* graph jobs; it does NOT make
   derivation automatic or continuous. Claiming otherwise ("graph is now kept up
   to date automatically") is false: with no producer calling
   `enqueueGraphDerivationJobs`, the queue stays empty forever. The explicit,
   bounded producer must stay the only enqueue path, and docs must say an
   operator / a future scheduler (#347) has to drive sweeps.
2. **Identity as a bypass.** A server-owned global maintenance identity
   (`ob-admin`, token-sourced) is needed so one runner can derive into whatever
   namespace a claimed job carries. The trap is treating that identity as the
   authority: it must grant only the cross-namespace *write capability*, while
   the persisted job payload's namespace stays the exact authority — re-checked
   via `canWriteNamespace` AND re-validated against the live source row inside
   the handler. A `header`-sourced identity would wrongly pin every write to one
   clientId namespace; a handler that trusted the identity instead of the
   per-job guard could derive into a namespace the job never authorized.

### Review Questions

- Does any doc/PR claim automatic/continuous derivation when the queue has no
  recurrence primitive and nothing enqueues sweeps? Is the explicit bounded
  producer preserved and documented as the required trigger?
- Can the handler be registered WITHOUT a clear auth identity (missing
  role/clientId)? It must fail closed at startup, not dispatch under an ambiguous
  identity — is there a test asserting the throw?
- Is the maintenance identity token-sourced (can serve cross-namespace jobs), and
  is the per-job namespace still the authority (re-checked against the live
  source), so the identity grants capability, not a guard bypass?
- Does the bootstrap compose handlers into one map without inventing a second
  bootstrap/framework, and is there a test proving BOTH existing and new kinds
  dispatch to their own handlers (not `unsupported_job_kind`)?
