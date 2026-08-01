# Let everything pass; the operator grades it

**Date:** 2026-07-28
**Status:** accepted (operator decision)
**Implements:** #394 (Deep / review page)
**Encoded in:** `src/db/migrations/037_candidate_memory_uncertainty.sql`,
`src/candidate-review.ts`, `src/grading-server.ts`, `src/grading-page.ts`

## The decision

Nothing is pre-filtered on a guess. Every candidate flows Light → REM → Deep and
lands in the operator's queue. The machine records its uncertainty instead of
acting on it. Grading is a human act, and the grades are the training data.

Verbatim, from the operator on 2026-07-28: *"a website where I can go grade the
responses"*, *"pass fail inconclusive"*, *"inconclusive should go through, and
then there should be a thing asking me, would you like to grade all of these
inconclusive things"*.

## Why (the rationale that gets lost)

A filter tuned before there is graded data is tuned on nothing, and it destroys
the evidence needed to tune it: a candidate suppressed at ingest cannot be
graded, so the error it represents is never measurable and never corrected.

The measured case for distrusting machine self-assessment here is in this
corpus, not in the abstract: 112 of 214 candidates were mislabelled `preference`
in the 2026-07-24 run (`docs/dream-design.md:238`). A model wrong about the
label 52% of the time must not also decide what is never seen.

Recall over precision **at ingest**. The tier system is the precision filter,
applied later, reversibly, on months of usage evidence. Content that never
entered has no usage history to be judged by and no path back. This is the same
asymmetry that removed the length floor from Light (`src/dream-light.ts:159-190`).

gbrain is the precedent, including the unpleasant part: they reached a working
automated promoter by grading the whole corpus first — *"a big giant slug that
was super annoying to do"* — not by guessing well up front.

## What this supersedes

`docs/dream-design.md:775-781` specifies a confidence-band table: commit above
0.5, review 0.2–0.5, drop below 0.2. **That band table is superseded for this
build.** Nothing is dropped and nothing commits silently. The queue predicate is
`reviewed_at IS NULL`, not a band.

`uncertain` and `machine_grade` survive as **advisory only**. They reach
`ORDER BY` so doubtful items surface first; they never reach `WHERE`
(`037:59-63`, asserted by the "uses the unreviewed predicate, not a confidence
band" test in `src/candidate-review.test.ts`).

## The structural rule: a machine may not write `review_action`

`candidate_memory_review_paired` means anything setting `review_action` also
sets `reviewed_at` — so a machine writing there **silently removes the item from
human review**. The model would be grading its own training data and marking it
done (`037:43-57`).

Enforced in three independent places, because the invariant is worth more than
any one of them:

1. `gradeCandidate` never names `machine_grade` in its `UPDATE`. A column that
   is never named cannot be written by a malformed request.
2. `POST /api/grade` returns 403 for a body carrying `machine_grade` — rejected,
   not ignored, so a caller cannot believe it recorded something.
3. `assertNotMachineIdentity` refuses a model-shaped `graded_by` at server
   construction, before the operator has spent attention on an item.

`machine_grade` is a *prediction*; `review_action` is the *label*. Their
disagreement rate is the measurement of whether REM has learned anything, and
that number only exists because the two were never allowed to contaminate each
other. The page shows it live.

## Attention budget is a hard constraint

`docs/dream-design.md:825-827`: *"The metric to watch is not REM cost but how
many items land on the nightly page. Roughly: 20 is reviewable, 200 gets
skipped."*

So the queue is paginated and capped (`MAX_QUEUE_LIMIT = 50`, default 20).
Handing the operator all 1,104 rows at once is the documented way to get zero of
them graded. The other half of the same constraint is per-item friction, which
is why the page is keyboard-driven and single-item: 1/2/3/4 under the fingers.

## `inconclusive` is load-bearing

It exists so *"I cannot tell"* does not collapse into `rejected` (`037:35-37`).
Treating unsure as no is exactly the silent data loss the design is trying to
stop. Items graded `inconclusive` stay findable
(`idx_candidate_memory_inconclusive`, `037:146-149`) and the page offers a
second pass over them once the main queue empties — the operator's ask,
implemented literally.

## Evidence, not just the claim

A candidate is not judgeable on its own text: the corpus is full of turns like
`"go for it"` and `"switched both"` (operator turns have a median length of 93
characters). So each item carries its source turns **and the surrounding
conversation** — 4 turns before and 3 after, ordered by
`(session_ref, occurred_at, id)`, the same expression the distiller windows on
(`src/distill-window.ts:25-39`). A candidate whose context comes back empty is
labelled ungradeable on the page rather than presented as a bare claim.

Reinforcement counts are joined live from `content_occurrences` on every read.
They are never denormalized onto the candidate row — `docs/dream-design.md:686`
is explicit, and :688-692 notes it is *"cheap enough to compute every time, so
it is never wrong."* That is what makes a gbrain-style receipt possible:
*"seen 3x across 2 sessions, Jul 20 to Jul 28"* rather than an unexplained
number (:709-712).

## Undo is deliberate, and it is the only reversal

A keyboard-driven grader will mis-hit a key. Without undo the only recovery is
to leave a wrong label in the table a future promoter trains on.
`POST /api/ungrade` clears `review_action`, `reviewed_at`, and `graded_by`
together — keeping `candidate_memory_review_paired` satisfied — and touches no
content. It cannot clear `machine_grade`; the operator never set it.

## Ambiguity, recorded rather than resolved

`docs/dream-design.md:1363-1365` says not to invent answers to the open
questions during implementation. Two are still open and were **not** closed here:

- **Is the review page ceremony?** (:1372) Mode A (commit >0.5, review 0.2–0.5)
  versus Mode B (commit >0.2, drop below) is unresolved until recall is
  compared. This build implements neither mode's filter; it grades everything,
  which is what produces the data the comparison needs.
- **Ranking versus per-item grading.** :785-786 anticipates *"Rico ranking
  picks"* as reference data. This page does per-item grading, because that is
  what the operator asked for verbatim and because grades are the input any
  ordinal fit would be derived from anyway. An ordinal ranking surface is not
  built and is not foreclosed.

Page layout, column set, and the keyboard map have no basis in
`docs/dream-design.md` — it contains no text on any of them. They are
implementation choices made to satisfy the operator's stated requirements
(speed, three verdicts plus duplicate, an inconclusive follow-up pass) and
should be changed freely on operator feedback without treating this document as
having settled them.

## Related

- `docs/dream-design.md` — Light/REM/Deep, the confidence bands this supersedes,
  the attention budget, and the reinforcement/receipts requirement.
- `docs/code-brain-design.md` — R3 authority tiers; promotion out of
  `candidate_memory` remains a separate, deliberate act.
- `src/db/migrations/033_candidate_memory.sql`,
  `src/db/migrations/037_candidate_memory_uncertainty.sql`.
