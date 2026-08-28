# HANDOVER RULES — open-brain (layer 0.1)

Repo-specific rules every handover in this repo needs. Overrides
HANDOVER-BASE.md; overridden by the handover document. Keep short; add a rule
only when a session actually needed it.

## Execution posture (operator ruling 2026-08-25)

1. **The head orchestrates and does not do the work.** It cuts tasks,
   dispatches, verifies, integrates. Inline work is limited to what
   delegation cannot help: one exact lookup, one deterministic single-file
   edit. A head that spends its turns editing files is off-contract.
2. **Lanes are 10-15 minutes.** A lane that would run 30 minutes was cut
   wrong, not slow. Re-cut until it fits. Expect MANY lanes landed per round;
   a round that produces one lane was under-dispatched.
3. **At most FIVE lanes in flight, each its own agent** (Rico ruling
   2026-08-26 evening). Ten is the normal ceiling; five is the number while
   Rico has his own work running on the Mac, which is the default assumption
   unless he says the machine is free — ten lanes on a loaded machine had it
   "howling like a jet engine". A nine-node Workflow is one swarm: Rico sees
   "3 of 9" and cannot open a lane. Dispatch every lane as its own Workflow with a single `agent()`
   node so each is its own visible row he can enter, never more than five
   running. Keep the QUEUE full instead: up to five batches of five briefs
   written and ready, and a lane launches the moment a slot frees. Scopes
   are disjoint and one file has one owner — two lanes never share a file;
   entangled files mean sequenced lanes, not parallel ones.
4. **Failure is a valid outcome WITH RECEIPTS.** A lane that fails but reports
   exactly what it ran, what it saw, and where it stopped is a good outcome.
   The head re-cuts a SMALLER task and sends a new worker carrying what the
   first one learned. Never a bigger one. No receipts = not done.
5. **A scribe runs the whole session.** Records land AS work lands, never
   batched at wrap: every landed change gets its issue comment, every gap
   becomes an issue, every commit reaches the forge, at the moment it happens.
6. **Graph mode always.** Agent produces, script judges, hook enforces.
   Declare the tier by blast radius. Behavior- or security-relevant work is
   RED-first: the check is SEEN failing before the fix makes it pass.
7. **Proper tests, not excessive ones.** Functional input/output tests at the
   real boundary, proven able to fail. No coverage gates, no re-running what
   is already proven, no test-writing as a substitute for the fix.

## Repo facts that trap sessions

8. The application exists TWICE — `src/` (legacy) and `server/` (rewrite) —
   and the halves have diverged. A fix landed in one twin looks fixed and is
   not. Before calling any behavior change done, check whether the file has a
   twin (`server/tools/` vs `src/tools/`) and which one the running service
   loads. `server/main.ts` is the live entrypoint; it imports
   `src/tools/index.ts` as `import type` only.
9. The dependency between the trees is CIRCULAR (`src/index.ts:7,49` import
   from `server/`). Neither side detaches until that edge is cut. Do not plan
   an archive or retirement lane that assumes one-way dependence.
10. Test evidence: `bun run test:isolated`, never bare `bun test`. Postgres
    tests SKIP SILENTLY without `OPENBRAIN_TEST_DATABASE_URL`, and full-suite
    runs against the dogfood database return a different failure count each
    time (#614). A bare `bun test` count is not evidence in a PR, issue, or
    review verdict.
11. `psql` needs no connection arguments here: `set -a; . ./.env; set +a` then
    bare `psql`. There is no `DATABASE_URL`; the app reads `DB_*` and `psql`
    does not. Hand-building a connection fails.
12. `_DOCS/STANDARDS-*.md` are GENERATED and carry a `source-hash`. Never
    hand-edit them. A rule change goes in the Development `_DOCS/` source,
    then `bun _ob/scripts/sync-repo-standards.ts open-brain` refreshes them.
13. core01 was OUT OF SCOPE (operator ruling 2026-08-25 morning) and is back
    IN scope for one purpose only (ruling 2026-08-25 evening, epic #762): the
    service leaves the Mac, to core01 at minimum, likely a k3s Postgres box.
    Until a #762 step executes, core01 still serves the old version, both
    workers return 503, and it is not a blocker for anything else.
14. Every behavior lane carries an executable check in `scripts/done-means/`,
    written RED-first. The checker declares done, never the lane
    (`docs/sop-rlvr-lanes.md`).
15. Workflow dispatch has two gates that fail on shape, not intent. The
    routing gate requires the router snippet from
    `/Users/rico/.claudex/workflows/mixed-model-routing.snippet.js` copied
    BYTE-EXACT, comments included -- a hand-written equivalent is refused. The
    same gate reads string literals for review vocabulary
    (review/verify/SME/gauntlet/antagonist/reconciler) and joins string
    concatenations before scanning, so splitting a word to evade it does not
    work and is a policy violation besides. Word build lanes as what they do:
    "confirm", "check", "prove".
16. Worker lanes cannot reach the forge. They have no `gh` and no network, so
    the head carries every receipt to the issue or PR as scribe. Do not brief
    a lane to comment on an issue. Native in-harness Opus lanes DO have `gh`
    for read-only calls (checks, run logs) unless a hook refuses; only Codex
    companion lanes have no forge access (observed 2026-08-26).
17. `_githooks/pre-push` runs `bun test` on the WORKING TREE, not the pushed
    tip (#761). A dirty checkout refuses every push, including a clean
    docs-only branch. Push from a clean clone (a cc-* box, or a fresh clone
    under the temp workspace); never `--no-verify` as an agent. To commit
    from a dirty checkout without switching, build the commit with a
    temporary index (`GIT_INDEX_FILE=<scratch> git read-tree <base>`,
    `git add`, `git write-tree`, `git commit-tree`, `git branch -f`).
18. The embedder is a fleet service, not a project host: `embed-gemma-dense`
    on k3s `ai/llama-swap` at `https://llama-swap.rodaddy.live/v1`, admitted
    to clone mode only through `OPEN_BRAIN_EMBEDDING_HOST_ALLOW`. TN01
    `10.71.1.11:8080` and the local MLX unit are dead; point nothing at them.
    The ingress has shown ~1-minute `503 no available server` windows
    (rtech-infra#1110); the clone rides through them.
19. Branch is not tree. `rg` for a symbol in a checkout answers for the branch
    CHECKED OUT, not for `main`, and an empty result reads as "main lacks
    this" when it means "this branch lacks it". Twice on 2026-08-25 that
    produced a confident wrong claim that external-embedder support was
    stranded on the deploy branch; it was already merged. Ask git, not the
    filesystem: `git show origin/main:<path>`, and settle "is it merged" by
    CONTENT (`git diff origin/main <ref> -- <paths>`, empty = identical), not
    by `git cherry`, which compares patch-ids and marks a squash-merged
    commit as unmerged.
20. A required-config guard goes at the CALL site, never at module level. A
    top-level `process.exit()` on missing env fires on IMPORT, so any test
    that imports the module takes the whole suite down with it -- observed
    2026-08-26 in `scripts/ob-backfill.ts`, suite exit 2, zero tests
    meaningful. Resolve through a `requireX()` the caller invokes.
21. The k3s Postgres is `10.71.20.167:5432` (CNPG cluster `general`, PG 18.4,
    pgvector 0.8.6, database `open_brain`, credentials in Vaultwarden under
    "PostgreSQL - general open_brain"). The Mac's kubeconfig for the cluster
    is `~/.kube/config-rtech-k3s` -- the DEFAULT context is a dead
    `docker-desktop` and will make every `kubectl` call fail; export
    KUBECONFIG before probing.
22. The git guard in the clone refuses `git checkout main` ("do not switch to
    main/master for work") for the head as well as workers, refuses
    `git -C <path> commit|push`, and refuses a `commit && push` chain. The
    form that passes is one call per verb: `cd <clone> && git commit -F
    <scratch file>`, then `cd <clone> && git push origin <branch>`. A merge
    via `gh pr merge --delete-branch` is what puts the clone back on `main`.
23. `.claude/hooks/design-lookup-gate.ts` gates Bash, Write, Edit, and
    AskUserQuestion on a recent lookup it recognises: `aqmd search "<word>"`
    (wrap in `timeout 60`; the librarian can hang) or a `Read` of
    `docs/decisions/*.md`. `sqlite3 .qmd/index.sqlite` does NOT count. The
    same gate refuses any command or file text containing cap, limit,
    ceiling, quota, budget, truncation, bound, or pruning -- in PR bodies,
    commit messages, and issue comments too. Write "rule value" and "max-*".
    The gate inspects each tool call's OWN text, so scanning a file for those
    stems needs character-class patterns (`c[a]p`) -- spelling one plainly in
    an `rg` argument refuses the command that was looking for it. It likewise
    refuses the full filename of `context-pack-b*.ts`, so glob that name.
24. `scripts/verify-lane.ts <pr>` runs from any branch: it cuts its own
    worktree from `origin/main` and posts the receipt bound to the head SHA.
    The worktree-hygiene gate allows ONE worktree at a time, so remove the
    verify worktree (printed at the end) before anything else needs one.
    The PR body's `- Done-means:` line is a bare path (`verify-lane.ts:232`),
    no arguments: a generic check takes its inputs from the diff against
    `origin/main` or an env override, never from argv.
25. The pre-commit gate lints STAGED FILES WHOLE (`.oxlintrc.json:17-25`), so
    a lane touching a file with pre-existing findings pays them first. Ruling
    2026-08-26 (#780): one file per lane, fully to standard, in the checklist
    order on #780, no disable comments, no hook baseline. A rewiring lane has
    TWO halves, the reader taking a parameter and the composition root
    passing the value; optional dependency fields with `?? default` let tsc
    and an absence-only check go green with nothing wired (#779). The
    done-means asserts ARRIVAL, not just absence of the old read.
26. `max-lines` (500 code lines) applies to test files too. A table-driven
    block that does not fit goes in a sibling `*.test.ts`, never by retiring
    assertions (#778 fixer had to). A schema field that mirrors an env reader
    is differenced against the reader input by input, and the test calls the
    exported reader; agreeing inputs prove nothing.
27. The lint sweep (#780) is not only size. Rico, 2026-08-26: common code
    becomes a util, "maximum code reusage when proper", so the code reads
    and maintains easily. A lane that splits a file into private helpers
    without checking for an existing helper has met the rule value and
    missed the spec. Decorators (logging, stack traces) are rung L3 of
    `_plans/server-hardening-ladder.md`, sequenced after L2, not the sweep.
28. **Delegate by default; the head does not do the work.** Rule 1 is enforced,
    not advice: every edit, test run, and probe that is not one exact lookup or
    one deterministic command goes to a Workflow `agent()` lane with the
    four-line brief (deliverable, scope, must-not, done). A head that has run
    several file-editing tool calls in a row is off-contract; stop and cut
    lanes. Failure with receipts is a valid lane outcome. A write lane that
    must commit in the clone routes to native Opus 5 at low effort with the
    reason stated (the Codex companion git guard refuses the commit there);
    read-only lanes stay Luna max. (Rico, 2026-08-26: "less work yourself,
    more agents.")
29. **Declare graph mode before the first mutation.** At State 0 the head runs
    `/opt/homebrew/opt/node@24/bin/node
    /Volumes/ThunderBolt/Development/_ob/scripts/graph-mode-gate.ts --agent
    claude --session-id <session> --cwd <repo> declare T1` (or the tier the
    handover names), and every lane carries a `scripts/done-means/` check seen
    RED before GREEN; the checker declares done, never the lane. (Rico,
    2026-08-26: "we should also be running everything in graph mode.")
30. **A scribe runs from State 0.** Records land as work lands: an issue
    comment per landed change, a `harvested:` or `No new lessons:` line per
    PR, a new issue per gap, each at the moment it happens. After every merge
    pass the `tracking-scribe` agent runs as a Workflow lane to mirror issues
    and harvest lane reports into `docs/lane-contract.md`,
    `docs/sme/entries/`, and `docs/issue-graph.md`. (Rico, 2026-08-26:
    "making sure that you have a scribe running.")
31. **The head consolidates; it never works.** Operator ruling 2026-08-26: the
    head NEVER codes and NEVER runs the plumbing itself. Everything that is
    not a decision goes to an army of well-informed Opus 5 low-effort (or
    no-thinking) lanes in batches of 5-10: CI log triage, receipt runs,
    worktree teardown, wait-and-poll, Codex result collection, PR body
    composition, draft text, recon, audits. Each lane returns a RESULTS block
    of at most 10 lines; the head consolidates the returns, checks them
    against live state, and makes the decision. A head that reads raw CI logs,
    dumps recon output into its own context, or re-runs a suite itself to
    "verify" instead of sending a verifier lane is off-contract. Why: the head
    compacting twice in one session (2026-08-26) was caused by head-side
    plumbing output, not by decisions. Rule 1 stays as the principle; this
    rule is the operational list.
32. **Lanes that do not touch each other run in PARALLEL, at most five at once (rule 3).**
    Operator ruling 2026-08-26: "if they can be done in parallel, we should be
    doing that." Sequencing lanes that share no file is wasted wall clock, not
    caution. Each lane gets its OWN LOCAL CLONE under
    `{temp_workspace}/open-brain/_worktrees/lane-N` — `git clone`, NOT
    `git worktree`: the worktree-hygiene gate allows one worktree per checkout,
    and a clone sits outside it. Each clone is branched from `origin/main`,
    has `bun install --frozen-lockfile` already done, and has `.env` copied in,
    so a lane starts on a tree that can already run. Each lane opens its own
    PR; collectors (receipt runs, CI triage) run per PR as they land, not in
    one pass at the end. The one sequencing rule: two lanes never create the
    same helper. Where several lanes want a shared module, ONE owner lane owns
    it and lands first, then the dependents rebase onto it. This supersedes the
    one-file-at-a-time sequencing from the 2026-08-26 morning ruling on #780;
    that ruling's "fully to standard, one file per lane" part still stands.
33. **Removing a fallback runs the WHOLE suite before push.** #857 deleted the
    `process.env` fallback in `server/tools/shared-namespace.ts`, its lane
    proved green on `server/tools` only, and main went RED at `49a8ae6`:
    `contracts/server-tool-parity.test.ts` composes tool dependencies itself
    and had no `sharedNamespaceNames` (fix #859). A lane that deletes a
    default, fallback, or lenient guard runs `bun run test:isolated` with no
    path before pushing, and its brief names `contracts/` as a composition
    site next to `server/main.ts`. A collector that sees a real failure
    compares it with the main run for the PR's base sha before blaming the PR.
34. **`sed -i` with no backup suffix (`sed` on PATH is GNU; `-i ''` is a
    BSD-ism that fails there); a lane never deletes its own leftovers
    either.** The #866 lane wrote `sed -i.bak` backups and then ran
    `fd -e bak . server -x rm {}` to clear them (self-reported, 2026-08-26).
    The no-delete rule has no agent-owned-file carve-out: write no backup, or
    `mv` it to `{temp_workspace}/open-brain/_archive/`. Briefs that mention
    `sed` say `sed -i ''`.
35. **`server/config.test.ts` refuses every edit until #868 lands.** With the
    repo hooks installed (`_githooks/install.sh`, which
    `750-l2b2-lint-refuses-process-env.sh` requires) the pre-commit gate
    lints a staged file whole, and that file carries
    pre-existing `max-lines` (652) and `node/no-process-env` (x6, its
    `withEnv` helper) violations. Any lane whose change touches it — every
    change to a config group's field set does, via the count assertion at
    `:901` — is blocked at commit. Sequence #868 (split the file, drop the
    `process.env` helper) before such a lane; a lint exemption for test files
    is a rung reopening and needs Rico.
    Resolved 2026-08-26 by #872: the file is split into `server/config.test.ts`,
    `server/config-extended.test.ts`, `server/config-equivalence.test.ts`, and
    `parseServerConfig(environment)` at `server/config.ts:380` takes the env
    object, so no test reads `process.env`. The rule stays as the pattern: a
    lane blocked by pre-existing lint in a shared test file sequences the
    split first, never `--no-verify` and never an exemption.
36. **Every Postgres test runs against a real test database; skipping is a
    HARD FAILURE.** Rico, 2026-08-26 (#878): "bad shit happens when we pretend
    that we're using a database and we're not." The pattern is
    `const pool = new Pool({ connectionString: requireTestDatabaseUrl() })`
    from `scripts/test-support/require-test-database.ts` with a plain
    `describe`; `describe.skip` on a missing `OPENBRAIN_TEST_DATABASE_URL` is
    a defect, and so is a lint exemption for test files. Test files are held
    to the server-code standard (rules 25/26). `_githooks/pre-push` runs
    `bun run test:isolated` (#881), so the database is always there at push.
37. **A pg suite rename or split updates `scripts/assert-db-tests-ran.ts` in
    the SAME commit.** CI's anti-skip guard is a manifest of suite names and
    minimum counts; #884's first CI run failed on the manifest alone, with
    zero test failures. The lane brief names it; the collector reads the
    guard's `MISSING` / `ran N expected M` lines before blaming a test.
38. **`--no-verify` is never the answer, and the head checks for it.** The
    #879 lane pushed with `--no-verify` when the old pre-push hook could not
    find a database (self-reported). The fix was the hook (#880/#881), not
    the flag. Every brief carries "never `--no-verify`" verbatim, and a lane
    that used it reports the sha; the head records the deviation on the
    scribe issue and re-runs the skipped gate itself before merge.
39. **Every lane clone carries `core.hooksPath=_githooks` before dispatch.**
    A fresh clone inherits the global `/Users/rico/.config/git/hooks`, so
    the repo's pre-commit/pre-push gates do not run there, and
    `bun scripts/verify-lane.ts` inherits the same setting and fails on the
    `750-l2b2-lint-refuses-process-env.sh` clause (#872). The head sets it
    with `git -C <clone> config core.hooksPath _githooks` on every clone at
    State 2 and re-checks it in the re-probe list.
40. **A done-means script diffs against the merge-base, scans the call line,
    and is proven with a deliberate miss.** `750-l5-shared-namespace-importers.sh`
    shipped three defects in one session (#875 origin/main instead of
    merge-base; #876 import line only, alias rejected, zero-call importer
    failed; #877 multiline regex merged adjacent calls). Each was found by a
    dependent lane, not the author. A check lane's Done-check includes the
    exit-1 run on a hand-broken input, and the check is on `origin/main`
    before a dependent lane opens a PR (`pr-body-gate` refuses a Done-means
    path that is not on the branch).
41. **A read-only lane that needs `gh` or the network is native Opus 5 low,
    not the Codex companion.** Codex companion lanes have no forge access and
    no DNS; they also trip the graph-mode gate (EPERM on chmod) and finish
    with that noise in their report. CI triage, run-log reads, and issue
    searches route native with the reason stated (rule 28 covers write
    lanes; this covers reads).
42. **A CI failure on a file the PR does not touch is compared with `main`
    before it blocks the merge, and it gets an issue.** #884's second run
    failed on `server/maintenance/maintenance.pg.test.ts:353`, a timing race
    the PR never touched (#889). The collector reruns the failed job once,
    files the race with file:line and the run id, and merges on green; the
    python-capture flake (#764) hit five PRs this way before its fix lane ran.
43. **The anti-skip manifest serializes every conversion PR; rebase one at a
    time with a git lane.** `MIN_TOTAL_LIVE_TESTCASES` must equal the sum of
    `minTests` (its own test enforces it), so every #878 PR conflicts on
    `scripts/assert-db-tests-ran.ts`. Merge order is: rebase lane (keep
    main's manifest plus the branch's entries, floor = main + delta, sum
    check), collect, next PR. A lane's brief states "floor +N" and the
    entry's `minTests` is the count the suite EMITS, verified from JUnit,
    not a tally (#905 carried 77 for a suite that emits 75).
44. **The PR body Done-means field is a bare script path.**
    `scripts/validate-pr-body.ts:138-152` resolves the field as one path in
    the tree, so `CHANGED_FILES=... bash scripts/done-means/x.sh` is
    refused. The field carries `scripts/done-means/x.sh`; the full
    invocation goes on the prose line beneath it (#917, #918, #919).
45. **A wall-clock or disk-bound assertion on the shared runner is a
    distribution tail, not a regression.** The `check` job runs on the
    self-hosted runner's own PostgreSQL 17 and disk (#915): a 48-migration
    `DROP DATABASE` took 23.7-30s there and 0.7s on the pg18 container
    (#912), and a 1000ms scan threshold tripped at 1024ms (#916). Handle per
    rule 42; a fix sizes the allowance to the measured tail with the
    measurement in a comment, or asserts growth shape instead of seconds.
46. **The wrap census is a command, not a memory.** Batch B's
    `ingest-raw-turn.test.ts` was listed as converted for a session and was
    not (#919). Before authoring a handover run
    `git grep -l 'describe.skip\|skipIf' origin/main -- '*.test.ts'` and
    read each hit; a comment mentioning the old guard is fine, a live
    `dbDescribe` is a lane.
47. **The authoring session drains.** Sessions 3-8 each wrote cleanup into
    the handover for the next session and none ran it: on
    2026-08-27 origin carried 31 merged branches and eleven lane clones sat
    on stale branches with stashes. Before writing State 2, run
    `/opt/homebrew/bin/bash /Volumes/ThunderBolt/Development/_ob/skills/handover-author/scripts/check-drained.sh .`
    until it exits 0: merged branches deleted on origin and in every clone
    under `_worktrees/`, stashes dropped after their patch is archived under
    `_archive/`, unmerged work landed or parked as a doc, no registered
    worktree. `scripts/done-means/handover-validates.sh` runs the same check,
    so a handover PR cannot merge while anything is left behind. A handover
    never names cleanup for the next session.
48. **The controller re-run is the handover's done-check invocation,
    verbatim.** `878-pg-tests-require-database.sh` discovers its subject as
    `*.pg.test.ts` from the merge-base diff, so a split that lands as
    `*.test.ts` files yields `SUBJECT: none`, exit 1, and no receipt; the
    session-9 collector ran the bare script on #933 and reported "not
    verified" on a PR that passes under `CHANGED_FILES`. A collector passes
    the `CHANGED_FILES` form the handover names (derive it from the PR's
    `*.test.ts` paths when the handover leaves it as `<the split files>`).
49. **Lint the origin/main copy before cutting a conversion lane.** The
    pre-commit gate lints staged files whole, so a lane inherits every
    pre-existing oxlint finding in a file it touches: three of five session-9
    batch-1 lanes overran the 15-minute timebox on that inherited work and
    one stopped red on 19 `no-non-null-assertion` findings inside bodies its
    brief forbade touching. Sizing a lane includes
    `./node_modules/.bin/oxlint --deny-warnings <file>` on the origin/main
    copy, and the brief names the allowed fix patterns: `expectDefined`
    guard in the helper module, `it` bodies hoisted to named module-scope
    functions, `as unknown as T`, helpers that take `pool` and create none.
50. **Workflow rows carry the session.** Session 9's rows read "session-7"
    because the reusable `*.workflow.js` were copied with their `meta`
    labels unchanged, and Rico could not tell which session was running.
    Each script carries `const SESSION = 'session9'` feeding the agent
    label; State 2 of every handover names the copy-and-relabel command
    (`cp` the scripts into `_scratch/session<N>/`, then
    `perl -pi -e 's/session-9/session-<N>/g; s/session9/session<N>/g'`),
    and a Workflow row showing another session's tag is a defect fixed
    before dispatch.
51. **One qmd index: the root checkout's. Never run `aqmd search`, `aqmd up`,
    or bare `aqmd` inside a lane clone** (Rico, 2026-08-27: "the only place
    you should have that stuff is in the root of this repo"). `aqmd` scopes
    by walking up to the nearest `.qmd/index.yml` (`_ob/bin/aqmd:23-25`),
    and every clone carries that tracked file, so a search run in a clone
    builds and embeds a private 43-81 MB index there; eleven of them (620 MB)
    were found after session 9, every one created by a lane brief that said
    `aqmd search`. Inside a clone the design-lookup gate is satisfied with
    `aqmd in open-brain "<question>"`, which queries the root index by name
    (`_ob/bin/aqmd:453`) and writes nothing in the clone. `aqmd up` runs
    once, at wrap, from the root checkout.
52. **A CI failure in a file the PR does not touch is read before it is
    acted on.** `gh run view <run> --job <job> --log` into the session
    scratch, then `rg -n '\(fail\)'`: one line names the test. Session 10's
    #944 failed on `scripts/ob-backfill.test.ts:310`, a CPU growth-shape scan
    that took 6.3 s against bun's 5 s per-test default on the runner, in a
    file the PR never touched, and the same job had passed on main at
    `89c8da62`. That shape gets ONE `gh run rerun <run> --failed`, recorded on
    the PR or #878 with the test name; a second failure becomes an issue. A
    hand merge or `--no-verify` is never the answer to a red check.
53. **The docs branch is pushed from a clean clone, never from the root
    checkout.** The root checkout's pre-push suite fails on the six
    order-dependent tracing tests of #924, so every session-9 and session-10
    push of `docs/pg-tests-*` ran as a lane in a detached clone:
    `git fetch /Volumes/ThunderBolt/Development/open-brain <branch>`, then
    `git push origin FETCH_HEAD:refs/heads/<branch>` (the hook runs the
    suite on the clone's tree, where it passes). The lane touches nothing in
    the root checkout and never checks the branch out.
54. **`_reports/` is gitignored** (`.gitignore:73`; no `_reports/` path has
    ever been tracked). The session record is WRITTEN there for `aqmd up` to
    index and is never staged; a scribe that cannot stage it has not
    failed. Whether the records should be tracked is Rico's call, not a
    lane's `git add -f`.
55. **A conversion brief says "floor +N" only when the live suite has NO
    manifest entry.** `MIN_TOTAL_LIVE_TESTCASES` is the sum of the manifest's
    `minTests` (its own test enforces it), so a suite whose describe name is
    already in `REQUIRED_SUITES` raises it by zero; the #949 lane raised it
    328 → 340 on a brief that said +N, and the guard's test refused the push.
    The head checks `rg -n '<describe name>' scripts/assert-db-tests-ran.ts`
    while writing the brief and states "entry exists at minTests M, floor
    unchanged" or "no entry: add at the JUnit count, floor +count".
56. **The head re-runs every beta receipt it cites before the docs commit.**
    The session-11 scribe lane recorded `ratchet-bound/check.sh` exit 0 on a
    tree where it exits 1 (live=16 over the rule value 15). A lane's exit
    column is PROPOSED; the head runs the same command on the committed tree
    and corrects the row, announcing the correction in the pilot findings.
57. **A closing keyword in any commit or PR text closes the issue at merge,
    whether or not the change did the work.** GitHub reads `closes #N`,
    `fixes #N`, `resolves #N` in the squash message (which carries the PR
    title and body) and closed #951 from the #952 handover commit, whose
    body merely said session 12 "closes #951". Write "session 12 finishes
    #951" or "wayfinder: #951"; a closing keyword appears only in the PR
    that lands the fix, and the head confirms `gh issue view N --json state`
    after every merge that mentions an issue. The keyword list is every
    tense: close, closes, closed, fix, fixes, fixed, resolve, resolves,
    resolved, each followed by `#N`. The PR that added this rule (#953)
    re-closed #951 with the past-tense form in its own body, so the safe
    shape in commit and PR text is the bare number ("issue 951", "#951 was
    auto-closed" is NOT safe) or the verb without the number.
