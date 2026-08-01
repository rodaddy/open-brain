# Light counts occurrences; it does not gate what REM sees

**Date:** 2026-07-28
**Status:** accepted
**Implements:** #390 (Light), #391 (REM), #394 (Deep)
**Delta against:** `docs/dream-design.md:230-243`
**Encoded in:** `src/dream-light.ts` (`readLightQueueDepth` doc comment),
`src/dream-rem.ts` (`heuristicRemGrader`), `src/candidate-dedupe.ts`
(`CANDIDATE_DUP_DISTANCE`)

## The decision

Light keeps counting occurrences exactly as designed. The count is **never** a
filter: REM reads every candidate whose `machine_grade IS NULL`, and Deep reads
every candidate whose `reviewed_at IS NULL`, regardless of occurrence count.

Corroboration is a **signal REM reads**, not a **gate REM sits behind**.

## What the design doc says

`docs/dream-design.md:232-234`, verbatim:

> The occurrence count light maintains **is** the corroboration signal that
> promotion (#394) and supersession (#396) depend on. Things that actually
> mattered get said more than once, across sessions. That is evidence the model
> does not generate — it just gets measured.

The reasoning is sound and the mechanism is worth having. The *premise in the
second sentence* is what measurement contradicts.

## The measurement

Full sweep of the dogfood clone, 2026-07-27 and re-confirmed 2026-07-28 at
3,795 turns / 1,098 occurrence rows.

| Signal | Measured |
|---|---|
| Turns swept | 3,795 |
| Distinct content rows counted | 1,098 |
| Content appearing in **more than one session** | **1** |
| That one item | *"are we at a good stop point, this box needs to reboot"* (5 sessions) |

One in 3,558 after excluding tool output and tool-call stubs. Before those
exclusions the top "corroborated facts" in the database were a runtime receipt
JSON blob (10 sessions) and `(Bash completed with no output)` (5 sessions) —
which is why the exclusions exist (`src/dream-light.ts:100-143`).

The same property shows up independently in the semantic near-dupe path (#398).
Over a 400-candidate sample of the 1,104 real candidates, all embedded:

| Cosine distance cutoff | Pairs found |
|---|---|
| 0.09 (the settled threshold) | **0** |
| 0.20 | 7 |
| 0.30 | 29 |

The closest pair anywhere in the sample is **0.1240**. Two independent
mechanisms — exact-hash cross-session counting and semantic similarity — both
report that this corpus does not restate itself.

## Why the premise is false here

It is not a bug in the counting. The operator states a decision once, in his own
words, acts on it, and moves on. The corpus is dense with exactly the content
the premise predicts would recur, and it does not recur even once.

The near-dupe problem #398 was written against — *"fifty rows for one fact"*
across a ~12,946-file backfill — is a backfill-scale phenomenon. This capture is
three days wide (2026-07-25 to 2026-07-28) and has not reached it.

## Why that disqualifies the count as a gate

If REM only saw corroborated content, REM would see **one** item and the other
1,103 candidates would never reach the operator. A 99.9% suppression rate,
produced by a premise measurement has already falsified.

That is precisely the failure the governing decision of 2026-07-28 exists to
prevent (`src/db/migrations/037_candidate_memory_uncertainty.sql:8-13`):

> A filter tuned before there is graded data is tuned on nothing. Worse, it
> destroys the very evidence needed to tune it: a candidate suppressed at ingest
> cannot be graded, so the error it represents is never measurable and never
> corrected.

## What is kept, not thrown away

The count is **not** worthless and Light is **not** weakened:

- `runLightSweep` is unchanged. Light still counts every sweep.
- When corroboration fires it is real evidence a model cannot manufacture, it
  costs nothing to maintain, and it is REM's strongest positive signal
  (`heuristicRemGrader` returns `promoted` on `session_count > 1` — which is how
  the single corroborated item in the corpus got the only non-`inconclusive`
  machine grade out of 1,104).
- `0.09` stays the near-dupe threshold. It is settled, not a fitting problem
  (`dream-design.md:645-649`). **Loosening it to 0.20 to capture 7 pairs would
  be tuning a merge threshold on the desire to see output** rather than on
  graded evidence — the same error in a different place.

## The open question this touches, and does not answer

`dream-design.md:1369`, Known open question #1:

> **How does a genuine one-off get promoted?** Corroboration cannot promote a
> decision made once and never restated, and *"some of the most important
> entries are exactly that. A companion rule is needed and is not yet
> designed."*

No rule is invented here. `heuristicRemGrader` returns `inconclusive` with the
reason *"single uncorroborated statement; no rule designed for one-offs"* and
leaves the item on the operator's queue — which is where an undesigned case
belongs. `dream-design.md:1363-1365` requires exactly this: record the choice
with its reasoning rather than closing the question silently.

## Consequence for anyone changing this code

An occurrence-count predicate added to REM's selection, to Deep's queue, or to
the near-dupe threshold is **reintroducing the gate this decision removed**. It
needs an operator decision and new measurement, not a commit.
