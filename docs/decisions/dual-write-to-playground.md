# Mirroring live writes into the playground database

**Status:** PARKED, not built. Designed and costed 2026-07-30.
**Priority:** operator, 2026-07-30 — *"not top priority, or it's not even in the
top 5 priorities right now."*

Deferred behind: finish the new Codex, verify it, then decide whether this is
needed at all or whether a **straight cutover** makes it unnecessary. The
straight cutover is the likely outcome and would retire this entirely.

Resume from here; the measurements below are the expensive part.

---

## What was asked

> *"Is there any way that we can just have the current runner that runs just
> write to two databases, same one then the other? Like we're not fucking
> pounding thousands of messages a second in here."*

Keep the playground database current with live automatically, so rebuild work
tests against real incoming data rather than a snapshot that ages.

---

## Workers are the wrong mechanism — checked first

`scripts/run-two-worker.ts:11-16` spawns N **identical** servers that share one
database, load balanced behind a public port. That is capacity, not duplication.

A "worker pointed at the playground DB" would receive **half** the incoming
traffic and write it only to the playground — splitting real memory in two
rather than copying it. core01 runs two workers and works fine precisely because
both write to the same place.

---

## The chokepoint exists — this is why it is small

`src/db/pool.ts:13` `createPool()` is the single factory, and **the server
creates its pool once**. Measured 2026-07-30: every other `createPool()` call
site is a standalone script (`backup.ts`, `migrate.ts`, `curate.ts`,
`backfill.ts`, and six more), not the request path.

So mirroring wraps `pool.query` in one place and reaches the whole live write
path. It does **not** require touching the 18 files that hand-write their own
hash → embed → INSERT sequences (`_plans/consolidation-2026-07-30.md`).

Estimated ~40 lines at one boundary.

---

## The trap this repo already hit — READ BEFORE BUILDING

`docs/sme/adversarial.md:205-218`. Severity HIGH, found in the PR #275 pre-merge
gauntlet for issue #269, fixed in PR #275:

> *"Racing a DB write against a timeout does not cancel the write: the losing
> `pool.query` keeps running detached and holds its pool connection until the
> server responds. Under a slow or wedged database, fail-open audit writes can
> accumulate detached queries until user-facing operations starve on the shared
> pool. Write concurrency caps must sit below the pool size, and **new fail-open
> writes must skip when `pool.waitingCount > 0`** so background telemetry never
> outbids foreground work."*

A naive mirror is exactly the shape that finding describes. The scope line even
names it: *"any fail-open/fire-and-forget DB write."*

Companion finding, `adversarial.md:812` — *"The unguarded step in a fail-open
path is the one that matters"*: one unguarded step in an otherwise fail-open
function is the whole bug. Guard every step, not most of them.

---

## The design, if it is ever built

1. **Wrap at `createPool`** (`src/db/pool.ts:13`) — the one chokepoint.
2. **A separate pool for the mirror**, small (`max: 2`). Live's 10 connections
   are then never contended by mirror traffic. This is stricter than PR #275
   requires and removes the starvation mode structurally rather than by policy.
3. **Unawaited.** Live commits and returns its receipt before the mirror runs,
   so live latency and durability are unchanged by construction, not by
   measurement.
4. **Skip, do not queue,** when the mirror pool reports `waitingCount > 0`
   (PR #275). A backed-up mirror drops writes rather than accumulating detached
   queries.
5. **Log every skip and failure** with a stable event name, so drift is visible.
   A silently diverging playground is worse than none: it looks authoritative.

Accepted consequence: the playground **will** drift when mirror writes are
skipped or fail. That is the correct trade — the playground is disposable and
re-clonable in ~3 minutes; live memory is not.

---

## Alternatives considered

| approach | live write path | why not now |
|---|---|---|
| **periodic re-clone** | untouched | **already built** (`scripts/local-clone-db.sh`), ~3 min for 4 GB, zero risk. Sufficient for testing the Python ingest path against a fresh snapshot. |
| **Postgres logical replication** | untouched | needs `wal_level=logical`; measured 2026-07-30 as `replica`, so it costs a **Postgres restart** — an outage on live memory. `max_replication_slots`/`max_wal_senders` are both 10, so only the one setting blocks it. |
| **app-level dual write** | modified | the design above; the only option that touches `src/` |
| **straight cutover** | n/a | the likely resolution: if the new tree replaces the old, there is nothing to mirror |

Logical replication is the lowest-risk *continuous* option and needs no
application code at all. If continuous sync is ever genuinely wanted, price that
restart before writing any of the code above.

---

## What would make this worth building

Only one thing: needing the playground to hold **current** data continuously,
rather than a fresh snapshot taken at the start of a test run. Nothing measured
so far requires that.

---

## See Also

- `docs/local-playground.md` — the playground, RUNNING
- `docs/sme/adversarial.md:205` — the pool-starvation finding, PR #275
- `scripts/local-clone-db.sh` — the re-clone path that makes this optional
- `src/db/pool.ts:13` — the chokepoint
- `scripts/run-two-worker.ts` — why workers do not solve this
