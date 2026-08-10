# SOP: RLVR Lane Operation (open-brain)

Status: WRITTEN 2026-08-08; the operating mode it describes is RUNNING —
adopted as this repo's default by operator decision (ledger item 12,
`docs/issue-graph.md`) after a measured first run, and made the norm by
operator directive the same day. This SOP exists so a head session that did
not live the adoption operates the same way as one that did.

Scope: this repo, now. The expansion path to Development-wide `_DOCS/` and an
`_ob` skill is at the bottom — deliberately staged, per the standing rule that
things are sussed out repo-local before they live forever.

## No variations (operator ruling, 2026-08-08)

This process is the default standard, used all the time. There are no ad-hoc
variations: a session does not improvise a lighter version, skip verification
because a change "looks safe," or route around a gate because it is
inconvenient. Exactly two sanctioned paths exist when the process and reality
disagree, and both are IN the process:

1. **A deviation is flagged, not taken silently** — implement the better
   behavior if the case is strong, name the recorded decision it touches, and
   request a ruling (the ledger item 20 model). The ruling updates the
   process.
2. **A broken process fails HARD** — if a required step cannot be executed
   (gate down, tooling broken, contract contradiction), the work STOPS at
   that step and the failure is reported. Fix the process through the
   decisions loop, then resume. Working around a broken step and shipping
   anyway is the one unrecoverable variation, because it converts the
   process's guarantees into decoration.

## The shape in one paragraph

Work is dispatched to worker lanes from a computed frontier, each lane
carrying an executable definition of done written BEFORE the work and proven
able to fail (run RED first). The lane delivers a PR plus transcripts; a
deterministic checker — never the lane — declares done; the controller
re-runs the check independently before merge. Every deviation, refusal, and
self-caught defect in the lane's report is harvested into the briefing
contract so the next dispatch starts stronger. Decisions and their rejected
alternatives are recorded in a ledger and reviewed WITH the operator, one
item at a time.

## The parts and where they live

| Part | File | Role |
|---|---|---|
| Frontier + ledger | `docs/issue-graph.md`, `scripts/issue-graph.ts` | what is workable now; decisions + rejected options |
| Lane briefing contract | `docs/lane-contract.md` | standing rules + dated Tightenings changelog (the ratchet) |
| Controller contract | `docs/controller-contract.md` | binds the HEAD: dispatch rules, required lane report format, verification/harvest obligations, enforcement migration |
| Done-means checks | `scripts/done-means/` | executable acceptance, red-first, checker declares done |
| Lane environment | `scripts/lane-bootstrap.ts` | one-command known-good worktree/env/DB; stated reason required |
| PR-body enforcement | `.claude/hooks/pr-body-gate.ts` + `scripts/validate-pr-body.ts` + `.github/pull_request_template.md` | invalid bodies impossible at the boundary; CI backstop |
| Review knowledge | `docs/sme/entries/` + generated lane files | reviewer-facing lessons, one file per entry |
| Verifier agent | `.claude/agents/verifier.md` | classifies a change against known classes and runs the covering done-means checks; produces receipts, gates nothing |
| Tracking-scribe agent | `.claude/agents/tracking-scribe.md` | OWNS step 5 (harvest) and the standing issue-mirror run; writes graph state to the ROOT checkout only; report-and-mirror, never closes or merges |
| Truth grammar | RUNNING / MERGED / WRITTEN / PROPOSED | every claim, everywhere (LAW 0) |

### Verifier agent

`.claude/agents/verifier.md` (built 2026-08-08, ledger item 8 — the first agent
candidate to graduate). It exists because step 3 of the loop below was being
done by hand every time: work out which class of change this is, remember which
check covers that class, run it, read the exit code.

Its design is deliberately thin. Its **brain is files, read fresh every
invocation** — `docs/sme/entries/` (the `Scope key:` lines are the known-goods
matrix), `docs/lane-contract.md` (the Tightenings), and `scripts/done-means/`
(the toolbox). Its **hands are deterministic scripts only**: it runs checks and
reads exit codes, and never re-implements a check's logic in prose. The
consequence worth stating: **every check merged into `scripts/done-means/` is
automatically a new tool for it, so its capability grows without its definition
changing.**

It works in tiers — known class with a covering check (run it, cheap); known
class with no check (partial coverage, gap named); or `NOVEL CLASS`, announced
loudly and punted to the head. That last path is never an error to take. The
design has exactly one failure mode — forcing an unfamiliar change into a known
class and returning a green receipt that proves nothing — and the loud unknown
is the only thing standing against it.

**It is not enforcement.** Agent produces, script judges, hook enforces. The
receipt it emits is evidence; the merge gate demands a receipt that came from
an executed script. `scripts/done-means/verifier-agent-grounded.sh` gates the
definition itself: committed and visible in a fresh clone (the `.gitignore`
`.claude/*` trap), every referenced path resolving, and the guardrail,
loud-unknown, and three brain sources still present.

### Tracking-scribe agent

`.claude/agents/tracking-scribe.md` (built 2026-08-10, ledger item 8). It exists
because step 5 below had no owner: harvest was described as an inline controller
action, so it was absorbed by the head — the recorded failure of controller
obligation 6 — and the tracking run itself lived only as a paste-in prompt the
operator re-sent by hand ("TRACKING SCRIBE run for...").

A prompt that is retyped from memory drops its own guardrails, and the one it
kept dropping is where the writing goes. `aqmd up` indexes the ROOT checkout
only, so a coordination file written in a lane worktree is invisible to search —
functionally deleted from the knowledge base. Measured 2026-08-10: three copies
of `docs/lane-contract.md`, none a superset, 164 lines of harvest rounds
stranded (`_plans/worklog/reconcile-root-2026-08-10.md`). The agent's FIRST law
is root-only-writes with that reason stated in the definition, so the constraint
travels with the entity that does the writing.

Two jobs, both bookkeeping: the **standing run** (`scripts/sync-issues.ts`
refreshes the `_plans/issues/` mirror, `scripts/stale-blockers.ts` reports
candidates, commit `_plans/issues` by explicit path, `aqmd up`) and the
**harvest** (lanes' returned learnings routed to `docs/lane-contract.md`
Tightenings, `docs/sme/entries/`, and the `docs/issue-graph.md` ledger).

**It is report-and-mirror only.** It never closes an issue, never merges, never
deletes. Stale-blocker output is a candidate list handed to the controller, not
a verdict. Boundaries with its neighbours: the controller decides and dispatches,
lanes write code, the verifier judges, `pr-scribe` writes PR bodies, and this
agent writes repo state.
`scripts/done-means/tracking-scribe-root-only.sh` gates the definition itself:
committed and visible in a fresh clone (the `.gitignore` `.claude/*` trap), the
root-only law FIRST and carrying its `aqmd` reason, the never-close/never-merge
boundary stated, the three harvest targets named, and this SOP still naming the
agent as the harvest owner.

## The head-session loop

1. **Frontier**: `bun scripts/issue-graph.ts` — workable now, parked (with
   reasons, first-class), blocked (native edges only).
2. **Dispatch**: worker lanes via the routing policy; the briefing states the
   task, deliverable, and done-means design, and POINTS at
   `docs/lane-contract.md` for everything else. Done-means check written
   red-first by the lane; controller states the check's design in the
   briefing.
3. **Verify**: on each lane report, the controller re-runs the done-means
   check in a fresh worktree (`lane-bootstrap`). Worker output is PROPOSED
   until this passes. CI green (or failures proven main-owned with the
   full-suite differential on fresh databases) is required alongside.
4. **Merge pass**: squash-merge, branch dies, issues close by keyword or get
   an evidence comment naming what remains. New defects found by lanes become
   issues (with native blocked-by edges where they block).
5. **Harvest (mandatory)** — **owned by the `tracking-scribe` agent**
   (`.claude/agents/tracking-scribe.md`), dispatched by the controller. Refusals,
   workarounds, self-caught defects, and surprises from every lane report go
   into `docs/lane-contract.md` Tightenings with provenance. A lesson in a
   report that is not harvested is a defect of THIS step. Review-facing lessons
   also become `docs/sme/entries/` files; rulings and rejected alternatives go
   to the `docs/issue-graph.md` ledger. All of it is written to the ROOT
   checkout and indexed with `aqmd up` — see the agent's first law for why a
   worktree write is functionally a deletion.
6. **Decisions pass, WITH the operator**: judgment calls made since the last
   pass — deviations ratified or reversed, new rulings generalized — one item
   at a time, TL;DR each, recorded in the ledger with rejected options and
   reasons. Never run solo.
7. **Wrap**: dirty-state reconciliation, `aqmd up`, worklog.

INLINE remains correct for conversation, single exact lookups, and tiny
deterministic single-file changes. The lanes are for work with a definable
end state.

## Why each part is load-bearing (measured, first two runs)

- Red-first checks: killed a false "pre-existing" claim before merge (PR
  #609's lane retracted with a 3-way full-suite proof); exposed a
  stale-by-cutover issue-half (#598) before a fix was written for it.
- Controller re-verification: corrected the controller's own briefing (PR
  #610's rollout lane found the contract delta narrower than briefed) — the
  verification points both ways.
- Boundary enforcement: three lanes failed PR-body format three different
  ways on night 1; after template + local validation + hook, night 2 had
  zero format round-trips.
- The ratchet: a validator lesson learned by one lane was in the next lane's
  briefing within a minute; night-1 environment friction (missing .env,
  deps, swallowed exits) is a one-command bootstrap on night 2.
- Decisions loop: ratified a justified deviation (template tripwire), kept a
  deliberate friction (pinned SME count), and generalized one observation
  into a standing rule (nothing-silent) — none of which a gate could decide.

## Expansion path (staged, operator-gated)

1. **Now — open-brain norm.** This SOP + AGENTS.md pointer. Done.
2. **Pilot in a second repo.** What transfers is the DISCIPLINE (red-first
   done-means, checker-declares-done, controller re-verification, harvest
   ratchet, decisions loop) — not this repo's scripts. The pilot repo gets
   its own lane-contract.md seeded from this one, its own done-means/
   directory, and re-derives its gates against its own validator/CI. Success
   looks like: the shape holds without this repo's tooling, and the pilot's
   first harvest entries are about ITS boundaries, not fights with the
   process.
3. **Promote to Development canon.** After the pilot proves transfer: the
   discipline becomes a `_DOCS/` SOP (referenced from AGENT_WORKFLOW.md),
   the reusable authoring guidance becomes an `_ob/skills/` skill with thin
   runtime adapters, and global agent candidates (the grill-with-docs-shaped
   ones) get built per the operator's earlier ruling. RLVR ticket-field
   promotion formally unparks #402 (ledger item 9b). Nothing goes canon on
   one repo's evidence.

Rejected on purpose: promoting straight to `_DOCS/` tonight (one repo, two
runs, is exactly the ship-on-theory pattern the ledger warns about); a
global always-on agent for the loop (unenforced-becomes-unused applies to
agents too — the enforcement lives in repo-local gates a session cannot skip).
