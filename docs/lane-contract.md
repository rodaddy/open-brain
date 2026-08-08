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
### 2026-08-08 (round 10b, lane-authored) — the #636 continuation lane's own harvest (detail companion to round 10; overlapping bullets kept for their specifics)

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
