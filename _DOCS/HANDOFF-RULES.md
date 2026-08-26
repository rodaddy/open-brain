# HANDOFF RULES — open-brain (layer 0.1)

Repo-specific rules every handover in this repo needs. Overrides
HANDOFF-BASE.md; overridden by the handover document. Keep short; add a rule
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
   2026-08-26 evening, superseding the 5-10 batch from earlier that day). A
   nine-node Workflow is one swarm: Rico sees "3 of 9" and cannot open a
   lane. Dispatch every lane as its own Workflow with a single `agent()`
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
    handoff names), and every lane carries a `scripts/done-means/` check seen
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
