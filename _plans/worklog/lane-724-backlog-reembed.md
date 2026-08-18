# Lane A — issue #724 item 1: Aug 14-17 backlog re-embed

Status of every claim below: **RUNNING** where it says "observed", meaning it was
measured against the live dogfood database (`open_brain_local_20260724` on
`127.0.0.1`) during this session on 2026-08-17/18. The code change is **WRITTEN**
and, once its PR lands, MERGED — nothing here is deployed to core01.

## 1. Does the restored worker drain the backlog on its own?

**No. CONFIRMED by measurement, not inference.**

The lane brief asked this first, so it was measured rather than assumed:

| Observation | Result |
| --- | --- |
| Eligible-but-unembedded `ob_session_lanes` at T0 (21:51:20 -04) | 549 |
| Same count at T1, 4 minutes later (21:55:20 -04) | 549 |
| `maintenance_jobs` rows updated in the preceding 10 minutes | 0 |
| `embedding.repair` jobs ever recorded in `maintenance_jobs` | 0 |

`maintenance_jobs` has only ever held `memory.distill` (3, last updated
2026-08-08) and `system.facts` (30, last updated 2026-07-26). The queue has been
idle for over a week.

### Root cause — it is a design boundary, not a broken worker

`docs/embedding-repair.md` ("Server-owned runtime and enqueue boundary") states
it outright: `src/maintenance-bootstrap.ts` starts the `embedding.repair` runner,
but the bootstrap **"invents no namespace and enqueues no job."** Enqueue is
deliberately an explicit, auth-scoped CALLER boundary, because a namespace cannot
be fabricated by a background process.

Nothing in the repo occupies that caller position for a bulk historical backlog:

- `src/maintenance-sweep.ts` enqueues `memory.distill` and graph-derivation jobs
  only — it never enqueues `embedding.repair`.
- `scripts/backfill.ts` covers only the five original domain tables
  (`BACKFILL_TABLES`: thoughts, decisions, relationships, projects, sessions).
  `ob_session_lanes` — where the window gap actually was — is **not** in that
  list.

So the runner was healthy and correctly idle. The backlog had no caller to push
it. Attribution of the backlog's *origin* to the nats-worker outage remains
**unverified**; this lane observed rows, not causes.

## 2. The fix — smallest thing that rides the existing path

`scripts/repair-embeddings.ts`: a CLI that occupies the missing caller position.
It adds no pipeline, no table, and no SQL. It loops the existing bulk primitive
whose own docstring (`src/embedding-repair.ts:682`) says it "is for
scripts/backfill-style bulk runs":

- `src/embedding-repair.ts:682` `repairStaleBatch(...)` — the bulk primitive.
- `src/embedding-targets.ts:326` `EMBEDDING_TARGET_NAMES` — the table registry,
  read at runtime. A second hand-maintained copy of that list is the #433 defect
  class, so there is none here.
- `src/embedding.ts` `generateEmbeddingWithMetadata` and `src/db/pool.ts`
  `createPool()` — the same provider and pool the server uses.

Every safety property is the primitive's, inherited unchanged: namespace-bound
reads *and* guarded writes, embeddings generated outside locks, idempotent
convergence on replay, retryable-vs-permanent failure classification,
content-free logging. Scope is mandatory — `--namespace <ns>` (repeatable) or the
separately named `--global`; there is no unscoped default.

### Two things measurement forced into the design

**(a) `reasons: ["missing"]` is required for a bulk drain to converge.**
`buildSelection` (`src/embedding-repair.ts:250`) ORs all staleness reasons into
one *unordered* `SELECT ... LIMIT n`, and the `source_drift` arm is
`embedding IS NOT NULL AND content_hash IS NOT NULL` — rows that already *have*
an embedding — with the real hash comparison done in JS afterward. Observed: with
all reasons enabled, `limit=500` on `ob_session_lanes` returned 100 candidates of
mixed reason while 549 rows sat unembedded. With no `ORDER BY`, repeated batches
can return the same rows forever. Selecting `missing` alone makes every selected
row one the loop can actually repair, which is what makes `repaired === 0` a
truthful stop condition. Drift repair stays the queue handler's job.

**(b) One table must not abort the drain.** The first `--global` run died
entirely on the first table. Cause: a **leaked test fixture on the live dogfood
database** — a `BEFORE UPDATE` trigger `dream_bulk_release_trigger` on `thoughts`
executing `dream_bulk_release_sentinel()`, which RAISEs on every update. It
originates from `src/tools/__tests__/bulk-set-tier.pg.test.ts` and is the #613
fixture-leakage class. The loop now isolates per-table failures, reports them,
and reflects them in the exit code. **This lane did not drop that trigger** —
destructive DDL is outside its authorization — and it is filed below as residual
work.

## 3. Result of the run

`bun run scripts/repair-embeddings.ts --global`, observed 2026-08-18 02:03 UTC:

| Table | selected | repaired |
| --- | --- | --- |
| decisions | 1064 | 1064 |
| ob_session_lanes | 489 | 489 |
| ob_session_events | 62 | 62 |
| ob_entities | 12 | 12 |
| relationships / projects | 0 | 0 (already clean) |
| thoughts | — | aborted: `dream-bulk-test forced failure` |
| sessions | — | aborted: duplicate key on `idx_sessions_content_hash` |

**Total repaired: 1,627.** Eligible-but-unembedded `ob_session_lanes` went
549 → 0 (the earlier `--namespace rico` run had already taken 60 of those).

## 4. Done-means

`scripts/done-means/724-backlog-recallable.sh`

- **RED** (before the run): `EXIT=1`, clause 1 FAIL —
  `ob_session_lanes: 2 of 2 eligible window rows have NULL embedding`.
  Clauses 2 and 3 PASS, so the instrument had authority.
- **GREEN** (after the run): `EXIT=0`, all three clauses PASS,
  `unembedded total: 0` across 101 eligible window rows.

Tests: `bun run test:isolated src/embedding-repair.test.ts
src/embedding-targets.test.ts` — 76 pass, 0 fail. `bunx tsc --noEmit` clean.

## 5. Residual — NOT closed by this lane

1. **Leaked `dream_bulk_release_trigger` on `thoughts`** (live dogfood DB).
   Blocks *every* update to `thoughts`, not just embedding repair. 1,297
   `thoughts` rows remain unembedded behind it. Needs its own issue: both the
   drop and the test-teardown fix that stops it recurring.
2. **`idx_sessions_content_hash` unique-constraint collisions** block the
   `sessions` drain; 11,166 rows remain unembedded. Duplicate session content
   hashing to the same value is a real modelling question, not a repair bug.
   `scripts/backfill.ts` already anticipates this class per-row; the repair
   primitive surfaces it as a thrown batch error instead.
3. **Nothing schedules this CLI.** The backlog is drained once, by hand. If the
   enqueue boundary stays empty, a future outage produces the same backlog again.
   Whether the sweep should enqueue `embedding.repair` is a design decision for
   the operator, not something this lane took unilaterally.
4. The done-means check counts rows; a row embedded with a *wrong* vector still
   passes clause 1.
