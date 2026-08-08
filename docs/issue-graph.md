# The issue graph: charting what the issues already say

**Status (2026-08-07): WRITTEN, running locally, nothing charted to GitHub yet.**
`scripts/issue-graph.ts` exists and runs read-only against live issues. No
`--chart --write` run has happened, so GitHub's native graph is unchanged. This
document is the design record and the operating manual; it is not a claim that
the graph is charted.

---

## Why this exists

The dependency structure of this repo's work is **already written by hand, in
the issue bodies**, and has been for months:

```
Parent: #293
Program: #320
Depends on: #391
Part of #389
Blocked by #435 and #436
**Depends on:** #344, #345, #346, #330, #335, #341
```

Measured 2026-08-07 across the 49 open issues: 11 declare a `Program`, 4 declare
`Parent: #293`, and real `Depends on:` chains exist (`#390 → #391 → #394`,
`#435 → #436`). The parser finds **59 declared edges**.

GitHub's **native** graph held **2** `blocked_by` edges and 15 parent links.

That gap is the entire problem. Because the ordering lives in prose:

- every session re-reads 49 issue bodies to rediscover ordering the issues
  already state;
- the only automated signal was `scripts/stale-blockers.ts`, a regex over
  `#NNN` that cannot distinguish "blocked by" from "mentioned in passing";
- work gets picked one at a time, by whoever is looking, in whatever order the
  last report happened to print.

Operator, 2026-08-07, naming the failure directly:

> "we've been just looping through and it's been less than ideal. Like, we need
> to start gathering things in and then fixing them in proper swarms so that we
> actually do the things correctly and quickly with less mistakes and things
> piling up on themselves."

## What the old signal got wrong

`stale-blockers.ts` reports open issues whose referenced issues are all closed.
On 2026-08-06 it flagged nine. Verified against the bodies:

| Flagged | What it actually was |
|---|---|
| #296, #298, #299, #300 | **Unstarted** P1/P2/P3 work whose PARENT (#293) closed. Not nearly-done; nothing had begun. |
| #400's 7 children | Marked `PARKED BY DESIGN — do not implement` and `Question, not work`. Deliberately open. |
| #604 | Genuinely actionable (PR #606 green, unmerged). |

Seven of nine were misleading. The tool is not broken — it is a regex being
asked a graph question. It stays useful as a *cross-check* (see "Relationship to
other tooling"), but it is not the ordering signal.

## What this is NOT

- It **never** closes, merges, deletes, or edits issue bodies.
- A frontier entry is a **candidate for work**, not a verdict that the work
  should start or that acceptance is met. The issue's own criteria decide that.
- It does not replace the controller. Per
  `_ob/skills/goal-run-controller/SKILL.md` §1, the controller owns the
  dependency graph; this script *serves* that ownership by making the graph
  machine-readable.

## The two rules that make the output honest

### 1. Hierarchy is not blocking

`Parent:` / `Program:` / `Part of` say where an issue **belongs**.
`Depends on:` / `Blocked by:` say what must land **first**. Conflating them
produces a deadlock: an epic stays open *until its children land*, so treating
containment as blocking means no child can ever start.

Both readings are computed and printed, because the operator asked to see the
difference rather than be told it. Measured 2026-08-07:

| Reading | Workable |
|---|---|
| **A** — hierarchy is not blocking | **44 of 49** |
| **B** — hierarchy also blocks | 24 of 49 |

B withholds #390 (DREAM-1 Light), #395, #396, #397, #399, #413, #414, #416,
#417 — all independently buildable, none actually blocked. **A is correct.**

The true dependency chain is small and clean:

```
#390 → #391 → #394      DREAM: Light → REM trigger → Deep
#389 → #393
#435 → #436 → #437      hosted REM → hourly Deep → web service
```

### 2. Parked is a state, not a filter

#400 SHAPE and its seven children carry `PARKED BY DESIGN — do not implement`
and `Question, not work`. An earlier draft of this tool filtered them out of the
frontier. That was wrong, and the operator corrected it on 2026-08-07:

> "if it is parked by design, then that is actually something that should be
> included and on purpose."

Parked work is **work whose gate is a decision, not a dependency**. #407's
rename question gates a public launch. Filtering it is how it gets lost — the
exact failure #400 was filed to prevent. So everything is reported, and the
graph records *why* a thing is not moving, with the marker that proved it.

## Usage

```bash
bun run scripts/issue-graph.ts                    # report only, writes nothing
bun run scripts/issue-graph.ts --chart            # DRY RUN of the edge writes
bun run scripts/issue-graph.ts --chart --write    # actually write native edges
```

Charting writes `Depends on:` / `Blocked by:` declarations as native
`blocked_by` dependencies. Hierarchy is **reported, never written as blocking**.

Verified once for this repo (2026-08-07): the `dependencies/blocked_by` and
`sub_issues` endpoints both respond `[]` rather than 404, so native
dependencies and sub-issues are enabled here. The wayfinder reference requires
this be checked once per repo and recorded so later sessions do not re-probe —
this is that record.

### Lane briefing: PR bodies

Validate the PR body locally BEFORE `gh pr create`, never after CI rejects it:
`PR_BODY="$(cat body.md)" PR_TITLE="..." bun scripts/validate-pr-body.ts`
(add `CONTRACT_PARITY_REQUIRED=true` when the diff touches
`contracts/parity-paths.txt`). Start from `.github/pull_request_template.md`
rather than reconstructing the sections — it is held against the validator by
`scripts/done-means/pr-template-passes-validator.sh`, so a filled template
cannot fail on shape. Three lanes failed the check three different ways in one
night, all format rather than substance: a bolded `- **Label:**` breaks the
`/^-\s*Label:/` anchor, a renamed or missing `## Review Gate` is a hard error,
and a body composed in chat arrives wrapped in a code fence. The `pr-scribe`
agent (`.claude/agents/pr-scribe.md`) composes a body from a lane's real
evidence and returns one only after it has seen the validator exit 0.

## Relationship to existing skills

**Existing patterns, deliberately reused — and a new paradigm built on them.**
Both halves are true and neither is a hedge. The skills below exist to be used;
using them is the point, not a borrowed credential. What is new is the
combination: a deterministic, re-runnable graph over the whole issue corpus,
feeding swarms instead of one-at-a-time work.

Confirmed 2026-08-07: `frontier` appears in `_ob/skills/wayfinder/` and
`_ob/skills/pro-con-analysis/` prose, and **no script in `_ob/scripts/`
implements it** (zero matches for `frontier` or `blocked_by`). The concept is
canon; the implementation did not exist.

| Skill | What this adopts |
|---|---|
| `wayfinder` (`_DOCS/procedure.md:1-15`) | The map/child model, typed tickets, the **frontier query**, and the Done Criterion "native blocking links match the actual dependency graph". This repo already has map **#443** with 14 sub-issues. |
| `wayfinder` (`_DOCS/references/issue-tracker-github.md`) | The exact `blocked_by` API shape, the requirement to use the blocker's numeric **database id** (not `#number`), and the once-per-repo endpoint verification. |
| `goal-run-controller` §1 | Controller owns the dependency graph. This serves that; it does not take it over. |
| `goal-run-controller` §2 | The **"deterministic watch layer"** contract: watchers "never host, launch, resume, steer, or poll model sessions." That is precisely this script's boundary. |
| `loop-engineering` | The Required Loop Spec vocabulary below, and the `board-sync-loop` name. |

### Relationship to `stale-blockers.ts`

Both stay. They answer different questions:

- `issue-graph.ts` — *what is workable*, from declared dependencies.
- `stale-blockers.ts` — *what references closed work*, from prose.

The second is now best read as a **graph-gap detector**: an issue it flags that
the graph does not show as unblocked means the prose and the declared edges
disagree, which is worth a look. Retiring it is a later decision, not this one.

## Loop spec

Per `_ob/skills/loop-engineering/_DOCS/procedure.md` ("Required Loop Spec").
Recorded so the wake condition is designed rather than assumed.

- **name**: `issue-graph-loop` (an instance of `board-sync-loop`)
- **trigger**: UNDECIDED — see "Open questions"
- **state read**: live `gh issue list` (open + all states); never a cached
  mirror, never `_plans/issues/`
- **allowed actions**: parse declarations; report; write native `blocked_by`
  edges only under `--chart --write`
- **required receipts**: edge counts, both frontier sizes, native-graph counts
  before/after; printed every run
- **handoff signals**: the frontier is the input to a swarm or a controller's
  lane decomposition
- **human stop conditions**: any close/merge decision; any edge the dry run
  shows that the operator has not seen; a parse the operator disputes
- **memory update**: this document; OB capture when the graph shape materially
  changes
- **next wake condition**: UNDECIDED — see "Open questions"

## The companion loop: catching bad decisions while they are still cheap

The issue graph answers *what is workable*. It does not answer *what did we get
wrong on the way here* — and that is the more expensive question.

Operator, 2026-08-07:

> "if we run [the decisions skill] and then we do the pro/con analysis, we find
> a lot of the random things that we thought were good ... that might not have
> been the best decisions and we can fix them in real time before they become
> super bad tech debt that has to be completely pulled out and reorganized and
> redone."

Two existing skills compose into that loop:

1. **`_ob/skills/decisions`** — retrospective low-confidence disclosure. It is
   the only decision skill in the fleet that fires *after* work: *"every other
   decision skill fires before implementation. This one surfaces the silent
   judgment calls already baked into finished work, so review attention lands
   on the 4 choices inside the diff instead of the 2,000 lines around them."*
   The confidence filter is the mechanism — "all choices" yields a changelog,
   "only the ones you are really unsure about" yields a review target.
2. **`_ob/skills/pro-con-analysis`** — takes a surfaced low-confidence call and
   re-opens it properly: detect the decision point, enumerate genuinely
   different alternatives, score on effort/maintainability/risk/fit, recommend
   with reasoning (`_DOCS/procedure.md` Steps 1-4).

`decisions` finds the guess; `pro-con-analysis` settles it. Done while the work
is fresh, the fix is an edit. Done six months later, it is a migration.

### It runs at the end of every run, and it is read WITH the operator

This is not something the agent does to itself. Operator, 2026-08-07:

> "at the end of each run we run decisions and then we go through it. It's not
> meant for you to do by yourself. It's meant to make sure that the project
> stays on track and we don't start doing silly things for silly reasons."

So the cadence is fixed — **end of every run** — and the output is reviewed
together, not filed. That is what makes it a **review gate rather than a
self-report**, and it is why `decisions/SKILL.md` marks the skill
**MANUAL-ONLY**: *"It must never auto-fire — as a required step it degrades
into noise."*

Those two facts are not in tension; the second protects the first. An
auto-fired disclosure becomes a form the agent fills in and nobody reads. A
fixed end-of-run cadence with a human reading the answers is the opposite. The
agent that made a questionable call is the last one who should be allowed to
rule on it — which is precisely the "silly reasons" failure mode.

Practically: at the end of a run, invoke `/decisions`, read the low-confidence
calls out loud, and route any that matter into `pro-con-analysis` before the
next run builds on top of them.

## Ledger

Per `_ob/skills/what-did-i-not-ask/_DOCS/grill-with-docs-procedure.md` §124.
Item → state → where the resolution is written. Deferred items are marked
deferred, never silently dropped.

| # | Item | State | Resolution |
|---|---|---|---|
| 1 | Does an open parent epic block its children in the frontier? | **resolved** | No. Frontier lines carry an epic tag instead. This doc, "Hierarchy is not blocking". Script change PENDING. |
| 2 | Keep the loose mid-sentence `Blocked by` parser pattern? | **resolved** | Yes — measured 0 false edges across 337 issues. `docs/sme/gotcha-agent.md` [2026-08-07]. Visibility section PENDING. |
| 2b | The `Depends on` pattern also matches mid-sentence prose | **open** | Found by the item-5 probe, not by the item-2 measurement — which only covered `Blocked by`. #393 yields 3 prose-derived edges from "this issue depends on the capture and promotion path actually running (#380, #382, #389)". Those edges are **semantically correct**, which is the problem: the pattern cannot distinguish a real prose dependency from an incidental mention. Needs the visibility treatment before charting. |
| 3 | Where does the design record for 1 and 2 live? | **resolved** | This doc IS the home. Per grill-with-docs §107 (amend the owning doc; do not scatter) and operator confirmation 2026-08-07: no separate record. In the same ruling the operator re-confirmed item 1 in his own words: "the whole idea of the graph pattern breaks down if you can't work on child issues unless the overriding epic is done." |
| 4 | Is "implements an existing standard" an honest framing? | **resolved** | Existing patterns reused deliberately AND a new paradigm on top. Both true, no hedge. This doc, "Relationship to existing skills". |
| 5 | Prove the `--chart --write` path? | **open** | Untested. `dbId()` verified working (#435 `5002073011`, #436 `5002075939`). 5 edges pending. |
| 6 | Where does the script and doc get committed? | **resolved** | Operator 2026-08-07: own branch (`feat/issue-graph`), committed, then merged back into the wip branch "so every work in progress branch moving forward will then have it." |
| 10 | RLVR trial target | **resolved** | #598 (provider CLI exits 0 with no receipt — itself an agent-lies-about-done bug). Write its executable `done_means` check FIRST, then fix, then the checker declares done. Operator approved 2026-08-07. |
| 11 | Consolidate open branches and worktrees to one starting point | **resolved** | Done 2026-08-07. 46 remote branches with squash-MERGED PRs deleted (verified per-branch against PR state; zero unique work lost), 39 stale local tracking refs cleaned, local main fast-forwarded 26 commits to d3fdc8a. Remaining, all deliberate: main, wip/2026-08-05-session, feat/issue-graph (this work), salvage/pre-squash-unique-work-2026-08-02 (archive), fix/604 (open PR #606 + fix-606 worktree), fix/81 (open PR #592). Needs-decision leftovers reported, not touched: local archive/pre-rewrite-20260731; closed-unmerged PR heads #476/#477 existed only as stale tracking refs (already gone on server). Lane finished by a delegated worker; its flag recorded: the design-lookup gate fires on plain git branch ops, costing two turns per cleanup lane — possible hook tweak, operator's call. |
| 7 | What wakes the loop? | **deferred** | Deliberately unwired until the graph has been watched. See "Open questions" below. |
| 8 | Build project-specific agents for known repeated work? | **open** | Candidates and their state in "Agent candidates" below. None built yet. |
| 9b | RLVR-style verifiable completion contracts on frontier tickets | **open** | Operator direction 2026-08-07, grounded in Nate B Jones' false-success video (agents report done when work never happened; RLVR training rewards the FORM of correctness over the result). Delta proposed: each dispatched ticket carries an executable `done_means` check (command + expected result); a deterministic runner — not the worker — declares done. Reuses `claim-verifier` (global) for post-hoc judging; the authoring discipline ("know what good looks like BEFORE dispatch") becomes a repo-local skill. Vet here, then candidate for global standard. Touches parked #402 (SHAPE-2, where assertions live): a local ticket field needs no ruling, but global promotion would BE the #402 answer and must formally unpark it. |
| 12 | Adopt frontier + RLVR lanes as the DEFAULT operating mode for this repo? | **resolved** | Yes — operator, decisions pass 2026-08-07, after the first at-scale run (PRs #609/#610/#611). Evidence that decided it: the #609 lane's false "pre-existing" claim was killed pre-merge by its own contractual full-suite proof (main 3701/0, branch 3701/1, fixed 3702/0); the #598 checker exposed a stale issue-half before a fix was written; the #610 rollout lane corrected the controller's own briefing (contract delta narrower than stated). Cost accepted: ~100–200k tokens per lane plus duplicated controller verification. Small work stays INLINE per the existing classification. |
| 13 | Fix the SME parallel-append conflict (3 manual union merges of `docs/sme/correctness.md` in one night)? | **resolved** | One file per entry under `docs/sme/entries/`, lane files become generated indexes rebuilt by script. Operator, decisions pass 2026-08-07. Conflicts become structurally impossible; entries get stable citable IDs. Build dispatched as a lane. |
| 14 | Stop PR-body validator failures being learned by punishment (3 lanes, 3 different format failures, 3 CI round-trips)? | **resolved** | Layered, operator 2026-08-07: deterministic floor (PR template generated FROM `scripts/validate-pr-body.ts`'s own field list + local validator run before `gh pr create` in every lane briefing) PLUS a repo-local `pr-scribe` agent that composes body content from lane evidence and ends by running the validator. The script never trusts the agent; the agent wraps the script. |
| 15 | Build a lane-bootstrap script (worktree + `.env` + frozen install + optional fresh test DB)? | **resolved** | Yes — operator, decisions pass 2026-08-07; the 3-4 rule was passed (~5 hand-bootstraps in one night, each hitting missing `.env`/`bun-types`/swallowed exit codes). Constraint: the script must carry a stated reason for the worktree (worktrees-need-a-reason rule stays intact) and never creates silently. Teardown deliberately NOT scripted: `git worktree remove` per AGENTS.md remains the manual, agent-owned cleanup. |
| 16 | Decisions review of the tooling pass (items 13–15 as built) | **resolved** | 2026-08-08 with the operator. (1) Template tripwire-not-generator deviation RATIFIED — the lane measured before deviating. (2) SME pinned entry count KEPT — silent-drop protection outweighs addition friction; first addition (227) already exercised the procedure successfully. (3) 63-byte DB-name handling acknowledged WITH a ruling that generalized: "anything silently is an unacceptable outcome" — nothing is adjusted silently, codified in AGENTS.md Coding Standards + SME entry 2026-08-08, first fix PR #619 (merged). |
| 17 | pr-scribe/PR-body enforcement: advisory or forced? | **resolved** | FORCED, repo-local. Operator 2026-08-08: "if it's not enforced, it's pretty much useless. Everything that's not enforced eventually gets unused... If I don't hammer it into you and force you to use it, eventually you'll decide that it's not useful and you won't." A repo-local PreToolUse hook gates `gh pr create`/body edits behind `scripts/validate-pr-body.ts`; CI stays the backstop. Global promotion deliberately deferred. Build dispatched as a lane; the hook must judge by PARSED ARGUMENTS, not text matching — #618 is the standing example of a text-matching guard taxing every lane. |
| 18 | Opus 5 vs Opus 4.8 worker A/B | **open** | Trial authorized and started 2026-08-08. Repo-local `.claude/agents/worker-48.md` pins `claude-opus-4-8` (requested-model provenance only; self-reported model line recorded as weak evidence). Round 1 assignment: hook lane + #613 on Opus 5; #612 + #614 on Opus 4.8. Compare on: false claims caught vs shipped, gate compliance, CI round-trips, token cost. Outcome lands here and, if it earns a route, in `_DOCS/MODEL_ROUTING.md` "Worker Runtime Preference & Comparison". |
| 19 | The ratchet: every lane run improves the system | **resolved** | Operator directive 2026-08-08: learn from each lane run, add it to the agent/contract/gates, and document how — so each dispatch starts stronger than the last. Mechanism: `docs/lane-contract.md` — the single briefing source lanes are pointed at, with a dated Tightenings changelog. Harvest is a MANDATORY merge-pass step: a lesson in a lane report that is not in the changelog is a defect of the merge pass that accepted the report. First harvest committed same day (11 entries from PRs #615–#621). |
| 9 | Adopt King Capital's SME growth model (curation gate)? | **open** | Operator, 2026-08-07: the KC concept is "good and sound," the implementation lacking. Verified both halves: KC separates raw candidate findings from operator-promoted `verified/` (promotion Rico-only via CODEOWNERS) and adds technique cards + injection audit — but gitignores the working files (knowledge unversioned, `agent-sme/REPO-README-TEMPLATE.md:3`) and builds on the retired PAI runtime (`~/.config/pai/Skills/`). This repo is the inverse: findings tracked and versioned in `docs/sme/`, but NO curation gate — agent entries flow straight into injected reviewer knowledge. The live case: three entries written to `gotcha-agent.md` today, uncurated. Candidate delta: keep open-brain's in-repo tracked files, add KC's candidate→promote split. Not built; operator decision. |

## Rejected and superseded

Recorded on purpose. An option rejected with no written reason gets
re-proposed by the next agent, and a superseded design that was silently
dropped reads as one that was never considered. Same rule
`docs/decisions/README.md` applies to design records and `AGENTS.md` applies to
SME entries: mark it, do not delete it.

| Option | Verdict | Why |
|---|---|---|
| **Frontier B — hierarchy blocks its children** | rejected 2026-08-07 | Deadlocks by construction. An epic closes BECAUSE its children land, so #389 and #390 would wait on each other forever. Measured: withholds 9 independently buildable issues (#390, #395, #396, #397, #399, #413, #414, #416, #417). |
| **Filter parked issues out of the frontier** | rejected 2026-08-07 | Operator ruling: parked-by-design is meaningful and belongs in the output. Hiding #400's children is the exact loss #400 was filed to prevent. Superseded by treating parked as a first-class state with its reason attached. |
| **Negation guards on the prose patterns** (`not blocked by`, `was blocked by`) | rejected 2026-08-07 | Dead code. Measured across 337 issues: zero negations exist in this repo's entire history. Guarding a phrasing that has never occurred, while the real risk was elsewhere. |
| **Drop prose patterns entirely, strict fields only** | rejected 2026-08-07 | Loses #437's and #393's genuine dependencies. The graph would be knowably incomplete. Superseded by the `LOOSE MATCH (verify)` quarantine, which keeps them visible without charting them. |
| **Line-anchoring as the field-vs-prose signal** | superseded 2026-08-07 | Wrong signal. #393 and #384 wrap sentences such that "depends on ..." begins at column 0, so a line start is a formatting accident, not authorial intent. Replaced by the COLON (`Depends on:`) plus the bold-label form. |
| **Move the whole doc into `docs/decisions/`** | rejected 2026-08-07 | Measured: that directory holds 15 rationale records and documents no tools. Tool manuals with usage blocks live at top-level `docs/` (`backup-restore.md`, `local-clone-dogfood.md`, `collab-retirement-preflight.md`). |
| **Mock `gh` and unit-test the write path** | rejected 2026-08-07 | Proves the mock, not the API. The real risk was GitHub's request shape, which only a live call settles. Superseded by the single reversible probe edge, which found the field-vs-prose defect a mock never would have. |
| **Sub-agents to investigate the write path** | rejected 2026-08-07 | Would produce several opinions about an API none of them had called. Single-fact questions are measured, not deliberated. The operator's parallel-investigation instinct is right for multi-route questions — this was not one. |
| **A `SessionStart`-only hook for the loop** | superseded 2026-08-07 | The operator runs one long session for hours, so a start-only trigger goes silent for the entire working window — reproducing the loop this tool exists to break. Folded into the open wake-condition question (item 7). |
| **PR-format agent WITHOUT the validator script** (item 14) | rejected 2026-08-07 | Moves the memory problem one level up instead of solving it: format compliance living in an agent's knowledge is exactly what three lanes disproved in one night. Deterministic script at the boundary; the agent only composes content. |
| **Scripted lane teardown** (item 15) | rejected 2026-08-07 | Operator chose bootstrap-only. Teardown stays the standard manual `git worktree remove` — a cleanup script that removes things it may not have created is a bigger risk than the friction it saves. |
| **Adopt-on-trial for the operating mode** (item 12) | rejected 2026-08-07 | "Trial" modes drift because nobody schedules the re-review; the ledger exists to record a real decision, and the companion decisions/pro-con loop already provides the standing re-examination a trial pretends to. |

## Agent candidates

Per the 3-4 rule (`docs/sme/gotcha-agent.md` [2026-08-07]): repetition is the
trigger, counted rather than predicted. Recorded now, built later — building
three untested agents would repeat the ship-on-theory mistake this session
spent its length correcting.

| Candidate | Times done by hand | Scope | State |
|---|---|---|---|
| `design-conversation` | 5 this session, **skipped 3** | grill-with-docs interview discipline, pro-con-analysis, `/decisions`, the three-part ADR test | **candidate** — genuinely global-shaped; travels to any repo |
| `issue-graph` | 3 parse/probe rounds | this repo's declaration conventions, the #437/#393 ambiguity, frontier semantics, charting boundary | **candidate** — genuinely repo-local |
| `repo-search` | 6 (`aqmd` gate satisfaction) | aqmd/qmd routing, fast-tools rules | **probably not an agent** — deterministic enough to be a script; see the mechanism hierarchy note below |
| `pr-scribe` | 3 format failures + 3 body compositions this run | composes PR body (self-review receipt, SME disposition, rollout classification) from lane evidence; final step runs `scripts/validate-pr-body.ts` and only returns a passing body | **decided** — ledger item 14, 2026-08-07; build dispatched with the item-13/15 lanes |

The measured problem an agent solves here is **discovery, not knowledge**. With
~60 skills listed in context, a skill is a document that must first be
remembered to be read; this session failed at exactly that step, improvising a
grilling procedure while `grill-with-docs` sat on disk. An agent replaces a
recall problem with a single invocation decision, and brings its own context
boundary.

The boundary of the idea, recorded so it is not overreached: **an agent does not
fix forgetting to invoke it.** For anything that must never be skipped, a hook
still wins, because a hook fires whether or not the agent remembers — which is
what `.claude/hooks/design-lookup-gate.ts` demonstrated repeatedly during this
session. Agents own *the right way to do a class of work*; hooks own *you may
not skip this*.

## Open questions

Genuinely undecided. Recorded rather than guessed.

1. **Where does it run automatically?** `SessionStart` fires on `startup`,
   `resume`, `clear`, and `compact`, but the operator runs one long session for
   hours, so a start-only hook goes silent for the entire working window —
   which is the loop this exists to break. Candidates: `SessionStart` for
   hydration, the standing scribe run for long-session coverage, and an
   after-something-closes trigger (the real state transition). **Deliberately
   unwired until we have watched it run and measured how often the graph
   actually moves.**
2. **Should hierarchy be written as native sub-issue links?** Currently
   reported only. Writing them would make GitHub's UI show the real tree, but
   15 issues already have a parent and the interaction with existing links is
   unverified.
3. **Does `stale-blockers.ts` become a graph-gap detector, or retire?** Depends
   on whether the charted graph proves complete enough to stand alone.

## Extending the parser

`DECLARATIONS` in `scripts/issue-graph.ts` holds the patterns. Two real misses
were found and fixed on the first live run — a useful record of what this class
of parser gets wrong:

| Miss | Why | Fix |
|---|---|---|
| #347 `**Depends on:** #344, #345, ...` | Bolded label; the pattern required a bare label | `\*{0,2}` around the label |
| #437 "Blocked by #435 and #436." mid-paragraph | Line-anchored only; the declaration was inside prose | A scoped unanchored `Blocked by` pattern |

Effect: 46 → **59** edges parsed, `depends` 7 → **18**.

When adding a pattern, keep the discipline that makes this better than the old
regex: **a bare `#NNN` is never a declaration.** Match a labelled relationship
or an explicit blocking phrase, never a passing mention. Then re-run read-only
and diff the frontier before charting anything.
