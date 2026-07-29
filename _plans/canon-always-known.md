# Canon — the always-known layer

**Status:** design, agreed 2026-07-29. Not yet implemented.
**Priority:** ahead of DREAM. See "Why this outranks dreaming".

## The problem, measured

Every failure in the 2026-07-29 session had the same shape: **the knowledge
existed, was correct, and was unreachable.**

| Thing | Built? | Reachable? | Consequence |
|---|---|---|---|
| `_DOCS/QMD_INDEXES.md` (150 lines, complete) | yes | **in no qmd index** | an `ai-agents` session improvised, ran `qmd-backfill` on a third-party checkout, and committed an index allowlist into `github.com/block/buzz` |
| `_ob/skills/skill-maintainer/workflows/update.md` | yes | **in no qmd index** | this session forked the `brain` skill into a runtime adapter instead of editing the canonical |
| `_DOCS/STANDARDS-*` (Development-wide) | yes | **in no qmd index** | rules re-derived from scratch each session |
| Canon lanes `profile_guidance` / `process_guidance` / `repo_facts` | yes (#328, #357, closed 2026-07-23) | **0 items** | nothing to load |
| Persona definitions (`_ob/skills/personas/`) | yes, authored | loader `load-core-context.ts` **does not exist** | `ACTIVE_PERSONA=bob` set, never loaded, all session |
| `recall()` over session events | yes | no producer (#433) | semantic recall answers from months-old rows |

Measured against the live local service (`$OPENBRAIN_BASE_URL`, namespace `rico`,
repo `open-brain`) on 2026-07-29:

```
profile_guidance: items=0
process_guidance: items=0
repo_facts:       items=0
```

`status: ok`, no scope denials, no degraded sources. The retrieval works exactly
as #328 specified — defined empty states rather than fabricated guidance. There
is simply nothing in the room.

Fleet index composition, same date:

```
fleet.sqlite: 10,900 documents, 40+ collections
  _DOCS: 0    _ob: 0
  buzz (github.com/block/buzz, third-party): 2,205  = 20% of the index
```

## The insight

Indexing `_DOCS`/`_ob` builds a **better pointer chain**. A pointer chain still
requires the agent to know it should follow one — and that is precisely the step
that fails. Every dead reference above is a pointer that rotted.

**Canon inverts it.** The rule arrives *with the task* instead of being
retrievable by an agent who does not know it needs retrieving.

The `buzz` agent did not need the 150-line procedure in context. It needed to
know a procedure existed and that improvising was forbidden. That is a
canon-sized fact — three lines.

## Design

### Default: canon only

Automatic recall loads **only** the always-known, context-free layer. Everything
else is explicit and scoped.

| Layer | Loaded | Why |
|---|---|---|
| **User** — who Rico is, people, preferences | always | stable; never contaminates |
| **Soul** — git rules, coding standards, LAWs, anti-preferences, persona | always | stable; the rules any agent needs |
| **Repo facts** — this repo's truths, exact-bound | always | scoped, never falls back to another repo |
| Episodic — lane events, "what were we doing" | **explicit only** | situational; contaminates a fresh start |
| Everything else | on request | |

The operator's rule, verbatim: *"it should only do the canonical front of mind
always known stuff like who I am, who people, places, things, coding standards,
git standards, all of the things that any agent that's going to be doing work
for me needs to know. Anything else if I don't tell it to load it shouldn't be
auto-loaded."*

**Episodic is explicit because it contaminates.** Sometimes the work is
unrelated to last session and the past muddies it; sometimes a fresh perspective
is the point. Verbs: last session, last N, this repo, (time windows blocked —
see Constraints).

### The three lanes already exist

`agent_context_pack` (#328/#357, closed and deployed) maps 1:1 onto the model:

| Concept | Lane |
|---|---|
| User | `profile_guidance` |
| Soul (rules + persona) | `process_guidance` |
| Repo facts | `repo_facts` |

Call shape (`requested_sections`, **not** `sections` — an unknown key is
silently ignored and returns the default pack):

```json
{"name":"agent_context_pack","arguments":{
  "requested_sections":["profile_guidance","process_guidance","repo_facts"],
  "agent":"claude","platform":"claude-code","server_id":"local",
  "channel_id":"cli","session_key":"dev:open-brain","repo":"open-brain"}}
```

Nothing needs building on the read side. The gap is content and a loader.

### Two levels, because canon cannot hold everything

`QMD_INDEXES.md` is 150 lines; `skill-maintainer/workflows/update.md` is
another; there are dozens. All of it always-loaded is a context blowout. The
January PAI hot-tier was 6-line files for exactly this reason — front-of-mind
works because it is small, not because it is fast.

- **Canon (always):** the *rule*, short and absolute. *"Prior art never goes in
  Development; it goes in a research root, indexed with `qmd-reference-index`.
  Never `qmd-backfill` a repo you do not own."*
- **Index (on trigger):** the full procedure text, served by qmd when the task
  touches it.

Neither alone works. Index-only is what failed on 2026-07-29; canon-only cannot
hold the detail.

### Persona

Rules are invariant; persona is tone only. `_ob/skills/personas/SKILL.md` already
draws this line:

> **Always keep regardless of persona:** technical accuracy, critical thinking
> (LAW4), no time estimates, working code over pseudocode.
> **Persona overrides only:** tone, humor, register, verbosity, vocabulary,
> structure.

So they are different records — `process_guidance` rules do not change when the
persona changes. Three levels, matching the existing design:

- condensed prompt (~40 words) — always loaded, selected by `ACTIVE_PERSONA`
- canonical table — the four personas, the locked rules
- full reference — calibration, phrases, openings; on demand

Storing these as rows removes the drift problem the canonical currently manages
by hand (*"if they diverge, the references win"*) — one row, one source.

**Open:** `ACTIVE_PERSONA=bob` is currently set. Deliberate or stale is
unresolved; it decides the loader default.

### Skills stay in files

Skill bodies as database rows lose diffs, git history, review, and the
`_ob` canonical/adapter discipline — the machinery that caught this session's
fork. Files stay authoritative; OB/qmd holds a derived index (`register_source`
with `source_kind='directory'`, or a qmd collection). Same relationship as
`.qmd/`: a projection, not an original.

The win is **discovery and scoping**, not lazy loading — skill bodies are
already lazy; only the ~150-line description index is always paid. Scoping that
index to the current repo/task is where context is actually saved.

Framing it as *"shit I know how to do"* rather than *"skills"* is deliberate:
the useful set includes SME docs, decision records, and standards, which are not
invocable but are exactly as load-bearing.

## Why this outranks dreaming

**Dreaming produces canon.** Light → REM → Deep exists to distill raw capture
into durable knowledge. With canon empty and no loader, the pipeline grades
candidates into a room nobody enters.

Canon-first fixes the consumer before scaling the producer. It is not a
preference ordering; it is a dependency.

## Constraints and known breaks

- **`ob_session_events.occurred_at` is NULL on all 9,805 rows** — no time
  windowing is possible. Order and filter on `created_at`. "Last 6 hours" cannot
  be served until this is fixed.
- **`event_limit` caps at 200**; a larger value is REJECTED and returns nothing,
  not a truncated list.
- **`recall()` searches `thoughts`/`decisions` only.** Session events reach those
  tables via `classifyLaneEvent -> tierLaneEvent -> graduateLaneEvent` and
  **nothing runs that chain** (#433, root-caused 2026-07-27). Episodic questions
  must use the lane directly.
- **Canon is a filter, not a similarity query.** These rows are *always*
  returned; do not build a semantic search over ~20 rows that must all come back
  anyway. #328 already specifies exact-scope retrieval.
- **Voice may not survive shredding.** Rules atomize well; a persona document is
  coherent prose whose parts reference each other. Store persona bodies as one
  row each, retrieved by name — not as N similarity-matched fragments.
- **`memory-contract.md:19`** says *"Not a behavior layer. Rules, routing, and
  personality live in CLAUDE.md / skill files."* This design supersedes that
  line deliberately — it was written when files were the home, and the PAI
  extraction is precisely the move away from that.

## Work items

Ordered by dependency. Each mutation needs explicit operator authorization.

1. **Rebuild the fleet index correctly.** `fleet.sqlite` is a cache in
   `~/.cache/qmd/` — expendable, rebuildable, no durable state. Delete and
   rebuild *scoped*; `ROOT=$DEVROOT` unscoped is what produced 10,900 documents
   including a third-party repo.
2. **`policy` index over `_DOCS` + `_ob`.** The retrieval half. Uses the
   existing parameterized tool: `ROOT=... INDEX=policy qmd-reference-index`.
3. **`buzz` cleanup.** Revert the index-allowlist commit so the checkout is
   pristine and `git pull` stays clean; move it out of Development to a research
   root; index as a named research index if `ai-agents` needs it. Separate git
   boundary — that work lands in that repo, on its own branch.
4. **Author canon content.** The rules, profile, and repo facts. Content the
   operator approves; #328 explicitly listed capture as a non-goal, which is why
   the lanes are empty.
5. **Canon loader.** Automatic at session start: three lanes + active persona.
   Replaces the missing `load-core-context.ts`. Reads from OB, not files.
6. **Document the research-index procedure where agents can reach it** — the
   root cause of the `buzz` incident. Rule in the owning SOP, full text in the
   `policy` index.
7. **Trim the `brain` skill.** Genuinely last, and mostly deletion: the current
   canonical is built around `mcp2cli`, which is retired and hook-blocked for
   Claude, hardcodes `10.71.1.21:3100` in three places against an env-driven
   client, ships a 46-tool table when the live server has 63 (17 added, 0
   removed), and its drift check writes to `/tmp`.

## Rejected

- **Skill bodies as database rows** — loses git, review, and the canonical
  discipline; editing would be miserable.
- **Persona as a file with an OB pointer** — that is the model the PAI
  extraction is moving away from. Persona lives in OB as content.
- **Hardcoding any endpoint** — including `127.0.0.1:3100`. The env
  (`OPENBRAIN_BASE_URL`) is the only source. A hardcoded host is wrong on both
  machines and goes stale the moment a port moves.
- **Auto-loading episodic context** — contaminates unrelated work and forecloses
  a deliberate fresh start.
