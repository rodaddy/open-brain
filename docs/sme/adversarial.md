# Adversarial SME Findings

Adversarial reviewers hunt for failure states: outages, partial writes, stuck
locks, oversized data, malformed responses, and tests that pass for the wrong
reason.

## [2026-06-11] Never hold spool locks across slow dispatch

**Severity:** HIGH
**Source:** Issue #80, PR #74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

`JsonlSpool.replay()` holding an exclusive file lock while calling a dispatcher
can block foreground writers for the duration of slow or down HTTP calls. This
is especially bad during outage recovery, when foreground writes are likely to
need spooling too.

### Review Questions

- Does replay claim/snapshot records under lock, then release the lock before
  network/slow dispatch?
- Are new appends preserved while replay is in progress?
- Is there a concurrent replay/append test proving append latency is bounded
  while a dispatcher blocks?

## [2026-06-11] Append success must mean the record is recoverable

**Severity:** HIGH
**Source:** Issue #80
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

An oversized single record larger than `max_bytes` can be written, trimmed away,
and still return success. That creates silent data loss in a recovery path.

### Review Questions

- What happens when one record exceeds `max_bytes`?
- Does `append()` reject, truncate with an explicit marker, or store separately?
- Is there a regression test proving `append()` cannot report success while
  storing nothing?

## [2026-06-11] Fixes need failure-mode tests, not just happy-path tests

**Severity:** MEDIUM
**Source:** Issues #77-#82
**Scope:** all Open Brain client/facade work
**Status:** active

### Pattern

The first package swarm had good happy-path coverage, but later reviews found
outage and malformed-input behavior: replay dispatch, live redaction, malformed
DreamEngine reports, unbounded responses, and missing in-process transport
contracts.

### Review Questions

- What fails if the server is slow, down, malformed, oversized, or partially
  successful?
- Does each recovery feature prove durability under its own failure mode?
- Are tests only asserting method names, or are they asserting state after
  failure?

## [2026-06-19] Cursor-resumable sweeps: every processed row must advance the cursor

**Severity:** HIGH
**Source:** Issue #161, PR #171 (lane→shared-kb promoter)
**Scope:** `scripts/promote-lane-shared.ts` and any `(created_at, id) > cursor` resumable batch runner
**Status:** active

### Pattern

A resumable promoter sweeps rows ordered by `(created_at, id)` and persists a
cursor. Two ways a row can pin the cursor and cause an infinite re-sweep (and,
for the events path, a wasted embedding call every tick):

1. **Non-terminal classification (manual-review):** the row is not promoted and
   its nomination flag is intentionally left set. If the cursor only advances on
   `share`/terminal-reject, a trailing manual-review row is re-fetched forever.
2. **Deterministic write failure (poison pill):** a row whose INSERT always
   throws hits the catch block. If the catch `break`s without advancing the
   cursor, that row blocks every row behind it on every subsequent run.

### Review Questions

- In apply mode, does the cursor advance for EVERY processed row, including
  manual-review and caught-failure rows (recording the failure in the receipt
  rather than pinning)?
- Is there a real-DB test seeding a trailing manual-review row AND a
  deterministically-failing row, asserting a second run makes forward progress?
- Does dry-run intentionally NOT advance the cursor, and is `--loop` dry-run's
  full re-scan understood as intended (not a bug)?

### Prior Fix

PR #171 advances the cursor for manual-review and for caught failures in both
the thoughts/decisions and events loops; nomination flag left set + failure in
`receipt.failures` for human follow-up. Regression tests use a test-managed
`BEFORE INSERT` trigger to force a deterministic failure.

## [2026-07-06] Retry bounds need a stable server-validated root

**Severity:** HIGH
**Source:** PR #244 initial swarm for Issue #176
**Scope:** `src/tools/append-session-event.ts`, any bounded resend/retry chain
stored in client-supplied metadata
**Status:** fixed in PR #244

### Pattern

Bounded resend logic can look correct while still trusting client lineage. In
PR #244, `reject_detail.resubmit_metadata.sanitized_resubmit_of` rotated to the
newest rejected event id after each failed sanitized resend. A client that
followed the returned metadata, or a malicious caller that supplied a later
rejected event as the root, could start a fresh counter and bypass the intended
bound.

### Review Questions

- Does the server keep a stable original/root id across the whole retry chain?
- Is the supplied root validated against same-lane state, rather than trusted as
  arbitrary metadata?
- Does a later retry/rejection ever become the new root and reset the counter?
- Is there a regression where a contract-following retry fails again and the
  next `resubmit_metadata` still points to the original root?
- Is there a regression where a rotated or invalid root is non-resubmittable
  instead of starting a fresh counter?

### Prior Fix

PR #244 validates `sanitized_resubmit_of` as an original same-lane rejected
event, keeps the original root in returned `resubmit_metadata`, and marks
rotated/non-root attempts at the retry bound. Regression tests cover both a
contract-following failed resend and an explicit rotated-root reset attempt.

## [2026-07-06] Retry bounds must not require cooperative lineage metadata

**Severity:** HIGH
**Source:** PR #244 Phase 3 Claude cross-review for Issue #176
**Scope:** `src/tools/append-session-event.ts`, bounded retry/resend responses
that depend on client-supplied metadata
**Status:** fixed in PR #244

### Pattern

A retry bound can still be bypassed after root validation if the bound only
applies when the client supplies lineage metadata. In PR #244, a caller could
omit `sanitized_resubmit_of` on repeated rejected nominations and continue
receiving `resubmittable: true` because every request looked like a new root.

### Review Questions

- Does the server derive retry state from observed same-lane rejects even when
  the client omits lineage?
- Is client lineage treated as a hint that can raise the observed attempt, never
  reset it?
- Do blocked responses omit retry instructions such as `resubmit_metadata`?
- Is an invalid root distinguishable from a genuine max-attempts result?

### Prior Fix

PR #244 derives no-lineage attempts from prior same-lane root rejections,
keeps invalid roots non-resubmittable with `resubmit_blocked_reason:
invalid_resubmit_root`, and omits `resubmit_metadata` when `resubmittable` is
false. Regression tests cover omitted-lineage retry loops and invalid roots.

## [2026-07-08] Deterministic retrieval arms must survive provider outages

**Severity:** HIGH
**Source:** PR #274 initial swarm for Issue #267
**Scope:** hybrid search fallback paths, deterministic graph/SQL retrieval arms
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Hybrid search can accidentally skip deterministic retrieval when the embedding
provider fails. In PR #274, the embedding failure branch returned keyword-only
fallback rows before running the graph traversal arm, even though relational
graph retrieval does not need an embedding and should remain available during
provider outages.

### Review Questions

- When vector embedding generation fails, which other retrieval arms are still
  independent and should continue?
- Does the fallback branch preserve deterministic SQL/graph retrieval before
  returning degraded results?
- Is there a regression test with `embedFn` returning `null` that still proves
  graph or other non-vector evidence is recovered?

## [2026-07-08] Promise.race timeouts leave detached DB writes holding pool connections

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, any fail-open/fire-and-forget DB write wrapped in
a timeout race
**Status:** fixed in PR #275

### Pattern

Racing a DB write against a timeout does not cancel the write: the losing
`pool.query` keeps running detached and holds its pool connection until the
server responds. Under a slow or wedged database, fail-open audit writes can
accumulate detached queries until user-facing operations starve on the shared
pool. Write concurrency caps must sit below the pool size, and new fail-open
writes must skip when `pool.waitingCount > 0` so background telemetry never
outbids foreground work.

### Review Questions

- Does any timeout race assume the losing promise stops consuming resources?
- Is the background write concurrency cap strictly below the pool size?
- Does the write path skip (not queue) when the pool already has waiters?
- Do tests wedge the fake pool and prove foreground queries still get
  connections while audit writes shed load?

## [2026-07-08] Auxiliary health bind failures must clean up started workers

**Severity:** HIGH
**Source:** PR #283 initial swarm for Issue #282
**Scope:** dedicated worker entrypoints that start subscriptions/pools before a
health or monitoring listener
**Status:** fixed in PR #283

### Pattern

A worker can successfully start its core subscription and database pool, then
throw while binding an auxiliary health endpoint. If that bind failure is
outside the guarded startup path, launchd/systemd restarts the process while the
startup path skips orderly bridge/pool cleanup. This turns a monitoring-port
collision into a noisy worker restart loop.

### Review Questions

- Are pool creation, bridge/subscription startup, and health-server bind inside
  one guarded startup path?
- If a later startup step fails, are already-started subscriptions, health
  servers, and pools closed before exit?
- Does the worker log a redacted startup failure instead of a raw exception?
- Is there a regression test where health bind throws after subscription startup
  and cleanup still closes both bridge and pool?

## [2026-07-08] Reusing an output field with a new value distribution is a contract change

**Severity:** MEDIUM
**Source:** PR #278 pre-merge gauntlet for Issue #268
**Scope:** `search_all`/`brain_answer` graph evidence rows, any consumer-visible
field whose value range changes without a schema change
**Status:** fixed in PR #278

### Pattern

Emitting an existing output field with a new value distribution -- `score` set
to a raw link weight instead of the established [0,1] relevance range -- is a
value-level contract change hiding under "no schema change." Downstream ranking,
thresholds, and display logic built for the old distribution silently misbehave.
Clamp/normalize at the consumer boundary and classify the change in the
downstream rollout gate even though the schema is untouched.

### Review Questions

- Does a new evidence source write into a pre-existing field? What distribution
  do current consumers assume for it?
- Is the new value clamped/normalized to the established range at the boundary?
- Was the change classified under `docs/downstream-rollout.md` as
  client-visible despite having no schema diff?
- Do tests assert the emitted values stay inside the documented range?

## [2026-07-13] Duplicate facts must not silently discard new citation evidence

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier antagonist review
**Scope:** append_session_event dedupe and citation recall
**Status:** fixed in issue #288 implementation

Content-hash dedupe can turn citation backfill into a false success. When an existing event lacks or differs from supplied citation fields, return an explicit citation-not-stored error instead of claiming a harmless duplicate.

## [2026-07-17] Fallback durable receipts must prove the exact operation succeeded

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** Python local-first runtime routing, `mcp2cli` subprocess fallback, and direct-start recovery
**Status:** fixed in PR #294

A generic success-shaped fallback response is not durable evidence. Receipts must validate tool-specific result fields, preserve the exact nullable scope, and bound subprocess stdout/stderr while streaming so a noisy child cannot exhaust memory. If direct start partially succeeds and a later step fails, fallback must verify the intended lane rather than treating any active lane as proof. Tests must force partial-start failure, wrong-lane evidence, null-versus-omitted scope, malformed success payloads, and unbounded-output pressure.
