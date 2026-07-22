# Adversarial SME Findings

Adversarial reviewers hunt for failure states: outages, partial writes, stuck
locks, oversized data, malformed responses, and tests that pass for the wrong
reason.

## [2026-06-11] Never hold spool locks across slow dispatch

**Severity:** HIGH
**Source:** Issue #80, PR #74 follow-up; PR #319 fix delta
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`, `clients/ts/src/spool.ts`
**Status:** active

### Pattern

`JsonlSpool.replay()` holding an exclusive file lock while calling a dispatcher
can block foreground writers for the duration of slow or down HTTP calls. This
is especially bad during outage recovery, when foreground writes are likely to
need spooling too.

**PR #319:** a portable lock must cover each local snapshot and reconciliation
transaction across processes, but must be released before dispatcher/network
calls; test independently opened spool instances, not only same-instance races.

### Review Questions

- Does replay claim/snapshot records under lock, then release the lock before
  network/slow dispatch?
- Are new appends preserved while replay is in progress?
- Is there a concurrent replay/append test proving append latency is bounded
  while a dispatcher blocks?
- Does a failed directory durability sync restore prior bytes (or absence) and
  avoid acknowledging the append?

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
**Scope:** Python local-first primary direct routing, `mcp2cli` subprocess fallback, and direct-start recovery
**Status:** fixed in PR #294

A generic success-shaped primary or fallback response is not durable evidence. Both paths must validate tool-specific result fields and presence-sensitive exact nullable scope proof for `session_start` and `agent_context_pack`; subprocess fallback must also bound stdout/stderr while streaming so a noisy child cannot exhaust memory. Response/receipt validation failures belong to the recoverable runtime path and must continue to the configured fallback or spool; caller-input validation failures must stop before any transport attempt. If direct start partially succeeds and a later step fails, fallback must verify the intended lane rather than treating any active lane as proof. Tests must force primary and fallback partial-start failure, wrong-lane evidence, null-versus-omitted scope, malformed success payloads, invalid caller input, and unbounded-output pressure.

## [2026-07-21] Parity declarations need executable cross-runtime proof

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/check-parity.ts`, `src/middleware/request-logger.ts`, CI warm-up/cache steps
**Status:** fixed-pre-merge

- The TS test pin, Python constant, and contract-declaration fixture carried the same schema_hash as three hand-copied literals with no executable TS-vs-fixture check; the parity validator must compute the live `buildContract()` schema_hash and fail on divergence, closing the triangle the pytest replay leaves open.
- The contract-mismatch tripwire warned on every request, so one stale client or attacker-supplied headers could amplify log volume; throttle to one warn per distinct declared (contract id, schema_hash) per 5-minute bucket with malformed headers collapsed to one key.
- Verified-artifact-vs-executed-artifact class: a warm-up or cache step (e.g. the uv cache) can validate one artifact while the gated job later executes another; gates must prove the executed artifact is the one that passed verification.

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

## [2026-07-21] Negative isolation matrices need full surface enumeration, an override attempt, and one live-DB anchor

**Severity:** MEDIUM
**Source:** PR #316 review swarm, 2026-07-21
**Scope:** `src/tools/__tests__/namespace-isolation-matrix.test.ts`,
`src/tools/__tests__/namespace-isolation-matrix-live.test.ts`, any cross-surface
security boundary test suite
**Status:** fixed-pre-merge

### Pattern

The first #297 negative matrix pinned only 2 of the 4 delete-capable
header-scopable tools (archive_entry, bulk_archive — missing archive_entity and
unlink_entities), never attempted a caller-supplied `namespace` argument, and
proved SQL/param shape on mocks only. Each gap is a distinct escape class:
an unenumerated tool can regress independently; a caller-influenceable
namespace argument (the `unlink_entities` schema accepts one, making this a
real future footgun for any tool that copies that schema) converts "predicate
present" into "predicate caller-controllable" unless an override attempt is
pinned; and mock-only shape proof never exercises real Postgres evaluation of
the predicate. Fixed by enumerating archive_entity/unlink_entities, adding an
override-attempt case (unknown key stripped, bound params stay auth-derived),
parameterizing over both delete-capable header-scopable roles, and adding an
`OPENBRAIN_TEST_DATABASE_URL`-gated live negative test that proves the foreign
row's `archived_at` stays NULL and the owning-namespace call succeeds
(non-vacuous).

### Review Questions

- Does the matrix enumerate EVERY tool in the boundary's capability class
  (grep the predicate/gate helper for all callers), not just the famous two?
- Is there a case where the caller actively supplies the protected dimension
  (namespace/scope) as an argument or unknown extra key, asserting it cannot
  influence the bound predicate?
- Is at least one denial anchored on a real database (row provably untouched)
  with a paired owning-identity success proving the test is not vacuous?
- Are all roles sharing the guarded branch parameterized, so a future
  role-specific branch cannot silently un-scope one of them?

## [2026-07-22] Declared budget limits must admit their own irreducible framing

**Severity:** P3 (LOW)
**Source:** PR #349 / Issue #326 confirmed finding
**Scope:** `src/tools/agent-context-pack.ts` whole-pack budget derivation
**Status:** active — fixed regression in
`src/tools/__tests__/agent-context-pack-budget.test.ts`

### Pattern

`agent_context_pack` reported `budget.whole_pack.content_char_limit` as the raw
member budget (`max_tokens * 4 - 1200`, clamped to 0). But
`JSON.stringify(payload.sections)` is irreducibly `"{}"` (2 chars) even when
every section is omitted, so for `max_tokens <= 300` (budget clamps to 0) the
contract "content_char_limit bounds the serialized sections object" was violated:
`2 <= 0` is false. Two omit tests masked it with `+ 2` slack instead of asserting
the true invariant. The declared serialized-section limit must account for the
irreducible empty object (floor of 2) while still leaving zero characters for
section members at those tiny budgets, and `content_chars_used` must stay
truthful and `<= content_char_limit`.

### Review Questions

- Does a declared serialized-size limit account for the container's irreducible
  framing (e.g. the `{}` an empty object always serializes to), or does a clamp
  to zero leave the limit below what `JSON.stringify` can ever emit?
- Do budget/limit tests assert `serialized.length <= limit` with NO additive
  slack, so a limit that is genuinely too small cannot pass?
- At the smallest budgets, is the member allocation still zero even though the
  declared limit is raised to the framing floor?

## [2026-07-22] Per-member object framing must be position-aware, not uniform

**Severity:** P2 (MEDIUM)
**Source:** PR #349 / Issue #326 Terra terminal-audit finding
**Scope:** `src/tools/agent-context-pack-budget.ts` `sectionFrameCost`,
`src/tools/agent-context-pack.ts` whole-pack section allocation
**Status:** active — fixed regression in
`src/tools/__tests__/agent-context-pack-budget.test.ts`

### Pattern

The whole-pack allocator reserved the enclosing `{}` once (2 chars) up front,
then charged `sectionFrameCost = key.length + 3 + 1` — a comma — for **every**
admitted section. But JSON writes object members as `"key":<body>` joined by a
single `,` *between* adjacent members: the FIRST member has no leading comma.
Charging a comma for the first admitted member overcounted exactly one character,
so content whose serialized section sat on the exact whole-pack boundary was
falsely truncated. Reproduction: a single small working-set item whose unbounded
serialized `sections` length equals the limit exactly (e.g. 804 chars, the budget
for `max_tokens=501`) was dropped even though it fit.

The fix makes framing position-aware:
- the **first** admitted member charges `key.length + 3` (quoted key + colon,
  no comma);
- each **subsequent** admitted member charges `key.length + 3 + 1` (add one
  comma).

Crucially, "first" tracks whether any earlier candidate was *actually admitted* —
a starved-out or omitted candidate must not consume the comma-free first-member
slot, so the next admitted section still frames as the first. This is distinct
from the [zero-floor entry above](#2026-07-22-declared-budget-limits-must-admit-their-own-irreducible-framing):
that one is about the *container's* irreducible `{}` floor; this one is about
*per-member* delimiter accounting between members inside the container.

**Fixed invariant:** for any admitted set of sections, the running budget spent
equals `2 (outer braces) + Σ member framing + Σ member bodies`, where member
framing is `key.length + 3` for the first admitted member and `key.length + 3 + 1`
for each subsequent one — i.e. exactly `JSON.stringify(sections).length`. Content
that fits the limit exactly is retained; nothing is dropped by an off-by-one
delimiter overcharge.

### Review Questions

- When a helper charges "framing" or "delimiter" cost per collection member, is
  the cost position-sensitive (first member has no separator) or does it
  uniformly charge a separator that the first element never pays?
- Does a "first member" flag flip only on *actual admission*, so a starved,
  omitted, or absent earlier candidate cannot steal the separator-free slot from
  a later admitted one?
- Is there an exact-boundary regression (serialized length == limit, no additive
  slack) proving content on the limit is retained, not truncated?
- Is the framing accounting validated against real `JSON.stringify` output for
  single-member and multi-member objects, not just an asserted formula?
