# Code-brain design

Status: **design, not built.** Captured 2026-07-24.

Open Brain is a *memory* system. The thing described here is a **conformance**
system: it volunteers that work has drifted from stated intent, without being
asked. Nothing in the market does this (see [Prior art](#prior-art)).

This document records decisions made in one long working session. Rico made
every substantive correction; the first draft of most sections was wrong in the
way noted inline. Read the corrections — they are the load-bearing part.

---

## The finding this exists to fix

**Open Brain does not have a design problem. It has a wiring problem.**

Eight measured instances of one defect — built, tested, correct, and nothing
calls it:

| # | Capability | State on 2026-07-24 |
|---|---|---|
| 1 | `discarded_entries` | 0 rows, no writer |
| 2 | maintenance runner | 2 handlers wired, `ENABLED=0` |
| 3 | Dream Cycle | documented manual, no scheduler |
| 4 | `graduateLaneEvent` | tool-only, no automatic caller |
| 5 | qmd → recall | orphaned 39 days |
| 6 | PreCompact capture | no branch at all — **fixed, see §5** |
| 7 | `ob_sources` | 9 canary rows, 8 retired |
| 8 | `ob_source_files` | 0 rows |

Every sprint issue closed. Every PR merged, CI green, review swarms run. The
issues closed against code that **exists** while nobody checked whether anything
**runs**.

---

## 1. Requirements

Gaps 1–3 are **required** for the system to work. Gap 4 is closed-brain only:
leave hooks, build nothing.

### R1 — Memory kinds and reach (required)

Three axes. Only one exists today.

| Axis | Question | Status |
|---|---|---|
| **kind** | how fast does it go stale | ❌ missing |
| **reach** | project-only, or applies everywhere | ⚠️ `shared-kb` exists, nothing routes to it |
| scope | who owns it | ✅ namespace / lane |

**Why kind:** a 3-month-old architectural decision and a 3-month-old "deploy
green" ping are the same age and wildly different value. Without a kind axis,
re-warming either surfaces noise or buries the decision.

Borrowed from gbrain `src/core/facts/decay.ts` — per-kind half-lives, chosen
empirically in a documented review:

| gbrain kind | Half-life | Their stated reason |
|---|---|---|
| `event` | 7d | *"lunch on Tuesday is meaningless after Tuesday"* |
| `commitment` | 90d | *"promises hold longer"* |
| `preference` | 90d | *"stays useful for a quarter"* |
| `belief` | 365d | *"opinions decay slow but not infinite"* |
| `fact` | 365d | same as belief by default |

**Do not copy their kinds.** Those are personal-assistant kinds. Candidate
OB-native kinds:

| Kind | Example | Lean |
|---|---|---|
| `decision` | "0.91 dedupe, per the LiteLLM rule" | long |
| `correction` | "recency does not win supersession" | **longest — arguably never** |
| `state` | "wheel is 0.1.17", "maintenance is off" | short, 7–14d |
| `outcome` | "PR #378 merged, CI green" | short, historically permanent |
| `pattern` | "agents drift when left autonomous" | long, and dangerous |

`correction` matters most: every real fix in this session was Rico correcting
the agent. Those are the highest-value rows in the system.

**Why reach:** project rules must not bleed; global rules must.

| Stays put | Bleeds everywhere |
|---|---|
| "in king-signals we use X pattern" | "never use `/bin/bash` on macOS" |
| "OB's dedupe threshold is 0.91" | "test varied inputs, not SQL shape" |

gbrain does **not** solve this — its scoping is `source_id` plus a slug path
prefix, one person's brain where bleed is the feature.

### R2 — Bi-temporal facts (required)

Borrowed from graphiti `graphiti_core/edges.py:271-280` (Apache-2.0). **Four**
fields, not two:

| Field | Meaning |
|---|---|
| `valid_at` | when the fact became true |
| `invalid_at` | when the fact **stopped being true** |
| `expired_at` | when the record was invalidated — **when we found out** |
| `reference_time` | from the source episode (their `occurred_at`) |

> **Correction.** The first draft proposed two columns and collapsed "stopped
> being true in the world" with "we learned it." They are different, and the
> **gap between them is the drift metric**: the wheel stopped being 0.1.17 on
> release day (`invalid_at`); OB learned three days later (`expired_at`). That
> window — "we believed a dead fact for 3 days" — is not computable with one
> column.

Ordering is a hard stop before any decay math:

```
if expired_at   → 0     ← nothing below runs
if invalid_at   → 0
else decay(last_seen_at)
```

Reinforcement bumps `last_seen_at`. **Never** `occurred_at`, and it can never
resurrect an expired row. Repeated assertion of an expired fact is not a
resurrection — it is an **operator alarm** meaning agents are running on stale
context.

### R3 — Authority tiers (required)

Every other axis — decay, reinforcement, recency — asks only *how fresh* or
*how repeated*. Under those alone, drift is **working as designed**:

1. plan says X
2. session infers Y, plausibly
3. Y is captured
4. next session recalls Y — newer, now repeated
5. Y reinforces; X sits still and ages
6. fifty sessions later Y has beaten X on every axis OB measures

Step 6 is the bug. The fix is not better detection — it is **precedence**.

| Tier | Source | Rule |
|---|---|---|
| **canon** | epic / issue / ratified decision doc | overrules |
| **decided** | an explicit Rico decision | strong |
| **observed** | what a session did or concluded | weak |

A session finding can never outrank canon, no matter how recent or how
repeated. It can only be **flagged as contradicting** canon — a question for
the operator, never an automatic override.

Authority is known at write time from the source, so it is Light work: no model.

**North star is the issue tracker**, not published docs — issues carry
hierarchy, state, and linkage; a doc stays canon until someone remembers to
unpublish it. Authority flows **down** the chain, evidence flows **up**:

```
epic → issue → PR/commit → session
```

Forge-neutral: model issue / hierarchy / state / link, with GitHub as one
adapter behind `source_kind` + `external_id`. Never GitHub-shaped columns.
`git.rodaddy.live` (forg) is already live.

### R4 — File citation in answers (closed-brain only)

**Hooks yes, implementation no.**

For a closed/tagged document brain, an answer must cite a specific file
resolving to `file_id` + `path` + `content_hash`. Whether `brain_answer`
source_refs can carry a file-level pointer is **unverified** — the one genuine
gap on the closed-brain side.

Everything else it needs already exists:

| Need | Status |
|---|---|
| tenant separation | ✅ per-consumer token → namespace |
| file dump with tagged retrieval | ✅ `ob_source_files` — **0 rows** |
| review / ingestion / output tags | ⚠️ `source_kind` exists; only ever held `git` |
| receipts | ✅ `content_hash`, `approval_state`, `revision` |

Do **not** build: a tag vocabulary, the file-as-truth inversion, or the
md→PDF pipeline. Cheap insurance is provenance and addressability; tags and
templates retrofit easily.

---

## 2. Closed ≠ delivered

Closure is a lagging indicator that measures the wrong thing.

> **Correction.** An earlier draft claimed closure gives canon a clean
> end-of-life. Wrong. Closure is precisely when canon becomes most dangerous —
> the compass gets put away and nothing checks arrival.

The north star is not the issue text. It is the **assertion the issue was
supposed to make true**:

| Intent | Assertion |
|---|---|
| discards get drained | `discarded_entries` count > 0 |
| maintenance runs | `ENABLED=1` and last run recent |
| dream runs nightly | last dream run < 48h |
| files are tracked | `ob_source_files` count > 0 |
| pre-compact captures | rows with `receipt_trigger='pre-compact'` exist |

Five queries. No model, no DSL, no new format. **They would have caught all
eight findings the day after each issue closed.**

An epic closed with failing assertions is not finished. It is drifted, and that
is the email.

*Open:* assertions on the issue body vs a versioned repo checks file. Lean
repo-side — one thing to maintain, runs whether or not anyone remembers the
issue exists.

---

## 3. Why an agent cannot do this

The coding agent has a stake: closing the issue is its success condition. So it
evaluates its own work and reports green.

A watcher has **no stake** — it never wrote the code, so "did this actually
happen" is not self-assessment.

That is structural, not a discipline problem. It is why *"assign an agent to
keep the board honest"* failed every time: the agent was inside the same run,
and board upkeep is a tool call an agent must **remember** — the same defect as
all eight findings. Observed this session: 15 issues filed, then a compaction,
then Project #8 never touched again.

**Board maintenance is service work.** `rodaddy-watcher` is live on CT219 with
its own Postgres, systemd, backups, an authoritative 15-minute sweep, forg
reviewed, `rodaddy/open-brain` configured, and runner boxes that cannot select
arbitrary commands from repository content. A service does not compact.

⚠️ **The agent swarm doing all the git/board work is not real yet.** OB must not
be based on it.

| | rodaddy-watcher | Open Brain |
|---|---|---|
| owns | forge state, jobs, dispatch, publication | memory, recall, distillation |
| knows | what issues **say** | what sessions **did** |

Neither sees the gap alone. Watcher knows #395 closed; OB knows
`discarded_entries` is still 0. The assertion check needs both, and today they
do not talk.

Measured: `rodaddy-watcher` appears **28 times** in `ob_session_events` and
**zero** times in `thoughts` or `decisions`.

**Standalone-useful step:** OB records observed system facts durably on a
schedule — row counts, is-maintenance-on, last-dream-run. No forge knowledge
needed, and the watcher join later becomes one query instead of a project.

---

## 4. Retention

**Never delete.** Three tiers:

| Tier | Where | When | In recall? |
|---|---|---|---|
| live | `thoughts` / `decisions` | current | ✅ |
| **unused** | `discarded_entries` | on expiry / supersession | ❌ still queryable |
| **cold** | hard storage, off-DB | ~6 months | ❌ fetch on demand |

Six months, not the week first discussed: **a week is shorter than the
phenomenon being caught.** A two-week drift is not visible in a one-week window.

Expiry **moves** the row rather than filtering it in place — live tables stay
clean and there is no `WHERE` predicate to forget.

Why dead rows are kept at all:

1. **Dedupe on re-ingest** — otherwise a re-scan resurrects it at full confidence
2. **The "why did we do that" trail** — decisions built on X need X to survive
3. **Repeat detection after death** — you cannot count hits on a missing row
4. **Negative patterns** — a fact that died is a learning experience

**The index of what is in cold stays in the database.** Only content leaves.
This makes the archival-unit question moot: find the row via the index, fetch
bytes on demand.

`ob_source_files` already has the shape — `path`, enforced sha256, `live`/
`deleted`, `revision`, namespace + scope, FK cascade. It needs a **writer**,
not schema. Same defect as `discarded_entries`. Two writers, one lifecycle.

**Deferred:** retention timing, mechanism, and size must become configuration.
Normal users do not have seven Proxmox servers, a TrueNAS, and a 2 TB external
drive. The shipped default must be sane for one laptop. Config comes last.

---

## 5. Drift detection

Cheap, model-free, and it catches the slope while it is still a slope.

At **≥0.9** similarity (the LiteLLM caching rule):

1. new item matches an existing one
2. **do not store it again** — counts once
3. tag it, file it as "yep, again"
4. counter increments
5. dream states read the counters

The counter is not just dedupe savings — **the shape of the counts is the
signal**:

| Pattern | Means |
|---|---|
| 40 hits over 3 months, steady | settled |
| 0 → 15 hits in 4 days | **something changed and nobody said so** |
| hits continuing after expiry | agents on stale context |
| hot decision, silent 3 weeks | drifted away from, or just done? |

**Alarm on 2–3 diverging sessions, not a volume threshold.** Volume thresholds
take weeks, and weeks is exactly how the drift happened.

Two verbs for dream:

- **invalidate and pull** — clear contradiction, automatic, link the successor
- **bring it to me** — the ambiguous middle, the nightly review page

> **Correction.** The first draft of drift detection (#393) was a REM-time
> semantic comparison needing a model. Rico's version needs **no model at all** —
> two counters and a date — and catches drift earlier.

Sustained observed contradiction of canon is the highest-value alert available:
*"twelve sessions across three weeks contradict the plan doc. Either they are
drifting, or the plan is dead. Which?"* That question is only askable **because**
the tiers exist.

---

## 6. Prior art

Clones: `/Volumes/ThunderBolt/_tmp/open-brain/research/` — gbrain, honcho,
cognee, cognee-integrations, mem0, graphiti. cognee / mem0 / graphiti are
Apache-2.0. **All credit given where taken.**

| Source | Take | Reference |
|---|---|---|
| **graphiti** | 4 temporal fields | `graphiti_core/edges.py:271-280` |
| **gbrain** | per-kind half-lives; `emotional_weight × 5 + ln(1 + take_count)`; notability gate | `src/core/facts/decay.ts`, `src/commands/notability-eval.ts` |
| **cognee** | detached idle daemon; read-side PreCompact; improve cooldown | `integrations/claude-code/scripts/` |
| **mem0** | nothing structural — cautionary | `mem0/configs/prompts.py:176` |
| **nobody** | intent vs runtime conformance | — |

**gbrain salience** is `emotional_weight × 5 + ln(1 + take_count)` — reinforcement
as a *separate axis*, log-damped so the 50th mention counts less than the 2nd.
That is exactly the correction Rico made to the naive "+0.2 to confidence"
proposal, already shipped and tested elsewhere.

**cognee is ahead of OB on lifecycle plumbing.** Verified in
`hooks/hooks.json`: all six surfaces wired, plus `idle-watcher.py`,
`exit-watcher.py`, `clear-transcript-context.py`. Their idle watcher is a
**detached daemon** launched from session start, polling an activity file —
their comment: *"survives Codex crashes better than foreground hooks."* That is
the REM idle-trigger problem solved by architecture instead of policy. Tuning is
stated and reasoned: poll 10s, idle 60s, **improve cooldown 600s** to prevent
back-to-back runs when activity is sporadic — an already-fitted high-water mark.

Their PreCompact is the **opposite direction** from OB's:

| | cognee | OB (fixed this session) |
|---|---|---|
| direction | **read** — pull summary, emit markdown | **write** — durable checkpoint |
| purpose | survive the context reset | survive the session |

Both are needed. OB built half the surface.

**mem0** resolves conflicts with one LLM prompt returning
`ADD`/`UPDATE`/`DELETE`/`NONE`. Two disqualifiers: `DELETE` is a real delete
with no audit trail, and every write costs a model call — incompatible with a
model-free write path. The four-verb vocabulary is only a reasonable shape for
Deep, which already has a model.

### The line nobody crosses

Every one of these answers *"what does the code look like / what was said?"*
None answers *"is the work going where it was supposed to?"*

| | Who has it |
|---|---|
| code + standards | cognee, code-graph tools |
| session history | mem0, cognee, everyone |
| stated intent (PRD, epic, goal run) | ADR piles — unchecked prose |
| **actual runtime state** | **nobody** |

cognee's own docs: goals and PRDs are just documents you ingest — no goal state,
no requirement→code linkage. It would have indexed `graduateLaneEvent`
perfectly and answered every question about it. It would never have told you
nothing calls it.

The field's own admitted hole, from the 2026 survey work:

> *memory staleness remains unsolved — a high-relevance memory stays accurate
> until reality changes, at which point it becomes confidently wrong*

Their proposed fix is ADR status fields set by hand — the same
"remember to update it" that fails after every compact. **The answer here is
different in kind: do not ask memory to know it is stale. Check reality on a
sweep.**

---

## 7. Order of work

1. **Turn on one built-but-dead capability and see what breaks.**
   Cheapest: `OPEN_BRAIN_MAINTENANCE_ENABLED=1`, or the 4am qmd job (#386).
2. Write one row to `ob_source_files` and one non-git `ob_sources` row. Both
   tables have held one shape forever; code may assume it.
3. Record observed system facts durably on a schedule (§3).
4. Add the R2 temporal fields — schema, cheap now, migration later.
5. Add R1 kind + reach — schema, same reasoning.
6. R3 authority tier at ingest, from source. No model.
7. Only then revisit #386–#399, most of which re-specify existing code.

---

## Standing hazard

Issues #386–#399 were written by **one agent in one session** — the same shape
as the drift being diagnosed. Every substantive correction came from Rico:

| Agent had it wrong | Corrected to |
|---|---|
| +0.2 to confidence per duplicate | confidence ≠ reinforcement; separate table, count rows |
| light on a 10–60 min timer | always-on, in the write path |
| recency wins supersession | a new bad thought is not better than an old correct one |
| two temporal columns | four — world-time vs knowledge-time |
| expiry filters in place | expiry **moves** the row |
| REM-time semantic drift detection | two counters and a date |
| "assign an agent to the board" | service work, not agent work |

Treat the issue list as a proposal to audit, not a plan to execute.
