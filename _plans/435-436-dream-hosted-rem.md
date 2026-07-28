# DREAM rearchitecture: hosted REM, hourly Deep, agreement-driven review

Issues: **#435** (hosted REM, constraints measured dead), **#436** (hourly Deep,
agreement-driven review). Web service is **#437**, deferred.
Branch context: `goal/dream-e2e-grading`
Date: 2026-07-28
Supersedes parts of: `docs/dream-design.md` (see "What this changes" below)

---

## Summary

`docs/dream-design.md` sizes REM around a 4B model resident on core01 competing
with Postgres for ~3 GB of unified memory. That constraint produced the trigger
design, the bounded forced slice, the "choosier not busier" backpressure rule,
and the nightly cadence for Deep.

Two measurements taken 2026-07-28 remove the constraint. REM should run on a
hosted model, Deep should run hourly, and the operator's review page should
shrink as a *consequence* of Deep learning from the operator's own labels rather
than as a filter placed in front of it.

---

## The two measurements

### 1. The entire candidate corpus is one prompt

```
unit_kind  anchor_kind        n     maxlen  avglen  totalchars
fragment   null             1104     4009     226      248,960
exchange   typed             284     3997    1807      513,122
exchange   orphan             20     3997    2990       59,797
exchange   askuserquestion     6     3997    2222       13,332
```

**835,211 characters total (~209k tokens) for all 1,414 candidates.**
The 310 exchanges alone — the population that matters, since the 1,104 fragments
come from the replaced extractor — are **586,251 chars (~147k tokens)**, which
fits in a single call on every model tested.

Measured via `bun run db` against the live clone, 2026-07-28.

### 2. The local 4B was never fairly measured

`dream-design.md:809` cites the one measurement that exists — the local 4B
"mislabelling 112 of 214 candidates as `preference`" — as the reason confidence
must be corroborated rather than self-reported.

That run had `enable_thinking` left on. Qwen3.5-4B is a reasoning model; without
`enable_thinking=False` it emits `Thinking Process:\n\n1. **Analyze the Request`
and the verdict never arrives inside a small `max_tokens` budget. The parser was
reading deliberation, not output.

**The design's case against a capable REM rests on a harness bug.** This does
not make the 4B adequate — its real ceiling is still unmeasured — but the cited
evidence does not support the conclusion drawn from it.

---

## What this changes in `docs/dream-design.md`

### Measured dead

| Design element | Cite | Why it no longer holds |
|---|---|---|
| Memory headroom as a required trigger signal | `:311`, `:1129` | The headroom gate exists because a local 4B competes with Postgres in unified memory. A hosted call loads nothing locally. |
| Bounded forced slice / thundering-herd guard | `:328-336` | The herd it fears is against core01. "Five sessions and six hours of backlog" is, measured, a fraction of one prompt. |
| "Under load, choosier not busier" | `:337-339` | Defers grouping because local work steals from serving. Nothing to steal. |
| Low high-water mark as the real fix | `:330-333` | A workaround for not being able to eat a big bite. |
| ~3 GB core01 budget spoken for by REM | `:761`, `:1086` | Spoken for by nothing. |
| REM model column: "local (small)" | `:84` | Wrong. |

### Survives unchanged

- **Yield on request** (`:341-346`) — a hosted call in flight should not block serving.
- **REM prepares, Deep commits** (`:127`) — a *permissions* boundary, not a
  capability one. A smarter REM still does not get commit rights.
- **Confidence must be measured, not claimed** (`:806-816`) — see the risk below.
- **The reversibility axis** (`:96-119`) — cheap-to-undo runs free, destructive asks.
- **R3 authority precedence is a hard stop before scoring** (`:790-792`).

### Deep goes hourly

All 12 occurrences of "nightly" were checked. Only one is load-bearing: the
review page (`:778`, `:825`), where the constraint is the operator's attention —
"Roughly: 20 is reviewable, 200 gets skipped."

The rest are incidental. `:757` says nightly because it is the heavy pass on a
big model, a cost argument that flat-rate subscriptions erase. `:687` worries the
pass "would degrade as the corpus grows", already solved by the covering index.
`:1243` makes "nightly run exceeding max duration" a circuit-breaker condition,
which is a duration check and not a cadence requirement.

**Hourly Deep is compatible with the design as written, except for the page** —
and there the fix is decoupling, not cadence. Deep commits hourly; the review
queue accumulates; the operator reads it once a morning. Items above the commit
band land within the hour instead of waiting up to 24.

Operator framing, 2026-07-28: *"we might be able to have the deep dream run
every hour and kind of keep things almost total recall version all of the time
instead of essentially once a day."*

### REM does real work, not categorization

REM's output type changes. Today it emits a *grade*. It should emit **drafted
work** — the merged claim, the paired contradiction, the grouped bundle with a
proposed resolution — leaving Deep to verify and commit.

This preserves `:127` while moving the "easy 90% / hard 10%" line (`:274-278`) a
long way toward REM. Operator framing: *"I still think it should just do a
mid-level of the work and have a deep dream do the rest."*

---

## The review page shrinks because Deep learns, not because we filter

Operator framing, 2026-07-28, corrected twice in one exchange and the correction
is the point:

> *"there's not that we're suppressing anything, it's that it already has
> information enough to know that this is how it should be categorized in the
> deep dream state. We're not suppressing it so much as processing it, and even
> that information can be put into the email report that I get."*

"Suppression" was the wrong frame — it implies an item that should have reached
the operator and did not, which would need a safety net. **Decided** is the right
frame: the item was handled, and the report states what was done.

### The expected ramp

| When | Page shows | Because |
|---|---|---|
| Day 1 | everything | no labels exist |
| End of week 1 | 10-15% | Deep has a week of operator labels |
| End of month 1 | <10% | patterns established |
| Steady state | 2-5% | only the genuinely inconsistent or novel |

**The rate is an output, not a schedule.** Nothing sets it. It falls as agreement
rises, and if it stops falling that is a real signal the residual is genuinely
hard rather than a dial being mistuned.

### The mechanism already exists in the schema

`src/db/migrations/037_candidate_memory_uncertainty.sql` was built for exactly
this and is better than anything proposed in this session:

- `review_action` — the human label, ground truth
- `machine_grade` — REM's prediction, **structurally separated** (`037:43-46`:
  "THE MACHINE GRADE MUST NOT LIVE IN review_action")
- `graded_by` — provenance, because "training data needs provenance"
- `reviewed_at IS NULL` — the operator's queue; nothing machine-written may set it

And `037:55`: **"machine_grade is the prediction; review_action is the label.
Their disagreement rate IS the"** [metric]. `dream-design.md:783` promised
"Rico ranking picks become reference data — the feedback loop that tunes the
threshold" and never said how. This is how.

### The supersession this creates — stated, not silent

`src/candidate-review.ts:23-29` records that the `0.2-0.5` band review page of
`dream-design.md:775-781` is **already superseded** by the operator's
2026-07-28 "let everything pass" decision: the queue predicate is
`reviewed_at IS NULL`, and `uncertain`/`machine_grade` affect only sort order,
never filtering.

The ramp above requires Deep to decide items so they never enter the queue,
which requires setting `reviewed_at` with `graded_by = 'auto:...'`. **That is
what today's rule forbids** (`037:60`).

Both rules are right for their moment. "Let everything pass" was correct when
nothing had ever been graded and there was no basis for deciding anything. Once
Deep has real labels, deciding is earned. This is a genuine reversal of a
decision made the same day and must be written as one, with the auto-decided
path always attributed in `graded_by` so the audit trail distinguishes "Rico
decided" from "the model was trusted to decide". Never silent.

**Blocked on data:** `machine_grade` is empty and the only human labels are 8
smoke-test grades on the old fragment population, which the operator has said
should be blanked and redone. The ramp cannot begin until a first week of real
labels exists.

---

## Review outcomes become retrievable

Operator framing: the input/output pairs *"get correlated into its own vector
database that the next session has access to to have more proper answers without
me needing to be interacting with it"* — clarified as **a table in the same
database, already embedded**, not a second store.

Not a separate vector store. Open Brain is already a vector store; a second one
means two things to sync and two places to search. The decisions are rows with
embeddings in the same store, distinguished by **authority**, not location — and
that concept already exists as the R3 tiers in `docs/code-brain-design.md`:
canon > decided > observed. An operator ranking is the strongest kind of
`decided`. It is a tier, not a database.

---

## Round-two bake-off results (2026-07-28)

30 nodes, 6 prompts x 5 model/effort configs, same 50 items, schema-validated
returns. 1,037,106 subagent tokens, 8.5 minutes wall clock.

Distinct score values out of 11 possible (0-10):

| prompt | terra-low | terra-med | luna-low | sonnet-low | mean range |
|---|---|---|---|---|---|
| **p1 anchored** | **11** | **11** | **11** | 10 | 4.4-5.4 |
| p2 two-axis | — | 8 | 8 | 8 | 4.8-7.8 |
| p3 deletion test | 10 | 10 | — | 9 | 4.9-5.3 |
| **p4 composed** | **11** | **11** | 9 | 9 | 4.8-6.2 |
| p5 rules applied | 7 | 9 | 6 | 8 | **6.2-8.4** |
| p6 canned replies | 7 | 8 | — | 8 | 5.9-7.4 |

Six cells are missing because of Codex forwarding timeouts (harness, not model);
they are re-runnable from workflow cache.

### Findings

1. **Anchoring the scale with worked examples fixes saturation.** p1 is the only
   prompt where all four configs both use the full range *and* agree on the mean
   (4.4-5.4). Round one's best was 7 distinct values with means scattered.
2. **The operator's standing rules do not work as a grading rubric.** p5 inflates
   hardest of any prompt (mean 8.4 on luna-low, 8.2 on terra-low). "Everything
   passes" reads to a grader as "score everything high." Those rules are correct
   as *ingest policy* and wrong as a *scoring rubric* — they belong in what
   happens after the score.
3. **Terra low == Terra med.** 11 distinct both; means 5.0 vs 5.2. Extra thinking
   budget bought nothing measurable. **Terra low is the REM model.**
4. **Sonnet low deflates** (mean 4.4-4.9 across every prompt) and lost items:
   46 and 49 of 50 on p4/p6, and returned 51 on p3, meaning it invented an id.

### Round-three prompt

p1's anchoring + p4's quote/label mechanism + p6's canned replies, on terra low.
One prompt combining the three things that measurably worked.

---

## Open risks

- **Hourly Deep multiplies the commit rate by 24.** `dream-design.md:806-816`
  requires confidence to come from corroboration — occurrence counts, repetition
  across independent extractions — not model self-report. If confidence is
  self-reported, hourly turns a slow leak into a fast one. This is an argument
  for building the corroboration counter **before** raising the cadence, not
  against the cadence.
- **The known hole stays open** (`:814-816`): corroboration cannot promote a
  genuine one-off — a decision made once and never restated. Some of the most
  important entries are exactly that. Do not invent a rule for it here.
- **4,000-char truncation at the source.** 52 of 310 exchanges are cut
  (`maxlen 3997` against a 4,000 cap). Feeding a much more capable model
  deliberately truncated input repeats the shape of the `enable_thinking` bug:
  blaming the model for the harness. Fix before widening context.
- **UNVERIFIED — daily email delivery.** The operator receives an HTML daily
  report for git activity. No such path was found under `_ob/`; searching found
  only `weekly-root-reconciliation.test.zsh` and a takeover script, neither of
  which is that report. Its origin must be identified before proposing a
  delivery mechanism; reusing it beats building a second one.

---

## Rejected in this session — do not re-propose

- **A separate vector database for review outcomes.** Same DB, embedded rows,
  distinguished by authority tier.
- **Sampled-audit as a safety net over auto-decided items.** Rejected as framing:
  the report *is* the visibility. A calibration sample may still be useful, but
  not as a leak detector.
- **Suppression-by-agreement as a filter in front of the page.** The learning
  belongs in Deep, not in a queue filter. Same numbers, right stage.
- **Building the web front end first.** Operator, 2026-07-28: *"we need to get
  this dream stuff done before we start writing a fucking front end for it."*
  The web service is a separate plan, deliberately sequenced after this one.

---

## Sequence

Each step blocks the next.

1. **Round-three prompt** — p1 anchoring + p4 quote/label + p6 canned replies,
   terra low. Produces `machine_grade`.
2. **Fix the 4,000-char truncation** before any context widening.
3. **Operator reviews a week of real output** — produces `review_action`. This is
   the up-front work the ramp depends on; nothing downstream can start without it.
4. **Corroboration counter** — confidence from repetition, not self-report.
   Required before hourly Deep.
5. **Agreement rate** computable from 2 and 3, per embedding neighbourhood.
6. **Auto-decide** turns on once 5 has data, and ramps by itself.
7. **Web service** — separate plan, separate issues, after all of the above.
