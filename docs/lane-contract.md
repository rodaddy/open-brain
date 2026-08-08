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
