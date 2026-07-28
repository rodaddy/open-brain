# DREAM — three-stage sleep cycle (Light / REM / Deep)

**Status:** design, not implemented. Implementable spec.
**Extracted:** 2026-07-27, from GitHub issues #389–#399 (all OPEN at extraction).
**Program:** #320. **Epic:** #389.

## Why this file exists

The DREAM design lived only in GitHub issue bodies. A working tree cannot see an
issue body, `.qmd` cannot index one, and an agent doing a repo search before
starting work finds nothing. A previous extraction pass covered CLOSED issues
only, so #389–#399 were missed. This file is the tree-visible copy. **The issues
remain the source of record**; every section below names its issue number.

Load-bearing rules are quoted **verbatim**. Where the text is quoted, the quote
is the spec — paraphrase loses precision and invites re-litigation.

### Companion documents — read, do not duplicate

| Document | Owns |
|---|---|
| [`code-brain-design.md`](./code-brain-design.md) | **R3 authority tiers** — the promotion rule. R1 kind/reach, R2 bi-temporal fields, retention, the model-free drift-counter correction |
| [`dream-ethereal-runs.md`](./dream-ethereal-runs.md) | **How the stages get TESTED** — real input, disposable output, `dream_run_NNN` schemas, the `zz_test_*` prior art |
| [`decisions/cognitive-tiering-dream-cycle.md`](./decisions/cognitive-tiering-dream-cycle.md) | The **older** (#12, 2026-04-06) tiering model: tier semantics, `entry_access_log`, `discarded_entries` schema, phases 4–7 |
| [`full-send-derivation-spec.md`](./full-send-derivation-spec.md) | Raw-turn ingest, the distillation job, the missing producer, generation-model sizing |

---

## ⚠️ Stale premises — read before coding (audit 2026-07-27)

An audit on 2026-07-27 measured the epic's "Built | Missing" table (#389) as
**roughly 2/5 correct**. The **design intent below is preserved as written**;
these flags mark the premises that no longer hold. Do not code against a
falsified premise, and do not "fix" a design because its motivating example
aged out.

| Epic claim (#389) | Measured 2026-07-27 | Verdict |
|---|---|---|
| Maintenance runner is off (`OPEN_BRAIN_MAINTENANCE_ENABLED=0` local, unset on core01) | `maintenanceQueueEnabled()` is **opt-out** (`src/maintenance-bootstrap.ts:173-180`: `return raw !== "0" && raw !== "false"`). The var is **absent from `.env`**, so the runner is **ENABLED** | ❌ **STALE — inverted** |
| "0.66% capture" proof case | Capture is **live**: `ob_raw_turns` 3,303 rows, `ob_session_events` 9,462 rows | ❌ **STALE — obsolete** |
| Dream Cycle is missing "a scheduler" | **Three scheduling primitives already exist**: leased `setInterval` in `src/maintenance-queue.ts:668-676`, the session sweeper in `src/transport.ts:99-113`, and launchd `com.rico.open-brain` | ⚠️ **PARTLY STALE** — what is missing is a *dream* scheduler, not scheduling capability. Reuse one of the three |
| `graduateLaneEvent` has no caller | It has a caller at **`scripts/tier-lane-durable.ts:352`** (plus the internal call at `src/tiering.ts:362`) | ⚠️ **PARTLY STALE** — no *automatic* caller; a script caller exists |
| `discarded_entries` — 0 rows, no writer | Still 0 rows, still no writer | ✅ **STILL TRUE** |
| `graduateLaneEvent` has never written a row | Still true — `thoughts WHERE promoted_from ? 'graduated_at'` is 0 | ✅ **STILL TRUE** |
| Nothing consumes raw turns | 3,303 turns captured, **0 distilled**, and **no consumer of `ob_raw_turns` anywhere in `src/`** | ✅ **STILL TRUE — this is the real residual gap** |

**The epic's thesis survives the corrections.** Verbatim (#389):

> One architectural defect repeated five times: **every transition is a tool, and
> tools only fire when an agent remembers to fire them.** A brain that only
> remembers when you ask it to remember is a filing cabinet.

Three of five instances have moved; the defect the epic names is still the
defect, and the strongest remaining evidence for it is the third ✅ row: capture
works, storage works, and nothing reads the result.

**Also outstanding:** `docs/dream-ethereal-runs.md` records that #382's
`candidate_memory` table **does not exist** (`to_regclass('public.candidate_memory')`
→ NULL) while `zz_test_candidate_memory` **does**, with 214 rows. See
[Known open questions](#known-open-questions).

---

## Governing principle (#389)

> Each stage does everything cheap that is certain and stops at the first thing
> needing judgment: **light stops when it would have to infer, REM when it would
> have to decide, deep when it is not sure** — and then it asks.
>
> The more each sleep stage can do without becoming slow or overwhelmed, the more
> the next stage can do.

Three stages, each with a different trigger, model, and budget. Rationale (#389):

> The current single-pass dream tries to do all of this with one cadence and one
> model, which is why extraction over-produces: a small model doing REM-level
> work at light-cycle cost.

### Stage summary

| Stage | Trigger | Where | Model | Commits? |
|---|---|---|---|---|
| **Light** (#390) | none — runs in the write path | in-transaction with the raw turn insert | **none, hard requirement** | tags only |
| **REM** (#391–#393, #396, #398) | low request rate **OR** low backlog high-water mark, **and** memory headroom; 6h starvation ceiling | core01, local model | local (small) | prepares bundles; tier flips |
| **Deep** (#394, #396) | nightly | **off-box** (Sol/Opus) | large | **yes — not advisory** |

---

## The two axes of autonomy

The epic uses **confidence bands**. The April 2026 SOP used **reversibility**.
Recorded in #389's comment (2026-07-27) so the epic carries the axis it would
otherwise lose. Verbatim from the April SOP:

> (1) Always present proposed changes to Rico before executing deletions.
> (2) Cold demotions can proceed without approval.
> (3) Hot promotions for SOPs and active refs are autonomous.

> That is **graduated autonomy keyed to reversibility**: cheap-to-undo actions run
> free, destructive ones stop for a human.
>
> This epic's confidence bands are a different axis. Bands answer *how sure is the
> model*; April answered *how bad is it if this is wrong*. They are not
> substitutes — a high-confidence deletion is still a deletion. Checked #394: its
> bands govern what **enters** the corpus (commit vs drop a proposal). Nothing in
> the epic currently governs the reversibility of actions taken on **existing**
> memory.

The reversibility axis, to be applied across the epic (#389 comment):

| Action | Reversible? | April's rule |
|---|---|---|
| tier demote hot→warm | yes, trivially | autonomous |
| tier promote for an SOP | yes | autonomous |
| consolidate/merge entries | only if originals retained | proposal |
| delete / hard discard | no | **always ask** |

#398's reinforcement-history design already applies this instinct in one place —
a history row instead of a mutated confidence score makes a merge reversible and
auditable. **Make it explicit across the epic rather than per-issue.**

### Where the current design beats April (#389 comment)

| | April | Current epic |
|---|---|---|
| Trigger | one nightly 3am pass by Skippy | Light in the write path (#390), REM rate-triggered (#391), Deep off-box (#394) |
| Failure mode | miss the run → nothing happens, silently | Light cannot not-run; REM has a 6h starvation ceiling |
| Stage roles | LIGHT=tiering, DEEP=consolidation, REM=TBD | REM prepares, Deep commits |
| Commit rule | "promote, demote, consolidate" | confidence bands: >0.5 silent, 0.2–0.5 review, <0.2 drop |

> The load-bearing improvement is Light moving into the write path. April's model
> was one scheduled pass doing everything, and this repo now has a measured
> example of that failure mode: the single `graph.derive` canary dead-lettered on
> 2026-07-23 and nothing noticed for four days. **A scheduled job that stops is
> invisible.**

Both April artifacts are queryable in the current corpus: `OB Dreaming Spec`
(2026-04-06) and `SOP: OB Dream Cycle` (2026-04-09) —
`select content from thoughts where content like 'SOP: OB Dream Cycle%'`.

---

# Stage 1 — LIGHT (#390)

*DREAM-1: always-on, model-free, runs in the write path (not a scheduled job).*

## Trigger

**None.** Verbatim:

> Light is **not a scheduled job**. It runs **in the write path**, in the same
> transaction as the raw turn insert.

## What runs it

The raw-turn insert path itself. No scheduler, no queue, no worker.

## Model

**None. Hard requirement.**

> These fields arrive **with** the turn. If light needed a model to infer what
> capture already told it, the capture would be broken and that is the bug to fix
> instead.

Consequences, verbatim:

> - cannot fall behind ingest
> - cannot compete for the ~3 GB budget on core01
> - cannot fail in an interesting way

## Budget / caps

> A few column assignments plus a hash, and one indexed lookup for occurrence
> counting. Microseconds on a write that is already hitting disk and already paid
> for a network round-trip. Not measurable.

Scaling limit, verbatim:

> **On the scaling limit:** if ingest volume ever gets high enough that tagging in
> the write path is a real cost, that is a hardware conversation, not a design
> one. Rico framing — reaching that point means core01 has been replaced by
> something much larger. Do not pre-optimize light into a queue for a load that
> does not exist.

## What it reads

The turn being written. Plus one indexed lookup for occurrence counting.

## What it writes

Records only what is already known at write time, verbatim:

> - user, project, source, runtime, session_ref
> - timestamp, turn_index, role
> - token count, content length
> - exact-hash dedupe
> - **occurrence counting**

**Plus the R3 authority tier.** Per `code-brain-design.md` §R3 and the
`dream-ethereal-runs.md` note on #390: *"Authority is known at write time from
the source, so it is Light work: no model."* The tag is a provenance lookup at
ingest, not a judgement. The tier vocabulary (`canon` / `decided` / `observed`)
and the precedence rule live in `code-brain-design.md` — do not restate them
here, and do not re-derive them.

## Yield / abort

Not applicable — light is part of the transaction. Verbatim:

> Always-on also removes an entire class of bug: there is no "light is behind"
> state. Either the turn was written with its tags or the turn was not written.

## Why always-on beats a timer (rationale — do not re-litigate)

> An earlier draft had light on a ~10-60 min interval. That was wrong — light does
> no thinking, it tags what the turn already carries. There is nothing to batch,
> so there is no reason to wait.

| Timer version | Always-on |
|---|---|
| turns sit untagged 0-15 min | tagged instantly |
| a job that can fail or lag | cannot lag — part of the write |
| REM can read untagged rows mid-gap | REM always sees complete data |
| needs a scheduler, a backlog counter, a "did light run" check | needs none of it |

> That third row is the load-bearing one. REM (#391) reads what light produced. On
> a timer, REM can catch turns inside the gap and work from incomplete tags.

## The load-bearing part: occurrence counting

> The occurrence count light maintains **is** the corroboration signal that
> promotion (#394) and supersession (#396) depend on. Things that actually
> mattered get said more than once, across sessions. That is evidence the model
> does not generate — it just gets measured.
>
> This is what makes automatic promotion possible without trusting a small model
> self-assessment, which has already been measured as unreliable: 112 of 214
> candidates mislabelled `preference` in the 2026-07-24 run.

Those 214 candidates are the `zz_test_candidate_memory` rows; the type breakdown
and what they reveal about the taxonomy are in `dream-ethereal-runs.md`.

## Correction: light does NOT own the REM backlog counter

> An earlier draft had light maintaining a backlog counter for REM high-water-mark
> trigger. With light always-on there is no light-backlog to count.
>
> What REM actually watches is **undistilled turns** — a
> `WHERE distilled_at IS NULL` count, which the existing partial index already
> serves. Simpler, and one less piece of state to keep correct.

Confirmed in the tree: `ob_raw_turns.distilled_at` exists with the comment
*"NULL `distilled_at` is the sweep work queue"* (`src/db/migrations/032_raw_turns.sql:137-138`).

## Acceptance criteria (#390, verbatim)

> - Zero model calls in the light path.
> - A turn is fully tagged in the same transaction that inserts it; no window
>   exists where an untagged raw turn is visible to REM.
> - Occurrence counts increase for repeated content across distinct sessions.
> - Write-path latency impact is measured and negligible (see #397 load test).
> - No light scheduler, no light backlog counter, no light-ran health check
>   exists anywhere in the codebase.

---

# Stage 2 — REM

REM is covered by five issues: the trigger/scheduler (#391), re-warming (#392),
drift detection (#393), contradiction pairing (#396, pairing half), and
near-dupe merge (#398).

> REM is a **prep stage**, not medium-depth analysis. It finds, groups, and
> packages work so deep does not have to go looking — doing the easy 90% itself
> and handing deep only the hard 10%, pre-bundled. It deliberately
> **over-prescribes** at first: better a too-big bundle than a clean one missing
> the key item, because deep can ignore extra context but cannot recover what was
> never sent. (#389)

## 2a. Trigger and scheduler (#391)

*DREAM-2: rate-based, low high-water mark, bounded forced slice.*
Depends on #390.

### Trigger

> REM starts when **either**:
>
> 1. request RATE is low, **or**
> 2. light backlog (#390) passes a deliberately LOW high-water mark
>
> ...**and** memory headroom exists. 6h ceiling as a starvation guard, **not** a
> cadence.

Per the #390 correction, "light backlog" means the `WHERE distilled_at IS NULL`
count on `ob_raw_turns`, not a counter light maintains.

### Idle means rate, not silence

> A box serving Open Brain is never at zero. "No requests at all" never happens
> and is a useless gate. A steady trickle of small writes is a sleeping box —
> Rico framing: 50 bpm, working so little it could be asleep.

### The idle signal

> Use Open Brain own last-MCP-request time plus memory headroom.
>
> **CPU idle and GPU utilization are wrong signals on Apple Silicon.** Unified
> memory means the model competes with Postgres for the same pool: a box can be
> 90% CPU-idle with no room to load a 4B model without evicting Postgres cache.

| Signal | Verdict |
|---|---|
| MCP request rate | best — direct measure of "am I needed" |
| Memory headroom | required — the actual constraint |
| Load average | weak, lags |
| CPU % / GPU % | misleading here |

### Where

core01, local model. See #397 for the residency decision (resident vs
load-on-demand) — **unresolved, decide on measurement.**

### Budget / caps: forced runs must be a sip, not a meal

> When the 6h ceiling fires, REM does **one bounded slice** — never catch-up. Five
> sessions and six hours of backlog followed by an unbounded forced run is a
> thundering herd against live serving.
>
> Keeping the high-water mark **low** is the real fix: REM fires often in small
> bites, so no backlog ever accumulates and the herd case does not arise. Small
> and frequent beats large and rare on a constrained box.

### Under load, choosier not busier

> Backlog changes *what* REM picks, not *how much* it does. Under pressure it
> does only cheap high-value work — tier re-warming, occurrence counting, hash
> dedupe — and defers grouping, connecting, and packaging until real idle.

### Yield / abort

> REM must yield when a request lands. Its work is already chunked into jobs, so
> it can stop between them and resume later.
>
> This is what makes an aggressive trigger safe: **the failure mode of being too
> eager is milliseconds; the failure mode of being too shy is the backlog.** Bias
> eager.

### Thresholds are unknown — a hard warning (#389 and #391, both)

> The ~2 turns/min figure from earlier analysis is the **import rate of a 2-day
> file scrape**, not core01 load. It must not be used to tune triggers. Set the
> dials low, measure under real full-send, adjust. They are config, not design.

**Dials:** forced-slice size, backlog high-water mark, rate threshold, headroom
floor. Real values come from #397.

### Acceptance criteria (#391, verbatim)

> - REM fires under low-rate conditions with live traffic present.
> - REM fires on backlog even under sustained load.
> - A forced ceiling run is bounded and measurable.
> - REM yields within one job of a request arriving.

---

## 2b. Re-warming (#392)

*DREAM-3: sustained re-engagement pulls a dormant project cluster back toward hot.*

### Problem

> Tier movement is currently one-way. Cold is a grave.
>
> Everything in the lifecycle is about things fading; nothing brings them back.
> Rico case: returning to a project untouched for 3 months. With the lifecycle
> running, that project decisions would be in Open Brain, correct and complete —
> and would stay cold while he re-derives decisions already made.

### The unit is the PROJECT, not the entry

> **The unit is the PROJECT, not the entry.** A single search hit warming a
> single row is noise — a stray match should not wake a project. Waking one entry
> and leaving its siblings cold is worse than useless: you get a fragment without
> its context.

| Sessions on a dormant project | Behaviour |
|---|---|
| 1 | notice, no action |
| 2-3 | begin warming related cold entries |
| 5-10 | project cluster restored to hot |

### Why REM owns this

> Light cannot — one session is not a pattern. Deep is too slow — you would be
> three days in before it noticed. REM idle-triggered cadence is the right grain:
> enough sessions to see a trend, fast enough to help while the work is live.

### Model / cost

**No model.** Both directions are a tier flip.

| Direction | Speed |
|---|---|
| cold → hot | fast, on contact |
| hot → cold | slow, on silence |

> Fast to remember, slow to forget — which is how people actually work.
>
> Both directions are **just a tier flip**: no model, cheap, reversible. That is
> what licenses aggression here. A wrong guess costs a tier update and drifts
> cold again on its own.
>
> This also mirrors the childhood-skill property: it comes back **faster than it
> was learned**. Re-warming should not cost what original promotion cost — the
> entries are already durable, already embedded, already connected.

This is the reversibility axis in action: cheap-to-undo, therefore autonomous.

### Recency source — hard constraint (#396)

Re-warming judgments use `occurred_at`, **never** `created_at`. See
[the hard constraint](#recency-is-the-wrong-default--two-distinct-reasons) below.

### Open sub-problem — do not invent an answer

> Defining "related" for entries **not** tagged to the project. Same-project is
> easy — that is metadata light already has (#390). The valuable case is the
> decision that was never tagged to that project and still matters.
>
> Candidates: embedding similarity, and `ob_entities` (currently 23 rows, barely
> used) which is the structure meant for exactly this.

### Acceptance criteria (#392, verbatim)

> - Re-engaging a dormant project across N sessions promotes its cluster, not a
>   single matched row.
> - An untouched project does not warm from one incidental search hit.
> - Re-warming performs no model calls.

---

## 2c. Cross-session drift detection (#393)

*DREAM-4: compare what is happening against what was decided.*

> ⚠️ **Superseded in mechanism, not in intent.** `code-brain-design.md` §5 records
> a Rico correction: *"The first draft of drift detection (#393) was a REM-time
> semantic comparison needing a model. Rico's version needs **no model at all** —
> two counters and a date — and catches drift earlier."* Build the counter
> version. #393's problem statement below is still the reason the job exists.

### Problem

> Over roughly two weeks, 50-500 mostly-autonomous sessions each made locally
> reasonable calls whose cumulative vector walked Open Brain away from an earlier,
> better design — toward the state diagnosed on 2026-07-24.
>
> **No single session did it, and no single session could see it.** Each started
> fresh, read current code as ground truth, and inherited the previous session
> drift as the baseline. That is not agents being wrong; it is having **no memory
> of direction, only of state**.

### Why session start/wrap cannot catch this

> Session wrap sees **one session endpoints**. A trend needs many sessions side
> by side.
>
> Worse: wrap writes the agent own summary of its own session. A drifted agent
> does not know it drifted, so its wrap reads as a clean, coherent day of work.
> **Do that 200 times and you get 200 clean summaries describing a curve nobody
> sees.**
>
> Rico framing: session start and wrap are the start and stop of a 100m dash when
> the thing being run is a marathon.

### The missing layer

| Layer | Sees | Exists |
|---|---|---|
| Session wrap | one session | yes |
| **Cross-session trajectory** | **N sessions vs. what was decided** | **no** |
| Durable memory | conclusions | yes |

### Scope

> A REM job that compares *what is happening* across recent sessions against
> *what was decided*, and flags the gap.
>
> This is not a summarizer. It needs a reference point: the design as agreed —
> which is exactly what durable decisions should hold.

The reference point is R3 **canon** (`code-brain-design.md` §R3). Sustained
observed contradiction of canon is, per that document, *"the highest-value alert
available."*

### The circular dependency worth naming

> Without durable decisions there is nothing to drift *from*. The drift was
> undetectable partly because the baseline was never stored. So this issue
> depends on the capture and promotion path actually running (#380, #382, #389).

### Related signal already available

> qmd (#386, #387) indexes what was **built**. Durable decisions record what was
> **intended**. "We decided X" + "the code says Y" = drift, detectable. Neither
> source alone is sufficient.
>
> Note that 9,017 `ob_session_events` rows carrying 15.2M chars already existed
> and were never read as a body — the data to see the drift was in the table, and
> nothing had the job of reading across it.

> ℹ️ **Count moved, point stands.** `ob_session_events` measured **9,462** rows on
> 2026-07-27. Still nothing reads across them.

### Alarm shape (from `code-brain-design.md` §5)

> **Alarm on 2–3 diverging sessions, not a volume threshold.** Volume thresholds
> take weeks, and weeks is exactly how the drift happened.

### Recency source — hard constraint (#396)

> This matters most for #393: import 50-500 autonomous sessions and order them by
> `created_at`, and the two-week drift arc collapses to a single point. The exact
> signal being looked for would be erased by using the wrong column.

### Acceptance criteria (#393, verbatim)

> - Given a seeded divergence between a recorded decision and current code, the
>   job flags it.
> - Given N sessions consistently moving one direction, the job reports the
>   trend rather than the individual sessions.

---

## 2d. Semantic near-dupe merge (#398)

*DREAM-9: reinforcement history table, NOT arithmetic on confidence.*
Related: #390, #394, #396. **Runs in REM.**

### Problem

> Candidate dedupe is **exact-match only** — the unique index on
> `(namespace, content_hash)` catches identical strings and nothing else.
>
> Measured 2026-07-24 over a 20-batch run: **307 emitted → 214 stored.** Dedupe
> fires (93 caught, ~30% exact overlap), but paraphrases pass straight through:
>
> - `"the delta is 5 rows"`
> - `"the real local-only delta is 5 rows, not 128"`
>
> Same fact, different hash, **both stored**.
>
> Across a ~12,946-file backfill the same decision is restated in dozens of
> sessions. Fifty rows for one fact, none of them looking well-established,
> defeats the mechanism #394 and #396 depend on.

### Confidence and reinforcement are DIFFERENT THINGS

> An earlier draft of this issue proposed adding +0.2 to a candidate confidence
> score per duplicate. **That was wrong** — it conflates two independent
> properties:

| Property | Question it answers |
|---|---|
| **confidence** | is this claim true / durable? |
| **reinforcement** | how well-established is it? |

> A claim extracted once with high certainty can be 0.7 confidence and barely
> established. A claim extracted twenty times can be 0.5 confidence per
> extraction and heavily established. **One number cannot hold both**, and
> arithmetic that turns a 0.7 into a 0.9 because something was repeated is
> silently changing a truth estimate using an evidence signal.

Corroborated independently in `code-brain-design.md` §6: gbrain salience is
`emotional_weight × 5 + ln(1 + take_count)` — reinforcement as a separate,
log-damped axis, *"already shipped and tested elsewhere."*

### Design: the history table IS the reinforcement

> A duplicate does not survive as its own row, and it does not modify the
> original confidence. It writes one row to a reinforcement history table.
>
> **Counting those rows is how reinforcement is measured. Nothing is added to
> anything.**

#### Reinforcement history table

> One row per merge. No content — the text is the redundant part.

| Column | Purpose |
|---|---|
| candidate_id | what was reinforced |
| dup_content_hash | which restatement |
| dup_occurred_at | when it was said |
| dup_source_turn_ids | which session said it |
| similarity | how close the match was |
| model | which extractor produced it |
| created_at | when the merge happened |

> ~100 bytes per row. Small, tangible, and it is the thing that does the
> reinforcing.

#### On the candidate row

| Field | On merge |
|---|---|
| confidence | **unchanged** |
| last-said timestamp | **advance to the duplicate `occurred_at`** |
| first-said timestamp | **unchanged** |
| content | unchanged; duplicate text discarded |
| `source_refs` | **do not append** — refs go to the history table |

> That last point corrects a second flaw in the earlier draft: merging refs inline
> grows `source_refs` unboundedly on a hot item. The history table keeps the
> candidate row small while the trail lives beside it.

#### Why both timestamps

> A fact restated today is current, and recency ranking should say so. But per
> #396 the **span** between first-said and last-said is itself evidence: "held for
> three months across twenty restatements" is what defends an old claim against a
> bare new one. Overwriting first-said would erase that.
>
> Recency ranking reads last-said. Support reads the span plus the row count.

Consistent with `code-brain-design.md` §R2: *"Reinforcement bumps `last_seen_at`.
**Never** `occurred_at`, and it can never resurrect an expired row."*

### Threshold: 0.09 distance (0.91 similarity) — SETTLED

> `DEFAULT_DUP_THRESHOLD = 0.08` (cosine **distance**, i.e. 0.92 similarity) was
> tuned for lane-event-to-durable comparison.
>
> Rico standing rule from LiteLLM semantic caching: **0.91 similarity**. Same
> question in a different domain — "is this close enough to treat as the same
> thing" — and two independent arrivals at 0.91/0.92 is good evidence for the
> neighbourhood.
>
> Use **0.09 distance** for candidate-to-candidate. Not an open fitting problem.
>
> Risk direction: too loose merges genuinely distinct facts, too tight leaves
> dupes. With the history table the loose case is now recoverable, but **slightly
> too tight remains the safer default.**

Confirmed in the tree: `export const DEFAULT_DUP_THRESHOLD = 0.08;`
(`src/tiering.ts:33`). The candidate-to-candidate path needs **0.09**, a
different value for a different comparison — do not change the existing constant.

### Indexing — what makes it almost free (#398 comment, 2026-07-25)

> Reinforcement count must never be denormalized onto the candidate row or cached.
> With the right indexes it is an index-only scan.

```sql
-- Primary access path: count/list reinforcements for one candidate.
-- Covering: candidate_id + occurred_at means the count and the span come from
-- the index without touching the heap.
CREATE INDEX idx_reinforce_candidate
  ON <reinforce_table> (candidate_id, dup_occurred_at DESC);

-- Idempotency: the same restatement must not reinforce twice if a batch is
-- reprocessed. This is the guard, not application logic.
CREATE UNIQUE INDEX idx_reinforce_dedupe
  ON <reinforce_table> (candidate_id, dup_content_hash);

-- Reverse lookup: "which candidate absorbed this hash", for unmerge and audit.
CREATE INDEX idx_reinforce_hash
  ON <reinforce_table> (namespace, dup_content_hash);
```

```sql
-- Recency ranking reads last-said.
CREATE INDEX idx_candidate_last_said
  ON <candidate_table> (namespace, last_said_at DESC);

-- Unreviewed queue for the #394 nightly page.
CREATE INDEX idx_candidate_unreviewed
  ON <candidate_table> (namespace, confidence DESC)
  WHERE reviewed_at IS NULL;
```

> ### Why this matters for #394
>
> The commit decision reads confidence **and** reinforcement count together. If
> the count required a heap scan per candidate, the nightly pass would degrade as
> the corpus grows and the temptation would be to cache it — which reintroduces
> the staleness class of bug this whole epic exists to remove.
>
> `(candidate_id, dup_occurred_at)` gives count, first, and last from one index
> scan. Cheap enough to compute every time, so it is never wrong.
>
> ### Note on the unique index
>
> `(candidate_id, dup_content_hash)` doubles as correctness, not just speed:
> reprocessing a batch after a resize or retry must not inflate reinforcement.
> `ON CONFLICT DO NOTHING` against that index makes re-runs idempotent, matching
> the pattern already used for `(namespace, session_ref, content_hash)` on raw
> turns.

### What this fixes downstream (verbatim)

> - **#394** commit decision reads **both** confidence and reinforcement count. A
>   0.3-confidence claim said fifteen times over three months is more trustworthy
>   than a 0.7 said once — now expressible instead of collapsed.
> - **#396** "accumulated support" stops being vague and becomes countable: how
>   many reinforcement rows, spanning what period, from how many distinct
>   sessions.
> - **Receipts on recall** (a standing Rico want, borrowed from gbrain): weight
>   0.7 becomes "0.3 baseline, reinforced three times across sessions on Jun 12,
>   Jul 3, Jul 19" instead of an unexplained number.
> - **Reversibility.** If the threshold proves too loose and distinct facts were
>   merged, the history holds the hashes and refs — the merge can be undone.
>   Without it, a bad merge is permanent.
> - **Threshold validation.** The trail is what makes it possible to audit whether
>   0.09 was the right cut, rather than only seeing the result.
> - **No clamping problem.** Nothing overflows; there are just fifteen rows.

### The machinery already exists

> `findDurableDuplicate` in `src/tiering.ts` — embedding-based semantic duplicate
> detection, exported and tested, reachable only via the `tier-lane` MCP tool.
>
> Same pattern as every other lifecycle gap: built, correct, never called on its
> own. This issue points it at the candidate pool.

### Where it runs

> REM (#391) — semantic comparison needs embeddings and is not free, so it cannot
> live in light (#390), which is model-free by design.

### Acceptance criteria (#398, verbatim)

> - Two paraphrases collapse to one candidate plus one reinforcement row;
>   confidence is unchanged, last-said advanced, first-said preserved.
> - Two genuinely distinct facts above 0.09 distance stay separate.
> - An item restated many times has many reinforcement rows and an unchanged
>   confidence value.
> - A merge can be reversed from the history table alone.
> - Re-running distillation over overlapping batches adds reinforcement rows
>   instead of candidate rows.

---

# Stage 3 — DEEP (#394)

*DREAM-5: off-box, consumes REM bundles, band-based commit with a nightly review page.*
Depends on #391.

## Trigger

Nightly.

## Where — and why placement is the design

> The nightly heavy pass. **Runs off-box** (Sol/Opus), not on core01.
>
> That placement is the point: deep is the only stage needing a large model, and
> moving it off-box removes the local resource-contention problem entirely rather
> than tuning around it. core01 ~3 GB budget is then spoken for only by REM.

## Input: pre-packaged work, not raw candidates

> Deep opens a queue of bundles prepared by REM (#391) — grouped, deduped,
> contradiction-paired, sized. It does **not** go looking.
>
> The cost consequence is the reason for the whole three-stage split: the
> expensive model only sees what the small model could not handle. For
> comparison, gbrain single-pass extraction over ~28k pages cost $361 with the
> big model reading everything.

## Output: deep commits, it is not advisory

| Confidence | Action |
|---|---|
| > 0.5 | **commit silently** |
| 0.2 – 0.5 | **nightly human-in-the-loop ranking page** |
| < 0.2 | drop |

> Only the uncertain band costs Rico attention. Everything else is automatic.
>
> Rico ranking picks become **reference data** — the feedback loop that tunes the
> threshold. This is the eval Open Brain has never had: nothing currently measures
> whether a promotion decision improved recall.

**The bands govern what ENTERS the corpus.** They do not govern destructive
action on existing memory — that is the reversibility axis above.

**The bands do not override R3.** Authority precedence (`code-brain-design.md`
§R3) is a hard stop before scoring: a session finding can never outrank canon
regardless of confidence or repetition. Confidence bands decide within a tier,
not across tiers.

## A/B to run, not a foregone conclusion

| Mode | Rule | Risk |
|---|---|---|
| A — review page | commit >0.5, review 0.2-0.5 | Rico is the bottleneck |
| B — permissive | commit >0.2, drop below | weak items enter the corpus |

> B is defensible because **stored is not the same as ranked**: a 0.3-weight
> memory sits at the bottom of results — quiet, not wrong. If B recall matches A,
> the review page is ceremony and should be dropped.

## The load-bearing dependency: confidence must be measured

> Confidence must be **measured, not claimed**. Thresholds on a self-reported
> number are theatre: the local 4B has already been measured mislabelling 112 of
> 214 candidates as `preference`.
>
> The number must come from corroboration — occurrence counts from light (#390),
> source, and repetition across independent extractions. Things that actually
> mattered get said more than once.

> **Known hole:** corroboration cannot promote a genuine one-off — a decision
> made once and never restated. Some of the most important entries are exactly
> that. A companion rule is needed and is not yet designed.

That hole is **open**. Do not invent a rule for it during implementation; see
[Known open questions](#known-open-questions).

## Attention budget is the real constraint

> The metric to watch is not REM cost but **how many items land on the nightly
> page**. Roughly: 20 is reviewable, 200 gets skipped. REM over-prescription
> (#391) is what fills it, and Rico rankings are what eventually tune it down.

## Borrowed from gbrain (#394, verbatim)

> - **Weight, not keep/drop** — every claim carries 0.0-1.0 confidence; weak
>   material is stored weakly and ranks lower rather than being discarded.
> - **Holder attribution** — who believes it, distinct from who it is about.
>   gbrain #1 extraction error was confusing the two. Relevant here given Hermes
>   agent logs and multi-agent corpora.
> - Their `hot facts → [dream consolidate] → cold takes` bridge is the same
>   one-way nightly promotion shape.

Attribution obligations: `docs/prior-art/ATTRIBUTION.md`.

## Acceptance criteria (#394, verbatim)

> - Deep runs off-box and consumes REM bundles without reading raw candidates.
> - Items above the commit band appear in durable tables with provenance.
> - Items in the review band appear on the nightly page and nowhere else.
> - A/B harness can run both modes and compare recall.

---

# Supersession (#396) — pairing in REM, resolution in Deep

*DREAM-7: pair contradictions in REM, resolve by accumulated support not recency.*
Related: #393.

## Problem

> Open Brain accumulates contradictions with nothing linking them, so recall
> surfaces whichever embeds closer to the query — a coin flip between right and
> wrong.
>
> **Proof case from 2026-07-24:** a delta-merge design was captured to Open Brain
> before verification and was wrong (timestamp cutoff as a cross-database delta
> boundary; set-difference on UUID later proved 124 of 129 selected rows already
> existed on the target). It was hand-corrected. Distillation as currently built
> would extract **both** the wrong design and its correction as separate
> candidates, unlinked.
>
> `thoughts` already has `consolidated_into` and `consolidated_from`, built for
> exactly this. Both unused.

Those two columns come from migration `006_cognitive_tiering.sql`; the design
that explains them (Phase 4 consolidate, with its explicit un-merge rollback
path) is in `decisions/cognitive-tiering-dream-cycle.md`.

## What is missing

| Needed | State |
|---|---|
| detect that two claims conflict | nothing |
| decide which wins | nothing |
| link old → new | **columns exist, unused** |
| hide superseded from recall | nothing |

## Recency is the wrong default — two distinct reasons

### 1. Backfill has no meaningful recency

> Loading months or years of transcripts in one pass gives every row the same
> `created_at`. That timestamp records when it was **imported**, not when it was
> **said**. Recency-wins would be actively wrong for the entire base corpus.
>
> **Verified 2026-07-24:** source JSONL carries real timestamps and the importer
> preserves them. `zz_test_raw_turns` shows **100% `occurred_at` coverage** across
> both runtimes (claude 1,439/1,439; codex 4,964/4,964). So the problem is
> avoidable, not inherent — it only appears if a consumer falls back to
> `created_at`.

> **Hard constraint: every recency judgment uses `occurred_at`. `created_at` is
> bookkeeping and must never drive supersession, re-warming (#392), or drift
> detection (#393).**

### 2. A new bad thought is not better than an old correct one

> Rico rule. Newest usually wins in live work, but a considered decision from
> three months ago can outrank a hasty one from yesterday.

## Resolution: accumulated support, not timestamp

> An older claim defends itself with evidence:

| Signal | Meaning | Source |
|---|---|---|
| occurrence count | it kept being true | light (#390), free |
| reasoning attached | someone thought about it | `rationale` present vs. bare claim |
| survived prior contradictions | already tested | supersession history |
| acted on / referenced | it worked | access count |
| `occurred_at` span | said over months vs. once | raw turns |
| source tier | Rico words vs. agent inference | provenance |

> A new claim with none of these is **one utterance**. It should not beat a
> position reinforced twenty times over three months.
>
> **The rule is not newest-wins or oldest-wins: new must outweigh accumulated
> support, and a bare assertion carries almost no weight against a well-supported
> one.**
>
> Note this reuses the corroboration count from #390 — the same signal serves
> promotion evidence *and* supersession defense.

The `source tier` row is R3 (`code-brain-design.md` §R3) as a supersession
signal. Note the interaction: R3 precedence is a **hard stop**, not one signal
among six. A session finding contradicting canon is flagged, never auto-resolved,
regardless of how the other five signals score.

## Where the work runs

> - **Pairing** — REM (#391 already lists contradiction pairing). Cheap, local.
> - **Resolution** — deep (#394). It is a judgment and it is irreversible.

## Default to not-superseding

> Rico framing: the past often has reasoning nobody wrote down — the "ask an old
> man or lady why it was done that way" case, except the agent cannot ask. The
> tacit judgment behind a claim is not in the record.
>
> Therefore, when close:

| Case | Action |
|---|---|
| new claim strong, old claim weak | supersede |
| new contradicts well-supported old | **review page (#394)** |
| both weak | keep both, flag |
| **backfill-era conflicts** | **never auto-resolve** |

> A wrongly-kept contradiction is recoverable. A wrongly-erased position is gone
> — and if its reasoning was tacit, permanently.

## Weights are deliberately unspecified

> The **signals** above are design and are settled. The **weights** are a fitting
> problem, not a design problem: any numbers chosen now would be invented.
>
> They get fitted against Rico rankings from the #394 review page. Sequence:
> build with signals and guardrails → collect ~50 ranked contradictions → fit
> weights to reproduce those judgments.

**Do not invent weights during implementation.** Ship the signals and the
guardrails; the weights arrive from ranked data.

## Borrowed from gbrain

> `docs/contradictions.md`: sample retrieval results, LLM judge on pair
> contradiction, severity rubric (low = naming/format, medium = stale factual
> values, high = identity/structural), operator decides what to act on. They also
> **measure** contradiction rate rather than assuming it — worth copying, since
> "how often do unmarked contradictions actually surface in retrieval" is
> currently unknown here too.

## Acceptance criteria (#396, verbatim)

> - A seeded contradicting pair is linked via `consolidated_into` /
>   `consolidated_from`.
> - A well-supported old claim contradicted by a bare new one goes to review, not
>   auto-supersede.
> - Two claims whose `occurred_at` predates the ingest run never auto-resolve.
> - Superseded entries stop surfacing in recall; the surviving entry carries
>   provenance to what it replaced.

---

# Discard drain (#395)

*DREAM-6: weekly discard drain — give `discarded_entries` a writer.*

## Problem — ✅ still true as of 2026-07-27

> `discarded_entries` exists in the schema, has the right columns
> (`original_content`, `original_id`, `source_table`, `tier_at_discard`,
> `access_summary`, `discarded_at`), and contains **0 rows**.
>
> Grep for it across `src/` and `scripts/` returns exactly one reference:
> `scripts/backup-lib.ts`. The table is backed up faithfully and has been empty
> since creation. Nothing has ever written to it.
>
> This is the clearest single instance of the pattern this epic exists to fix:
> the system carefully preserves a table that no code path fills.

The as-designed column list and the 90-day `expires_at` window are in
`decisions/cognitive-tiering-dream-cycle.md` (Phases 5 and 6). Note the two
column lists differ (`access_summary` vs `access_history`, plus `reason` /
`expires_at` / `consolidated_into` in the older design) — reconcile against the
live schema before writing, not against either document.

## Trigger

Weekly. Rico framing: the *"once a week ballpin hammer to the head"* session.

## Scope

> - Weekly job identifying entries that have aged out without ever being used.
> - Write to `discarded_entries` with `tier_at_discard` and `access_summary`
>   intact, so the discard is a **record**, not a deletion.
> - Raw turns that never distilled into anything keepable within ~1 week are the
>   primary input (per the resolved retention design: candidates get embeddings,
>   raw turns get FTS only and a conditional TTL).

## Conditional, not purely time-based

> The expiry rule is "has not been used to distill into something keepable",
> **not** "is older than N days". A turn whose candidate was promoted has done
> its job. A turn that produced nothing in a week probably never will.

## Eviction, not destruction — deferred

> Optional follow-on discussed but not scoped here: index-then-archive to
> compressed cold storage on the NAS, keeping a queryable stub row in Postgres
> (id, session_ref, date, content_hash, archive filename, offset) so existence
> questions never leave the box while bodies live off it.
>
> Deferred deliberately — the immediate problem is that the table is empty, not
> that it will be too full.

`code-brain-design.md` §4 carries the same principle: *"The index of what is in
cold stays in the database. Only content leaves."* It also sets the cold tier at
**~6 months**, not a week, because *"a week is shorter than the phenomenon being
caught."* These are different tiers — the ~1 week TTL here is for **undistilled
raw turns**; the ~6 months is for **live entries going cold**. Do not collapse
them.

## Storage context (measured, corrects an earlier assumption)

> `zz_test_raw_turns` measured 8,816 kB for 2 days / 6,403 turns → ~1.6 GB/year
> against 1.4 TB free. Raw dialogue is **not** a disk-exhaustion path, which was
> the premise of #381 and is wrong. With a ~1 week TTL steady state is ~30 MB and
> no embeddings.
>
> The real risk is **distillation falling behind ingest** — turns expiring before
> being distilled. The metric that matters is *oldest undistilled turn age vs.
> TTL*, not backlog bytes. #381 should be rewritten around that.

## Acceptance criteria (#395, verbatim)

> - `discarded_entries` is non-empty after a drain cycle.
> - A turn that produced a promoted candidate is not discarded.
> - A turn older than the TTL with no candidate is discarded with tier and access
>   history preserved.

---

# Proving it under load (#397)

*DREAM-8: all measurements so far are idle-box only.* Covers #390, #391, #394.

## Problem

> Every performance number measured for distillation was taken on an **idle box
> with zero Open Brain traffic**:

| Measured | Value | Conditions |
|---|---|---|
| Generation throughput | ~50 tok/s | idle |
| Avg job time | 13.0 s | idle |
| Model cold load | ~1.8 s | idle |
| Batch outcome (20 jobs) | 20 ok, 8 resized, 8 truncated, 0 dead-letter | idle |

> core01 is a base 16 GB Mac Mini with roughly 3 GB free, and that budget is
> already spoken for once by the generation model. It simultaneously serves Open
> Brain, the local MLX embedding server (`embeddinggemma-300m-8bit`, ~300 MB
> resident), Postgres and its cache, and on-demand paperless-ngx AI processing.
>
> **Nothing has been tested under contention.** The design assumes the stages
> coexist with live serving; that assumption is unproven.

## What the design already removed

> This issue is deliberately scoped to the *residual* risk. Three of the four
> original contention concerns are resolved by design, not by measurement:

| Original concern | Resolved by |
|---|---|
| Big model needs local memory | **#394** — deep runs off-box entirely |
| Distillation runs mid-session | **#391** — REM is idle/rate-triggered and yields on request |
| Light adds constant load | **#390** — no model, SQL only |
| Backlog forces a large catch-up run | **#391** — bounded slice, low high-water mark |

> The stage that needs the big model no longer runs on core01, and the stage that
> does only runs when there is room. What remains is proving it.

## 1. Concurrent-load test

> Run REM distillation while Open Brain serves realistic traffic. Measure:
>
> - OB p50/p95 request latency with REM idle vs REM working
> - REM throughput degradation under traffic
> - Postgres cache hit ratio before/during/after a REM run
> - memory pressure / swap events
> - whether the yield-on-request path (#391) actually fires and how fast
>
> **Pass condition:** OB serving latency is not materially degraded while REM
> works, and REM yields within one job of a request arriving.

## 2. Idle signal implementation and validation

> #391 specifies *what* the signal should be — last-MCP-request time plus memory
> headroom — but nothing implements it, and there is no memory-headroom check
> anywhere in the codebase today.
>
> Validate specifically that CPU-based idle detection is rejected: on Apple
> Silicon unified memory, a box can be 90% CPU-idle with no room to load a 4B
> model without evicting Postgres cache. The test should demonstrate this rather
> than assert it.

## 3. Model residency decision — OPEN, decide on evidence

| Strategy | Cost | Benefit |
|---|---|---|
| Resident | ~2 GB held continuously | no cold-start latency |
| Load-on-demand | ~1.8 s per run | memory free between runs |

> At a ~25 min REM interval, 1.8 s of cold start per run is negligible, which
> argues for load-on-demand — but that is reasoning, not evidence. Measure both
> under load and pick.

## 4. Establish real trigger thresholds

> The ~2 turns/min figure used in earlier discussion is the **import rate of a
> 2-day file scrape, not core01 load** and must not be used for tuning. This test
> is where the real numbers come from: rate threshold, backlog high-water mark,
> forced-slice size, headroom floor.

## Acceptance criteria (#397, verbatim)

> - [ ] Load test harness exists and is repeatable.
> - [ ] OB latency under REM load is measured and within budget.
> - [ ] Yield-on-request is observed, not assumed.
> - [ ] Residency strategy chosen on evidence and recorded.
> - [ ] Trigger thresholds in #391 replaced with measured values.
> - [ ] paperless-ngx on-demand processing is included in at least one contention
>       scenario, since it competes for the same box.

Load testing is distinct from **ethereal runs** (`dream-ethereal-runs.md`), which
is the correctness/iteration methodology: real input, disposable output, one
`dream_run_NNN` schema per run. #397 measures contention; ethereal runs measure
whether the output is any good. Both are required.

---

# Loop supervisor (#399)

*DREAM-10: trip, release, and notify when a dream stage runs away or stops running.*
Related: #388, #397.

## Problem

> Nothing watches whether the memory lifecycle is actually turning. That is how it
> reached the 2026-07-24 state: five dead transitions, one dead-lettered job from
> July, a qmd index 39 days stale — and **no signal for any of it**.
>
> Adding always-on light (#390), idle-triggered REM (#391), and nightly off-box
> deep (#394) adds three things that can silently stop or silently run away.

## Two failure directions, both need catching

### Running away

> If light cannot keep up in the write path, there are two possible causes and
> they are not equally likely:

| Cause | Likelihood |
|---|---|
| Genuinely huge legitimate volume | rare — a hardware conversation |
| **Something is broken** — runaway loop, stuck retry, an agent spamming, a query gone bad | **far more likely** |

> Treating the symptom as "we have made it" is how a runaway sits for a week
> eating the box. Volume that looks like success must still trip an alarm.

### Silently stopping

> The opposite and, on current evidence, the more common failure here:
>
> - REM never fires because the idle signal never evaluates true
> - deep never runs because the off-box call fails
> - distillation stalls and turns age toward TTL expiry (#381)
> - qmd sync stops because its host job was removed (#386 — this already happened)

## What already exists — reuse, do not reinvent

> **Per-job breaker** in `src/maintenance-queue.ts`: `maxAttempts`,
> `backoffBaseMs`, `backoffMaxMs`, `dead_letter`, `dead_lettered_at`. Working.
>
> **Watchdog with recovery** in `src/embedding.ts`:
> `EMBEDDING_WATCHDOG_FAILURE_THRESHOLD` (default 2) →
> `EMBEDDING_WATCHDOG_COOLDOWN_MS` (default 300000) →
> `EMBEDDING_WATCHDOG_RESTART_SCRIPT`.
>
> That is **detect → stop → recover**, complete and in production. It is the right
> shape one level up.
>
> **What is missing:** the notification leg. There is no Discord, webhook, or
> alert path anywhere in `src/`. Both mechanisms above fail **silently** — which is
> exactly how the single `graph.derive` job dead-lettered in July and nobody knew.

Also reusable, per the 2026-07-27 audit: **three scheduling primitives already
exist** — the leased `setInterval` at `src/maintenance-queue.ts:668-676`, the
session sweeper at `src/transport.ts:99-113`, and launchd
`com.rico.open-brain`. The dream scheduler should be built on one of these, not
as a fourth.

## Scope: trip → release → notify

### Trip (stop the bleeding)

> An alert on a runaway loop that keeps looping is a notification delivered 400
> times while the box burns. **Detection must halt the offending stage, not just
> observe it.**
>
> Per-stage circuit breaker, modelled on the embedding watchdog:

| Stage | Trip condition (starting values, tune via #397) |
|---|---|
| light | write-path latency above budget, or ingest rate far above baseline |
| REM | run count per hour above ceiling, or a single run exceeding max duration |
| deep | consecutive off-box failures, or nightly run exceeding max duration |
| any | repeated dead-letters of the same job kind |

> Tripped state must be **persisted**, not in-memory — a restart cannot silently
> clear a breaker and resume the runaway.

### Release

> - Automatic after a cooldown, matching the embedding watchdog pattern.
> - Manual release available to the operator.
> - **Exponential cooldown on repeat trips** — a stage that trips, releases, and
>   immediately re-trips must back off further rather than oscillating.
> - Every trip and release recorded with cause and timestamp.

### Notify

> The genuinely new piece. Requirements:
>
> - Reaches Rico out of band — not a log line nobody reads.
> - **Content-free.** Stage name, condition, counts, timestamps. No memory
>   content, no prompts, no secrets. Same posture as `mcp_tool_audit_log`.
> - **Deduplicated.** One notification per trip, not one per occurrence.
> - Also fires on **silence**: "REM has not run in N hours" is as important as
>   "REM ran 400 times".
>
> `discord-courier` exists as an established comms path in this environment and is
> the obvious candidate, but the transport choice is deliberately left open here.

## Health surface

> Extend `src/operator-doctor.ts` (which #388 already extends for qmd freshness)
> with lifecycle liveness:
>
> - light: write-path p95 latency, turns tagged in last hour
> - REM: last run, runs in last 24h, average duration, current breaker state
> - deep: last run, last success, consecutive failures
> - distillation: oldest undistilled turn age vs TTL (#381)
> - queue: dead-letter count by job kind
> - qmd: index age (#388)
>
> **Doctor answers "is the brain breathing" in one call.** Today there is no way to
> ask that question.

This is the same instinct as `code-brain-design.md` §2's assertion queries
(*"discards get drained → `discarded_entries` count > 0"*), applied to liveness
rather than closure. **Do not build two of them** — decide whether the doctor
surface and the closure assertions are one mechanism.

## Acceptance criteria (#399, verbatim)

> - A simulated runaway trips its breaker and **stops**, rather than only logging.
> - A tripped breaker survives a process restart.
> - Repeat trips back off exponentially.
> - A stage that stops running produces a silence alert.
> - Notifications are content-free and deduplicated.
> - Doctor reports liveness for all three stages plus queue and qmd.
> - The July 2026 scenario — one job dead-lettered, nothing else running — would
>   have produced an alert within an hour.

---

# What must exist before coding starts

Ordered. Each item blocks the ones under it in its group.

## Blocking — nothing can be built without these

1. **A candidate table with a real migration.** `to_regclass('public.candidate_memory')`
   is **NULL**; `zz_test_candidate_memory` exists with **214 rows** and no
   migration, no SQL, no TypeScript anywhere in the repo. Decide: adopt that
   shape with a real migration, or discard it deliberately. Every stage below
   writes to or reads from this table. See `dream-ethereal-runs.md`.
2. **The R3 authority-tier columns and the write-time provenance lookup.** Light
   tags authority at ingest; Deep's bands operate inside it; #396's `source tier`
   signal reads it. `code-brain-design.md` §R3 is the rule. **The doc itself is
   currently untracked in the working tree** — it exists at commit `a659c4a` and
   was reverted by `39e591e` in the #434 pull-back. Landing it properly is
   outstanding work and is a prerequisite, not a nicety.
3. **A resolved type vocabulary.** `GRADUATE_TYPES` is `fact | decision | handoff`
   (`src/tiering.ts:36`). The distiller's two largest outputs — `preference` (112)
   and `correction` (12) — cannot graduate. Tracked as **#431**. Until this is
   resolved, promotion has no path for most of what the distiller produces.
4. **A consumer of `ob_raw_turns` in `src/`.** There is none. 3,303 turns
   captured, 0 distilled. This is the residual gap the whole epic exists to close
   and it is the single most load-bearing precondition.

## Required before the stage that needs it

5. **`occurred_at` everywhere a recency judgment is made** (#396 hard
   constraint). Verify no consumer falls back to `created_at`. Blocks #392, #393,
   #396, #398.
6. **The `distilled_at IS NULL` backlog query and its partial index**, confirmed
   against the live schema (`src/db/migrations/032_raw_turns.sql:137-138`).
   Blocks #391.
7. **A memory-headroom check.** #397 records that none exists anywhere in the
   codebase today. Blocks #391's trigger.
8. **The reinforcement history table and its five indexes** exactly as specified
   in the #398 comment, including the `UNIQUE (candidate_id, dup_content_hash)`
   idempotency guard. Blocks #398, and #394's commit decision reads its count.
9. **An off-box execution path** for Deep (Sol/Opus) with a bundle queue. Blocks
   #394.
10. **A notification transport.** No Discord, webhook, or alert path exists
    anywhere in `src/`. Blocks #399's notify leg — which is the only genuinely new
    piece of that issue.
11. **The ethereal-run harness** — `dream_run_NNN` schemas, the run manifest
    table, and the restricted Postgres role. Every stage should be developed
    against it, not against the real corpus. See `dream-ethereal-runs.md`.

## Measured, not assumed

12. **Real trigger thresholds from #397.** Rate threshold, backlog high-water
    mark, forced-slice size, headroom floor. **The ~2 turns/min figure is the
    import rate of a 2-day file scrape and must not be used for tuning.**
13. **The model residency decision** (resident vs load-on-demand), chosen on
    evidence and recorded.

---

# Known open questions

Named, not answered. **Do not invent answers to these during implementation** —
if implementation forces a choice, record it as a decision with its reasoning
rather than closing the question silently.

| # | Question | Source |
|---|---|---|
| 1 | **How does a genuine one-off get promoted?** Corroboration cannot promote a decision made once and never restated, and *"some of the most important entries are exactly that. A companion rule is needed and is not yet designed."* | #394 |
| 2 | **What does "related" mean for entries not tagged to the project?** Candidates: embedding similarity, and `ob_entities` (23 rows, barely used). The valuable case is the decision never tagged to that project that still matters. | #392 |
| 3 | **What are the supersession weights?** *"The signals above are design and are settled. The weights are a fitting problem, not a design problem: any numbers chosen now would be invented."* Fit against ~50 Rico-ranked contradictions from the #394 page. | #396 |
| 4 | **A/B outcome: is the review page ceremony?** Mode A (commit >0.5, review 0.2–0.5) vs Mode B (commit >0.2, drop below). Unresolved until recall is compared. | #394 |
| 5 | **Model residency:** resident (~2 GB held) vs load-on-demand (~1.8 s/run). Reasoning favours on-demand; evidence does not exist. | #397 |
| 6 | **Which notification transport?** `discord-courier` is the obvious candidate; *"the transport choice is deliberately left open here."* | #399 |
| 7 | **Does the ethereal candidate table adopt the `zz_test_candidate_memory` shape** as-is or with changes — with `preference` in the type check most in question? And what happens to the ten existing undocumented `zz_test_*` tables: adopt, migrate, or drop? | `dream-ethereal-runs.md`, #382 |
| 8 | **Do ethereal runs share embeddings?** Re-embedding identical content across 100 runs is wasteful; a content-hash-keyed cache outside the run schemas would avoid it. | `dream-ethereal-runs.md` |
| 9 | **Are the doctor liveness surface and the closure assertion queries one mechanism or two?** Both check "did the thing actually happen." | #399, `code-brain-design.md` §2 |
| 10 | **Are assertions stored on the issue body or in a versioned repo checks file?** *"Lean repo-side."* Not decided. | `code-brain-design.md` §2 |
| 11 | **How is the reversibility axis expressed in code?** #389's comment establishes that bands and reversibility are orthogonal and that nothing currently governs destructive action on existing memory. The mechanism is not designed. | #389 comment |
| 12 | **Do the #395 and #12 `discarded_entries` column lists reconcile?** `access_summary` vs `access_history`; `reason` / `expires_at` / `consolidated_into` appear in one design and not the other. | #395, `decisions/cognitive-tiering-dream-cycle.md` |

---

## Standing hazard — carry this forward

From `code-brain-design.md`, verbatim:

> Issues #386–#399 were written by **one agent in one session** — the same shape
> as the drift being diagnosed. Every substantive correction came from Rico:

| Agent had it wrong | Corrected to |
|---|---|
| +0.2 to confidence per duplicate | confidence ≠ reinforcement; separate table, count rows |
| light on a 10–60 min timer | always-on, in the write path |
| recency wins supersession | a new bad thought is not better than an old correct one |
| two temporal columns | four — world-time vs knowledge-time |
| expiry filters in place | expiry **moves** the row |
| REM-time semantic drift detection | two counters and a date |
| "assign an agent to the board" | service work, not agent work |

> Treat the issue list as a proposal to audit, not a plan to execute.

The corrections in that table are already folded into the sections above. The
hazard is that the *uncorrected* parts of #386–#399 carry the same provenance and
have not been through the same scrutiny.

---

## Issue → section map

| Issue | Title | Section |
|---|---|---|
| #389 | Epic: three-stage sleep cycle | Governing principle; The two axes of autonomy; Stale premises |
| #390 | DREAM-1 Light stage | Stage 1 — LIGHT |
| #391 | DREAM-2 REM idle trigger | Stage 2a — Trigger and scheduler |
| #392 | DREAM-3 REM re-warming | Stage 2b — Re-warming |
| #393 | DREAM-4 REM drift detection | Stage 2c — Cross-session drift detection |
| #394 | DREAM-5 Deep stage | Stage 3 — DEEP |
| #395 | DREAM-6 discard drain | Discard drain |
| #396 | DREAM-7 supersession | Supersession |
| #397 | DREAM-8 concurrent load | Proving it under load |
| #398 | DREAM-9 near-dupe merge | Stage 2d — Semantic near-dupe merge |
| #399 | DREAM-10 loop supervisor | Loop supervisor |
