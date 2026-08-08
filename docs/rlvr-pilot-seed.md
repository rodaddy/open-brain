# RLVR Lane Seed — how to run this process in another repo or session

Status: WRITTEN 2026-08-08. This is the portable core of open-brain's
operating mode (`docs/sop-rlvr-lanes.md`), extracted for the second-repo
pilot the SOP's expansion path calls for. Hand this file (or its text) to a
head session in another repo as its operating brief. It deliberately names
NO open-brain scripts: the pilot re-derives its own tooling against its own
validator, CI, and hooks — what must survive the move is the shape.

## The shape (memorize this paragraph)

Work is dispatched to worker lanes from a computed or explicit frontier.
Each lane carries an EXECUTABLE definition of done written BEFORE the work
and proven able to fail (run RED first). A deterministic checker — never
the lane — declares done; the controller re-runs the check independently
before merge. Every refusal, workaround, self-caught defect, and surprise
in a lane's report is harvested into the repo's briefing contract before
the next dispatch, so every dispatch starts stronger. Judgment calls are
recorded in a decisions ledger with rejected options, and reviewed WITH the
operator, one item at a time. Nothing is adjusted silently. No variations:
a deviation is flagged for a ruling, and a broken process step fails HARD
and gets fixed through the decisions loop — never worked around.

## The six roles (create one file/dir each in the pilot repo)

1. **Lane contract** (`docs/lane-contract.md`) — standing rules every lane
   is pointed at, plus a dated **Tightenings** changelog. THE RATCHET: a
   lesson in a lane report that is not harvested here is a defect of the
   merge pass that accepted the report. Seed the standing rules from the
   list below; start the Tightenings empty — the pilot's entries must be
   about ITS boundaries.
2. **Controller contract** (`docs/controller-contract.md`) — binds the HEAD:
   dispatch = task + deliverable + done-means design + route + ONE pointer
   to the lane contract + the required report format. The head never
   absorbs lane work (verification runs, diagnostics, conflict resolution
   are lanes). Obligations are labeled ENFORCED (a hook/script refuses) or
   AUDITED (checklist), with a standing migration: audited obligations
   become enforced as their patterns stabilize.
3. **Done-means checks** (`scripts/done-means/` or equivalent) — one
   executable file per claim class. Rules that earned their place:
   red-first always; re-prove RED after ANY edit or inversion of a clause;
   every failure-signal check needs a control clause proving the healthy
   path stays healthy; every exception mechanism needs a negative control
   (inject a violation, confirm it still fails); prefer injected clocks and
   event counts — wall-clock assertions are flake generators; mutation-test
   any clause whose PASS comes from a negative match.
4. **Decisions ledger** (a table in a tracked doc) — item → state →
   resolution WITH rejected options and reasons. Reviewed with the
   operator; nothing resolved solo. A ruling that retires a mechanism
   ships its own done-means check on the same pass, or record and tree
   drift silently.
5. **Report format** (in the controller contract) — every lane returns
   EXACTLY these fields, in order: self-reported model / branch / pr /
   red / green / root-cause / deviations / refusals-and-violations /
   teardown / claim-states / lessons. A missing field sends the report
   back. Self-reported violations are harvested, never punished; burying
   one is the offense.
6. **Truth grammar** — every claim everywhere carries RUNNING (observed
   live this session) / MERGED (in main, unproven live) / WRITTEN (on
   disk) / PROPOSED (stated). A subagent's confident output is PROPOSED
   until the controller's own run passes. "Merged to my branch" is not
   merged.

## The head-session loop

1. Frontier: what is workable now (computed from issue dependencies, or an
   explicit operator list).
2. Dispatch lanes: brief = task, non-goals, done-means DESIGN, report
   format, pointer to the lane contract. Direct and succinct; bounded
   deliverables.
3. Verify: re-run each lane's check independently in a fresh checkout
   (delegate to a verifier agent if one exists — the head reads receipts,
   not scripts). Worker output is PROPOSED until this passes.
4. Merge pass: merge; issues close by keyword or get an evidence comment
   naming what remains; new defects found by lanes become issues, never
   absorbed fixes.
5. Harvest (MANDATORY): lane lessons → Tightenings, with provenance,
   before the next dispatch.
6. Decisions pass WITH the operator: deviations ratified or reversed, one
   item at a time, TL;DR each, recorded with rejected options.
7. Wrap: dirty-state reconciliation, index refresh, worklog.

## Enforcement ladder (in order of preference — cheapest that holds)

permissions.deny (never run this) → environment (make the right thing the
default) → hook (only when the decision needs context a pattern cannot
express; judge PARSED intent, never vocabulary — word-matching guards tax
every lane and train route-around behavior) → prose (judgment calls, and
recording WHY a mechanism exists). Unenforced rules decay: migrate what
matters up the ladder as soon as its pattern is stable. Two gates that
proved the model: a PR-body validator wired to a PreToolUse hook (invalid
bodies impossible at the boundary, CI as backstop), and a merge gate that
refuses merge without (a) an independent verification receipt bound to the
CURRENT head SHA and (b) harvest proof.

## Traps already paid for (do not re-buy)

- A guard a repo commits cannot protect a run that checks out an older
  commit; a gate must judge the version under judgment, not the primary
  checkout.
- A done-means clause can silently measure its own harness (optional
  chaining on a missing method; `rg -E` flag errors reading as
  "not found" inside elif chains; a top-level `await main()` with no
  `.catch` exiting 0 on crash). A green clause is not evidence until it
  has been seen to fail.
- A check that exercises its own tooling inherits that tooling's ambient
  environment — clear it, or the check measures the guard and reports the
  wrong cause.
- Shared mutable test state makes full-suite counts non-evidence; use a
  fresh isolated database/environment per run.
- Placeholder sweeps: a literal that anything compares to reality is
  BEHAVIOUR, not an example. Check the SKIP count after any sweep, not
  just the pass count.
- Merges: a conflict-free merge is not a clean merge — re-run the branch's
  own checks after merging the default branch. Generated files in conflict
  are regenerated from inputs, never hand-merged.
- The stash stack is shared even in a private worktree; lanes use
  file-copy for red/green proofs, never `git stash`.
- Verify which tree the process actually RUNS before reading source as
  truth (`lsof` on the port, `ps` on the pid).
- A recorded ruling is not an implemented one — nothing fails until a
  check asserts the implementation.
- Model pins through agent-definition frontmatter may not bind; quality
  tracks the CONTRACT (tight brief + verifiable output), not model choice
  (operator ruling, ledger item 26). Requested-model provenance is never
  attestation — lanes self-report, controllers treat it as weak evidence.
- A deploy's revision proof is not a feature-live proof. After any deploy
  meant to light up a feature, read the FEATURE's own signal (its /health
  block, its log event), never just the revision. When a merged feature
  fails in deployment, ask which seam the passing check could not see.
- A teardown/cleanup that reports success is not evidence of removal —
  the tally is the thing under test. Assert a row/file COUNT from outside
  the run.
- A live-service check reads the SERVING process's credentials, never the
  checkout's; and a security control is unproven until something REQUESTS
  the forbidden thing and is refused by name.
- A ruling that enumerates items from a log or report inherits that
  filter's classification errors — a lane validates each enumerated item
  against source before implementing, and HOLDS AT PROVEN RED to escalate
  when the premise is wrong, rather than obeying or deviating silently.
- Errors must name what the caller can change. An error naming an
  internal key the caller has no way to send is a dead-end; fixing one
  case of it (mismatch) does not fix its sibling (absent) — enumerate the
  cases at the boundary.

## Adopted amendments (2026-08-08 — from the first pilot's own friction report)

The first factory pilot ran one session inside this process and sent back
four honest frictions (the AUDITED honor system, flat-priced ceremony,
head-absorption gravity, ratchet scroll) plus fixes. Operator-ratified the
same day (open-brain ledger item 27); a pilot should build these in from
day one rather than rediscovering them:

- **Validate the report as a schema, not prose** — a small script refuses
  a report with missing fields, a RED lacking real nonzero-exit output, or
  claims outside claim-states. The first obligation to enforce.
- **Bind the harvest mechanically** — if the accepted report's lessons ≠
  none, merge refuses unless the diff actually touches the lane contract.
- **Own landing as a machine verb** — validate→push→PR→verify→merge→
  teardown as one command; the head approves, the machine lands. Dissolves
  head-absorption instead of policing it.
- **Tier ceremony by blast radius, not size** (T0 none / T1 five-field +
  one receipt run / T2 full graph), with the tier declaration itself
  auditable.
- **Give the ratchet a graduation valve** — a bounded live-entry set;
  overflow graduates the most stable entry into a check or ledger row.
  The check is the memory; prose is the nursery.
- **Random audit** — ~1-in-5 merge passes, an auditor lane checks an
  already-accepted report's "deviations: none" against its transcript.
  Backstop behind the schema validator, never the primary control.

## What success looks like for a pilot

The shape holds without open-brain's tooling, and the pilot's first
harvest entries are about ITS boundaries (its validator, its CI, its
gates) — not fights with the process itself. Promotion to Development-wide
canon (`_DOCS/`, `_ob/skills/`) happens only after that evidence exists —
nothing goes canon on one repo's word.
