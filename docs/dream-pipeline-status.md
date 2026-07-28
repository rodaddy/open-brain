# DREAM pipeline — status as built

**Date:** 2026-07-28
**Branch:** `goal/dream-e2e-grading`
**Measured against:** the dogfood clone (3,795 raw turns, 1,104 candidates)

Every number below was read from the real database on 2026-07-28, not from a
fixture. Where something is not built, it says so.

## TL;DR for the operator

```bash
set -a; . /Volumes/ThunderBolt/open-brain-local/local-clone.env; set +a
bun run migrate          # 39 migrations, idempotent
bun run dream:cycle      # distill -> light -> rem -> deep, 1.3s
bun run grade            # grading page at http://127.0.0.1:3417/
```

Then open <http://127.0.0.1:3417/> and grade with `1` pass · `2` fail ·
`3` inconclusive · `4` duplicate · `u` undo.

## What is built

The pipeline runs end to end: a captured turn reaches the operator's review
queue with its provenance intact. That path is what #382/#390/#391/#394
collectively exist to produce, and before this branch it had never been
demonstrated — 3,795 turns captured, 0 reviewed.

| Stage | Issue | Module | Entrypoint | Writes? |
|---|---|---|---|---|
| Distill | #382 | `src/distiller.ts`, `src/distill-handler.ts` | `bun run distill` | `candidate_memory`, stamps `ob_raw_turns.distilled_at` |
| Light | #390 | `src/dream-light.ts` | `bun run dream:light` | `content_occurrences`, stamps `light_swept_at` |
| REM | #391/#392/#398 | `src/dream-rem.ts`, `src/candidate-dedupe.ts` | `bun run dream:rem` | `machine_grade` only; tier flips on `thoughts` |
| Deep | #394 | `src/dream-deep.ts` | `bun run dream:deep` | **nothing — read-only** |
| Grading page | #394 | `src/grading-server.ts`, `src/grading-page.ts`, `src/candidate-review.ts` | `bun run grade` | `review_action`/`reviewed_at`/`graded_by`, operator only |
| Whole cycle | — | `scripts/dream-cycle.ts` | `bun run dream:cycle` | all of the above in order |

Order is load-bearing and documented at `scripts/dream-cycle.ts:13-28`: Light
must count before REM grades, because grading is idempotent on
`machine_grade IS NULL` and a candidate graded before its evidence was counted
is graded permanently.

`distill` and `grade` were the two stages with a script but no `package.json`
entry; they are wired now so every stage is reachable the same way.

## Measured numbers (2026-07-28, real clone)

### Corpus

| | |
|---|---|
| `ob_raw_turns` | 3,795 |
| undistilled | 0 |
| turns without `session_seq` | 0 |
| `ob_session_events` | 9,517 |

### Distill output

1,104 candidates from 3,795 turns, all embedded (0 NULL embeddings):

| Type | Count | Uncertain |
|---|---|---|
| fact | 612 | 377 |
| correction | 325 | 325 |
| decision | 166 | 128 |
| preference | 1 | 0 |
| **total** | **1,104** | **830 (75%)** |

`correction` is 100% uncertain by construction — an assistant turn matching a
correction marker may be self-correction or may be restating the operator's
correction, and the distiller records that ambiguity rather than resolving it.

### Light

| | |
|---|---|
| Occurrence rows | 1,098 |
| Cross-session (corroborated) | **1** |

One item in 3,558 non-tool turns has cross-session support. This is why Light
counts but does not gate — `docs/decisions/light-counts-but-does-not-gate.md`.
Gating on the count would suppress 99.9% of the corpus.

### REM

| | |
|---|---|
| Machine graded | 1,104 (100%) |
| `inconclusive` | 1,103 |
| `promoted` | 1 |
| Near-dupes merged | 0 |
| Reinforcement rows | 0 |

The single `promoted` grade is the single corroborated item. Dedupe found 0
pairs at the settled 0.09 cosine threshold; the closest pair anywhere in a
400-candidate sample is 0.1240. Two independent mechanisms agree this corpus
does not restate itself.

### Deep

| | |
|---|---|
| Bundles built | 20 (`DEFAULT_BUNDLE_LIMIT`) |
| Queue depth | 1,104 |
| Context turns | 115 across 20 bundles (min 2, max 7) |
| Missing provenance | 0 |

### Cycle wall time

1.3s cold, 0.7s on re-run, against the full 3,795-turn corpus.

## The governing invariant, verified after the run

`docs/decisions/let-everything-pass-grading.md`: nothing is pre-filtered, and a
machine may not write a human label. Asserted directly against the database
after the full cycle:

```
reviewed_at set   : 0
review_action set : 0
graded_by set     : 0
machine_grade set : 1104
```

No stage suppresses anything. The Deep queue is still all 1,104 candidates.
`machine_grade` is a *prediction*; `review_action` is the *label*; their
disagreement rate is the only measurement of whether REM has learned anything,
and it exists only because the two were never allowed to contaminate each other.

## Nothing was destroyed

Row counts before and after the full pipeline run, identical:

| Table | Before | After |
|---|---|---|
| `ob_raw_turns` | 3,795 | 3,795 |
| `thoughts` | 24,956 | 24,956 |
| `decisions` | 17,983 | 17,983 |
| `ob_session_events` | 9,517 | 9,517 |
| `candidate_memory` | 1,104 | 1,104 |
| `content_occurrences` | 1,098 | 1,098 |

`thoughts` and `decisions` match the last backup exactly. Migrations 001–037 are
unmodified — `git diff --name-status origin/main -- src/db/migrations/` reports
eight `A` (added) entries and zero modifications.

## Gaps — what is NOT built

These are real and should not be read past.

**1. Nothing has been graded.** `graded=0`, so `machine_agreement.rate` is
`null`. The whole point of the branch is to produce the grading surface; the
training data does not exist until the operator uses it. Every downstream claim
about REM accuracy is unmeasurable right now.

**2. REM's grader is a heuristic, not a model.** `rem-heuristic-v1` returns
`promoted` on `session_count > 1` and `inconclusive` otherwise. On this corpus
that is 1 promoted and 1,103 inconclusive — it is a placeholder that defers to
the human, which is the correct failure direction but is not grading. No model
is wired into REM.

**3. Re-warm is convergent but not idempotent, and it is unbounded across
runs.** Each `dream:cycle` flips up to 250 `thoughts` rows to `tier='hot'`
(measured: +250 on the first run, +130 on the second, 3,065 still warmable).
`src/dream-rem.ts:508-510` documents the convergence, and `:389-391` warns that
warming everything is the same as warming nothing — `tier` stops
discriminating. **Do not loop `dream:cycle` in a tight loop on this clone.**
Only `thoughts.tier` and `updated_at` change; no rows are created or deleted.

`scripts/dream-rem-run.ts` accepts `--no-rewarm` and the `dream.rem` job payload
accepts `skip_rewarm` (`src/dream-rem.ts:604`), but **`scripts/dream-cycle.ts`
exposes no such flag** — `runRemPass` is called with no rewarm opt-out at
`scripts/dream-cycle.ts:230`. To run the candidate stages without tier flips
today, run the stages individually:

```bash
bun run distill --all && bun run dream:light && bun run dream:rem --no-rewarm && bun run dream:deep
```

**4. There is no scheduler.** `src/maintenance-bootstrap.ts:171-174`: registration
is dispatch only, the maintenance queue has no recurrence primitive, and a DREAM
cycle still starts from an operator running the script. #347 is the scheduler.

**5. Deep is deliberately not a registered job kind**
(`src/maintenance-bootstrap.ts:199-202`) — it is a read-only bundle builder whose
output is a page, so a background worker would compute a result and discard it.
This is intentional, listed here so nobody "fixes" it.

**6. Cooling is not implemented.** Re-warm only warms. Cooling on silence is the
slow half of the pair (`dream-design.md:409-414`) and is a decay process, not a
sweep. Not designed, not built.

**7. No rule for one-offs.** `dream-design.md:1369` open question #1 — how a
genuine one-off gets promoted when corroboration cannot promote it. REM returns
`inconclusive` with that reason and leaves the item to the operator. No rule was
invented.

**8. The grading page has never been used by the operator.** It serves 200 and
its API returns real bundles, but keyboard flow, pagination at 1,104 items, and
the inconclusive second pass have only been exercised by tests and curl.

## How the operator starts the grading server

```bash
cd /Volumes/ThunderBolt/Development/open-brain
set -a; . /Volumes/ThunderBolt/open-brain-local/local-clone.env; set +a
bun run grade
```

Output:

```
  Open Brain -- candidate grading
  ------------------------------------------------------------
  URL          http://127.0.0.1:3417/
  namespace    rico
  graded_by    rico
  ungraded     1104 of 1104
  keys         1 pass · 2 fail · 3 inconclusive · 4 duplicate · u undo
  ------------------------------------------------------------
```

Options:

```bash
bun run grade --port 3418            # if 3417 is taken (it says so and exits 1)
bun run grade --namespace rico       # default; never inferred from the database
bun run grade --graded-by rico       # lands in candidate_memory.graded_by
```

The listener is loopback-only and not configurable
(`GRADING_BIND_HOST`, `src/grading-server.ts:62`). It probes the database before
binding, so an unreachable DB fails loudly instead of serving an empty page that
looks like an empty queue.

Endpoints, verified live:

| Endpoint | Result |
|---|---|
| `GET /` | 200, 16,379 bytes |
| `GET /api/stats` | `{"total":1104,"ungraded":1104,"graded":0,"uncertain_ungraded":830,...}` |
| `GET /api/queue?limit=N` | candidate + surrounding turns + reinforcement receipt |
| `POST /api/grade` | 403 if the body carries `machine_grade` |
| `POST /api/ungrade` | clears `review_action`/`reviewed_at`/`graded_by` together |

The queue is capped at `MAX_QUEUE_LIMIT = 50`, default 20 — handing over all
1,104 rows at once is the documented way to get zero of them graded
(`dream-design.md:825-827`: 20 is reviewable, 200 gets skipped).

## Verification state of this branch

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test` | 2,634 pass / 298 skip / **0 fail**, 184 files, ~30s |
| `bun run migrate` | 39 applied, no-op on re-run |
| Full cycle on real DB | 1.3s, no row-count change |

`src/source-sync.test.ts` (#422, full-suite-only failure) **did not reproduce**
on this branch — it passes both standalone (24 pass) and in the full suite.

## Related

- `docs/dream-design.md` — the design this implements and departs from
- `docs/decisions/let-everything-pass-grading.md` — the governing decision
- `docs/decisions/light-counts-but-does-not-gate.md` — why the count is a signal, not a gate
