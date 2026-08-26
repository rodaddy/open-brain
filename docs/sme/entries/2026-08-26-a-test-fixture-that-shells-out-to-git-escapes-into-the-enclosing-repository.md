---
lane: gotcha-agent
order: 75
---
## [2026-08-26] A test fixture that shells out to git escapes into the enclosing repository

**Provenance:** PR #776, issue #775. Severity: HIGH. Status: open.
**Scope:** `scripts/*.test.ts`, `scripts/done-means/*.sh`, any test or check
that builds a throwaway git repository.

A done-means check and its unit test both built a scratch git repository and
then drove it with `spawnSync("git", args, { cwd: fixture })` and
`git -C "$FIXTURE"`. Both spellings look scoped and neither is: when the target
directory is NOT a repository, git does not fail — it walks UP the directory
tree to the first enclosing `.git` and operates on THAT.

One `mkdtempSync` fixture came back without a `.git` directory. `git init` had
not taken and nothing checked its exit code, so every subsequent call in the
fixture's setup resolved to the surrounding worktree. The fixture's own commits
— `base` and `docs only` — were authored into the branch under development as
`verify-lane test <test@example.invalid>`, and because the fixture commits a
tree containing only `package.json`, `bun.lock`, and `README.md`, the commit
DELETED every other tracked file in the worktree. The setup's `git config`
calls landed in the enclosing repository too, writing `core.bare=true`, the
test identity, and `commit.gpgsign=false` into the clone's `.git/config`.

The check reported all clauses PASS while doing this. Its assertions were about
git's diff behavior on the fixture, which remained true; nothing in the check
looked at the repository it was running inside. The corruption was found only
because the branch was pushed and the diff was inspected.

Two properties make this dangerous rather than merely annoying. First, the
failure is silent and delayed: a fixture that fails to initialize produces no
error, and the damage surfaces later as "why did my branch delete everything".
Second, moving fixtures into the repo's own `_scratch/` (correct for CI
portability — a hardcoded `/Volumes/...` default failed the Linux runner with
`EACCES: permission denied, mkdir '/Volumes'`) puts the fixture strictly INSIDE
the repository, which makes the upward walk shorter and guaranteed to find a
target.

The fix is two mechanical rules, both fail-closed. Pin `--git-dir <fixture>/.git`
and `--work-tree <fixture>` on every call, which makes the walk impossible —
git errors instead of finding a parent. And assert `git init` succeeded on BOTH
its exit code and the resulting `.git` before any other git call runs, since an
unchecked init is what enables the escape at all. Verified directly against a
non-repo directory nested in the worktree:

```
git --git-dir <d>/.git --work-tree <d> rev-parse HEAD
  -> fatal: not a git repository
git -C <d> rev-parse HEAD
  -> 365ae45          # the ENCLOSING worktree's HEAD
```

### Review Questions

- **Does any test or check run git with a bare `cwd` or `-C` against a
  directory it created?** That is the escape. Require `--git-dir` and
  `--work-tree` on every invocation; `-C` alone scopes nothing when the target
  is not a repository.
- **Is `git init`'s success asserted, or assumed?** An init that silently did
  not take converts every following call into an operation on the enclosing
  repo. Check the exit code AND that `.git` exists before proceeding.
- **Does the check inspect the repository it is running INSIDE?** A check that
  can mutate its host must prove it did not: `git status --short`,
  `git rev-parse HEAD`, and `git config --list --local` of the enclosing repo,
  before and after. Green clauses are not evidence here — this one was green
  throughout.
- **Where does the fixture root come from?** Repo-relative `_scratch/`
  (gitignored, `src/operator-doctor.test.ts:29`), never a hardcoded absolute
  path. A `/Volumes/...` or `/Users/...` default is a test that only runs on one
  machine, and it will fail CI rather than gate it.
- **Would a stray write land somewhere the repo ignores?** Fixtures inside
  `_scratch/` bound the blast radius even when the other rules are followed;
  fixtures outside the repo do not.
