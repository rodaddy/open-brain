# Graphiti — prior art review

**Reviewed:** 2026-07-27
**Headline:** this is the borrow that **worked**. Recorded in as much detail as
the failures, because knowing what a successful borrow looks like is how we
recognise an unsuccessful one.

## Provenance

| | |
|---|---|
| Upstream | `github.com/getzep/graphiti` |
| Clone commit | `3bb2d0b` (2026-07-23) |
| Local path | `/opt/open-brain-local/research/graphiti` |
| License | **Apache-2.0** |
| Code reuse | **No.** Idea only. |

## What they do

`graphiti_core/edges.py:271–282` — an `EntityEdge` carries **four** temporal
fields, not two:

```python
expired_at: datetime | None      # "datetime of when the node was invalidated"
valid_at: datetime | None        # "datetime of when the fact became true"
invalid_at: datetime | None      # "datetime of when the fact stopped being true"
reference_time: datetime | None  # "reference timestamp from the episode that produced this edge"
```

The split is the point:

- `valid_at` / `invalid_at` are **world-time** — when the fact was true out
  there, independent of anyone knowing.
- `expired_at` is **knowledge-time** — when *we* invalidated the record, i.e.
  when we found out.
- `reference_time` ties the claim back to the source episode that produced it,
  rather than to write time.

## Why it is right

A single `updated_at` column silently conflates two different questions. With
the split, "the fact stopped being true on Monday, we learned on Thursday"
is expressible — and **the gap between `invalid_at` and `expired_at` is a
measurable drift metric**. You cannot compute how long you believed a dead fact
if you only stored one timestamp.

`reference_time` separately prevents a backfill from destroying history: if
ordering keys off write time, importing six months of transcripts collapses them
all to the import moment.

## What is bad, or does not fit

**Naming is unintuitive.** `expired_at` sounds like world-time but is
knowledge-time, and `invalid_at` sounds like knowledge-time but is world-time.
Anyone reading the columns without the docstrings will get them backwards. Ours
inherit that hazard.

**Graphiti is a recall system.** It knows a fact stopped being true only when
something tells it — nothing goes and looks. That is not a defect in their
design; it is a scope boundary worth being explicit about, because Open Brain's
conformance ambition (compare declared intent against observed runtime state) is
outside it.

## Ideas we are borrowing

1. **Separate world-time from knowledge-time** — four fields, not two.
2. **The gap between them is a metric**, not an accident.
3. **Tie occurrence to the source episode**, not to write time.

## Shape comparison — does our shape preserve the property?

| Concept | Graphiti | Open Brain (`ob_raw_turns`) |
|---|---|---|
| fact became true | `valid_at` | `valid_at` |
| fact stopped being true | `invalid_at` | `invalid_at` |
| when we found out | `expired_at` | `expired_at` |
| source episode time | `reference_time` | `occurred_at` |
| row write time | (implicit) | `created_at` |

**Verdict: our shape PRESERVES the property.** Verified against the live schema:

```
distilled_at, occurred_at, valid_at, invalid_at, expired_at, created_at
```

All three world/knowledge fields landed with their meanings intact.
`reference_time` was renamed `occurred_at`, which is both clearer and consistent
with the rest of our schema — a rename that keeps semantics is fine; a rename
that quietly changes them is the failure mode.

The borrow is also **tested, not just declared**.
`src/db/migrations/032_raw_turns.test.ts:281–292` measures the drift window
directly, and its comment names the source:

> Bi-temporal, borrowed from Graphiti: world-time vs knowledge-time. The fact
> stopped being true at 12:52; we found out at 12:53. The gap is the drift
> metric, and it is only expressible because both are stored.

**Mutation-proven 2026-07-27**, not taken on trust: with a real Postgres, the
file is 17 pass / 0 fail. Renaming the `invalid_at` column in
`032_raw_turns.sql` drops it to **0 pass / 2 fail**; restoring returns 17 / 0.
The test genuinely depends on the borrowed field.

### Why this one worked, when cognee's did not

Worth naming, because it is the difference this whole directory exists to catch:

1. **The borrow was written down at the borrow site.** A comment in the test
   names Graphiti and states the property.
2. **The property was encoded as an assertion**, not a schema column alone. A
   column can exist and mean nothing; a test that measures the drift window
   cannot pass unless the semantics survive.
3. **The rename was semantic-preserving and deliberate.**

The cognee `PreCompact` borrow failed on exactly point 1: nothing recorded that
their hook reads and ours writes, so nothing flagged that we had built half the
surface.

## Attribution

Idea only, no code. Entered in `ATTRIBUTION.md`. The borrow is additionally
credited in-source at `src/db/migrations/032_raw_turns.test.ts:282`, which is
the practice to repeat.

## Open questions this review did not settle

1. **Half the borrow is live; the half that matters is not.** Measured on the
   dogfood clone, 2026-07-27:

   | field | populated | of |
   |---|---:|---:|
   | `valid_at` | 2736 | 2736 |
   | `occurred_at` | 2736 | 2736 |
   | `invalid_at` | **0** | 2736 |
   | `expired_at` | **0** | 2736 |

   So the write path sets world-start and source time on every row, and has
   **never once** recorded a fact ceasing to be true or the moment we found
   out. The drift metric is expressible and has never been expressed.

   This is not a schema defect — it is the absence of a **retraction path**.
   Nothing in Open Brain currently says "that fact is dead." Which is the same
   shape as every other finding this month: the capability is built and correct,
   and nothing calls it (`discarded_entries` 0 rows, `ob_source_files` 0 rows,
   `graduateLaneEvent` never executed).

   Graphiti populates `invalid_at`/`expired_at` during edge invalidation, when
   a new episode contradicts an existing fact. We have no equivalent trigger.
   Supersession (#396) is where that would live.

   **The borrow is correct and half-dormant.** Worth stating plainly rather
   than filing under "done."
2. Should the confusing upstream names be aliased or documented in
   `docs/GLOSSARY.md`? Inheriting a naming hazard is a choice we can revisit.
