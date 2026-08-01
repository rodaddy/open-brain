# Git And GitHub Standards

## Repo Ownership (the responsibility boundary)

**The git boundary is the responsibility boundary.** An agent working in a repo
is responsible for that repo's git state and nothing else. This is what keeps a
mistake small and cheap to undo: every change is a commit in the repo that owns
the files, and a commit is the most reversible artifact there is.

- **Commit in the repo that owns the files, not the repo you started in.** If a
  task takes you into another repo, the work lands there, on that repo's branch,
  with its own message. Never version an artifact belonging to repo A inside
  repo B — it escapes A's log, so A's history and any hygiene job reading it will
  never know the artifact exists.
- Do not reach into another repo's git state on your own initiative. Rico may
  authorize a crossing ("just do x over there"); that authorization is what
  lifts the default, and the crossing is still subject to the rule above.
- A tool belongs in the repo whose subject matter it serves. A Development
  hygiene script lives in Development, even when it is invoked from elsewhere.
- Leaving work uncommitted is the expensive failure. Dirty files carry no
  author, no reason, and no timestamp beyond mtime, so they sit outside the
  audit trail that makes everything else recoverable.

## Branches

- Do not commit directly to `main`, `master`, or protected branches unless the
  user explicitly approves it.
- Inspect branch state and dirty files before edits.
- Never revert user changes unless explicitly asked.
- Use focused branches for implementation slices.
- **After a merge, fetch and branch the next task from fresh `origin/main`.**
  Every task starts from the merged remote state:

  ```bash
  git fetch origin --prune                    # refresh refs; prune deleted remote branches
  git checkout -b <type>/<slice> origin/main  # branch from the tip that includes the merge
  ```

  Branch from `origin/main` directly rather than checking out the local default
  branch first: some repos run a guard that blocks `git checkout main` outright
  ("do not switch to main/master for work"), and `fetch` + branch-from-remote
  needs no checkout, so it works everywhere and cannot leave you sitting on the
  default branch by accident.

  Continuing on the just-merged branch, or branching off a stale local `main`,
  produces a PR whose diff replays work already on `main` — it looks like new
  changes to every reviewer and to CI, and it invites the semantic conflicts
  that have no textual conflict (a cherry-picked slice silently reverting a
  neighbouring change that landed in the meantime).
- **Never commit onto a branch that already has an open PR unless the commit
  belongs to that PR.** Adding an unrelated commit silently expands the PR's
  scope after review has started. Check first —
  `gh pr list --head <branch>` — and if the work is unrelated, branch from
  fresh `main` instead.
- Verify the base before starting, not after committing:
  `git merge-base --is-ancestor origin/main HEAD` exits 0 when the branch is
  current. If it exits 1, the branch is behind and should be rebased or
  recreated before more work lands on it.
- Temporary review worktrees belong under the configured temp workspace, grouped
  as `{temp_workspace}/{project-or-repo}/...`. On Rico's Mac this is
  `/Volumes/ThunderBolt/_tmp`; on cc-* boxes this is `/mnt/collab/tmp_space`.
- Do not create scratch worktrees, review checkouts, generated patches, or test
  clones directly under `/Volumes/ThunderBolt/Development`.
- Every `{temp_workspace}/{project-or-repo}` area must have an `_archive/`
  folder. Move stale scratch artifacts there when they are no longer needed,
  unless the user asks to preserve them active.
- **Worktrees are the exception: they are REMOVED, not archived.** Archiving one
  strands its git registration AND leaves the checkout on disk in a folder
  nobody empties -- so it costs the same space and destroys the `worktree list`
  signal too. `git worktree remove <path>` is the whole job in one step. See
  "Clean up your own worktrees" below.
- Temp workspace paths, including `_archive/`, have no lifetime persistence
  guarantee. Anything that must be retained belongs in the owning repo/project
  folder or another durable user-approved location, not in temp. A `_keep/`
  folder may be used only for short-term explicitly preserved temp state.
- Do not ask before archiving current-run temp worktrees/artifacts under the
  configured temp workspace. Ask only for durable, user-created,
  outside-temp-root, or ambiguous paths.
- MUST NOT use raw `rm -f` or `rm -rf` for worktree cleanup, ever. It removes
  the directory and leaves the registration behind, so `git worktree list` keeps
  advertising a path that is gone. Use `git worktree remove`, which unregisters
  and removes as one operation.

### Clean up your own worktrees

**A worktree is scaffolding for one piece of work, not a record of it. Whoever
creates one removes it.**

- **Remove it in the SAME session that created it**, once the branch is merged,
  the PR is closed, or the information is gathered:
  `git worktree remove <path>`. Then `git worktree prune` to clear any
  registration whose directory is already gone.
- **Copy out anything worth keeping FIRST** -- a patch, a report, notes -- to
  the repo/project folder or an `_archive/` bucket. The worktree is never the
  durable home for an artifact.
- **This is the one cleanup an agent completes itself.** `git worktree remove`
  is a git operation, not a delete, and is NOT covered by the no-recursive-delete
  rule in `AGENTS.md`. It also refuses to run on a dirty worktree, which is the
  safety property `rm -rf` lacks -- if it refuses, that is real uncommitted work
  and it needs a decision, not force.
- **Before creating a new worktree, clear your finished ones in that repo.**
  `git worktree list` first; any entry of yours that is merged and clean goes
  before the new one is added. This is the checkpoint that actually fires,
  because it happens at the moment an agent is already thinking about worktrees.
- **Park them under `_worktrees/`, never at the area root.** Two in
  `rtech-infra` sat directly in `{temp_workspace}/rtech-infra/`, which hides
  them from any check scoped to the bucket.

**Why this is a rule:** measured 2026-07-30 -- 37 leftover worktrees across two
repos, 3.0 GB, `open-brain` alone holding 32. Every one was live and registered;
`git worktree prune` had nothing to collect. Several sat on branches whose work
had already landed. Nobody could tell from `git worktree list` which ones were
live, which is the real cost -- the disk is secondary to the signal being
destroyed.

## The Development Root Repo (weekly `wip/` rotation)

The Development root follows the same lifecycle as every other repo — branch,
work, PR, review, merge, delete, branch fresh from `origin/main`. The only
difference is that its branch is **time-boxed rather than task-boxed**, because
agents from other projects drop unrelated changes into it all week.

- The working branch is **`wip/<YYYY-MM-DD>`**, dated from the day it was cut.
- **When you change something in Development, commit it with a message.** Do not
  branch, rebase, squash, merge, push, or open a PR. Those are the weekly
  rotation's job, not yours.
- That rule is what makes the weekly close cheap: the commit log *is* the audit
  trail, written by whichever agent had the context at the time. Nothing has to
  infer intent afterwards. An agent that squashes or rewrites destroys exactly
  the granularity that makes a single bad drop revertible without losing the
  week.
- **Development must never have worktrees.** One registered worktree — the main
  checkout — and nothing else, ever. A worktree removal takes a directory and
  can destroy the only copy of uncommitted work, which is the one failure this
  system cannot undo.
- The weekly rotation reviews the week's commits, merges `wip/<date>`, deletes
  the merged branch, and cuts `wip/<today>` from fresh `origin/main`. A week
  with nothing worth merging still rotates.
- A violated invariant (worktrees present, stray branches, uncommitted files
  with no commit) is a **hard failure that gets reported, not quietly tidied**.
  It means an agent broke the rule, and which agent is the useful information.

## Commits And PRs

- Commit only related changes.
<<<<<<< Updated upstream
- Use FOSS Gitleaks through the machine-wide pre-commit and pre-push hooks as
  the locally controlled credential-safety gate. Missing Gitleaks is blocking.
  GitGuardian or `ggshield` may remain as an additional hosted signal when
  credits and repository access are available, but they do not replace the
  Gitleaks gate or become a required dependency for private/internal repos.
=======
- **Local secret gate** -- Gitleaks is the default scanner for routine local
  commits and pushes. The global hooks are
  `~/.config/git/hooks/{pre-commit,pre-push}`, selected by the global
  `core.hooksPath`. They must fail closed when Gitleaks is unavailable and use
  full redaction (`--redact=100`).
- Pre-commit scans staged changes only. Pre-push scans commits reachable from
  each pushed ref that are not already present on known remote refs. Do not run
  a full-history scan on every commit or push.
- **GitGuardian boundary** -- Keep GitGuardian for managed public-repository
  monitoring and deliberate targeted scans. Do not use quota-backed `ggshield`
  as the routine local hook scanner or run broad private-repository history
  scans through it. GitGuardian API quota is workspace-wide and rolling over 30
  days, not a calendar-month bucket.
- **Private-repository depth** -- Gitleaks protects the developer commit/push
  boundary. The central private-repository target is scheduled Betterleaks
  incremental scans plus a monthly full-history scan on a dedicated scanner
  LXC. Until that service is deployed and verified, do not claim central or
  monthly private-repository coverage.
- Gitleaks is accepted as equivalent for the narrow local hook enforcement job,
  not as feature-equivalent to the GitGuardian platform. A clean synthetic
  smoke test proves hook wiring, not detector parity across every secret type.
- Never bypass secret hooks in a durable repository. `--no-verify` is allowed
  only inside an isolated temp test repository when explicitly proving that the
  pre-push gate independently blocks a synthetic finding; the test remote must
  also remain local and disposable.
>>>>>>> Stashed changes
- One issue does not imply one PR. Group related issues into the smallest
  coherent PR by default. Split them only when concerns, risk, ownership,
  deployment order, reviewability, or diff size make the combined PR unsafe or
  unwieldy, or when Rico explicitly requests separate PRs.
- Before a PR is considered ready, verify the remote PR branch contains the
  intended commits.
- PRs must link relevant issues and include validation evidence.
- A queued self-hosted GitHub Actions job is not passive `CI pending`. If a job
  is queued before runner pickup beyond a short grace period, diagnose runner
  routing immediately: exact `runs-on`, repo runner labels, and canonical
  sibling/source repo workflow patterns.
- Posting a PR comment is not a fix. Fixes must land in code, docs, tests, or be
  explicitly waived.
- Generated reports or artifacts belong in the owning repo's visible expected
  folder only when they are intended project artifacts. Otherwise put temporary
  output under `{temp_workspace}/{project-or-repo}/...` and archive it after
  use.

## Issue And Project Mutations

GitHub issue, PR, and project-board mutations change shared state.

- Use REST for issues, PRs, checks, comments, reviews, labels, milestones,
  merges, and repository state. Reserve GraphQL for GitHub Projects v2
  operations that have no suitable REST endpoint.
- Follow `_DOCS/BOARD_FIELDS.md` for Project IDs, targeted reads, mutation
  batching, rate-budget handling, and event-driven board synchronization.
- Creating issues is additive and usually safe.
- Closing issues, bulk label changes, milestone changes, and project field
  changes require current-state verification.
- Do not close an issue unless implementation is verified or the user explicitly
  approves the closure.
- **"Close" means finish, not flip.** A request to close an issue or PR is an
  instruction to work it to real completion -- implement, validate, review,
  merge, synchronize -- and then close it as done. It is never authorization to
  set the state to closed, apply `not planned`/`wontfix`/duplicate, abandon the
  branch, or otherwise retire an unfinished item to reduce the open count.
  Retiring unfinished work requires an explicit user decision to drop that item.
  If it cannot be finished, leave it open and report the blocker with evidence.
- For multi-issue work, update the project board on concrete state transitions:
  before dispatch, at review/fix/validation transitions, and at closure. Do not
  poll or rediscover the whole board to prove each update.

## Review Gates

- **Reviews fire ONLY at the PR boundary** (Rico 2026-07-10). No review rounds
  on specs, briefs, or intermediate heads during development.
- Review weight scales with blast radius, not line-count theater. Canonical:
  `_ob/skills/pre-merge-gauntlet`.
  0. Pre-PR: author runs critical-mode and exact automated gates (self-check,
     not a review).
  1. Capture one pinned candidate diff and run ONE risk-sized review pass.
     Tiny mechanical/docs changes may use one terminal reviewer; ordinary
     behavior changes use SME + antagonist; security/deploy/shared-contract
     changes add only the specialist lenses their failure modes require. At
     least one lane must be opposite-runtime for meaningful behavior/risk work.
  2. Fix or explicitly waive every finding, then rerun the exact repo gates.
  3. If a material fix changed behavior or risk, run ONE focused verifier on
     the fix delta. Do not restart the full review.
  4. Controller verifies exact head/CI/comments, then deliberately merges.
- Pure typo/comment changes with no executable or operational claim may pass on
  controller diff inspection plus exact automated gates; do not spawn agents by
  habit.
- A review swarm, when used, still needs an SME and an antagonist. A single
  terminal reviewer is a review lane, not a swarm.
- Findings are work orders, not notes.
- No known material P0/P1/P2 issues may remain at merge, unless the user
  explicitly accepts a blocker or deferral.
