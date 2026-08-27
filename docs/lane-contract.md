# The Lane Contract

Status: WRITTEN 2026-08-08, adopted by operator directive the same day —
"every time we tighten it, we make better every time, and we document how we
did it." This file is the single briefing source for RLVR worker lanes in this
repo. The controller's dispatch prompt states the task, the deliverable, and
the done-means design; for everything else it POINTS HERE instead of restating.

Graph Mode v1.3-beta, opted in 2026-08-27 (pilot); beta checks under
`scripts/done-means/beta/`.

The ratchet rule (ledger item 19, `docs/issue-graph.md`): after every lane
run, the controller harvests the lane's refusals, workarounds, self-caught
defects, and surprises into the Tightenings changelog below — with provenance —
before the next dispatch. **A lesson that appears in a lane report and not
here is a defect in the merge pass that accepted the report.** SME entries
(`docs/sme/entries/`) capture review knowledge for reviewers; this file
captures operating knowledge for lanes. Same lesson may land in both.

## Lane tiers (operator ruling, 2026-08-08 — ledger item 22)

The full treatment is not free, and spending 25–45 minutes of deep research
on a change we are already confident about buys little. Two tiers:

**FAST LANE** — eligible when the change matches a KNOWN class (an SME scope
key with a covering `scripts/done-means/` check — the verifier agent's tier-1
test) and the diff is bounded. Route: Sol low/medium, or Terra medium when the
known class still carries weight (Terra runs low/medium/high — operator ruling
2026-08-08, proven live; the high-only line was a stale claudex-launcher gate,
now removed). Skips: the deep research
phase, the full-suite three-way differential, exploratory root-causing.
Keeps (the floor is not negotiable): the covering check run RED-first against
the claim, PR-body validation (hook enforces it anyway), the required report
format, truth labels, teardown, and one controller (or verifier-agent) run of
the check before merge. Target: minutes, not quarter-hours.

**STANDARD** — everything else: novel classes, security boundaries, deep
root-causes, anything touching serving trees or contracts. The full standing
contract below, unabridged.

**Escalation is one-way and loud:** any surprise inside a fast lane — the
check fails unexpectedly, the diff grows, territory turns out unfamiliar —
promotes the lane to STANDARD immediately and says so in the report. A fast
lane that absorbs a surprise silently is the ledger-item-21 unrecoverable
variation. Misclassifying novel as known is the design's one failure mode;
when the match is arguable, it is not a match.

## Standing contract

Every lane, no exceptions:

1. **RLVR shape.** The executable done-means check is written FIRST and run
   RED before the change exists — a check that has never failed proves
   nothing. The checker declares done; the lane never self-certifies. RED and
   GREEN transcripts go in the PR body. The controller re-runs the check
   independently before merge; worker output is PROPOSED until then.
2. **Environment.** `bun scripts/lane-bootstrap.ts --branch <name> --reason
   "<why the worktree>"` (add `--fresh-db` when tests touch Postgres). Work in
   the worktree it prints. Never switch the primary checkout's branch.
3. **PR bodies.** Compose from `.github/pull_request_template.md`; validate
   locally BEFORE `gh pr create`:
   `PR_BODY="$(cat body.md)" PR_TITLE="<title>" bun scripts/validate-pr-body.ts`.
   The repo hook (`.claude/hooks/pr-body-gate.ts`, ledger item 17) refuses
   invalid bodies at `gh pr create`/`edit`; CI is the backstop, not the
   discovery mechanism.
4. **Truth labels.** Every claim carries RUNNING / MERGED / WRITTEN /
   PROPOSED. "Merged to my branch" is not merged.
5. **Nothing silent** (AGENTS.md Coding Standards, 2026-08-08). Every
   adjustment, N/A step, and workaround is announced in the report.
6. **Never conclude "pre-existing" from a single-file run.** The proof is the
   full suite on clean `origin/main` vs the branch, in separate worktrees with
   separate fresh databases (the #609 standard).
7. **Teardown.** You created it, you remove it: `git worktree remove`,
   `dropdb` by exact name. Scratch worth keeping moves to
   `{temp_workspace}/open-brain/_archive/<lane>/` — never deleted. Report
   anything you could not remove. No `rm -rf`, ever, anywhere.
8. **Report shape.** The REQUIRED field format is defined in
   `docs/controller-contract.md` ("Required lane report format") — return
   exactly those fields, in order; prose goes after them, never instead.
   Self-reported violations are harvested, never punished; burying one is the
   offense.
9. **Refusals are rules working.** A hook denial means adjust, not retry a
   spelling variant. If the denial looks like a false positive, work around it
   the sanctioned way, and REPORT it — gate defects get fixed by the operator
   loop, not fought by lanes.
10. **Fast tools.** `rg`/`fd`/`mdfind`; `grep`/`find` are denied at the tool
    layer and the refusal names the replacement.

## Tightenings

Newest first. Every entry: what changed, and the observation that forced it.

### 2026-08-26 (round 38) — harvest of the #780 wave 2 file lanes (PRs #797-#814)

- **A reuse candidate is only reuse when its defaults AND its failure shape
  match field for field.** `normalizeSearchArgs` and `respondToSearchFailure`
  both looked like the obvious extraction target and both would have moved
  behavior silently — a different default result count (10 vs 50), and a bare
  driver message where the caller emits a prefixed one. Diff what the helper
  emits, not what it is named. (PR #800)
- **Split an authorize step so it returns a union of success-shape or
  error-result and narrow it with a type predicate.** `tsc` then refuses the
  forgot-to-check path at compile time; an early-return-only split leaves that
  safety to reviewer attention. (PR #802)
- **A helper that does strictly MORE is a behavior change wearing a
  refactor's clothes.** `memory-helpers.authorize` fit the permission checks in
  `tier-mutations.ts` by shape, but it resolves and checks a caller-supplied
  namespace none of those four tools accepts. On a behavior-preserving sweep,
  read the candidate's full body first: the reuse test is identical semantics,
  not similar shape. (PR #803)
- **Two namespace-predicate helpers can emit different SQL.**
  `read-scope.ts`'s `appendReadNamespacePredicate` takes a caller-named column
  plus a legacy-shared-fallback option; `namespace-policy.ts`'s
  `namespacePredicate` does not. Substituting one for the other inside a
  no-behavior-change lane changes the query. Read the emitted output, not the
  signature. (PR #804)
- **A `max-depth` finding inside a filter-then-emit loop means the row-admission
  DECISION and the row EMISSION are tangled; lift the decision into a named
  predicate rather than re-indenting.** The trap: the original marked a scope
  key as seen BEFORE testing the item count, so a deduped-then-refused row still
  consumes its key. Extracting the predicate makes it easy to move that `add`
  after the count test unnoticed, which changes which items survive once a
  maximum applies. Diff the ORDER of side effects against the guards, not just
  the guards. (PR #805)
- **Before changing a shared signature, lint the callers at `origin/main`
  first.** The check's file list is derived from the branch diff, so touching a
  dirty caller imports its findings into this lane —
  `loadDurableMemoryContext`'s five-parameter finding was fixable only by
  editing a caller already carrying three findings of its own (complexity 129
  across 535 lines) on untouched `main`. If a caller is dirty the signature
  belongs to whichever lane owns it: leave it, say so in the PR, and let
  done-means stay honestly red on the one item rather than reach for a disable
  comment or a silent revert. (PR #806)
- **An over-complex function is usually held together by its mutable locals,
  not by its length — name the shared state as one object before extracting.**
  `buildAgentContextPackPayload` scored 129 because three locals were read and
  written by nine sections in sequence; introducing `PackAllocator` first made
  each section a one-argument function and took the file 729 → 425 code lines
  with no helper over four parameters. Recorded as
  `docs/sme/entries/2026-08-26-an-over-complex-function-is-usually-held-together-by-mutable-locals-not-by-length.md`
  (lane: quality). Second lesson in the same entry: the extraction rewrote one
  boolean predicate into a non-equivalent nested conditional and the 218-test
  suite stayed green — a refactor claimed behavior-free is verified by reading
  each extraction back against its original, not only by a green run. (PR #806)
- **When a split leaves one helper still over the complexity rule value, the
  leftover is usually a single composite decision, not size.**
  `storedCitationResult` sat at 13 because the `expandable` disjunction was
  inlined in the payload literal; extracting that one predicate cleared it.
  Reach for the decision, not another arbitrary slice of the body. (PR #809)
- **A near-identical sibling classifier can emit different label strings for the
  same class.** `src/source-sync.ts`'s SQLSTATE-class table looks like an exact
  fit for the one in `server/tools/conversation-facts-contract.ts`, but emits
  `connection_error` where the contract publishes `connection_exception`;
  importing it would have changed the error classes callers see. The reusable
  thing was the PATTERN (switch → frozen lookup table), not the table. (PR #810)
- **When a refactor splits a builder that assembles SQL with positional
  placeholders, the parameter array is the invariant, not the SET list.** The
  file numbered each placeholder from `params.length` immediately after pushing,
  and appended the WHERE id param last. Splitting is safe only while every
  helper mutates the one shared array in the original order; returning
  per-helper arrays and concatenating renumbers placeholders silently, and both
  the typechecker and a schema-level test stay green because the SQL is still
  valid and the arity still matches. The catching check is reading the emitted
  SQL and param order against the pre-change file. (PR #811)

### 2026-08-26 (round 37) — harvest of the L2b-1 config-injection lane (PR #779) and the search-all lint lane (PR #780)

- **A single-file green is not a suite green: `bun test` runs the whole
  directory in ONE process, so module-scope memoization keeps the first value
  it ever saw.** `recoveryWalStoreFor` (`server/tools/realtime-stores.ts:53`)
  memoized its fallback store on first touch, so whichever file registered
  first decided the WAL path for every later file. The new arrival test passed
  alone and failed in CI job `db-integration`; the fix keys the fallback on the
  `recoveryWalPath` it was built for (`realtime-stores.ts:59-66`) and the
  docstring now names the failure mode: "Memoizing on first touch alone made
  the answer depend on registration order, which is invisible in a single-file
  run and wrong in a whole-suite one." Run the DIRECTORY before trusting a
  single-file green.
- **A test never builds a path under the Mac scratch workspace; it uses
  `os.tmpdir()` through `mkdtempSync`.** The precedent is
  `src/rotating-file.test.ts:23` — `mkdtempSync(join(tmpdir(), "ob-rotating-"))`
  with `tmpdir` imported from `node:os` (`:12`). This is the one place the
  never-`/tmp` rule does NOT mean "hand-write a workspace path": the workspace
  is Mac-local and the test also runs on CI and in runner boxes, so the
  resolved-at-runtime temp directory is the portable answer and the literal is
  the bug.
- **An arrival done-means needs a clause that RUNS the arrival test, not only
  one that greps the call site.** In
  `scripts/done-means/750-l2b1-tool-readers-take-config.sh`, clause 4 reads the
  composition root's source and proves the values are passed (`:115-120`) —
  which stays green while the wiring is merely TYPED. Clause 5 exercises it
  (`:122`, `server/tools/dependency-arrival.test.ts`), and its failure text
  says why: "clause 4 asserts the wiring was TYPED; nothing here asserts it
  WORKS" (`:305`). A static clause and a behavioral clause are two clauses.
- **The Codex runtime rejects `--effort max`; companion recon lanes ran at
  xhigh.** Pin the effort the runtime actually accepts when briefing a
  companion lane, and record the substitution rather than letting the launcher
  pick silently.
- **A recon lane that reads the Mac checkout answers for THAT checkout's
  branch, not `main`** (rule 19, again). The Mac tree is dirty on
  `sprint/standards-fmt` (`_DOCS/_handover/2026-08-26-lint-sweep-l2.md:15`), so
  a "what does main look like" question answered from it is answered about
  someone else's in-progress work. Point recon at the clone, or at
  `git show origin/main:<path>`.
- **Shared extraction across twins happens only after the defaults are
  confirmed byte-identical.** `normalizeSearchArgs` moved to
  `server/tools/search-request.ts:33` in `fca45fb (#779)` and is now imported
  by both `server/tools/search-brain.ts` and `server/tools/search-all.ts`; the
  legacy `src/tools/search-all.ts` twin was deliberately left untouched. Two
  callers that merely look alike get differenced first; the extraction is what
  you do once they are proven the same, not the way you find out.

### 2026-08-26 (round 36) — harvest of lane 1 of the #780 sweep (PR #782), the #779 review, and the session-2 collection pass

- **A git pathspec `**` must consume a directory.** `git diff --name-only
  origin/main...HEAD -- 'server/**/*.ts'` matches NOTHING for a file directly
  under `server/`, so `server/main.ts` was silently excluded while
  `server/db/pool.ts` would have matched; the command exits 0 and the list is
  just short. The check's refusal of an empty file list is what caught it. A
  diff-derived file list is filtered with an anchored `rg '^server/.*\.ts$'`
  over the full diff, never a git glob pathspec
  (`scripts/done-means/780-touched-files-lint-clean.sh`).
- **A rewiring lane has two halves, and the done-means asserts ARRIVAL.** #779
  made four tool readers take a parameter with `?? default` fallbacks and never
  changed the composition root (`server/main.ts:168`), so tsc and an
  absence-only check went green with nothing wired. The check registers the
  tools with a non-default env value and reads it back; the old `process.env`
  read being gone proves nothing on its own.
- **Tooling:** the Codex companion (`codex:codex-rescue`) refuses a commit in
  the clone ("Codex git guard: unable to verify the current branch") and hands
  the Workflow "No output." with no receipt, so a write lane that must commit
  routes to a native Opus 5 worker at low effort with that reason stated; Codex
  Luna max stays the route for read-only lanes. `gh run rerun --failed` on a
  run whose only red job is the runner-transcript test (#764) left the run
  `queued` with no second attempt for 20+ minutes; `main` has no required
  status checks (ruleset `main`: pull_request, linear history), so the merge
  evidence is the green jobs on the SHA plus the #764 reference, not a re-run.
  `gh pr close` then `gh pr reopen` fires the `pull_request` trigger for a
  PR that never got a CI run. verify-lane leaves a `verify-lane/pr-N-*` branch
  behind with its worktree; both go in the same session.
- **The harvest gate reads the whole Bash line.** `gh pr comment ... &&
  gh pr merge ...` is refused because the merge is present before the comment
  has landed; the comment and the merge are two separate calls.

### 2026-08-26 (round 35) — harvest of the L2a config-schema lane (PR #778)

- **A schema field that "mirrors" a reader is differenced against the reader
  input by input, and the test calls the reader.** L2a declared 23 env names
  with parsers that reproduced the readers' fallbacks, and every test picked
  inputs where reader and schema agreed, so 65 green tests could not falsify
  the PR's own start-equivalence claim. The Light-tier reviewer ran a 15-input
  differencing set (`"3000ms"`, `"1e3"`, `"0x10"`, `"10.5"`, `""`, `"   "`,
  `"-1"`, `"Infinity"`, ...) and found three P1 divergences: `PORT` is read
  with `Number()` (`server/main.ts:362`) and the schema used `parseInt`, so a
  value that crashes `listen` today silently became 3100; the capture-health
  integers are read with `Number(raw.trim())` + `isInteger`
  (`server/capture/liveness-observer.ts:535-550`), not `parseInt`; and the
  shared-namespace canonical precedence was inverted against `envString`
  (`server/tools/shared-namespace.ts:79-82`). Where the reader is exported,
  the equivalence test calls it and compares; where the reader would crash the
  process, the schema rejects with a named issue, never a substitute value.
- **Cite the parse, not the constant.** The PR body cited
  `liveness-observer.ts:404-408`, which is where the env NAMES are declared;
  the parse is at `:535`. A citation to the name constant reads as "checked"
  while the semantics were never opened.
- **`??` is not "blank falls through".** `process.env.A ?? process.env.B`
  keeps `A=""`; a blank-as-absent preprocessor makes it fall through to `B`.
  Two readers with different blank handling cannot share one preprocessor.
- **`GROUPS` is a bash builtin** holding the user's numeric group IDs;
  assigning it in a done-means script silently yields that list and fails as
  `but 20 is missing`, which reads like a broken check rather than a name
  collision.
- **Tooling:** the Codex git guard refuses `git checkout main` in the clone
  for the head as well as for workers ("do not switch to main/master for
  work"); verify-lane runs fine from a feature-branch checkout because it cuts
  its own worktree from `origin/main`. Two CI runs on one SHA inverted their
  flakes (`db-integration` vs `python-capture`, #614/#764); every job has a
  green run on the SHA, which is the evidence, not a re-run to all-green.
- **`max-lines` at 500 on a test file changes how a table-driven block is
  added.** The fixer retired five hand-constant assertions the reader-driven
  table subsumes so `server/config.test.ts` still passed the rule; the next
  rung adds a sibling `*.test.ts` per group instead of removing assertions.

### 2026-08-26 (round 34) — harvest of the verify-lane deps-at-head lane (PR #776, #775)

- **verify-lane installed dependencies at `origin/main` and then verified the
  PR head, so the first dependency-adding PR could not get a receipt.**
  `lane-bootstrap.ts` cuts the verification worktree from `origin/main` and
  runs `bun install --frozen-lockfile` THERE; verify-lane then hard-resets the
  same worktree onto the PR head and never reinstalled. The SOURCE moved and
  `node_modules` did not. Measured twice on #771, which adds `oxlint`: the
  check died on `MISSING TOOL: .../node_modules/.bin/oxlint` and NO receipt was
  posted, while a second install in that same worktree made the identical check
  pass. Fixed by reinstalling when `package.json`/`bun.lock` differ between the
  bootstrap ref and the head. `git diff --quiet` answers 0 for "same" and 1 for
  "differs", so it cannot go through `capture()` (which throws on any non-zero
  status); every OTHER status fails closed rather than being read as
  "unchanged", because reading a broken comparison as "unchanged" reintroduces
  the original defect exactly when git cannot compare.
- **A test that shells out to git MUST pin `--git-dir` and `--work-tree` on
  every call, and MUST assert `git init` succeeded before any other git call.**
  A bare `-C <fixture>` does not fail when the fixture is not a repository — it
  walks UP to the first enclosing one and operates there. One `mkdtempSync`
  fixture came back without a `.git` (init did not take, nothing checked), so
  the fixture's own `base` and `docs only` commits were authored into the
  surrounding worktree as `verify-lane test <test@example.invalid>`, deleting
  every tracked file in it, and the fixture's `git config` calls wrote
  `core.bare=true`, the test identity, and `commit.gpgsign=false` into the
  CLONE's `.git/config` (the controller restored it). Proven directly rather
  than argued: against a non-repo directory, `git -C <d> rev-parse HEAD`
  returns the enclosing worktree's HEAD while the pinned form returns
  `fatal: not a git repository`. Recovery used `git update-ref` plus a mixed
  reset, because the guard correctly refuses `git reset --hard` — the guard was
  right and the workaround is the supported path, not a bypass.
- **Test scratch is repo-relative `_scratch/`, never a hardcoded Mac path.**
  Both the test and the done-means check defaulted to
  `/Volumes/ThunderBolt/_tmp` when `OPENBRAIN_TEMP_WORKSPACE`/`DEV_TMP` were
  unset. That is the operator's machine, so CI failed in both `check` and
  `db-integration` with `EACCES: permission denied, mkdir '/Volumes'` on the
  Linux runner. The repo already had the right shape
  (`src/operator-doctor.test.ts:29`): a `_scratch/<name>/` directory resolved
  from the repo root, already excluded by `.gitignore:119`. A fixture that
  requires one machine's volume layout gates nothing in CI, which is where the
  check most needs to run. Keeping the fixture inside the repo also bounds the
  escape above — the worst a stray git call can reach is a directory the repo
  already ignores.
- **A check that can mutate the repository it verifies is a worse defect than
  the one it gates.** Proving such a check is not "it exited 0": it is
  `git config --list --local` and `git status --short` of the ENCLOSING repo,
  before and after, plus confirming HEAD is unchanged and no fixture path shows
  up as untracked. The escape above passed its own clauses green while
  corrupting the branch it ran on; only inspecting the enclosing repo caught
  it.

### 2026-08-26 (round 33) — harvest of the plans lane (PR #772) and the L1 lint-gate lane (PR #771)

- **A docs-only PR still carries an executable done-means.** The merge gate
  has no not-applicable path, and that is the point: "not applicable" was the
  loophole. For a measurement document the check is one that re-runs the
  document's own commands and fails on drift
  (`scripts/done-means/750-server-baseline-holds.sh`); it is EXPECTED to go
  red when a ladder rung moves the numbers, and the rung updates both.
- **Cut the branch from the current tip, and check before the PR.**
  `pr-body.yml` decides Contract Parity with a two-dot diff from the base
  TIP, so a branch 4 commits behind main tripped it on main's own #768
  change (#773). `git merge-base --is-ancestor origin/main HEAD`
  (`STANDARDS-git.md:63`) before `gh pr create`.
- **Landing a hook is not evidence the hook runs.** The lint step early-exits
  when no `.ts` file is staged, so the commit that adds `_githooks/pre-commit`
  never exercises it. The receipt came from a separate `.ts` commit, and the
  RED probe was committed as a re-runnable check with a negative control on
  `core.hooksPath` (`750-precommit-lint-gate-fires.sh`), because a global
  `core.hooksPath` had let an earlier probe pass falsely.
- **Tooling:** the Codex git guard refuses `git -C <path> commit|push`
  ("unable to verify the current branch") and accepts `cd <path> && git ...`.
  A fresh worktree needs `bun install --frozen-lockfile` before pre-push
  `tsc` can run (`bun-types` ENOENT). `db-integration` still fails on
  #608/#632 (one defect, two issues); `gh run rerun --failed` clears it.

### 2026-08-18 (round 32) — harvest of the live-observer completion lane (PR #737)

- **A SURFACE PROVEN ONLY BY INJECTION IS NOT LIVE — assert the DEFAULT
  composition.** #728 built and tested the embed_watermark surface entirely
  through injected observers; the live entrypoint composed none, so the
  deployed worker logged `embed_watermark_observed:false` and could never
  alarm. Third paid instance of the #674 class (in tree, absent from the
  serving process; #656 was the second). The closing gate's shape to copy:
  a test that calls the REAL entrypoint composition with no override and
  asserts the observer exists and the block appears.
- **Re-prove a red is load-bearing by NEUTERING the fix (`if (false)`), not by
  trusting the author's transcript** — the #737 implementer did, same runner,
  0 pass / 4 fail, file restored and diffed clean.
- **Harness gotcha: `startNatsWorkerProcess.shutdown()` closes the pool it was
  handed** — suite-shared pools go in behind a Proxy with a no-op `end()`, or
  cases 2-N die on 'Cannot use a pool after calling end' as a fake red.
- **Anti-stub assertions are RANGES derived from seeded offsets**, not
  equality constants — a hard-coded health block cannot satisfy stale +
  healthy + idle simultaneously.

### 2026-08-17 (round 31) — harvest of the #724 wave (PRs #727-#732, forensics lane, Development-repo lane E)

- **THE PR-BODY GATE RESOLVES RELATIVE PATHS AGAINST THE PRIMARY CHECKOUT —
  PASS `--body-file` AN ABSOLUTE PATH.** Three independent lanes (#727, #730,
  #732) hit the same PreToolUse refusal: `gh pr create --body-file pr-body.md`
  resolved against `/Volumes/ThunderBolt/Development/open-brain`, not the lane
  clone. Every lane recovered by reading the refusal and using the absolute
  scratch path. Standing rule for every lane working out of a clone.
- **`aqmd` HAS NO INDEX IN A FRESH CLONE — it hangs, it does not error.** Two
  lanes had `aqmd search` exceed 120-180s in a new clone (no `.qmd/` there).
  Satisfy the design-lookup gate by querying the PRIMARY checkout read-only, or
  accept the backgrounded call. A hang here is missing-index, not load.
- **A CLONE DOES NOT CARRY `.env`.** Lane A lost time to it; the recipe is
  read-only sourcing from the primary checkout (`set -a; . <primary>/.env`).
- **A WORKER CORRECTLY IDLE IS NOT A WORKER BROKEN: enqueue can be a
  deliberately caller-scoped boundary.** Lane A's premise ("the restored worker
  should drain the backlog") was KILLED by docs/embedding-repair.md — the
  bootstrap "invents no namespace and enqueues no job." The 549-lane backlog
  had no caller, not a dead pipeline. Check the enqueue boundary's design DOC
  before diagnosing the runner.
- **FOR BULK CONVERGENCE, SELECT ONLY WHAT THE LOOP CAN REPAIR.**
  `buildSelection` ORs all reasons into one unordered LIMIT query; including
  already-embedded drift rows means repeated batches can spin without
  converging and `repaired === 0` stops meaning done. Lane A's caller selects
  reason `missing` alone; drift stays the queue handler's job.
- **CLIENT-SIDE SCOPE CANNOT DISTINGUISH "the capture hook's lane" FROM
  "another same-namespace session's lane" — the wire requests are identical.**
  Lane B proved it by printing both call sequences. Any adoption/refusal split
  between those two cases must live server-side; a client test asserting the
  split is asserting the impossible (the #732 held decision).
- **A LANE RESUMING A BRANCH THAT ALREADY CARRIES THE RED TEST HAS NO
  INDEPENDENT RED** — say so in the report (lane C did) instead of quoting the
  author's transcript as your own observation.
- **FORENSICS: READ THE APP-OWNED LOG FIRST; launchd's redirect files are
  expendable and get truncated on reinstall.** Then tie the log line to its
  emitter in source (run-nats-worker.ts:243-247 turned "Shutting down" into
  proof of SIGTERM/bootout) and treat SURVIVORS as evidence (30 intact sibling
  plists converted "a cleaner ran" into "one item was picked"). Use
  `/usr/bin/log`, not the `log` zsh function.
- **A HAND-CREATED LAUNCHD SERVICE WITH NO INSTALLER AND NO LIVENESS ASSERTION
  IS THE DEFECT**, not the deleter. The pattern already exists in
  scripts/install-qmd-sync-launchagent.sh and was not applied to the NATS
  worker; that gap, not the removal, bought the three silent days.
- **WHEN THE HOOK IS THE SUBJECT UNDER TEST, THE FIXTURE PINS THE REAL VALUE**
  (`core.hooksPath=_githooks`), and simulating the operator's global config is
  done via `GIT_CONFIG_GLOBAL` in the harness env — never by writing the real
  global. Lane #722's re-blind negative control (pin removed → both checks
  fail naming core.hooksPath) is the shape to copy.
- **A SALVAGED "UNTESTED" LABEL IS A CLAIM LIKE ANY OTHER: re-verify, then
  amend the message if verification flips it** (lane #721 did; content
  untouched, message corrected — announced, not silent).

### 2026-08-10 (round 30) — harvest of the #716 issue-artifacts landing lane

- **`--` BEFORE ANY PATTERN THAT CAME FROM DATA, AND `-F` DOES NOT IMPLY IT.**
  The pre-rebase superset check ran `rg -qF "$line"` over the branch's added
  lines; diff-derived lines routinely begin with `-`, ripgrep parsed that as a
  flag, and the check reported **seven false MISSING lines** for content that
  was present. Fixed with `rg -qF --`. Third distinct spelling of the same
  family — round 19's `rg -r` (REPLACE, not recursive) and two `rg -E`
  incidents (`--encoding`, not extended-regex) — so it is a standing class, not
  three coincidences: a flag-shaped argument is accepted as a flag and the
  command still exits 0. The failure mode is a **plausible-looking wrong
  answer**, never an error. It bit once more while harvesting this round:
  `rg -h "^order:"` printed ripgrep's help (`-h` is `--help`; `--no-filename`
  is the flag), so the reflex is not yet trained out. Fixed-string mode
  disables regex interpretation, not option parsing; only `--` stops the
  second.
- **A ONE-DIRECTIONAL CHECK CANNOT TELL "ABSENT" FROM "MY QUERY WAS BROKEN",
  and here the broken answer pointed at the destructive move.** Believing those
  seven MISSING lines meant "root is not a superset, keep the branch side" —
  i.e. restoring stale graph-file content over newer root content, the precise
  2026-08-10 reconcile failure the check existed to prevent. Where a check's
  verdict authorizes a DROP or an OVERWRITE, it carries a positive control: one
  line known present and one known absent, so a malformed query fails loudly
  instead of confirming the alarming direction. Review-facing half:
  `docs/sme/entries/2026-08-10-a-verification-command-that-takes-untrusted-text-as-a-pattern-needs-an-end-of-options-guard.md`.
- **CLI-CLOSED ISSUES HAVE NO PR LINKAGE, WHICH IS THE LIVE ARGUMENT THAT
  OBLIGATION 2b IS LOAD-BEARING RATHER THAN A COURTESY.** #710 and #712 were
  closed from the CLI, so `sync-issues.ts` renders "Closed without a pull
  request" for both. That is the renderer being HONEST, not a defect — and it
  measures the gap ledger item 32 predicted from the other direction: this
  repo's lanes squash-merge into a wip branch, so GitHub's auto-close linkage
  frequently never registers, and a CLI close never creates one at all. The
  resolution therefore cannot depend on linkage. It has to live in a CLOSURE
  COMMENT on the issue, which the discussion mirror captures unconditionally.
  Verified: #710's artifact carries its full closure rationale by that route
  and nothing else. Controller-contract obligation 2b (direction + why +
  receipts, at merge or at close) is the only thing standing between a
  CLI-closed node and an artifact that records a CLOSED stamp with no reasoning
  — do not treat it as optional when a PR happens to exist either, since the
  linkage that would carry it is exactly what this flow drops.

### 2026-08-10 (round 29) — harvest of the #709 hook-feeds-head-ref lane

- **ROUND 28'S FIRST BULLET RECURRED IN THE NEXT LANE, AND ITS OWN CHECK
  STAYED GREEN THROUGHOUT.** #706 shipped a correct three-tier validator and a
  hook that fed it neither the right tree nor the head ref at all, so the tier
  the issue asked for by name was dead code from the only caller that runs.
  `706-done-means-resolves-pr-head.sh` was 5/5 GREEN before, during, and after
  the defect, because it calls the validator DIRECTLY and sets `PR_HEAD_REF`
  itself. A check that supplies the input under test proves the consumer works
  WHEN FED — never that anything feeds it. Writing the round-28 bullet did not
  stop the lane that wrote it from reproducing it, which is the measurement:
  the rule needs a clause driving the real entry point, not a paragraph.
- **NAME THE DEAD SIDE OF EVERY SEAM.** When a fix spans a producer and a
  consumer, the check must drive the PRODUCER's real entry point at least
  once, and one clause must be impossible to pass without the specific wiring
  under repair. Here clause 2 moves the file OUT of the lane worktree while it
  stays committed on the branch, so a fix that merely read the `cd` target —
  which passes clause 1 — still fails. Without that clause the lane would have
  shipped a half-fix that looked complete, exactly as #706 did.
- **A HOOK PAYLOAD'S `cwd` IS THE SESSION'S, NOT THE COMMAND'S.**
  `cd <worktree> && gh pr create` in ONE Bash call does not move `input.cwd`.
  #706's own source comment asserted the opposite in prose ("the tree the
  command was actually run from — the lane worktree") and the code inherited
  the claim. A comment stating what an input contains is not evidence; the
  payload's shape is checkable and was not checked.
- **PRINT THE GATE'S INPUTS ON THE REFUSAL PATH, NOT ONLY ON THE ALLOW.** #706
  echoed which tree ANSWERED only when it passed. #709 had to be diagnosed
  from a refusal that named the tree it searched but not where that tree came
  from, so it read as "your path does not exist" when the truth was "the gate
  looked in the wrong place". A refusal is precisely when someone must work
  out why. Round 28 said assert on announcements; this adds: announce on the
  branch where the reader actually lands.
- **DEGRADE TO THE OLD BEHAVIOUR, NEVER TO A GUESS.** The new `cd`-target
  reader refuses to resolve `cd -`, a variable-built path, or a detached HEAD,
  and falls back to the payload cwd instead. `branchOf` uses
  `symbolic-ref --short` rather than `rev-parse`, because a raw SHA is a valid
  `git cat-file` argument and would make the announcement say "resolved in
  branch 9f3a1c2" — a non-fact in the grammar of a fact.
- **`lane-bootstrap` cuts from `origin/main` only, with no base flag.** A lane
  building on work that merged to a wip branch must create and push the branch
  at the right base first, then bootstrap continues on it. Announced in the
  lane report rather than silently rebased. Small gap; worth a `--base` if it
  recurs.
- **Two blockers found live and FILED, not absorbed** (#711, #712).
  `core.hooksPath` is absolute in `.git/config` so every worktree runs the
  primary checkout's hooks — round 28's third-family instance, now with the
  extra finding that `_githooks/install.sh` already writes the RELATIVE value
  and nothing detects the divergence (#711). And `bun test` aborts with
  `WriteFailed` when its stdout is git's pipe, so `_githooks/pre-push` fails
  EVERY push while the suite itself is 3372 pass / 0 fail — reproduced on an
  untouched primary checkout (#712). `--no-verify` was not used.
- **A gate that fails identically for a green push and a broken one has
  stopped carrying information**, and that is the state #712 leaves the push
  path in. Filing it is cheaper than the habit it would otherwise train; #705's
  own commit message predicted this exact slide into routine bypass.

### 2026-08-10 (round 29) — harvest of the #712 pre-push WriteFailed lane

- **A GATE MUST NOT LET ITS OWN REPORTING CHANNEL DECIDE ITS VERDICT.**
  `_githooks/pre-push` ran `bun test` bare, so bun inherited git's stdout and
  stderr; when the CALLER pipes git's output, bun 1.3.14 dies mid-coverage-table
  with `WriteFailed` and exits 1 on a suite that is GREEN. The real result
  existed and was thrown away because the process died printing it. Read the
  verdict from the EXIT CODE; send a child's output somewhere the caller cannot
  make hostile, then replay for the human. Second instance of CLOSED #483's
  family (there the inherited thing was `GIT_DIR`) — two instances make it a
  family: audit what else a gate passes down untouched.
- **Measure WHICH fd before fixing, or the obvious fix looks right and changes
  nothing.** Redirecting each fd independently proved the failing writer is
  **stderr** (stdout FILE + stderr PIPE still exits 1; stdout PIPE + stderr FILE
  exits 0). `bun test > log` — the reflex spelling — leaves the defect 100% live
  and passes review. The done-means clause must pin the fd that was MEASURED,
  not the one that is conventional to redirect. Also measured: a fully-draining
  `cat` does not help and output truncates mid-line, so "something downstream
  stopped reading" was the wrong first hypothesis.
- **A failure whose presence depends on HOW THE CALLER CAPTURED OUTPUT is
  intermittent from the operator's seat** — the push "randomly" failed then
  "randomly" worked, with text identical to a genuinely broken branch. That is
  the precise profile that makes `--no-verify` habitual, so it is a severity
  multiplier, not a footnote.
- **Do NOT couple a check to the upstream bug's own threshold.** Reproducing
  bun's internal ~214 KB stderr trigger was attempted and abandoned: a synthetic
  4 MB stderr writer exits 0, and fixture suites of 300 and 1200 modules both
  exit 0 through a pipe. A check that depended on it **would go green the day
  bun fixes the bug**, silently un-testing the hook's classification logic —
  which is the part this repo owns. Reproduce the child's OBSERVABLE CONTRACT
  (fd 2 is a FIFO → `WriteFailed`, exit 1) via a PATH shim; keep the HOOK, the
  pipe, and the stdin range real. Round 28 says the invocation shape must be
  real; this says the *upstream defect* need not be, and names the line between.
- **Know which spelling the subject actually invokes.** The fake runner was
  first placed in `package.json` `scripts.test`, but the hook calls `bun test`
  DIRECTLY, not `bun run test` — so the clause went red with "0 test files
  matching", a false RED proving the FIXTURE wrong rather than the hook broken
  (rounds 18/22/23 family). Round 18's read-WHY-it-went-red rule caught it.
- **"Tests failed" and "the runner could not report" are different defects with
  different owners, and a gate that collapses them stops carrying information.**
  Two lanes were blocked on #712 before it was diagnosed. The fix names which,
  and the mutant clause (b) holds the other direction: a genuinely failing suite
  must still fail AND still be called a test failure.
- **Round 28's pre-existing-failure practice held twice.** `sme-per-entry-files.sh`
  clause 1 was RED for #707 (not this lane's file; zero mentions in this lane's
  diff) — proven identically RED on the untouched primary at `e3917ab` and left
  failing rather than absorbed. The count pin WAS this lane's and was raised in
  the same commit as the entry, with the reason named.
- **The #711 bootstrap trap is now the standing condition for hook lanes.**
  `core.hooksPath` is absolute, so a lane worktree runs the PRIMARY's hook — a
  lane fixing pre-push cannot exercise its own fix on push without an explicit
  `-c core.hooksPath=<lane worktree>`. Used here (the #713 precedent: running
  the FIXED gate is not a bypass), declared in the PR body, and `--no-verify`
  was not used. This lane's own push through a piped git IS the live proof.
- **A git-guard refusal and a design-lookup refusal were both the rules
  working** — `git reset --hard` refused when re-basing the lane onto its real
  integration target (rebuilt with `git checkout -B` instead), and a Write
  refused pending a subject-relevant lookup. Neither was retried as a spelling
  variant.

### 2026-08-09 (round 28) — harvest of the #705/#706 gate-fix lane (PR #708)

- **A SEAM ADDED TO MAKE A GATE TESTABLE IS NOT THE PATH THAT RUNS.** This
  lane's `--explain` flag let clauses (a)-(e) drive base selection without
  the multi-minute validation phases — and all five PASSED against a fix
  that still reproduced #705 on the very first real push, because
  `--explain` resolves from the symbolic `HEAD` while a real push supplies
  a raw SHA. When a check drives a convenience entry point, at least one
  clause MUST drive the real invocation shape (for pre-push: a genuine
  stdin range with a zero remote SHA). New spelling of the false-green
  family; the sibling of round 22's stub-the-boundary rule.
- **`@{upstream}` needs a SHORT BRANCH NAME, and both wrong forms fail
  silently in the same direction.** `<sha>@{upstream}` is meaningless and
  `refs/heads/x@{upstream}` is a hard `fatal: no such branch` — neither is
  distinguishable from "no upstream configured", so both fall through to
  the fallback. Any lookup whose failure mode is indistinguishable from its
  legitimate empty case must be asserted on POSITIVELY (name the ref you
  expected), never by observing that nothing broke.
- **A function that PRINTS its result and is called via `$(...)` cannot set
  globals** — the subshell swallows them. Here that blanked only the
  ANNOUNCEMENT while the flags stayed correct, i.e. it failed GREEN in the
  one dimension nobody asserts on by reflex. Caught solely because two
  clauses asserted on the announcement. Assert on announcements, or they
  rot silently.
- **Three instances of one family in one lane: a gate resolving its base or
  its tree from something other than the change under review** —
  `import.meta.dir` (#706), a hardcoded `origin/main` (#705), and an
  absolute `core.hooksPath` (found live). The third means a lane worktree
  runs the PRIMARY checkout's hooks, so **a lane fixing a hook structurally
  cannot exercise its own fix on push**, and a lane fixing the PR-body gate
  cannot name its own new check. Ask of every gate: which tree answered,
  and which ref did it compare against? SME entry:
  `docs/sme/entries/2026-08-09-a-gate-that-judges-from-a-tree-other-than-the-one-under-review.md`.
- **Bootstrap ordering is declared, never routed around.** When the fixed
  gate cannot yet judge its own PR, cite a pre-existing check that GENUINELY
  judges the change (here `pr-body-gate-fires.sh`, the standing acceptance
  test for the very hook being modified), print both the accepting and
  refusing validator runs in the body, and say plainly why. `--no-verify`
  and hook bypass were not used; the live proof was produced with an
  explicit `-c core.hooksPath=<lane worktree>`, which is running the FIXED
  gate, not skipping a gate.
- **Changing an assertion after seeing a result obliges a full RED re-proof.**
  Clause (d) here was wrong (it demanded the absence of a word that legitimately
  appears in the correct answer — the round-9/17/23 negative-match family), so
  the CORRECTED clause set was re-run against the pre-fix sources before any
  green was claimed.
- **Pre-existing failures are proven against the untouched primary checkout,
  then filed.** `sme-per-entry-files.sh` was already RED at `a45e7d9` on two
  clauses (231 entries vs a pinned 227, and one level-1 undated heading). The
  pin was reconciled to 232 WITH a comment naming the four entries that were
  never this lane's, and the heading defect was filed as #707 rather than
  absorbed into a gate-fixing PR.
- **Two hook refusals were the rules working** (design-lookup-gate on a Bash
  and a Write; the git guard on a commit whose heredoc mentioned protected
  branches). Handled the sanctioned way — do the lookup, write the message
  file in a separate call — never a retried spelling. Round 24's practice held.

### 2026-08-09 (round 27) — operator ruling: a completed node shows its outcome (ledger item 32), harvested from the artifact-resolution lane

- **At merge, the controller posts a CLOSURE COMMENT on the ISSUE** —
  direction taken, why that direction over the alternatives, and the
  receipts (PR number, merge SHA, done-means check name). The generator
  now renders a `## Resolution` from the closing PR, but the artifact is
  only as good as what was written: a PR body that never states WHY
  produces a Resolution section that faithfully preserves nothing.
  Operator, 2026-08-09: the artifacts must "explain the direction we went
  in and why we went in them." The comment lands the reasoning where the
  mirror already captures it (comments have been mirrored since the
  generator's first version) rather than depending on PR linkage.
- **A closing PR body is a durable artifact, not a merge formality.** It
  is reproduced BYTE-FOR-BYTE into the closed issue's artifact and is
  what a future `aqmd` search returns as the answer. Write it for the
  reader who arrives in six months with no session context.
- **Measured trap — `closedByPullRequestsReferences` is EMPTY in this
  repo.** Lanes squash-merge into a wip branch, not the default branch,
  so GitHub's auto-close linkage never registers: the field returns
  `[]` for #681 even though PR #687 demonstrably closed it. Resolution
  comes from the TIMELINE instead (closer is a PullRequest in 20 of 25
  recent closures, a Commit needing SHA-to-mergeCommit correlation in 2,
  and null in 3). Any future tooling that reads closure MUST use the
  timeline; the obvious field silently reports absence.
- **Cross-referenced PRs are not a list of closing PRs.** #659 is
  cross-referenced by four and closed by one. Use them ONLY to resolve a
  closing commit SHA to its PR. Rendering candidates would put several
  directions on an issue that took one — an ambiguous answer fails the
  ruling as surely as a missing one.
- **Importing a script to test it must not RUN it.** The lane's own first
  RED run imported `scripts/sync-issues.ts` for its renderer and fired
  the entire `gh issue list` sweep, rewriting every file in
  `_plans/issues/`. A check that mutates the tree it measures cannot be
  trusted about it. Scripts that a done-means check imports now guard
  their side effects behind `import.meta.main`.
- **Prove the EXPECTATION, not just the assertion.** The lane's driver
  derived its expected body-phrase by filtering long words and joining
  them, fabricating a string present nowhere in the source — so a
  CORRECT renderer failed the clause and read exactly like a renderer
  defect. Derived expectations now carry a self-check that they exist in
  the source, asserted before anything rests on them. Sibling of round
  25's "prove the prover."
- **An embedded document's own headings are structure, and they collide.**
  PR bodies here carry `## Summary` / `## Verification` headings; inlined
  into an artifact they became top-level sections of the ISSUE, so the
  PR's structure masqueraded as the issue's. Blockquoting the embedded
  body keeps every line inside its section and byte-identical.

### 2026-08-08 (round 26) — operator ruling on test-data cleanup (ledger item 31)

- **A prefix-scoped SQL DELETE of rows a lane can PROVE are its own test
  residue is the lane's to run** — count before, delete in one
  transaction children-first, verify zero after, announce the counts.
  "It's a database, not an RM-RF" (operator, 2026-08-08). The
  unconditional no-`rm` rule governs the FILESYSTEM and is unchanged.
  Rows of uncertain provenance, user data, and anything outside a
  provably-test prefix stay report-only.


graduated: bullet 1 -> docs/sme/entries/2026-08-08-a-prefix-scoped-sql-delete-of-provable-test-residue-is-the-lanes-to-run.md (domain-backend order 83), and the FILESYSTEM half stands unchanged as standing contract clause 7 (no rm, ever, anywhere).
provenance: operator ruling 2026-08-08, ledger item 31 (docs/issue-graph.md); no PR.
### 2026-08-08 (round 25) — harvest of the #653 final-sync lane (clause-e residue edit)

- **When a gate has no clause-level seam, EXTRACT the clause from the
  real file by markers — never retype it.** A retyped copy proves the
  copy. The extractor fails hard on empty/unrecognisable extraction, or
  "0 lines extracted, all cases as expected" is a vacuous green.
- **Prove the prover:** "all cases behaved as expected" is a claim about
  the author's expectations until one deliberate driver mutation
  (`elif false`) makes it report MISMATCH.
- **Marker extraction: gate the END pattern on the state variable**
  (`on &&`) — an END regex that also matches EARLIER than START turns
  the block off before it turns on and silently yields nothing.
- **`rows=0` means both "clean" and "never looked" — a companion
  `checked` field read separately is mandatory, and a receipt MISSING
  the field entirely is a third world that must ERROR, never default:
  otherwise a stale pre-fix receipt satisfies the clause added to read
  it.**
- **Round 24's git-guard practice held:** message files written in
  separate tool calls before the guarded command — no compound-chain
  aborts. Standing practice.
- **Bootstrap continuation mode's first real run was correct** — banner
  names the SHA and says the ref was untouched, making continuation
  distinguishable from a fresh cut in a transcript. The hand-build tax
  this lane paid twice is gone.
- **The design-lookup hook caught a real gap** (an edit against a design
  merged hours earlier and unread), and the fallback that mattered was
  reading the SME entry directly — the index had not caught up with
  tonight's merges. An index-only lookup would have been satisfiable
  without informing anyone.
- **Refusal-path coordinate count is now 10** (the two capture fallbacks
  joined the enumeration) — the briefed "8" is stale; brief the observed
  number or brief "the enumerated set," not a count.


graduated: bullets 1, 2, 3 and 4 -> docs/sme/entries/2026-08-08-extract-the-clause-from-the-real-file-by-markers-and-prove-the-prover.md (correctness order 84); bullet 5 -> docs/sme/entries/2026-08-08-pipestatus-outside-the-pipelines-shell-prints-empty-and-reads-as-exit-0.md (write message files in a separate call before a guarded command); bullet 7 -> docs/sme/entries/2026-08-08-pipestatus-outside-the-pipelines-shell-prints-empty-and-reads-as-exit-0.md (brief the enumerated set, never a count); bullet 6 -> history-only, bootstrap continuation mode's first real run, shipped by scripts/done-means/667-lane-bootstrap-continuation.sh; bullet 8 -> history-only, one design-lookup payback already covered by round 17's payback rule.
provenance: PR #653 final-sync lane.
### 2026-08-08 (round 24) — harvest of the #671 verdict-channel lane (PR #673)

- **A driver that implements a changing interface can silently repair the
  defect it exists to expose.** Returning only the post-fix shape handed
  the pre-fix gate an object with no `failed`, and `undefined > 0` is
  false — the broken gate reported PASS and the RED was false. New
  spelling of the false-RED family (round 18's broken import, round 22's
  env mutant): a CONTRACT-SHAPE mismatch that looks like legitimate
  green. When the fix changes a driver-implemented signature, return both
  shapes and assert the RED went red for the defect's own reason.
- **When a fix changes WHICH SIGNAL produces a failure, the control
  clause must assert the signal, not the outcome** — "gate failed" was
  satisfied pre-fix by the old tally verdict, certifying a mechanism that
  did not exist yet. Round 9/17 negative-match family extended.
- **A residue/leak reader shares the remover's resource list — never a
  parallel one.** Two lists drift, and the drift fails GREEN: the table
  the purge stops clearing also stops being counted. Enforce with a unit
  test asserting the reader names exactly the remover's tables.
- **"Not observed" must fail closed** — a verdict moved onto a query
  inherits the query's failure modes; unchecked and partially-read
  readings both fail, or the false-red fix becomes a false-green one.
- **A git-guard refusal aborts the ENTIRE compound command** — heredocs
  and file writes earlier in the chain never executed, so the next step
  fails on a missing file and reads as an unrelated bug. Write message
  files in a separate tool call before the guarded command.
- **Empty shell variables in numeric tests abort under `set -u`** and
  truncate the remaining clauses — a transcript that reads as a crash,
  not a verdict. Sentinel JSON reads, guard the arithmetic (round 21's
  PIPESTATUS sibling).
- **A lane constrained away from the live path reports instrumentation
  shipped, not findings observed** — the #671 lane could only see its own
  stub label and said so, filing #672 for the real one instead of
  fabricating. "NOT OBSERVED — structurally cannot observe" is a
  complete, correct answer.


graduated: bullets 1, 2 and 4 -> docs/sme/entries/2026-08-08-a-driver-that-implements-a-changing-interface-can-repair-the-defect-it-exposes.md (correctness order 85); bullet 3 -> the same entry's residue-reader corollary, enforced by scripts/done-means/671-teardown-verdict-residue.sh; bullets 5 and 6 -> docs/sme/entries/2026-08-08-pipestatus-outside-the-pipelines-shell-prints-empty-and-reads-as-exit-0.md (quality order 88); bullet 7 -> the round-24 entry's structurally-cannot-observe corollary, and standing contract clause 8 (report shape).
provenance: PR #673.
### 2026-08-08 (round 23) — harvest of the #667 bootstrap-continuation lane

- **A negative-match clause on a crashing subject can go green off the
  SUBJECT'S OWN error text.** git's `fatal: a branch named 'x' already
  exists` satisfied an `already exists` announce-assertion on the exact
  run where the script announced nothing and died. Anchor
  announce-assertions on a marker the script OWNS (its `[ok]` step
  prefix), never on prose the failure mode also emits. Round-9/17
  family, new spelling; caught by round 18's read-WHY rule.
- **A summary line hardcoding one path's provenance silently misreports
  the other the moment a second path exists** (`(from origin/main)`
  became a lie in the same commit that added continuation). When adding
  a branch to a function, grep the REPORTING strings, not just the logic.
- **When the subject IS a script, the check resolves the script from its
  own tree** (`BASH_SOURCE`-derived root) so it structurally cannot reach
  across trees — make this the default shape for tooling done-means
  (round 12 sharpened).
- **Plant-and-survive on worktree refusals needs the REGISTRY check, not
  just the directory check** — a created-then-cleaned worktree leaves a
  `.git/worktrees` registration a `-d` test alone would miss.
- **Local-only branch (no origin counterpart) is continued and
  announced, not refused** — lane judgment call, flagged in PR #669's
  assumptions field; stands unless the operator overrules.


graduated: bullets 1, 3 and 4 -> docs/sme/entries/2026-08-08-a-negative-match-clause-can-go-green-off-the-subjects-own-error-text.md (adversarial order 86); bullet 2 -> the same entry's summary-line corollary; bullet 5 -> history-only, a lane judgment call flagged in PR #669's assumptions field and never overruled.
provenance: PRs #668, #669.
### 2026-08-08 (round 22) — harvest of the #666 transport-delegation lane

- **When the defect is "what does X pass to the boundary," stub the
  BOUNDARY — do not extract a helper for observability.** Extracting
  `buildProviderEnv()` would invent a seam the check proves instead of
  the real call site — the same gap class that let #655's stubbed green
  miss #666. Monkeypatching `Bun.spawn` (existing convention:
  src/tools/__tests__/search-all.test.ts:85) lets the SHIPPED method run
  unmodified while the check reads what the real spawn received.
- **A single-key presence assertion most needs a mutant, and an ENV-level
  mutant beats a source-level one** — stripping the key from the OBSERVED
  env keeps RED regenerable forever with the fix in place (round 16's
  SKIP-flag idea, env spelling). Report what it proves honestly: the
  clause reads that key and fails on absence.
- **The design-lookup gate's window EXPIRES mid-lane** (plain time decay,
  distinct from round 20's sibling contention). Long lanes get gated
  twice on unrelated writes; when a legitimate lookup returns nothing,
  declare UNVERIFIED and source the convention elsewhere (git log) —
  an empty result is neither permission nor a gate defect.
- **Fast-and-explicit "No results found" is a genuine miss; empty output
  after a 120s+ hang is did-not-run.** The two are distinguishable and
  must be treated differently (rounds 11/17/20 refined).


graduated: bullets 1 and 2 -> docs/sme/entries/2026-08-08-stub-the-boundary-do-not-extract-a-helper-for-observability.md (correctness order 87), enforced by scripts/done-means/666-transport-delegates-namespace.sh; bullets 3 and 4 -> the same entry's empty-result corollary, and docs/sme/entries/2026-08-08-includes-on-a-raw-log-line-is-a-substring-match-and-every-superset-satisfies-it.md (empty after a timeout is did-not-run).
provenance: PR #666 lane; issue #666.
### 2026-08-08 (round 21) — harvest of the #653 branch-sync lane

- **`lane-bootstrap` refuses a continuation lane on an EXISTING BRANCH,
  not only on a leftover worktree** (hard-coded `worktree add -b` at
  scripts/lane-bootstrap.ts:302-309; round 11 recorded only the worktree
  half). Until the script gains a continuation mode (ruling requested,
  pending decisions pass), a continuation lane hand-replicates fetch /
  `worktree add` WITHOUT `-b` / `.env` copy / `bun install --frozen-lockfile`
  — and announces the hand-build, because hand-building is what ledger
  item 15 exists to stop.
- **Record the NEGATIVE results of the merge-recheck rule too.** Round
  11's "conflict-free is not clean" re-run cost ~1 minute and came back
  clean; only reporting the catches would make the rule look more
  expensive than it is.
- **`PIPESTATUS` evaluated outside the pipeline's shell prints EMPTY** —
  indistinguishable at a glance from exit 0, and it bit twice in one lane
  (a refusal path whose whole claim is nonzero exit, and tsc). Round 19's
  tee-masking lesson, second spelling: redirect to a file and read `$?`.
- **"Prove the refusal, never the credentialed path" is a viable standing
  split for uncredentialed continuation lanes** — the gate's refusal
  enumerates all 8 missing coordinates by name, so a lane with no
  credentials fully exercises the refusal branch with zero harvest risk;
  the credentialed leg stays with the controller-dispatched verifier.


graduated: bullets 1 and 4 -> docs/sme/entries/2026-08-08-pipestatus-outside-the-pipelines-shell-prints-empty-and-reads-as-exit-0.md (quality order 88), with the continuation-mode half now shipped by scripts/done-means/667-lane-bootstrap-continuation.sh; bullet 2 -> the same entry's record-the-negative-results corollary; bullet 3 -> the same entry's opening pattern.
provenance: PR #653 branch-sync lane.
### 2026-08-08 (round 20) — harvest of the #661 five-keys lane (PR #663) and the hold-at-RED escalation

- **An issue generated from a tool's own output inherits that tool's
  classification errors** — #659's reporter could not tell set-empty from
  set-valued, its boot line named a prohibited key, and the ruling said
  "honor all six." The lane validated each enumerated key against source,
  found the prohibition (`PROHIBITED_PATH_KEYS`, test-pinned), HELD AT
  PROVEN RED, and escalated with options instead of obeying or silently
  deviating. Operator amended the ruling (29.2a). This is the
  no-variations rule's designed behavior — brief it as the expectation.
- **Empty-means-suppressed is repo precedent** (`QMD_PATH=`): a drop
  reporter distinguishes unset / set-empty / set-valued, and skips
  explicit suppressions rather than announcing them — a per-suppression
  boot line is the noise the #659 scope rule exists to prevent.
- **Report equivalent mutants as equivalent, not as kills.** A survived
  mutant (`=== ""` vs `!configured` behind an undefined-guard) is
  provably unreachable, not a check gap; the first instinct to "fix" the
  check would have shipped a false rationale. A survived mutant deserves
  the same why-analysis as a failed clause.
- **The two-runs-same-SHA CI comparison settled a red check in one
  call** (push failed, pull_request passed on identical 93d021d): a
  fixed-literal fixture on the shared CI database collides across
  concurrent jobs — filed as #665, not absorbed, not retried into green.
- **Prove new tests execute** — assert the test COUNT went up (14→19)
  rather than trusting a green suite that may not have loaded the file.
- **`aqmd search` >120s hang, third datapoint** (rounds 11/17): treat
  `qmd search` direct (~1s) as the standing fallback; empty output after
  a timeout is did-not-run.


graduated: bullets 1, 2, 3 and 5 -> docs/sme/entries/2026-08-08-an-issue-generated-from-a-tools-output-inherits-that-tools-classification-errors.md (adversarial order 89), enforced by scripts/done-means/661-launcher-honors-six-keys.sh; bullet 4 -> docs/sme/entries/2026-08-08-includes-on-a-raw-log-line-is-a-substring-match-and-every-superset-satisfies-it.md (the two-runs-same-SHA corollary), with the collision itself filed as #665; bullet 6 -> the same entry's empty-after-a-timeout corollary.
provenance: PR #663; operator ruling 29.2a.
### 2026-08-08 (round 19) — harvest of the #662 validator lane (PR #664) and the #653 credentialed verify

- **A guard written as "key present AND value wrong" leaves the absent
  branch unguarded** — and the absent branch inherits the exact dead end
  the guard was added to remove. #654 and #662 are one defect on two
  sides of one `if`. When a fix special-cases a key, enumerate the key's
  states — present-correct, present-wrong, absent — and say which branch
  handles each.
- **"The server always sends it" is not a reason to leave a validator's
  hostile-input branch dead-ended.** The lane object is the untrusted
  thing being validated. The dispatch's server-side hypothesis was
  reasonable and wrong; one live `tools/call` plus reading the column
  lists settled it in minutes — a lane rejects a briefed hypothesis on
  evidence and writes the reasoning into the check header, never decides
  silently.
- **Absence and mismatch need different messages because only one has a
  remedy.** Reusing the delegation advice for the absent case would pass
  a naive "mentions namespace" assertion while being a dead end with more
  words. Clauses assert what the message SAYS, not that it exists.
- **`rg -r` is ripgrep's REPLACE flag, not recursive** — it silently
  emits mangled replacement text that reads as a single real hit. Joins
  the `rg -E` family: the failure mode is a plausible-looking wrong
  answer, not an error.
- **A verify run that pipes the driver through `tee` masks the exit
  code.** Read the code directly (re-run clean or use pipefail); the
  #653 verify caught its own masked first run and re-ran.
- **The controller's external row count corroborated the gate's own
  teardown clause** (round 16 rule applied in anger): baseline before,
  count after, from outside the run. Also observed: a per-run tally can
  under-report entity creation (attempted=1 while two namespaces
  appeared) — count the entities, not the attempts.
- **A gate that keeps failing on REAL defects is doing its job** — the
  #578 gate's first credentialed run found the third live defect in the
  very path it composes (#654's absent-case sibling). Resist reading a
  red gate as a broken gate; the verifier proved the fixed defects fixed
  (re-ran their checks live) before attributing the new failure.


graduated: bullets 1, 2 and 3 -> docs/sme/entries/2026-08-08-a-guard-written-as-present-and-wrong-leaves-the-absent-branch-unguarded.md (security order 90), enforced by scripts/done-means/662-absent-namespace-scope-proof.sh; bullet 4 -> the same entry's rg -r corollary, and docs/sme/entries/2026-08-08-lane-tooling-gotchas-the-shell-the-validator-and-the-worktree.md; bullet 5 -> docs/sme/entries/2026-08-08-pipestatus-outside-the-pipelines-shell-prints-empty-and-reads-as-exit-0.md; bullets 6 and 7 -> the round-19 entry's gate-that-keeps-failing corollary.
provenance: PR #664; the #653 credentialed verify.
### 2026-08-08 (round 18) — harvest of the #659 launcher-env lane (PR #660) and the controller-side discovery

- **A revision proof is not a feature-live proof.** The clone redeploy
  PASSED its revision proof at the right SHA while the merged feature
  stayed dark: the launcher's env allowlist dropped the new config keys.
  After any deploy that is supposed to light up a feature, read the
  FEATURE's own signal (/health block, log event), not just the revision.
  (#659 exists because these were conflated for ~10 minutes.)
- **When a merged feature fails in deployment, ask which seam the passing
  check could not see.** #656's done-means drove `createShadowApplication`
  directly, so the entire launcher spawn chain was outside its vantage —
  the check was honest about its seam and the seam was where the defect
  lived. Chain-level clauses driving the real launcher through its
  injected boundaries were cheap and were the only ones reproducing the
  live symptom.
- **An env allowlist between launcher and child is a standing drop
  hazard** — third instance of the class (#530 tracing, then AUTH_TOKEN_USER_,
  now capture-health). The fix is announce-on-drop, not abolishing the
  allowlist; six more silently-dropped configured keys surfaced the moment
  drops became visible (PROPOSED, need an operator ruling each).
- **A done-means check for a NEW export must import it dynamically.** A
  static import at the pre-fix tree dies at module resolution before any
  clause prints — a false RED identical in shape to a real one, reached by
  the ORDINARY act of writing a check for a function that does not exist
  yet. Round 16's broken-import lesson generalized: this is the default
  path, not an edge case.
- **A scope rule needs both halves in ONE clause, and only a mutation
  proves it.** "Ambient vars NOT announced AND configured key IS" was the
  only clause catching an announce-everything filter; an unscoped drop
  report is boot noise an operator learns to skip — silence with extra
  steps. Companion rule: a drop report names KEYS, never values (the
  dropped set contains secrets in the general case).
- **Read WHY each RED clause failed, not just the tally.** Three fixture
  defects (WAL path, clone root, QMD_PATH) failed identically to the
  defect under test at the shell. A false RED banks confidence in a check
  that measured nothing.
- **Suspect your own formatting before a known gate defect.** #641 being
  real made it the attractive explanation for a validator refusal that was
  the lane's own backticks-in-field-value. Reading the validator's five
  lines of path resolution beat another workaround attempt.
- **Self-reported violation, harvested not punished:** a reflexive bare
  `rm -rf` (argument-less, deleted nothing, error swallowed by
  `2>/dev/null`) ran inside a clean-clone command. The reflex fires inside
  otherwise-correct compound commands — which is exactly why the ban is
  unconditional and why `2>/dev/null` on cleanup steps deserves suspicion.


graduated: bullets 1, 2, 3, 4, 5, 6 and 7 -> docs/sme/entries/2026-08-08-a-revision-proof-is-not-a-feature-live-proof.md (domain-backend order 91), enforced by scripts/done-means/659-launcher-env-passthrough.sh; bullet 8 -> the same entry's self-reported-violation section, and standing contract clause 7 (no rm, ever, anywhere) plus clause 8 (self-reported violations are harvested, never punished).
provenance: PR #660.
### 2026-08-08 (round 17) — harvest of the #656 observer-wiring lane

- **`includes("<event_name>")` on a raw log line is a substring match, and
  every superset satisfies it.** A renamed event (`x_MUTED`) kept two
  clauses green. Parse the line and compare the `msg` field for equality
  (`findEvent()`), then mutation-test the rename. Round-9 negative-match
  family, new spelling: the clause passed both when the notice existed and
  when it had been renamed away.
- **A "loud on absence" claim asserts BOTH halves in ONE clause** — loud in
  the log AND quiet in the health verdict. Split into two clauses, each
  half passes for the wrong reason: silence-on-absence is the status quo,
  and a verdict-on-absence violates absence-is-not-staleness. Two
  audiences, one clause.
- **The design-lookup gate earned its cost a second time** (after round
  10b): it fired on the exact edit where the lane was about to hand-roll
  shutdown teardown in a catch block, and the surfaced doc showed
  `backgroundRuntimes` already owns ordered shutdown — the delta became
  one runtime registration instead of a new mechanism. Record gate paybacks
  as deliberately as gate taxes, or the ledger only ever argues for
  retirement.
- **`aqmd search` returning EMPTY after a 120s+ timeout is worse than
  slow** — it reads as "no results," not "did not run." Extends round 11:
  wrap in `timeout` AND treat empty output as did-not-run; `qmd search`
  direct is the ~1s fallback. (Second datapoint, gate defect thread.)
- **Two CI runs of one identical SHA disagreed again** (#643 shape) — the
  `push` and `pull_request` workflows both run `check` on the same commit,
  so every PR gets this two-runs-same-SHA comparison for free; use it
  before concluding branch defect.


graduated: bullets 1 and 2 -> docs/sme/entries/2026-08-08-includes-on-a-raw-log-line-is-a-substring-match-and-every-superset-satisfies-it.md (correctness order 92), enforced by scripts/done-means/656-capture-observer-wired.sh; bullets 3, 4 and 5 -> the same entry's payback, timeout, and two-runs-same-SHA corollaries.
provenance: #656 observer-wiring lane.
### 2026-08-08 (round 16) — harvest of the #655 eval-teardown lane

- **A teardown that reports success is not evidence of removal.** The RED
  run shows `failed=0` while 2 rows leak: the tally is the thing under
  test, never the proof. A teardown gate asserts a row COUNT from outside
  the run.
- **In this schema a namespace is an emergent property of its rows** — no
  registry table, so soft-delete (`archive_entry`) can never retire one.
  24 archived-only eval namespaces are what that looks like after months.
  State this once instead of rediscovering it per lane.
- **RED by breaking the import is a false RED.** Moving the module aside
  killed the driver at import; clause (a) measured nothing. A `SKIP_*` env
  flag reproduces the pre-fix world with everything else intact and keeps
  RED regenerable forever without deleting the fix.
- **A guard needs a canary, not just an exception.** "Throws on a bad
  name" and "refuses BEFORE mutating" are different claims; only planting
  a row under each refused name and checking it survives distinguishes
  them.
- **The design-lookup gate's recent-lookup window is session-scoped, not
  lane-scoped** — a sibling concurrent lane's lookup can occupy the window
  and make a correct denial look spurious. Gate working as designed; know
  the shape before reporting it as a misfire.


graduated: bullets 1, 3 and 4 -> docs/sme/entries/2026-08-08-red-by-breaking-the-import-is-a-false-red-use-a-skip-flag.md (correctness order 93), enforced by scripts/done-means/655-eval-teardown.sh; bullet 2 -> docs/sme/entries/2026-08-08-a-prefix-scoped-sql-delete-of-provable-test-residue-is-the-lanes-to-run.md (a namespace is an emergent property of its rows); bullet 5 -> the round-16 entry's session-scoped-window corollary.
provenance: #655 eval-teardown lane.
### 2026-08-08 (round 15) — harvest of the #654 namespace-scope lane (PR #657) and its verify run

- **A live-service check reads the SERVING process's credentials, never the
  checkout's.** The repo `.env` has an empty `AUTH_TOKEN_ADMIN` since the
  #645 scrub, so a check built on it 401s by design and reads as a service
  fault. Round 12's which-tree-runs rule extended to identity: name where
  the credential comes from in the check header, and refuse loudly when it
  is absent instead of falling through to a misleading auth failure.
- **A security control is unproven until something REQUESTS the dangerous
  thing.** The server role-gates `X-Namespace`, but the Python client had
  `delegate_namespace=False` hardcoded since #294 — the header was never
  sent, so the 403 path had never executed in any run. A refusal branch
  that has never refused is decoration; the done-means now sends the
  forbidden request and asserts the refusal (clause c) AND that the
  refusal names the actionable cause (clause d).
- **Silent-default identity is tenant mis-scope, not cosmetics.** With
  delegation hardcoded off, every delegated-intent session landed in
  namespace `admin` — a real cross-tenant landing, stronger than the issue
  as filed. Any config key that selects identity is REQUIRED config, loud
  on absence, never silently defaulted (ledger item 28).
- **Errors must name what the caller can change — the dead-end-error
  class.** #646 (scope errors naming response vocabulary the validator
  rejects) and #654 (a silent wrong-namespace landing with no signal at
  all) are the same defect at different volumes. A refusal that does not
  name the acting cause, or a mis-scope that says nothing, both strand the
  caller; checks assert the error TEXT, not just the status.
- **A red anchor that inverts at the fix is only meaningful bound to the
  PR head.** Clause (a)'s PASS proves the fix only because verify-lane
  pinned the worktree to the head SHA and re-read it after the run
  (`recheck-head`). Any check whose RED lives on main and GREEN on the
  branch inherits this binding requirement.


graduated: bullets 1, 2, 3, 4 and 5 -> docs/sme/entries/2026-08-08-a-live-service-check-reads-the-serving-processs-credentials.md (security order 94), enforced by scripts/done-means/654-namespace-scope-proof.sh; bullet 3 also -> ledger item 28 (identity-selecting config is required config, loud on absence).
provenance: PR #657.
### 2026-08-08 (round 14) — harvest of the #652 capture-health composition lane

- **A "compose it" lane must ask what the composer can actually SEE.** The
  reader wanted watermark bytes and spool depth — client-side per-hook
  files a server cannot enumerate. Passing an honest-looking 0 for an
  unobservable count is not neutral: zero-while-sessions-ran IS the wedged
  fault, so it would degrade every healthy deployment. Substitute a value
  preserving the PROPERTY (turns arriving ≈ watermark advancing) and
  publish which faults the vantage point can raise. (Round 10's TEST-NET
  lesson, counts domain.)
- **A per-role check must seed the expected roles before folding rows.**
  `GROUP BY role` returns no group for the dead speaker — the exact entity
  the check exists to find. A fold over returned rows reports a busy lane
  and rebuilds #447.
- **Late-binding needs its own clause:** two requests against one composed
  app with the observation changed between them was the ONLY clause that
  caught a boot-captured reading. Any health input composed as a closure
  carries this clause.
- **A WRITTEN-not-RUNNING declaration that names its own missing piece
  makes the next lane cheap** — #648's residual-risk field pointed straight
  at the composition root; this lane declares its own remaining gap
  (server/main.ts wiring awaits an operator config ruling: namespace,
  window, refresh cadence) the same way. Hardcoding defaults to satisfy a
  dispatch expectation would have been the adjusted-silently failure.
- **A type added for a future composer is exported at the boundary in the
  same PR** — tsc found #648's `TransportCaptureHealth` declared but never
  barrel-exported; invisible until the first composer tried to import it.


graduated: bullets 1, 2, 3 and 5 -> docs/sme/entries/2026-08-08-a-compose-it-lane-must-ask-what-the-composer-can-actually-see.md (domain-backend order 95), enforced by scripts/done-means/652-capture-health-composed.sh; bullet 4 -> the same entry's declare-your-own-gap corollary, and standing contract clause 5 (nothing silent).
provenance: #652 capture-health composition lane.
### 2026-08-08 (round 13) — harvest of the #647 capture-liveness lane (PR #648)

- **The design may already exist and simply never have been executed.** #647
  read as "invent a liveness check"; `docs/decisions/capture-never-drops-a-turn.md:182-200`
  had specified it — per-role, count-based — for eleven days, with its own
  record that it "was never run." Treat "has this been specified and left
  unrun?" as the FIRST question of any build lane, not a formality: the
  lookup materially changed the deliverable and avoided rebuilding the #447
  per-role blind spot.
- **A top-level `await main()` with no `.catch` exits 0 when it throws** —
  a crashing subject banks a false GREEN, and the shell wrapper's careful
  status capture cannot save you because the defect is upstream of it.
  Verify the crash path's exit code under mutation. (SME entry order 67;
  invisible in every green run.)
- **A control clause that passes PRE-fix is the signal the check
  discriminates.** 10/13 red with the two controls green is stronger
  evidence than 13/13 red — a check that fails everywhere proves only that
  it fails.
- **The stash stack is shared even when the worktree is exclusively yours.**
  Second lane this session to pop a foreign stash from a bootstrapped
  worktree (third incident overall). New rule: lanes do not use `git stash`
  for red/green proofs — file-copy instead. The round-1 "checkout you don't
  own" wording under-scoped the hazard.
- **Gate-precision datapoints:** design-lookup accepted `aqmd` but refused a
  direct `sqlite3` query of the same index (#637 corpus); git guard fired on
  a protected-branch name inside a merge-commit MESSAGE (fifth #618 shape —
  say "upstream default branch").
- **Capability state named honestly:** the liveness reader is MERGED code,
  but no process composes it yet — no live /health reports capture until a
  composition change ships. WRITTEN-not-RUNNING, stated in the PR rather
  than implied away.


graduated: bullets 1, 3 and 4 -> docs/sme/entries/2026-08-08-ask-whether-the-design-already-exists-and-was-simply-never-run.md (quality order 96); bullet 2 -> docs/sme/entries/2026-08-08-a-top-level-await-driver-exits-0-when-it-throws-banking-a-false-green.md, already carried at order 67; bullets 5 and 6 -> the round-13 entry's gate-precision datapoints and its name-the-capability-state corollary.
provenance: PR #648.
### 2026-08-08 (round 12) — harvest of the #646 provider-scope lane (PR #650)

- **Verify which tree the process actually runs before reading source as
  truth.** The lane reasoned about correct-looking code in `src/` while the
  service ran `server/main.ts` (`lsof -nP -iTCP:<port>` + `ps -o command`
  answers it in one call; `package.json` `start` still points at the
  non-serving tree). A source file that contradicts observed behavior is
  evidence you are reading the wrong file, not evidence of a mystery.
- **A done-means fixture encodes a world-assumption that can be wrong in
  either direction — query the real distribution before inventing a fixture
  shape.** The lane's first fixture seeded a conflicting `agent` and read
  the server's contract-correct refusal as a failure; it nearly "fixed"
  correct code. All 2011 real lanes carried the matching agent.
- **A shared test resource closed by an earlier suite's `afterAll` fakes a
  red.** Distinguish by assertion count: 23 assertions executing means the
  subject failed; a harness error executes near zero.
- **`git stash push` on already-committed work stashes NOTHING, and the
  follow-up pop grabs someone else's stash.** Read the stash output before
  popping. (Second foreign-stash incident; first was #624.)
- **A live-service-bound receipt is not portable:** a check that proves
  behavior against 127.0.0.1:3100 at revision X proves nothing about any
  other host or revision, and goes stale on redeploy. Name the binding in
  the receipt.
- **Near-miss discipline, both directions:** a phantom finding (nonexistent
  import) was re-checked and retracted before reporting; a wrong fixture
  was corrected and RED re-proven against the pre-fix revision. Both are
  the report's job, not its shame.
- **Lazy-heal is a decision, not a default:** 2011 scope-broken lanes heal
  on their next capture; no bulk repair was run, and the report says so —
  bulk-heal remains an operator option.


graduated: bullets 1, 2, 3, 4 and 5 -> docs/sme/entries/2026-08-08-verify-which-tree-the-process-runs-before-reading-source-as-truth.md (domain-backend order 97), enforced by scripts/done-means/646-provider-scope.sh; bullets 6 and 7 -> the same entry's near-miss-discipline and lazy-heal corollaries, and standing contract clause 5 (nothing silent).
provenance: PR #650.
### 2026-08-08 (round 11) — harvest of the #645 conflict lane, the ledger-25 retirement lane (PR #649), and the worker-48 pin failure

- **A recorded ruling is not an implemented one, and the gap is invisible to
  every check that predates it.** Ledger item 25 retired the capture gate;
  main kept it registered, and nothing failed because no check asserted the
  retirement. A ruling that retires a mechanism needs its own done-means
  check on the same pass, or ledger and tree drift silently.
- **The worker-48 model pin does not bind through direct Agent dispatch:**
  the lane self-reported claude-fable-5 — the head's model — despite the
  agent definition pinning claude-opus-4-8. Requested-model provenance
  recorded what was asked, not what answered (the ledger-18 provenance
  warning proven live). A/B still has ZERO valid 4.8 samples; model-pinned
  dispatch must go through the route that actually places the model.
- **A generated file in conflict is regenerated, never hand-merged** — the
  conflict lives in the inputs, and usually is not one (SME index rebuilt
  from entries; both sides' entries survived).
- **A conflict-free merge is not a clean merge: a merge is a fresh RED
  opportunity for every gate the branch owns.** The neutrality gate caught a
  literal #642 introduced after the branch cut — correct on each side,
  wrong only in combination. Re-run the branch's own checks AFTER merging
  main.
- **Inverting a done-means clause needs its own RED** (extends round 9's
  rewritten-clause rule), and **retired-vs-deleted must be distinguished by
  the check** — the 451 clauses now fail loudly if a cleanup deletes the
  #647 prior art instead of retiring it.
- **A hook-set assertion needs both directions:** "none missing" passes
  while a sixth hook creeps in; the "none extra" half catches config drift.
- **FETCH_HEAD is per-worktree**; fetch inside the worktree you merge in.
  **lane-bootstrap refuses a leftover worktree** — on a continuation lane
  for the same branch, reuse it after verifying clean/synced/.env, and flag.
- **Gate defects, minimal-paired this round:** git guard fires on the word
  "main" in commit MESSAGE prose on a correctly-named branch (say "the
  default branch"; guard should read `git branch --show-current`);
  design-lookup-gate fires on a gitignored scratch PR-body file; the
  PRE-PUSH hook runs the suite against the shared dogfood DB — the exact
  inadmissible path of the #614 ruling (1 fail → 0 fail on an identical
  tree, skip counts 485 apart). `aqmd search` can exceed 120s — wrap in
  `timeout`.
- **Announced by tooling, needs a home:** verify-lane/lane-bootstrap print
  `ADJUSTED: neither OPENBRAIN_TEMP_WORKSPACE nor DEV_TMP is set` and place
  worktrees under ~/.cache instead of the configured temp workspace. Set the
  variable in controller/verifier environments or teach the scripts the
  Development default.


graduated: bullets 1, 3, 4, 5, 6 and 7 -> docs/sme/entries/2026-08-08-a-recorded-ruling-is-not-an-implemented-one-and-the-gap-is-invisible.md (gotcha-agent order 98), with the retirement half enforced by scripts/done-means/648-capture-gate-retired.sh; bullet 2 -> the same entry's model-pin corollary and _DOCS/MODEL_ROUTING.md (a worker launch pins its own model); bullet 8 -> the same entry's gate-defects section.
provenance: PR #649; the #645 conflict lane; the worker-48 pin failure.
### 2026-08-08 (round 10) — harvest of the #636 neutrality-scrub lanes (PR #645, Sol + Claude continuation)

- **A placeholder only neutralizes a value nothing compares to reality.** A
  find-and-replace sweep treats every match as an example, but a literal that
  the filesystem, an equality check, a skip condition, a recorded fixture, or
  a pasting human actually READS is behaviour — substituting it silently
  disables what it was for. 8 of the inherited sweep's edits looked correct
  in the diff and broke real things (a safety handshake, 18 identity tests,
  a documented deploy command). Companion SME entry: gotcha-agent order 66.
- **Check the SKIP count after a sweep, not just the pass count.** 25 Python
  tests silently stopped running (581/26 skip → 606/1) because a gate path
  became a placeholder; the suite reported green throughout.
- **Every done-means check with an exception mechanism needs a negative
  control.** The inherited gate piped violations into `| while read`, which
  cannot count across the subshell — it printed its own VIOLATIONs and
  exited 0. The repaired gate injects a violation into an excepted file and
  must still catch it.
- **192.0.2.x is TEST-NET-1, not RFC1918.** A fixture standing in for a LAN
  host must stay inside the address class the code under test classifies;
  the wrong placeholder family failed 18 server-identity tests.
- **Continuation-lane audit duty is load-bearing:** ~90% of the dead Sol
  lane's sweep was kept, 8 defects corrected, 2 suspicious edits verified
  and kept with reasons — inherited commits are salvage to audit, never
  truth to build on (round-7 rule, proven at scale).
- **Fail-closed deviation, flagged and resolved:** deploy runner labels are
  now a REQUIRED repo variable with no fallback (an unset variable used to
  still schedule onto any matching macOS runner). Controller set
  OPENBRAIN_DEPLOY_RUNNER_LABELS to the prior label set same-session, so the
  next deploy schedules unchanged. Ratification belongs to the next
  decisions pass.
- **GitGuardian flags credential-SHAPED fixture strings on every diff that
  touches them** — the hunter2-family fakes exist to prove redaction and
  re-trigger the scanner whenever scrubbed. Expected noise on neutrality
  work; the finding to check is whether the HOST half is real, not the
  fake secret.


graduated: bullets 1, 2, 4 and 7 -> docs/sme/entries/2026-08-08-a-placeholder-only-neutralises-a-value-nothing-compares-to-reality.md (gotcha-agent order 66); bullet 3 -> docs/sme/entries/2026-08-08-a-repaired-or-rewritten-check-has-never-failed-in-its-current-form.md; bullet 5 -> standing contract clause 1 (worker output is PROPOSED until the controller re-runs); bullet 6 -> history-only, the deploy-runner variable is required with no fallback and was ratified in the same session.
provenance: PR #645.
### 2026-08-08 (round 9) — harvest of the #451 tiered-coverage lane (PR #642)

- **`rg -E` can manufacture a false GREEN, not just an error.** Inside an
  if/elif verdict chain, rg's flag-parse failure exits non-zero, which reads
  identically to "pattern not found" — the clause silently advances to PASS.
  Second `rg -E` incident in these Tightenings; first that PASSED instead of
  failing. Use `rg -e`; mutation-check any clause whose PASS comes from a
  negative match — those pass both when the thing is absent and when the
  check is broken.
- **A green clause is not evidence until it has been seen to fail.** Both of
  the lane's self-caught defects were invisible in a fully-green run and
  surfaced only under deliberate mutation. The mutation-test Tightening
  (#615/#620) extends to every negative-match clause.
- **Check the enum before designing a new dimension.** The natural
  `usage_kind="recall"` would have required a Zod enum change AND a DB CHECK
  migration — two greps found the pin before any code was written. Read the
  constraint, not just the field.
- **An outage path is testable without an outage:** a closed port in
  7100-7199 yields a real connection refusal with no waiting and no
  wall-clock assertion; "service up" cases differ only by fixture data.
  Reusable for any gate distinguishing unreachable from empty.
- **Verify "pre-existing" by stashing, not asserting** — the #609 full-suite
  differential applied cheaply to a formatter: stash the lane's changes,
  re-run, identical 42 files → main-owned.
- **Honest gaps carried forward (PROPOSED, named in PR #642):** the
  drain-DELIVERS direction (a drain that produces the receipt flipping a
  refusal to a pass) is unproven — needs a seeded-spool clause; hung-TCP
  outage shape untested; session_id/session_key equivalence assumed, enforced
  nowhere.


graduated: bullets 1 and 2 -> docs/sme/entries/2026-08-08-a-repaired-or-rewritten-check-has-never-failed-in-its-current-form.md; bullets 3, 4 and 5 -> docs/sme/entries/2026-08-08-prove-absence-by-the-variable-the-code-reads-and-re-run-never-re-quote.md; bullet 6 -> history-only, gaps named in PR #642 and carried by done-means 451-tiered-coverage.sh.
provenance: PR #642.
### 2026-08-08 (round 8) — harvest of the #625 (PR #640) and #563 (PR #639) lanes

- **A done-means clause can silently measure its own harness — optional
  chaining on the subject's API is the newest mechanism.** #625's clause (a)
  called `sweep.runOnce?.()` on a method that did not exist, attempted
  nothing, and would have "passed" while proving zero. When a clause drives a
  subject, assert the drive actually happened (round 6's measures-the-guard
  pattern, new spelling).
- **A rewritten or repaired clause has never failed in its current form — RED
  must be re-proven after ANY edit to the check.** Both lanes hit this
  independently (#625 after repairing clause (a); #563 after rewriting clause
  5's instrument). A correct-looking aggregate FAIL can hide a clause that
  measured nothing.
- **Every failure-signal check needs a control clause proving the healthy path
  stays healthy** (#624 clause-z, generalized): assert the signal appears when
  it should AND does not when it should not.
- **Measure the envelope before blaming the payload** (#563): a size probe
  showed the "oversized" reply was the honest cost of ten whole records;
  guessing would have trimmed real data to satisfy a self-imposed threshold —
  exactly what the no-reduction rule forbids.
- **"Absence is not staleness"** (#625): a component that is not composed must
  not be reported broken, or every opted-out worker degrades itself.
- **pr-body-gate wrong-version defect confirmed by THREE independent lanes**
  (#637, #625, #563); mechanism pinned to pr-body-gate.ts:95-96 +
  validate-pr-body.ts:70 resolving repoRoot from the hook's own location.
  Tracked as #641. Interim sanctioned workaround (the cleanest of the three
  observed): run `CLAUDE_PROJECT_DIR="$PWD" gh pr create` FROM the lane
  worktree so the gate validates the correct tree — enforcement stays live,
  no materializing files into the primary checkout.
- **Two runs of the same SHA disagreeing is the flake signal** (#563): check
  headSha on both runs before concluding anything from a red check; file the
  flake (#643) instead of absorbing it.
- **Gate false positives, new shapes for the #637 fixture corpus:** "limit"
  inside a QUOTED phrase from the observability standard (#625); firing on
  READS of pre-existing field names — including while removing that very
  field (#563 ×3).
- **Flagged deviation awaiting ruling** (#625): issue text asked for a
  wall-clock live-watch clause; lane implemented injected-clock event counts
  per the round-5 flake rule. Open question for the decisions pass: is
  hermetic-deterministic the standard for this class, or does a live-clone
  control clause get added alongside (the #384/#612 checks drive the live
  clone)?


graduated: bullets 1, 2 and 3 -> docs/sme/entries/2026-08-08-a-repaired-or-rewritten-check-has-never-failed-in-its-current-form.md; bullet 4 -> AGENTS.md Coding Standards (nothing is adjusted silently) and docs/sme/entries/2026-08-08-nothing-is-adjusted-silently-tools-announce-every-self-made-decision.md; bullet 5 -> done-means 625-sweep-heartbeat.sh; bullet 6 -> docs/sme/entries/2026-08-09-a-gate-that-judges-from-a-tree-other-than-the-one-under-review.md; bullet 7 -> docs/sme/entries/2026-08-09-an-exit-code-is-not-a-verdict-until-you-know-the-subject-ran.md; bullets 8 and 9 -> history-only, resolved by done-means 637-gate-precision.sh and the #625 ruling.
provenance: PRs #640, #639.
### 2026-08-08 (round 7) — harvest of the #637 gate-precision lane (PR #638) and the Sol runtime failures

- **A guard's own repair is the hardest thing to write past it.** The #637 lane
  was refused 12 times by the hook it was fixing — including on an `import`
  path, a file rename, and a read-only `rg` — plus a 13th firing on the
  controller while filing the follow-up issue. Hold precision-check fixtures in
  DATA FILES, never inline in code or commands; otherwise every agent editing a
  checker is refused by the guard under repair.
- **Assert the RIGHT refusal, then check whether the assertion is the bug.**
  The lane's first driver asserted a specific banner; RED revealed a sibling
  clause refusing those cases correctly. Satisfying the naive assertion would
  have weakened a layer that was never broken — the round-6 wrong-layer
  pattern, this time caught before it cost anything.
- **Text passes have different jobs: detection may strip, classification must
  read the sentence as written.** Path-stripping fed into the intent classifier
  deleted the subject noun a defect-report fixture's grammar needed. Never feed
  a stripped string to the pass that asks "what is this text DOING?"
- **pr-body-gate judges done-means paths at the wrong version** — it resolves
  against the primary checkout, so a PR introducing a NEW check is refused even
  though the path exists at the PR's own head. Filed as #641 with the
  read-only-`rg` classifier gap. Same wrong-version class as round 5.
- **Sol runtime instability is A/B data:** two consecutive process deaths on
  one dispatch (exit-144 with zero work; mid-work death that printed a false
  "RUNNING" and exited 0). The recovery pattern that worked: a continuation
  lane inheriting the dead lane's worktree, auditing the inherited commits as
  PROPOSED before building on them. A dead worker's branch state is salvage,
  not trash — and not truth.
- **Operator-attention flag (unresolved):** PR #638's conventional-commit-prefix
  exemption is its widest exemption and likeliest future false pass; the lane
  flagged it as known residual risk rather than silently narrowing or keeping
  it. Needs a ruling at the next decisions pass.


graduated: bullets 1, 2 and 3 -> docs/sme/entries/2026-08-08-name-the-layer-that-produced-the-symptom-before-writing-the-fix.md; bullet 4 -> docs/sme/entries/2026-08-09-a-gate-that-judges-from-a-tree-other-than-the-one-under-review.md; bullet 5 -> standing contract clause 1 (inherited work is PROPOSED until re-verified); bullet 6 -> history-only, the PR #638 exemption was carried to the decisions pass.
provenance: PR #638.
### 2026-08-08 (round 6) — harvest of the #629 clause-8 fix (the check that measured its own guard)

- **A done-means check that exercises its own tooling inherits that tooling's
  ambient environment.** The controller's clause-8 RED was real but blamed the
  wrong component: verify-lane's re-entry guard (`MGVL_VERIFY_LANE_PRS`) fired
  BEFORE done-means resolution, so the nested probe died at the guard and never
  reached the error text the clause asserted on. A clause must clear the
  ambient state its subject reacts to, or it measures the guard — **and
  reports a wrong cause that sends the next agent to fix code that was never
  broken.** The misdirection is the dangerous half.
- **"Fixing the wrong layer" is a lane-level pattern, not an incident.** Three
  distinct instances in one lane (two recursion-guard attempts against a
  selection defect, then a message-text fix against a pre-emption defect).
  Before writing a fix, state which layer produced the observed symptom and
  what evidence puts it there.
- **Named-env coupling flagged, not buried:** clause 8's correctness now
  depends on clearing two specifically named env vars; a future guard reading
  a different name silently regresses the clause to measuring the guard again.
  No test enforces the coupling; the refusal text is the only mitigation.
  (Lane-flagged residual risk, PR #629.)
- **Bootstrap refuses loudly without `.env` in the invoking checkout** — the
  controller's first fresh-worktree verify run failed at exactly the
  missing-.env failure the script exists to prevent, and no receipt was
  posted. Copy `.env` into any bare worktree you run verify-lane from.


graduated: bullets 1, 2, 3 and 4 -> docs/sme/entries/2026-08-08-name-the-layer-that-produced-the-symptom-before-writing-the-fix.md.
provenance: PR #629.
### 2026-08-08 (round 5) — harvest of the merge-gate lane (PR #629) and the Terra ruling

- **A repo guard cannot protect a run that checks out an older commit of the
  repo.** verify-lane executes the done-means check FROM the PR-head worktree,
  so a recursion fix committed after that head does not exist where the check
  runs. The #629 lane burned two fix attempts on guards before seeing the real
  defect was SELECTION (the live clause picked "whatever PR is open" — the PR
  containing itself). When a tool tests repo state at a pinned SHA, ask which
  VERSION of every involved script actually executes.
- **Fixture-driven staleness proof:** a receipt is only valid for the exact
  head SHA it ran against; verify-lane re-reads the head AFTER the check and
  refuses to post if the PR moved mid-run. Gates must name BOTH SHAs when
  refusing as stale.
- **Wall-clock assertions (`toBeLessThan(1000)` ms) are CI flake generators**
  — three runs, three different unrelated timing failures, all proven
  main-owned via the #609 differential and filed (#632, #634) instead of
  absorbed.
- **Gate defect:** design-lookup HARD NO fires on `prune` inside
  `git worktree prune` in a commit message — a git registration cleanup, not
  a cap. Reword; report. (Second `prune` false-positive this week.)
- **Effort tiers are policy, not fact** (operator ruling): `terra medium` was
  blocked by a stale launcher gate contradicting canonical
  `_DOCS/MODEL_ROUTING.md`; gate removed, route proven live. When a
  constraint appears only in a secondary copy, check the canonical source
  before repeating it.


graduated: bullets 1 and 2 -> docs/sme/entries/2026-08-09-a-gate-that-judges-from-a-tree-other-than-the-one-under-review.md and docs/sme/entries/2026-08-08-name-the-layer-that-produced-the-symptom-before-writing-the-fix.md; bullet 3 -> docs/sme/entries/2026-08-08-prove-absence-by-the-variable-the-code-reads-and-re-run-never-re-quote.md; bullet 4 -> standing contract clause 9 (refusals are rules working; report, do not fight); bullet 5 -> _DOCS/MODEL_ROUTING.md is canonical, secondary copies are not.
provenance: PR #629.
### 2026-08-08 (round 4) — harvest of a CONTROLLER defect (Langfuse false-absence claim)

- **Prove absence by the variable the CODE reads, never the product name.**
  The controller asserted "Langfuse unconfigured" after grepping env files for
  `LANGFUSE_*`; the sink reads `OPENBRAIN_TRACING_*`
  (`server/observability/langfuse-tracing.ts:601-604`), which was set and
  ENABLED the whole time — 806 traces landed in the claimed-dark window. To
  claim a config is absent: find the `process.env.X` read in source first,
  then search for X. Same defect class as #618 (matching vocabulary instead
  of the operation), committed by the head.
- **A verification conclusion is only as fresh as its last execution.** The
  wrong claim was made once from a bad grep and REPEATED hours later by
  quoting the earlier conclusion instead of re-running the check. Re-quote
  nothing; re-run it. Controller reports are subject to this exactly as lane
  reports are.


graduated: both bullets -> docs/sme/entries/2026-08-08-prove-absence-by-the-variable-the-code-reads-and-re-run-never-re-quote.md.
provenance: PR #629 round-4 harvest.
### 2026-08-08 (round 3) — harvest of the enforcement-build lanes (PRs #628, #630, #631)

- **`lane-bootstrap` prints the worktree path but does not change your
  directory.** Relative commands after it still target the primary checkout.
  Enter the printed absolute path explicitly. Also: `bunx --cwd` is not a
  thing — run `bunx` from inside the worktree. (Sol lane, PR #630 — first
  Codex-routed lane; returned the required report format exactly.)
- **Verify `.gitignore` outcomes by `git ls-files`, not by reading patterns**
  — a later rule can override the one you read. (#628 lane.)
- **Citations to artifacts that do not exist yet are fabrications.** A PR
  number guessed before `gh pr create` is a guess in the grammar of a fact;
  write the reference after the artifact exists. (#628 lane, self-caught.)
- **The done-means field is now enforced** (PR #630): every PR body carries
  `- Done-means: <path>` (validator-confirmed to exist) or the not-applicable
  form with a real reason. Forward-compliance is over; it is simply required.
- **Process canon now lives on `main`** (PR #631): lanes read
  `docs/lane-contract.md` and `docs/controller-contract.md` from their own
  worktree; the absolute-path bridge is retired.

graduated: bullets 1, 2 and 3 -> docs/sme/entries/2026-08-08-lane-tooling-gotchas-the-shell-the-validator-and-the-worktree.md; bullet 4 -> standing contract clause 3 and scripts/validate-pr-body.ts (the Done-means field is enforced, not forward-compliance); bullet 5 -> history-only, docs/lane-contract.md and docs/controller-contract.md now live on main and lanes read them from their own worktree.
provenance: PRs #628, #630, #631.
### 2026-08-08 (round 10b, lane-authored) — the #636 continuation lane's own harvest (detail companion to round 10; overlapping bullets kept for their specifics)


graduated: bullets 1 through 8 -> docs/sme/entries/2026-08-08-a-placeholder-only-neutralises-a-value-nothing-compares-to-reality.md (the full seven-instance taxonomy) and done-means 636-neutrality.sh with its allowlist and line-exception files; the negative-control bullet also -> docs/sme/entries/2026-08-08-a-repaired-or-rewritten-check-has-never-failed-in-its-current-form.md; the closing gate-refusal bullet -> standing contract clause 9. provenance: PR #645.
### NOTE (2026-08-18 rotation merge) — the round numbering forked

Between 2026-08-09 and 2026-08-18 two integration lines advanced in parallel:
main took PRs #686-#691/#701/#726 directly while wip/2026-08-07 carried
#708-#737. Both lines harvested rounds numbered 27-29 for DIFFERENT lanes.
Per the ratchet rule nothing is dropped: the three main-line entries follow
here, headings unchanged. Read round numbers at/below 29 as per-line, not
global; numbering is unified from round 30 up.

### 2026-08-09 (round 29) — harvest of the #675 integration (PR #688): the collision is the norm, not the incident

- **Third consecutive integration, same two collisions** (#701 -> #687 ->
  #688): the SME entry-count pin conflicted, and the `order:` field
  duplicated in a way git reported as no conflict at all. Round 28 recorded
  it as a merge-order hazard; three for three makes it a PROPERTY of running
  lanes in parallel, not an unlucky merge. Every integration of a branch
  carrying an SME entry should now EXPECT both, and the cost of assuming
  otherwise is a silently duplicated `order` that only the build can see.
- **A warning is the right severity for discovery and the wrong one for a
  gate.** `build-sme-indexes.ts` warns on a duplicate `order` and exits 0, so
  a merge that never runs the build ships the duplicate. It was caught all
  three times only because the integration ran the build by hand. The
  standing rule stays "re-run the branch's tooling after integrating," but
  the enforcement-migration candidate is obvious: the per-entry done-means
  check should fail on a duplicate `order`, the way it already fails on a
  duplicate heading. Flagged for the decisions pass rather than built here —
  it is main-owned tooling and belongs in its own change.
- **`FETCH_HEAD` is per-worktree, re-proven.** `git merge FETCH_HEAD` in a
  freshly-added worktree died with `could not open .git/worktrees/<name>/FETCH_HEAD`
  because the fetch had run in a different worktree. Fetch inside the
  worktree you merge in (round 11), and note the error names a missing FILE
  rather than a missing ref, which reads as a broken repo at a glance.
- **The design-lookup gate fired twice mid-lane on unrelated writes** (round
  22's window decay). Both were complied with rather than routed around, and
  the second lookup was load-bearing: it confirmed `order:` is an explicit
  sort field independent of entry date, which is what made "move the
  duplicate to the next free number" the correct resolution instead of
  renumbering by date.


graduated: bullets 1, 2 and 4 -> docs/sme/entries/2026-08-09-a-pin-derived-before-integration-is-stale-the-moment-anything-else-merges.md; bullet 3 (per-worktree FETCH_HEAD) -> the same entry's closing note. provenance: PR #688.
### 2026-08-09 (round 28) — harvest of the #681 integration (PR #687), a merge-order collision

- **Two branches can each derive a pinned count HONESTLY and still be wrong
  after the merge.** PR #687 measured EXPECTED_ENTRY_COUNT as 235 on its own
  tree and was correct there; PR #701 then landed its own entry and main
  became 235 too. The merged truth is 236. So a pin computed BEFORE
  integration is stale the moment anything else merges, and the freshness of
  a measurement is not a property of how carefully it was taken — it is a
  property of when. **Re-measure the pin after integrating the upstream
  default branch, never carry the branch's own derivation across a merge.**
  This is the concurrency half of the never-sum rule, and it is invisible to
  a lane working alone.
- **Git reported the ORDER collision as no conflict at all.** Both branches
  independently chose correctness `order: 68`, in two different entry FILES,
  so there was nothing for a textual merge to conflict on — the tree merged
  clean and the duplicate only surfaced when `build-sme-indexes.ts` was run
  and warned. Round 11's "a conflict-free merge is not a clean merge" with a
  sharper edge: the branch's own tooling must be RE-RUN after integrating,
  because the class of defect a merge introduces is precisely the class no
  textual merge can see. A generated-file conflict is regenerated; a
  generated-file NON-conflict still needs the build.
- **A shared sequential ID chosen by hand collides under parallelism by
  construction.** `order:` is allocated by reading the current maximum, which
  every concurrent lane reads identically. The build warns rather than fails,
  which is the right severity for a merge-time discovery, but the allocation
  scheme is the root cause and it will keep colliding as long as lanes run in
  parallel. Flagged for the decisions pass, not worked around here.


graduated: all three bullets -> docs/sme/entries/2026-08-09-a-pin-derived-before-integration-is-stale-the-moment-anything-else-merges.md. provenance: PR #687.
### 2026-08-09 (round 27) — harvest of the #271 tripwire heal (PR #701), a CONTROLLER merge defect

- **A failing assertion turns off every clause after it in the same test, and
  for a TRIPWIRE that is a hole rather than an inconvenience.** The #271
  block's later clauses — the exact top-level key-set assertion and the
  push/injection negative filter — are the ones that enforce the boundary,
  and the stale version literal aborted the body before either ran (37
  expect() calls red vs 44 healed). For the window main stayed red, a
  push-shaped hot-memory key could have landed and the tripwire would have
  failed for the OLD reason, looking like the same known redness. **A red
  tripwire and a disabled tripwire are indistinguishable in test output**,
  and known redness is a strong anaesthetic. Never leave a guard red on the
  upstream default branch; heal it or revert what broke it.
- **Prove a guard test by its executed-assertion COUNT, not by its exit
  code.** A floor on expect() calls is the only clause that can express "the
  body ran to the end"; green/red structurally cannot. Pin a floor, not an
  equality, so adding assertions does not fail the gate.
- **A PR that moves a pinned value must re-run the OTHER assertions of that
  value, including in files its diff never touches.** #691 bumped the tool
  contract 2 -> 3 with all its own gates green; the pin-holder was a test in
  an untouched file, so the branch was green and the merge was red. This is
  the controller's defect, not the lane's — the cross-file pin check belongs
  in the merge pass.
- **A mutation clause written against an ALREADY-RED subject banks the
  pre-existing failure as a kill.** Clause c passed on the pre-fix tree in its
  first form — a survived mutant reported as a discriminating check. Gate
  mutation clauses on a proven-green baseline and report INCONCLUSIVE
  otherwise. Found by reading WHY each RED clause failed rather than accepting
  a satisfying 4/4 red.
- **Exit 127 can masquerade as a gate verdict.** Five CI failures asserted
  `toBe(1)` for a refusal and received 127 — the shell's command-not-found,
  meaning the script under test never ran. "Did not execute" and "refused
  correctly" were distinguishable only by the number's luck. Any clause
  asserting a specific nonzero exit should reject 127 explicitly. Filed as
  #702 rather than absorbed.
- **The two-runs-same-SHA comparison settled a red CI check again:** identical
  f0e135c passed on `push` and failed on `pull_request`. Corroborated by
  running both failing clusters locally on clean origin/main AND on the branch
  in separate worktrees — 29 pass / 0 fail on both — before concluding
  environment-owned. A same-SHA disagreement is the signal; the local
  differential is the proof.
- **PIPESTATUS printed empty when read outside the pipeline's shell**, reading
  as exit 0 at a glance. Every verdict in this lane re-read the exit code
  directly from the command instead.
- **Pin collisions between concurrent branches are a merge-order hazard the
  pin cannot see.** PR #701 and PR #687 each legitimately re-measured
  EXPECTED_ENTRY_COUNT as 235 on their own trees; whichever merges second is
  silently stale. Re-measure the pin AFTER integrating main, never carry a
  branch's own derivation across a merge — and never sum.

- **Inherited work is PROPOSED, and auditing it is the first task, not a
  formality.** A continuation lane picked up a partially-applied scrub and
  found EIGHT defects in it: six edits that renamed something real (a hook
  instruction to a nonexistent path, an operator handshake token out of sync
  with its runbook, six citations of a real script filename, a doc link, npm
  script names, a private-range network fixture) plus two bugs in the
  inherited gate itself. Every one looked correct in the diff.
- **A find-and-replace sweep must ask what READS each literal.** A placeholder
  only neutralises a value that nothing compares to reality. Where the reader
  is the filesystem, an equality check, a skip condition, a recorded fixture,
  an external runtime, or a human pasting a command, replacing the text
  silently disables the thing the value was for. Full taxonomy with all seven
  instances: `docs/sme/entries/2026-08-08-a-placeholder-only-neutralises-a-value-nothing-compares-to-reality.md`.
- **Check the SKIP count, not just the pass count.** A scrubbed path turned the
  Python suite's only cross-language proof into a permanent silent skip that
  still reported green; restoring it moved the package from 581 passed / 26
  skipped to 606 passed / 1 skipped. Twenty-five tests had stopped running and
  the suite said nothing. A green run after a sweep is not evidence.
- **`... | while read` cannot count.** The inherited done-means check
  incremented its violation counter inside a pipeline subshell, so the value
  was discarded: it printed VIOLATION lines and exited 0. A gate that reports
  failure and passes anyway is worse than no gate, and only a NEGATIVE CONTROL
  catches it — inject a real violation and confirm the check fails. Every
  done-means check with an exception mechanism needs one.
- **Prefer a `path:substring` exception to a file-wide allowlist entry.**
  Exempting a whole file to permit one legitimate line blinds the check to
  every future real leak in that file. Each exception carries its reason
  inline, so the next reader can tell a justified retention from a silenced
  inconvenience.
- **Picking the wrong neutral value is its own failure mode.** A fixture moved
  to `192.0.2.0/24` (TEST-NET-1, RFC5737) when the property under test was
  RFC1918 private-range membership; the code correctly rejected it and all 18
  tests in the file failed. The replacement must preserve the property the test
  is about.
- **A "neutral" fallback can be more dangerous than a hardcoded value.** The
  inherited scrub gave the deploy runner-label variable a fallback that dropped
  only the host-identifying label — so an unset variable still SCHEDULES, onto
  whichever machine matches the remainder. Fail-closed beat neutral: the
  variable is now required with no fallback.
- **Gate refusal (design-lookup) fired correctly** on an edit to
  `server-identity.test.ts` after an unrelated lookup earlier in the session.
  Complied, ran the lookup, and the design doc it surfaced
  (`docs/CONFIG_REFERENCE.md`, "Host identity in /health") is what confirmed
  the RFC1918 root cause. The gate paid for itself.


graduated: bullets 1 and 2 -> docs/sme/entries/2026-08-09-a-failing-assertion-turns-off-every-clause-after-it-in-the-same-test.md and done-means 271-tripwire-acknowledges-contract-moves.sh; bullets 4, 5, 6 and 7 -> docs/sme/entries/2026-08-09-an-exit-code-is-not-a-verdict-until-you-know-the-subject-ran.md; bullets 3 and 8 -> docs/sme/entries/2026-08-09-a-pin-derived-before-integration-is-stale-the-moment-anything-else-merges.md. provenance: PR #701.
### 2026-08-08 (latest) — harvest of the #612 lane (PR #624)

- **`rm` of ANY spelling is banned — including single-file `rm -f`.** The
  cleanup verb is `mv` to the lane's `_archive/`. One lane ran
  `rm -f <file>` before reading the rule closely and self-reported; the rule
  has no single-file carve-out. (Disclosed violation, harvested not punished.)
- **Never `git stash` in a checkout you don't exclusively own.** `stash pop`
  popped ANOTHER session's pre-existing stash and left a `UU` conflict; the
  foreign stash was preserved and the lane switched to file-copy for its
  red-proof. Worktrees from `lane-bootstrap` are exclusively yours; the
  primary checkout never is.
- **No absolute machine paths in tests or defaults** — a hardcoded
  `/Volumes/...` default died with `EACCES` on the Linux CI runner. Use
  repo-relative `_scratch/` (gitignored) like `src/operator-doctor.test.ts:32`.
- **A live-system check needs a CONTROL CLAUSE proving the observation window
  was live** (#624's clause z: legacy lines still flowing). It fired for real
  — the clone went quiet mid-check — and refused to bank a free RED. Without
  it, a dead system hands every RED check a false pass.
- **"Partial" symptoms deserve a total-loss hypothesis.** 3,465 surviving
  lines came from a SECOND legacy logger; the system under suspicion was
  emitting zero. Ask which emitter the surviving evidence actually belongs to
  before concluding partial breakage.
- **Injected-dependency tests can 100%-cover a module whose production
  composition is broken.** All 5 logger tests injected a stream, bypassing
  the default transport that was the defect. Exercise the production default
  path at least once.


graduated: bullets 1 and 2 -> standing contract clause 7 (teardown; no rm, ever, anywhere) and docs/sme/entries/2026-08-08-lane-tooling-gotchas-the-shell-the-validator-and-the-worktree.md; bullet 3 -> the same tooling entry (no absolute machine paths); bullets 4 and 5 -> done-means 612-component-lines-reach-logs.sh, whose control clause z is the live-window proof; bullet 6 -> docs/sme/entries/2026-08-06-instrumentation-on-a-tree-whose-wrapper-is-never-installed-is-dead-code.md and docs/sme/entries/2026-08-08-injecting-a-test-destination-can-bypass-the-composition-that-is-broken.md. provenance: PR #624.
### 2026-08-08 (later) — harvest of the #614 lane (PR #623) and its ruling

- **Deviating from a recorded decision is allowed exactly one way: implement
  the better behavior, FLAG it as a deliberate divergence naming the decision
  it reverses, and request a ruling.** The #614 lane did this (auto-drop vs
  ledger item 15's printed-never-executed) and the operator ratified narrow.
  Burying the same deviation would have been a violation; flagging it made it
  the new rule. This is the model.
- **Auto-removal exception (ledger item 20, narrow):** a process may remove a
  resource on exit/interrupt only when it is (1) self-created this run,
  (2) prefix-guarded so it structurally cannot name anything it did not
  create, and (3) session-scoped throwaway content. All other teardown stays
  printed-never-executed.
- **Push with an explicit refspec** (`git push origin HEAD:refs/heads/<branch>`)
  when the git guard (#618) rejects `push -u` — more specific, not a variant
  retry.


graduated: bullet 1 -> standing contract clause 5 (nothing silent) and clause 8 (self-reported violations are harvested, never punished); bullet 2 -> history-only, ledger item 20 records the narrow auto-removal exception; bullet 3 -> docs/sme/entries/2026-08-08-lane-tooling-gotchas-the-shell-the-validator-and-the-worktree.md. provenance: PR #623.
### 2026-08-08 — harvest of the tooling + fixture lanes (PRs #615, #616, #617, #619, #620, #621)

- **`validate-pr-body.ts` reads `PR_BODY`/`PR_TITLE` from ENV, not argv or
  stdin.** Run with no env and it validates the empty string — and in one
  observed path printed failures while exiting 0. Always confirm the literal
  "PR body validation passed" line, not just the exit code. (Found
  independently by the controller and the #613 lane; validator exit-code
  defect tracked in its own issue.)
- **No `###` subheadings inside validator-required PR-body sections.** The
  section parser terminates on `startsWith("## ")`, which `### x` satisfies —
  an h3 silently truncates the section. Use bold text instead. (#613 lane.)
- **Bun names tests only on failure.** A gate that greps the suite log for a
  test name to prove execution false-negatives on a fully-passing run. Prove
  execution by asserting a non-zero pass count. (#613 lane, self-caught.)
- **ripgrep `-E` is `--encoding`, not extended-regex.** `rg -qiE <pattern>`
  errors and can read as the thing-under-test failing. Use `rg -e`. (#621
  lane, self-caught in its own check.)
- **`sed -i` is not portable between this shell's GNU sed and BSD examples;
  in-place sed has burned two lanes.** Prefer the Edit tool, `awk` to a new
  file, or `> file && cp`. (#615 near-false-green; #613 workaround.)
- **Git guard (#618, open): commit MESSAGES and heredoc text containing
  protected-branch names get blocked on feature branches.** Sanctioned
  workaround until fixed: write the message to a scratch file and
  `git commit -F <file>`; for merges, `git merge FETCH_HEAD` after an explicit
  fetch. Report each firing on #618. (Three lanes + controller, five shapes.)
- **Design-lookup gate cap-matcher fires on SQL identifiers containing
  "constraint" (e.g. `information_schema.constraint_column_usage`).** Not a
  cap question. Workaround: query `pg_constraint` directly, or reword.
  Report, don't fight. (#613 lane.)
- **A suite that exits 0 can still leak rows — gates read the database, not
  the exit code.** The parity harness passed green for its whole life while
  seeding 9 tables. (#620.)
- **Clean up by the dimension the PRODUCER uses, not the dimension the test
  seeds** — and prefer the owning shared helper over per-suite patches when
  one line serves every fixture. (#609 → generalized by #620.)
- **`.gitignore` can silently drop lane-created files from fresh checkouts**
  (`.claude/*` nearly ate the pr-scribe agent). The clean-clone (or fresh
  worktree) run of the done-means check is the only thing that catches this
  class — always finish with one. (#615 lane.)
- **Mutation-test the gate itself when the PR's claim IS the gate.**
  Reintroduce each real failure mode and watch the gate fail; a gate observed
  only green is decoration. (#615, #620 practice; SME
  `sme.duplicated_selection_lists_diverge` corollary.)


graduated: bullets 1, 2, 3, 4, 5, 8, 9, 10 and 11 -> docs/sme/entries/2026-08-08-lane-tooling-gotchas-the-shell-the-validator-and-the-worktree.md; bullets 6 and 7 (git-guard and design-lookup false positives) -> standing contract clause 9, refusals are rules working and each firing is reported. provenance: PRs #615, #616, #617, #619, #620, #621.
### 2026-08-07 — founding round (PRs #609, #610, #611 and the decisions pass)

- Red-first done-means checks with controller re-verification became the
  operating mode (ledger item 12) after killing a false "pre-existing" claim
  pre-merge (#609), exposing a stale issue-half (#598), and correcting the
  controller's own briefing (#610 rollout).
- PR-body format lessons (fenced templates invisible; bolded labels break
  `^-\s*Label:`; `## Review Gate` required) — superseded by the template +
  local-validation rule above, then enforced by the hook (item 17).
- Lane environments are bootstrapped, not hand-built (item 15), after ~5
  hand-builds hit missing `.env`/`bun-types`/swallowed exit codes in one
  night.
- SME capture moved to one-file-per-entry (item 13) after three same-file
  union merges in one night; additions raise the pinned count in the same
  commit, on purpose.

graduated: bullet 1 -> standing contract clause 1 (RLVR shape) and clause 6 (the #609 differential); bullet 2 -> standing contract clause 3, superseded by the template plus local validation and enforced by .claude/hooks/pr-body-gate.ts; bullet 3 -> standing contract clause 2 (scripts/lane-bootstrap.ts); bullet 4 -> docs/sme/README.md capture rules and scripts/build-sme-indexes.ts. provenance: PRs #609, #610, #611.
