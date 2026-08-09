# The Lane Contract

Status: WRITTEN 2026-08-08, adopted by operator directive the same day —
"every time we tighten it, we make better every time, and we document how we
did it." This file is the single briefing source for RLVR worker lanes in this
repo. The controller's dispatch prompt states the task, the deliverable, and
the done-means design; for everything else it POINTS HERE instead of restating.

The ratchet rule (ledger item 19, `docs/issue-graph.md`): after every lane
run, the controller harvests the lane's refusals, workarounds, self-caught
defects, and surprises into the Tightenings changelog below — with provenance —
before the next dispatch. **A lesson that appears in a lane report and not
here is a defect in the merge pass that accepted the report.** SME entries
(`docs/sme/entries/`) capture review knowledge for reviewers; this file
captures operating knowledge for lanes. Same lesson may land in both.

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

> **Note on this file's history, recorded 2026-08-09 by the #271 tripwire
> lane.** Rounds 8 through 26 are committed on the unmerged `wip/2026-08-07`
> branch and are NOT on the upstream default branch: main's copy is 211 lines
> and jumps from round 7 to the founding round, while the wip copy is 945
> lines. Lanes read this file from their own worktree (round 3, PR #631), so a
> lane bootstrapped from main has been briefed from a contract missing
> nineteen rounds of ratchet. The ratchet only ratchets where it is merged.
> Flagged for the decisions pass rather than fixed here — landing nineteen
> rounds of someone else's harvest inside a test-heal PR would be the silent
> scope adjustment the contract forbids. The round 27 entry below is written
> into main's lineage so this lane's own harvest is not lost to the same gap.

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

### 2026-08-08 (round 7) — harvest of the #636 continuation lane (inherited a dead lane's worktree)

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
