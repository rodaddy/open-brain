# gbrain — prior art review

**Reviewed:** 2026-07-27
**Headline:** the most directly comparable system in this set. gbrain has a
**shipped, running dream cycle** — the thing our DREAM epic (#389–#399) is
specifying. It answers questions our epic leaves open, and its answers are
mechanisms rather than policies.

Reviewed at Rico's direction ("another dive into the gbrain and other mem
brains/agents... if we use their idea, but the shape is different, it may
fail"). gbrain was named first and had **never been examined** — 0 references
in the Open Brain corpus before this review.

## Provenance

| | |
|---|---|
| Upstream | `github.com/garrytan/gbrain` |
| Clone commit | `d9eb027` (2026-07-22) |
| Local path | `/Volumes/ThunderBolt/open-brain-local/research/gbrain` |
| License | **MIT** (read from `LICENSE`: "Copyright (c) 2026 Garry Tan") |
| Code reuse | **No.** Idea only. MIT would permit code reuse with attribution; we are not exercising that. |

### A note on evidence quality

gbrain's `README.md` is marketing-shaped — benchmark numbers, "strategic moat",
"install in 30 minutes". Per `docs/prior-art/README.md` ("Marketing is not
evidence"), every claim below is cited to a source file. Two README claims were
checked directly against source and **both held up**, which is worth recording:
the marketing is accurate, it is just not evidence on its own.

The source is unusually well-commented — most findings here come from comments
the authors wrote explaining *why*, not from reverse-engineering. That practice
is itself the most transferable thing in the project.

## What they do

### 1. The dream cycle is real, and it is 22 phases

`src/core/cycle.ts:101+` — `ALL_PHASES`, in pinned execution order:

```
lint, backlinks, sync, synthesize, extract, extract_facts, extract_atoms,
resolve_symbol_edges, patterns, synthesize_concepts,
recompute_emotional_weight, consolidate, propose_takes, grade_takes,
calibration_profile, conversation_facts_backfill, enrich_thin, skillopt,
embed, orphans, purge
```

The README says "6-phase"; the source says 22. The README describes an older,
smaller shape. **Source wins.**

Ordering is not incidental — nearly every phase carries a comment explaining why
it sits where it does. `skillopt` runs late (`cycle.ts:166–176`) so it optimizes
against the freshest state, "strictly fresher than 'right after patterns' since
downstream phases also mutate state the optimizer reads."

The order is **enforced by a test**, not by convention (`cycle.ts:173–175`):

> Position MUST match the dispatch block in runCycle (see line ~1912) — pinned
> by the `report.phases.map(p => p.phase)).toEqual(ALL_PHASES)` assertion in
> `test/core/cycle.serial.test.ts`.

### 2. One-shot and scheduler are separate commands over one primitive

- `src/commands/dream.ts:1–24` — *"gbrain dream — run one brain maintenance
  cycle... Thin alias over runCycle."* Cron-friendly, `--dry-run`,
  `--phase <name>` to run a single phase.
- `src/commands/autopilot.ts:1–18` — *"Self-maintaining brain daemon."*

Their own summary of the split (`dream.ts:22–24`):

> Related: `gbrain autopilot --install` for continuous daemonized maintenance.
> **dream is the one-shot, autopilot is the scheduler.**

Both converge on the same primitive deliberately (`dream.ts:8–11`): *"Both this
command and `gbrain autopilot` converge on the same primitive so there's one
source of truth for what 'overnight maintenance' means."*

`autopilot` is a supervised process, not a loop (`autopilot.ts:5–11`): it spawns
a `gbrain jobs work` child, submits **one** `autopilot-cycle` job per interval
**with an idempotency key so slow cycles don't stack up**, and restarts on crash
with 10s backoff and a 5-crash cap that stops autopilot with a clear error.

### 3. The cycle lock — the most transferable artifact here

`src/core/cycle.ts:30–43`, verbatim:

> **COORDINATION:**
> Postgres: a row in `gbrain_cycle_locks` with a TTL (30 min). Refreshed between
> phases via `yieldBetweenPhases`. **Works through PgBouncer transaction pooling
> (session-scoped `pg_try_advisory_lock` does not).**
>
> PGLite / engine=null: a file lock at `~/.gbrain/cycle.lock` holding the PID +
> mtime. Same 30-min TTL semantics.
>
> **LOCK-SKIP:** Filesystem-only or read-only phase selections (lint, backlinks,
> orphans) skip the lock. Only DB-write phases (sync, extract, embed) trigger
> lock acquisition.

`NEEDS_LOCK_PHASES` (`cycle.ts:272–309`) is an explicit set with a per-entry
comment naming *what that phase writes* — `resolve_symbol_edges` "writes
`code_edges_symbol.edge_metadata` + `content_chunks.edges_backfilled_at`",
`extract_facts` "wipes + re-inserts facts per affected page". Of 22 phases, only
`orphans` is read-only and skips the lock.

The lock has been through real failure. `src/core/db-lock.ts:46–58` documents a
**heartbeat-aware steal grace**:

> A holder whose [`last_refreshed_at` is recent] is not stolen even if its
> `ttl_expires_at` has lapsed — defending a live, actively refreshing holder
> whose refresh tick was briefly starved (the #1794 thrash, where a CPU-bound
> import let the TTL expire and a competing launch stole the live lock). A
> genuinely dead holder stops refreshing, ages past the grace, and becomes
> stealable again (TTL stays the ultimate backstop).

Holder liveness is *classified*, not guessed (`db-lock.ts:70–132`): `cross_host`
is a distinct state because `process.kill` cannot probe another host, and
`dead_eligible` requires provably-dead **and** same-host **and** past the grace
window.

### 4. Zero-LLM entity extraction — claim verified, with a caveat they published

README lines 12/248/257 claim every page write extracts typed edges "with zero
LLM calls." **Verified at source.** `src/core/link-extraction.ts:612` is headed
`Relationship type inference (deterministic, zero LLM)`; line 694 repeats it.
Grep for `anthropic|openai|llm|fetch(|claude` in that file returns only comments
and unrelated code. It is genuinely pure regex, and the module docstring states
the functions are pure with no DB access (`link-extraction.ts:8–11`).

The caveat is the valuable part, and **they published it against themselves**
(`link-extraction.ts:616–619`):

> Calibrated against the BrainBench rich-prose corpus (240 pages of LLM-generated
> narrative). The templated 80-page benchmark hit **94.4%** type accuracy, but
> rich prose dropped to **70.7%** before this round of tuning — LLMs use far more
> verb forms than the original regexes covered.

Followed by a changelog of exactly which patterns were missing ("led the seed",
"early investor", "invests in", possessive "his time at"), and a note that
`ADVISES_RE` had to be *tightened* because generic "board member" over-matched
investors holding board seats.

There is also a **freshness watermark for the extractor itself**
(`link-extraction.ts:18–29`): `LINK_EXTRACTOR_VERSION_TS` is bumped whenever
extraction shape changes, so every previously-stamped page becomes stale and
re-extracts on the next sweep. The staleness predicate is stated in the comment:
`links_extracted_at IS NULL OR links_extracted_at < LINK_EXTRACTOR_VERSION_TS OR
updated_at > links_extracted_at`.

### 5. Budgets are per-phase and two-tier

`cycle.ts:150` — *"Budget caps live in `src/core/cycle/budget-meter.ts` via
`BaseCyclePhase`."* Phases carry a brain-wide `BudgetTracker` and a **walltime
cap** alongside the cost cap (`cycle.ts:86–91`, `2123`, `2156`). `skillopt` is
capped at **$0.50 per skill / $2.00 brain-wide** (`cycle.ts:170–171`).

Note the pairing: cost cap **and** walltime cap. A cost cap alone does not stop a
cheap phase from running forever.

### 6. Expensive/mutating phases default OFF

`skillopt`, `enrich_thin`, and `conversation_facts_backfill` gate on a
`dream.<phase>.enabled` / `cycle.<phase>.enabled` config key (`cycle.ts:484`,
`496`). `skillopt` is "Default OFF; opt-in via
`gbrain config set cycle.skillopt.enabled true`" (`cycle.ts:170–172`).

### 7. The bundled-skill safety guard

`cycle.ts:97` and `cycle.ts:171`, stated twice:

> Bundled-skill safety (D16): **never auto-mutates bundled skills — emits
> `proposed.md` instead for user review.**

A self-improving phase that would rewrite its own operating instructions may
*propose* but not *apply*. The autonomy boundary is drawn at reversibility, and
it is drawn in code, not in a doc.

## What is good

**1. Reliability is architectural at every level.** The daemon is supervised with
a crash cap; the cycle is idempotency-keyed so slow runs don't stack; the lock
survives PgBouncer; the liveness classifier handles the cross-host case it cannot
probe. None of it depends on an agent remembering anything. Same conclusion
cognee reached, arrived at independently — two systems converging on
"architecture, not policy" is a stronger signal than either alone.

**2. Failures are encoded as comments at the fix site.** `#1794` (the lock
thrash) is explained where the grace window is computed. That is the practice
`docs/prior-art/README.md` exists to enforce, found in the wild.

**3. Phase ordering is a test, not a convention.** An ordering constraint that
lives only in a comment decays. `toEqual(ALL_PHASES)` cannot.

**4. Honest about their own accuracy decay.** 94.4% → 70.7% is a bad number
published voluntarily. It makes the zero-LLM claim *more* trustworthy, not less,
and it is the most useful single data point in this review for us.

**5. Mutating phases default off, capped two ways, autonomy bounded by
reversibility.** Ours is `dry_run: true` by default
(`src/tools/tier-lane.ts:93`) — same instinct, and worth recording that we got
that one right.

**6. Lock-skip is per phase, derived from what the phase writes.** Read-only work
is not serialized behind write work.

## What is bad, or does not fit us

**Regex entity extraction does not transfer to our corpus.** Their inputs are
curated wiki-style pages with `[[wikilinks]]` — the structure is *authored*. Ours
are agent session events and raw turns, 35% of which are `[tool_use: X]` stubs.
Their 70.7% is measured on *good* prose; ours would be worse. The idea is right
for them and wrong for us, and the reason is corpus shape.

**22 phases is a lot of surface.** Comments reference v0.10.5 through v0.42.x —
this grew across many releases with real users. Reading `ALL_PHASES` as a target
would mistake the endpoint of a long incremental path for a design. Our epic
should not start at 22.

**README/source drift.** The README says 6 phases; the source says 22. Their own
marketing is stale against their own code — a live example of why this directory
requires source citations.

**Their write path is LLM-bearing where ours is not.** `skillopt`, `synthesize`,
`consolidate`, and the contradiction judge all call models — hence dollar caps.
Open Brain's Light stage is deliberately model-free, so their cost cap maps to
our *database load*, not token spend. The walltime cap transfers directly; the
dollar cap does not.

**Single-brain, single-operator.** No namespace isolation, no per-consumer auth
tokens. Nothing here informs our namespace security boundary.

## Ideas we are borrowing

1. **One-shot and scheduler as separate commands over one shared primitive** — so
   "what maintenance means" has exactly one definition.
2. ~~A TTL cycle lock in a table row~~ — **not borrowed; we already have a
   pooler-safe equivalent** (`FOR UPDATE SKIP LOCKED` + leases). Kept in the
   list as a recorded non-borrow: the hazard it avoids (session-scoped advisory
   locks dying at a pooler) is still worth knowing.
3. **Lock requirement declared per phase, derived from what that phase writes.**
   This is the part of gbrain's concurrency design we do not have.
4. **Heartbeat-aware steal grace** — a live-but-starved holder must not be stolen
   from; a dead one must eventually be reclaimed.
5. **Cost cap *and* walltime cap** — two ceilings bounding different failure modes.
6. **Expensive/mutating phases default OFF behind a per-phase config gate.**
7. **The autonomy boundary is reversibility** — a self-modifying phase proposes,
   it does not apply.
8. **An extractor version watermark that invalidates its own prior output.**
9. **Publish the accuracy gap between clean and real inputs.**
10. **Pin phase order with an equality assertion.**

## Shape comparison — does our shape preserve the property?

### Borrow A — the dream cycle itself

| | gbrain | Open Brain (DREAM epic #389–#399) |
|---|---|---|
| Phase list | `ALL_PHASES`, 22, in source | specified across 11 issues |
| Order guarantee | `toEqual(ALL_PHASES)` assertion | not specified |
| One-shot | `gbrain dream` | — |
| Scheduler | `gbrain autopilot` (supervised child, idempotency key, crash cap) | not specified |
| Shared primitive | both call `runCycle` | — |

**Verdict: UNVERIFIED — we cannot mismatch a shape we have not built yet.** That
is the honest answer: the epic is specification, not code, so there is no
implementation to compare against.

What the comparison *does* establish is which questions our spec has not
answered: what runs the cycle, what enforces phase order, and whether one-shot
and scheduled runs share a definition.

The one thing to flag now: **we have no equivalent of the "one shared primitive"
rule.** If manual `tier_lane` and a future scheduled sweep become separate code
paths, they will drift — and the manual path is the one that gets tested. gbrain
avoided that by construction and said so in a comment.

### Borrow B — concurrency control

| | gbrain | Open Brain (`src/maintenance-queue.ts`) |
|---|---|---|
| Mechanism | `gbrain_cycle_locks` row + 30-min TTL | row lease + `FOR UPDATE SKIP LOCKED` (line 440) |
| Pooler-safe | yes, by design (`cycle.ts:33–34`) | yes — transaction-scoped, not session-scoped |
| No stacking | one job per interval, idempotency key | `ON CONFLICT (job_kind, idempotency_key) DO NOTHING` (line 370) |
| Stale holder | TTL + heartbeat steal grace + liveness class | `lease_expires_at` + attempt-capped dead-letter |
| Per-phase requirement | `NEEDS_LOCK_PHASES` set | n/a — no phases exist yet |
| Read-only skip | yes | n/a |

**Verdict: our shape PRESERVES the property, by a different and arguably
stronger mechanism.** Corrected 2026-07-27 — the first draft of this review
said "none found," which was wrong. It was written after searching for a *cycle
lock* and not finding one, rather than searching for what we actually have. The
repo-search standard (`_DOCS/STANDARDS-repo-search.md`) names this exact
failure; the finding surfaced within minutes of using the index.

The comparison worth drawing is that both projects converged on **idempotency
keys to stop slow runs stacking** — gbrain at `autopilot.ts:5–11`, us at
`maintenance-queue.ts:370`. Neither borrowed from the other. That convergence is
a stronger signal that it is the right primitive than either instance alone.

Where the mechanisms differ, ours is better suited: `FOR UPDATE SKIP LOCKED` is
transaction-scoped, so it survives a transaction pooler for the same reason
gbrain's table row does, without needing a TTL heartbeat or a liveness
classifier. gbrain needs those because a *cycle* is long-running and
externally-launched; a queue lease with an expiry and an attempt cap covers the
same ground for a worker-drained job.

**What we genuinely lack is the per-phase dimension.** gbrain declares, per
phase, whether it writes and therefore whether it needs the lock
(`NEEDS_LOCK_PHASES`, `cycle.ts:272–309`). We have one substrate and no phases,
so there is nothing yet to declare. When DREAM adds phases, that per-phase
write-declaration is the part to carry over — not the locking primitive, which
we already have.

The PgBouncer detail (`cycle.ts:33–34`) is still worth recording:
`pg_try_advisory_lock` is session-scoped and **silently** stops working through a
transaction pooler. That is a bug you ship, not one you catch locally. It is now
a hazard to avoid rather than a decision to make — we already use
`FOR UPDATE SKIP LOCKED`, which is transaction-scoped and immune. The note
matters if anyone ever proposes "just take an advisory lock" as a simplification.

### Borrow C — autonomy boundary

| | gbrain | Open Brain |
|---|---|---|
| Self-modifying phase | `skillopt` | DREAM promote/archive/demote |
| Guard | never mutates bundled skills; emits `proposed.md` | `dry_run: true` default (`src/tools/tier-lane.ts:93`) |
| Default state | OFF, per-phase config gate | dry-run, no gate |
| Boundary drawn at | reversibility | execution mode |

**Verdict: same instinct; ours is weaker in one specific way.** A dry-run default
protects against *accidental* mutation. gbrain's guard protects against
*authorized* mutation of the wrong class of thing — you can turn `skillopt` on
and it still will not rewrite a bundled skill. Ours has one switch; theirs has a
switch plus a category the switch does not reach.

Whether we need the second layer depends on whether any DREAM phase would modify
something that governs its own future behavior. Worth asking during #389 rather
than after.

### Borrow D — extraction without a model

| | gbrain | Open Brain |
|---|---|---|
| Trigger | every `put_page` | write path |
| Method | regex + page-role priors | n/a — no entity extraction |
| Input | authored wiki pages, explicit `[[links]]` | agent turns, 35% `[tool_use:]` stubs |
| Measured accuracy | 94.4% templated / 70.7% rich prose | n/a |
| Re-extraction | `LINK_EXTRACTOR_VERSION_TS` watermark | n/a |

**Verdict: do NOT borrow the mechanism. DO borrow the watermark and the
honesty.**

Their regexes work because their corpus is authored with explicit link syntax.
Ours is not. Porting the mechanism would produce a worse number than 70.7% and we
would not know it, because we have no equivalent of BrainBench.

Two parts transfer, both corpus-independent:

- **The version watermark.** Any derived artifact needs a way to invalidate
  itself when the deriver changes. `ob_raw_turns.distilled_at` is 0 on every row
  today, so this is currently theoretical — but the moment distillation runs, we
  need `distilled_at < DISTILLER_VERSION_TS` or the first bug fix silently never
  reaches already-processed rows.
- **The clean-vs-real accuracy gap.** A number measured on tidy fixtures is not
  the number you get. Same failure that produced "10 of 12 tests silently skip
  without `OPENBRAIN_TEST_DATABASE_URL`": fixtures agreed, reality was never
  asked.

## Attribution

Ideas only, no code. MIT would permit code reuse with attribution; we take none.
Entered in `ATTRIBUTION.md`:

- Separate one-shot and scheduler commands over a single shared cycle primitive.
- TTL table-row cycle lock (pooler-safe), per-phase lock requirement, and
  heartbeat-aware steal grace.
- Paired cost and walltime caps.
- Autonomy boundary drawn at reversibility: self-modifying work proposes rather
  than applies.
- Extractor version watermark that invalidates previously-derived rows.

## Open questions this review did not settle

1. ~~Is our deployment behind a transaction pooler?~~ **Moot.** We use
   `FOR UPDATE SKIP LOCKED`, which is transaction-scoped and pooler-safe either
   way. The question only mattered under the false premise that we had no
   locking primitive.
2. **Does any DREAM phase modify something governing its own future behavior?**
   If yes, `dry_run` alone is the wrong guard — Borrow C applies.
3. **Do manual `tier_lane` and a future scheduled sweep share one primitive?**
   Unanswered in the epic. gbrain's answer is the one worth copying.
4. **What is our BrainBench?** gbrain can state 70.7% because they built a corpus
   and measured against it. We have no equivalent, which is why "known good and
   fully tested" currently has no number attached. This is the largest gap the
   review surfaced, and it is not a DREAM question — it is upstream of every
   claim we make about extraction quality.
5. **Should `ob_raw_turns` carry a `DISTILLER_VERSION_TS` watermark before
   distillation ships**, rather than after the first bug fix reveals it needed one?
