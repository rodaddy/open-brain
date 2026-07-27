# qmd × Open Brain — layered recall

**Status:** design, not implemented. Nothing here is merged behavior.
**Written:** 2026-07-27
**Owner decisions captured:** see "Provenance" — every design constraint below
traces to a recorded decision, not to inference.

## The one-sentence design

**Open Brain answers *which corpus* and *what happened*. qmd answers *what the
code says*. OB is the entry point; qmd is the layer it reaches through.**

That is a layering, not a federation of peers. The distinction is the whole
document.

## Why the split falls where it does

The two layers are not divided by convenience. They are divided because the two
bodies of data have **opposite convergence properties**, and that single fact
determines everything else here.

| | Open Brain | qmd |
|---|---|---|
| Holds | conversations, decisions, corrections, session history | source files — "the Codex" |
| Across machines | **divergent by nature** | **convergent by nature** |
| Rico's agent vs Kevin's agent | genuinely different data. Both real. Not reconcilable into one truth. | ~99.9% identical at any moment, enforced by git |
| Therefore must be | multi-writer, namespace-partitioned, shared | rebuildable from scratch, locally, with the same result |
| Therefore syncing is | the hard problem — it is what OB *is* | **not a problem at all** |

The owner's statement of it:

> The thing that Open Brain will have is the conversations back and forth that
> Kevin has with his agent. That will be **semantically different** than whatever
> I had. But the Codex, the part that QMD would have — that should be **99.9%
> some version of sigma correct and the same across the board all the time**.

Three consequences follow directly, and each one removes work:

1. **OB cannot be the code layer.** It is built for divergence — namespaces,
   per-session lanes, multi-writer history. Pushing convergent source data
   through that machinery buys partitioning nobody needs and pays for it in
   staleness.
2. **qmd cannot be the history layer.** It indexes files. Two agents' reasoning
   about the same file is not a property of the file.
3. **There is nothing to sync in qmd (D8).** Not because syncing was descoped,
   but because convergent data reached by git needs no reconciliation protocol.
   A local rebuild after a pull produces the same index anyone else would build.
   **The 0.1% is just the window between someone's commit and your pull** — which
   is a freshness question (R4), not a distribution one.

This is also the cleanest test of whether a future change belongs in this
design: ask whether the data diverges between machines. If yes, it is OB's. If
no, it is qmd's.

## Why this exists

Two capabilities were built separately and never joined:

- Open Brain holds session, project, user, and machine history — decisions,
  corrections, blockers, lane events, durable memory.
- qmd holds semantic and keyword search over source files, per repo, in
  `.qmd/index.sqlite`.

Asking a question today means knowing in advance which of the two to ask, and
the answer to "what did we decide about X, and what does the code actually do"
requires both. The owner's framing:

> Use Open Brain to find out what is in their corpus ... and then use qmd to
> pull in the semantics and information about the Codex that's in there — that
> should get them 99.999% of the way there. There should never be a reason to
> use grep or cat or anything ever.

and, on the current state:

> Open Brain also has access to QMD, so that the semantics of the Codex that's
> written in each directory should be able to be returned from Open Brain. **It's
> just not fully wired right now.**

This document specifies the wiring.

## Provenance — the decisions this design is built on

Recorded in Open Brain, namespace `rico`, 2026-07-26/27. Quoted rather than
paraphrased because the shape follows from the exact wording.

| # | Decision | Consequence for this design |
|---|---|---|
| D1 | "Open Brain is by design session/session, then project, then users, then machine, then so on and so forth based. **There's levels to it.**" | OB resolves scope before any code search runs. The level *is* the router. |
| D2 | "Open Brain also has access to QMD ... It's just not fully wired right now." | The target state is OB-mediated, not two tools an agent picks between. |
| D3 | "I honestly would like it very, very much if **every folder had its own QMD SQL light database** instead of the one big giant one for everything." | Per-repo `.qmd/` is the primary store. A global index may still exist for cross-repo work; it is not the default path. |
| D4 | "Any agent that I run inside of a folder or repo is by default supposed to be **the knower and owner of that repo** and they shouldn't be asking me questions about the things that are in there." | Search-before-ask is a hard rule, and the index must be local and instant enough that there is no excuse. |
| D5 | "In each repo's agents.md they should have (or a workflow link) the commands to either use qmd to get the info about their repo, or if it's faster/easier just the SQL to do it." | Both entry points stay documented per repo. SQL is a first-class path, not a fallback. |
| D6 | "Make sure not to index builds, py env's, logs, etc — that's a killer." | Allowlist, not blocklist. Already implemented in `_ob/bin/qmd-backfill`. |
| D7 | "Think about it more like how Development's gitignore is — ignore everything and add these includes." | Same. Deny-by-default is the stated idiom. |
| D8 | The repos Kevin works on "are the same as I'm working on ... I'll pull it and have the updated Codex on my side. Then I'll QMD and sync if needed." Source is "the same across the board all the time"; conversations are "semantically different." | **No distribution problem** — because source is convergent (see "Why the split falls where it does"). Source travels by git; indexes rebuild locally to the same result. No served qmd endpoint, no remote embedding, no sync protocol. |
| D9 | "Nobody but me is doing enough Codex that having to re-embed on a regular basis from somewhere else is a useful exercise." | Reindex stays manual and operator-triggered. Automate only if it chafes. |

## Topology

One topology, all hosts:

```
          ┌──────────────────────────────────────────┐
question →│ Open Brain                               │
          │  · resolves scope (D1): session→project  │
          │    →user→machine                          │
          │  · answers what happened: decisions,      │
          │    corrections, lane events, durable mem  │
          └───────────────┬──────────────────────────┘
                          │ identifies WHICH repo
                          ▼
          ┌──────────────────────────────────────────┐
          │ that repo's own .qmd/index.sqlite  (D3)  │
          │  · what the code says                     │
          │  · FTS5 for a known word                  │
          │  · embeddings for a known idea            │
          └──────────────────────────────────────────┘
```

Both layers live on whichever host is asking. Neither is served over the
network.

### How each host gets current data

- **Source** arrives by git. Kevin's work reaches this machine by `git pull`
  (D8) — it is the same repo, not a foreign corpus.
- **Indexes** are rebuilt locally after a pull (D8, D9), manually.
- **core01** gets both because the Development drive clones there daily. It is a
  *consumer* of the same mechanism, not an authority anyone queries remotely.

This is why there is no sync design in this document. There is nothing to sync.

## What already exists

Verified in-tree 2026-07-27. Recorded because this repo has repeatedly rebuilt
things it already had.

| Piece | Where | State |
|---|---|---|
| Per-repo index for open-brain | `.qmd/` | **live** — 520 docs, 30 MB, ~43 ms count query |
| Prior-art index over 6 clones | `~/.cache/qmd/research.sqlite` | **live** — 7,108 docs, ~150 ms BM25 |
| Backfill tool (allowlist idiom, D6/D7) | `_ob/bin/qmd-backfill` | **live**, resumable, skips indexed repos |
| Reference-index rebuild | `_ob/bin/qmd-reference-index` | **live** |
| qmd path resolution | `src/qmd-path.ts` | live but **default is wrong** — see below |
| Federated search tool | `src/tools/search-all.ts` | live, RRF-merged, fail-open — but **peer federation, not layered** |
| Doctor integration | `src/operator-doctor.ts` | live; freshness reporting is open as #388 |
| Repo-fact ingestion definition | closed #132 | defined; relationship to D2 unresolved |

### Two defects found while writing this

1. **`DEFAULT_QMD_PATH` points at a path that does not exist.**
   `src/qmd-path.ts:7` is `/opt/qmd/src/qmd.ts`; that file is absent on this
   machine. The real binary is `~/.local/bin/qmd` (qmd 2.6.3).
2. **`QMD_PATH=` is set *empty* in the dogfood clone env**, which is not
   `undefined`, so `resolveQmdPath()` returns `{path: "", source: "env"}` and
   `search_all` spawns `bun "" search …`. Empty-string is treated as a
   configured value.

Both are pre-existing and neither is fixed here. They mean `search_all`'s qmd
arm cannot currently work on the clone — and because the arm is deliberately
fail-open, it degrades **silently** to brain-only results.

## The gap this design closes

`search_all` is the closest existing thing, and it is the wrong shape for D1/D2:

| | `search_all` today | This design |
|---|---|---|
| Relationship | two peers, results RRF-merged | layered: OB resolves, then reaches qmd |
| Scope | caller passes `-c <collection>` | OB derives repo from session/project scope (D1) |
| Index selection | global collection list; no `--index` support | the resolved repo's own `.qmd` (D3) |
| Failure | fail-open, silent | must be *loud* — see below |
| Answers "which corpus?" | no — caller must know | yes, that is the entry point |

Peer federation still has a place for genuinely cross-repo questions. It is not
the default path, because the default question is about the repo you are
standing in (D4).

## Design rules

**R1 — OB resolves scope before qmd runs.** The level (session → project → user
→ machine) selects the repo. An agent should not have to name a collection.

**R2 — The per-repo `.qmd` is the unit.** Instant, local, standalone (D3). No
global index in the default path.

**R3 — Both entry points stay documented per repo (D5).** `qmd query` for an
idea; raw `sqlite3 .qmd/index.sqlite` for a known word. SQL is first-class —
faster, and needs nothing installed.

**R4 — Staleness must be loud, not silent.** This is the design's sharpest
requirement and the one most likely to be skipped.

**R5 — Allowlist, never blocklist (D6/D7).** Already the idiom in
`_ob/bin/qmd-backfill`; do not regress it.

**R6 — Never write into a checkout that is not ours.** The prior-art clones
index to `~/.cache/qmd/research.sqlite` precisely so `git pull` stays clean and
upstream diffs stay honest.

## R4 in detail — the failure mode that matters

Two ways this design can lie, both silent by default:

**Stale index.** `git pull` updates source; it does not update `.qmd`. Between a
pull and a reindex, the index answers from the *old* code — and a stale hit is
indistinguishable from a fresh one. Given D9 (manual reindex), this window is
routine, not exceptional.

*Requirement:* every qmd-sourced answer carries index age and the indexed commit,
and a threshold makes it an alarm rather than a footnote. This is exactly
**#388 (QMD-3, index freshness in operator-doctor)** — that issue is the right
home; this design raises its priority from hygiene to correctness.

**Single-checkout blindness.** An index reflects **one working tree**. Code on
another branch is invisible to it.

This is not hypothetical. During the 2026-07-27 issue audit, an agent searching
the working tree concluded that the producer of 30 `system.facts` maintenance
jobs had *"zero code presence anywhere — the producer is external."* It was
commit `caabc14` on `feat/380-raw-turns-ingest`, unmerged. Good-faith evidence,
confidently wrong conclusion, because the tool's boundary was invisible.

*Requirement:* "search before you ask" (D4) must be paired with "a clean miss
across one checkout is not proof of absence." When a search comes back empty on
something that demonstrably happened, check other branches before concluding
anything. Search failure and absence are different findings.

## Open questions

1. **Does OB shell to `sqlite3`/`qmd`, or read `.qmd/index.sqlite` directly?**
   Direct read is faster and dependency-free for the FTS path; the binary is
   needed for embeddings. Probably both, split by query type — undecided.
2. **How does OB map a resolved scope to a filesystem path?** D1 gives the
   levels; the project→path mapping is not specified. `ob_sources` may already
   carry enough.
3. **What is the relationship to closed #132** ("qmd-derived context fact
   ingestion")? That is the ingest-into-OB direction; this is the query-through
   direction. They may be complementary or may conflict.
4. **Does `search_all` become the layered path, or does a new tool sit above
   it?** Changing it is a contract change with downstream consumers
   (`docs/downstream-rollout.md`).
5. **What proves this works?** Per the standing rule, against the real database
   and a real index, bottom to top — not fixtures. The acceptance shape needs
   defining before implementation.

## Relationship to open issues

- **#386 QMD-1** (restore qmd sync as a scheduled job) — predates D3/D8/D9;
  needs re-reading against per-repo indexes and manual reindex.
- **#387 QMD-2** (triage 55 unindexed Development repos) — still valid; this
  design raises its value, since an unindexed repo is one an agent cannot own
  (D4).
- **#388 QMD-3** (index freshness in operator-doctor) — **promoted by R4** from
  hygiene to a correctness requirement.

The 2026-07-27 issue audit explicitly left qmd→OB unverified: *"#386-#387
qmd→OB recall (the epic's fifth table row, unchecked by any report)."* This
document fills that gap as design; it does not claim any of it is verified.

## What this document does not claim

- No code has been written or changed.
- The two `src/qmd-path.ts` defects are **reported, not fixed**.
- Nothing here is measured against core01 — all observations are this machine
  and the local dogfood clone.
- The multi-machine case is settled by D8 (same repos, git-distributed), **not**
  by anything tested.
