# Dream stages — ethereal runs

**Status:** design, not implemented.
**Written:** 2026-07-27

## The rule

**Real input. Disposable output.**

Dream stages read the real corpus — the actual 9,440 lane events and 3,118 raw
turns produced by real work. They write only into a throwaway schema. Break it,
drop it, change a parameter, run again. Expect 20–100 runs before the shape is
right.

Nothing graduates into `thoughts`, `decisions`, or `discarded_entries` until a
run is good enough to promote deliberately.

## Why

The corpus is the asset. It is real captured work, it took a month to
accumulate, and it cannot be regenerated. Iterating a distiller against it
in-place would corrupt it long before the distiller was correct.

The zero-baselines are the other half. Because nothing has ever run:

| Table | Rows | Property |
|---|---:|---|
| `discarded_entries` | 0 | no writer has ever fired |
| `thoughts WHERE promoted_from ? 'graduated_at'` | 0 | `graduateLaneEvent` has never written |
| `ob_raw_turns.invalid_at` / `.expired_at` | 0 / 3118 | no retraction path has run |

**Any non-zero after a run is attributable to that run**, with no baseline noise
to subtract. That is a rare and perishable measurement property — it survives
exactly until something writes for real. Ethereal runs preserve it indefinitely.

This also removes the idempotency problem. Promotion is not naturally
idempotent, so a first real run would spend the clean baseline whether or not it
was correct. Under ethereal runs it never touches it, so `graduated_at` becomes
a promotion-time concern rather than a precondition for experimenting.

## Shape: schema per run

Each run creates its own Postgres schema:

```
dream_run_001, dream_run_002, ... dream_run_047
```

Same table shapes in each. Every row also carries `run_id`, so cross-run
comparison is a plain join and a stray row can never be mistaken for another
run's.

- **Teardown is one statement:** `DROP SCHEMA dream_run_047 CASCADE`. No
  partial-delete risk.
- **Comparison works:** `dream_run_046.candidates` vs `dream_run_047.candidates`
  diffs directly — which is the point of running it 100 times.
- **Contamination is structurally impossible** rather than avoided by care.

A run manifest table records what produced each run: parameters, model, prompt
version, source row counts, start/end, and a free-text note. A run whose
parameters are unknown is not a data point.

## Prior art in our own database — the `zz_test_*` tables

**This was already prototyped and the work was never written down.** Found
2026-07-27; recorded here so it is not re-derived a third time.

Ten `zz_test_*` tables exist in the dogfood clone, including
`zz_test_candidate_memory`, `zz_test_raw_turns`, and `zz_test_distill_jobs`.
They are defined **only in the database** — `rg` finds no migration, no SQL, no
TypeScript anywhere in the repo.

`zz_test_candidate_memory` holds **214 real distilled candidates**, produced
2026-07-24 by **Qwen3.5-4B-4bit**:

| candidate_type | count | reviewed |
|---|---:|---:|
| preference | 112 | 0 |
| fact | 63 | 0 |
| decision | 27 | 0 |
| correction | 12 | 0 |

This matters twice over: the schema is good and should be carried forward, and
the output is a free measurement of what a 4B model actually does on our real
transcripts.

### The schema is worth keeping

```
id, namespace, candidate_type, content, content_hash,
source_turn_ids uuid[],           -- provenance back to exact turns
distill_job_id, model,            -- attributable to what produced it
promoted_from jsonb, source_refs jsonb,
embedding halfvec(768),
reviewed_at, review_action,       -- promoted | rejected | duplicate
created_at
```

with `UNIQUE (namespace, content_hash)` for dedupe and a partial index on
unreviewed rows. `source_turn_ids` and `model` are the two columns that make a
run auditable after the fact; keep both.

**Decision needed:** adopt this shape as the ethereal candidate table (with a
real migration this time), or discard it deliberately. Leaving it as undocumented
residue is what caused #382 to be specced as if nothing existed.

### What the 214 rows already tell us

Read from a random sample of the actual content:

1. **`preference` is a catch-all.** It is the largest bucket at 112/214, and it
   holds things that are plainly not preferences — an OAuth redirect URI, the
   procedure for adding Cloudflare subdomains, a function call signature,
   Caddyfile template ownership. The classifier reaches for `preference` when it
   is unsure. Either the taxonomy needs tightening or the classifier needs
   constraining; probably both.
2. **The model contradicts itself in a single sentence.** One candidate reads
   *"use model 'gpt-5.6-sol' (not 'gpt-5.6-sol')"* — emitted verbatim, unnoticed.
   4B is undersized for this work, which is what **#383** (local MLX generation
   endpoint sized for core01) exists to address.
3. **The two largest outputs cannot be promoted.** `preference` (112) and
   `correction` (12) are not in `GRADUATE_TYPES`, which is only
   `fact | decision | handoff`. As it stands the distiller's most common product
   has no path anywhere. Reconciling that vocabulary is **#431**.
4. **Zero of 214 were ever reviewed.** `review_action` is unset on every row. The
   prototype produced output and no one ever judged it — which is precisely the
   loop this design exists to close.

This is the same lesson the gbrain review recorded from outside: **94.4% on
clean fixtures, 70.7% on real prose.** Here it is our own model, our own data,
and the failure is not extraction but taxonomy.

## Dogfood-only guard rails

**These are scaffolding, not architecture. They come out when this leaves
dogfood mode or moves to core01.** Stated explicitly so nobody later mistakes
temporary experiment safety for a permanent design property.

A dedicated Postgres role with `SELECT` on real tables and full rights on
`dream_run_*` schemas, used only by dream runs during the experimentation phase.
A stray write to a real table then fails at the database rather than succeeding
quietly. It is cheaper than remembering not to, and it protects the corpus
through 20–100 destructive iterations.

**Removal condition:** when dream stages graduate from experiment to real
behavior — on core01, or when dogfooding ends — runs move into the normal lanes
and this role goes away. The owner's call: *"just for this while we're
dogfooding, it shouldn't be a real thing."*

Deliberately **not** in scope, per the owner: redaction, secret scanning, or
credential handling in the distiller. These are LAN-local, internet-disconnected
services with local-only keys, single operator. Finishing touches for the end,
not design constraints that slow development now.

## What a run looks like

1. Allocate the next `dream_run_NNN` schema; record parameters in the manifest.
2. Read real input — `ob_session_events`, `ob_raw_turns` — read-only.
3. Write stage output into the run schema only.
4. Compare against the previous run. Judge the output; that is the missing step
   the 214 unreviewed candidates prove we skip.
5. Keep or `DROP SCHEMA ... CASCADE`.
6. Promote only when a run is deliberately judged good — and promotion is its own
   decision, made once, not a side effect of experimenting.

## Open questions

1. **Does the ethereal candidate table adopt the `zz_test_candidate_memory`
   shape** as-is, or with changes? (`preference` in the type check is the part
   most in question, given finding 1 above.)
2. **What is "good enough to promote"?** Review is currently a human judging
   sampled rows. Whether that scales past a few runs is unresolved, and it is the
   real bottleneck at 100 runs — not compute.
3. **What happens to the ten existing `zz_test_*` tables?** Adopt, migrate, or
   drop. They are undocumented either way today.
4. **Do runs share embeddings?** Re-embedding identical content across 100 runs
   is wasteful; a shared content-hash-keyed embedding cache outside the run
   schemas would avoid it.

## Relationship to open issues

- **#382 DISTILL-1** — specced to create `candidate_memory` from nothing.
  `to_regclass('public.candidate_memory')` is NULL, but
  `zz_test_candidate_memory` exists with 214 rows. Reconfigure around the
  prototype rather than starting over.
- **#383 DISTILL-2** — the 4B self-contradiction is direct evidence for sizing a
  proper generation endpoint.
- **#431** — `preference` and `correction` are the distiller's two largest
  outputs and neither can graduate.
- **#389 DREAM epic** — the residual gap is 3,118 turns captured, 0 distilled,
  and no consumer of `ob_raw_turns` in `src/`. Ethereal runs are how that
  consumer gets built without risking the corpus.
