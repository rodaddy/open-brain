# Open Brain — CI/CD Requirements

**What gates a commit, what gates a push, what gates a merge, and what gates a
deploy.** Measured against `.github/workflows/ci.yml`, `.git/hooks/pre-commit`,
and `.git/hooks/pre-push` on 2026-07-30.

`docs/CODING_STANDARDS.md` states the rules. This file states **where each rule
is actually enforced**, and names the rules that are currently written but
unenforced.

---

## The four gates

| gate | runs where | cost | what it must catch |
|---|---|---|---|
| pre-commit | local, every commit | seconds | formatting, lint, types, docs generation, secrets, debug leftovers |
| pre-push | local, every push | ~a minute | contract parity, fast tests |
| CI | rodaddy self-hosted runners | minutes | full suite against a real database |
| deploy | production-host macOS runner | manual/tag | production rollout |

**A rule enforced only in CI is a rule the author learns about ten minutes
later, on a branch, after the mistake is already committed.** Push what can be
checked locally down to pre-commit; the teeth belong where the work happens.

---

## Gate 1 — pre-commit (local)

### Current state — MEASURED 2026-07-30

`.git/hooks/pre-commit` is 15 lines. It chains to
`/Users/rico/.config/git/hooks/pre-commit` (the operator's global gitleaks hook)
and exits 0 if that file is absent. It runs **no lint, no typecheck, no tests,
and no docs generation.**

The file's own header says: *"Local interim install (unversioned); superseded by
versioned .githooks (#311)."*

**#311 is half-landed, and the half that landed is not running.** Measured
2026-07-30:

- `.githooks/` exists and is tracked, containing **only `pre-push`**. There is
  no versioned `pre-commit`.
- `core.hooksPath` is set to
  `/workspace/open-brain/.git/hooks` — the *untracked*
  directory.

So the tracked `.githooks/pre-push` **is not the hook git executes**; the
untracked `.git/hooks/pre-push` is. Editing the reviewable one changes nothing,
and a fresh clone gets neither.

Completing #311 means: write the versioned `pre-commit`, and point
`core.hooksPath` at `.githooks`.

Consequences already observed in this repo:
- A dead variable in `distiller.ts` reached commit and only surfaced at `tsc`.
- Python `ruff`/`mypy`/`pytest` run only in the `python-package` and
  `python-provider` CI jobs — nothing checks them before a commit lands.
- 36 duplicate content-bound definitions accumulated across 25+ files with no
  gate objecting.

### Required state

The hook is **versioned in the repository** (`.githooks/`, `core.hooksPath`
pointed at it) so it is reviewable, diffable, and identical for every clone.
An unversioned hook in `.git/hooks/` is invisible to review and absent on a
fresh checkout.

Every check below **blocks the commit**. None warns. None exits 0 on a skip.

| # | check | command | why |
|---|---|---|---|
| 1 | secrets | chain the global gitleaks hook | preserve today's only working gate |
| 2 | format | `ruff format` on staged Python, then re-stage | **ruff, not black** |
| 3 | lint | `ruff check` on staged Python | |
| 4 | types (py) | `mypy` over the **real package path** | see the path trap below |
| 5 | types (ts) | `tsc --noEmit` | with `noUnusedLocals` / `noUnusedParameters` on |
| 6 | package docs | the generator, in **blocking mode** | a missing docstring is a hole in qmd |
| 7 | bare except | `except:` and `except ...: pass` | a bound-but-unlogged handler counts |
| 8 | debug leftovers | `pdb`, `ipdb`, `set_trace`, stray `print()` in library code | |
| 9 | naive datetime | `datetime.now()` with no timezone | |
| 10 | hardcoded hosts | IP literals and credential-shaped strings | never `192.0.2.21`, never `127.0.0.1` |
| 11 | manifest sync | lockfile matches the project file | |

### The mypy path trap — verify this specifically

The reference hook this repo's design was adapted from
(`WorkStuff/b1x-message-coordinator/.git/hooks/pre-commit:60`) runs
`mypy src/b1x_telegram_listener/` while that repo's package is
`message_coordinator`. **mypy on a nonexistent path exits 0.** That hook has
been passing without typechecking anything.

When adding or renaming a package, assert the path resolves. A gate that cannot
fail is not a gate.

### Blocking, not warning

The package-docs generator must **fail the commit** on a missing docstring, a
too-short docstring, or one lacking the required sections. The reference
implementation's `should_generate_readme()` prints `⏭️ Skipped` and returns 0 —
which leaves in place exactly the undocumented package the rule exists to
prevent.

Operator decision, 2026-07-30: *"we should not let the generator fail silently.
It should be a blocker and stopper. I know it's just docs, but once we have all
of this stuff in qmd, those docs will be super important for finding stuff."*

---

## Gate 2 — pre-push (local)

Contract parity is the one check that must run before a push, because it
compares TypeScript and Python behaviour across a boundary CI cannot repair
after the fact.

`contracts/parity-paths.txt` lists the watched paths. It is the **single source
of truth** for the filter: the tracked hook, the CI `contract-parity` job, and
the PR-body workflow all read it, and `check-parity.ts` asserts it is non-empty.

### Two different pre-push hooks exist — MEASURED 2026-07-30

| | tracked `.githooks/pre-push` | live `.git/hooks/pre-push` |
|---|---|---|
| language | zsh | bun/TypeScript |
| parity paths | reads `contracts/parity-paths.txt` | pattern-matches "memory-client source" |
| diff base | `git merge-base` with `origin/main`, falling back to `main` | commit-message declaration line |
| runs `check-parity.ts` | yes | only `if (existsSync(...))` |
| **executed by git** | **no** | **yes** |

`diff` confirms they are not the same file. `core.hooksPath` selects the live
one, so the richer, reviewable, path-file-driven hook does not run.

### The invariant to preserve when this is fixed

The hook and the CI job must **diff against the same base**: the merge-base with
`origin/main`. CI states this explicitly (`ci.yml:394-398`) — *"Match the
pre-push hook: diff against the merge-base with origin/main so CI never checks a
narrower range than the hook does."*

A hook checking a wider range than CI is fine. The reverse is a hole. The
tracked zsh hook already implements this correctly; the live bun hook does not.

---

## Gate 3 — CI (`.github/workflows/ci.yml`)

Runs on push to `wip/**`, `feat/**`, `fix/**`, `main`, on `v*` tags, and on
same-repo pull requests.

**Fork PRs deliberately do not run.** These are self-hosted runners; untrusted
fork code must never execute on them. A maintainer re-pushes the branch to this
repo to test it. Every job carries the same guard:

```yaml
if: github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository
```

### Jobs

| job | runner | what it proves |
|---|---|---|
| `check` | `[self-hosted, Linux, rodaddy]` | typecheck, migrate, `bun test` against whatever Postgres is on the runner |
| `db-integration` | same | full suite against an **ephemeral digest-pinned pgvector container**, plus the anti-skip guard and the #298 restore drill |
| `python-package` | same | `ruff check`, `mypy src/openbrain_memory`, `pytest`, `uv build` |
| `python-provider` | same | `ruff format --check`, `ruff check`, `mypy` on **src and tests**, `pytest`, `uv build` |
| `contract-parity` | same | TS↔Python fixture replay, only when watched paths changed |
| `deploy` | `[self-hosted, macOS, production-host]` | production rollout; needs all five above |

### The anti-skip guard — the most important line in the file

Postgres-backed suites are gated on `OPENBRAIN_TEST_DATABASE_URL`. Unset, they
**skip silently** and the job goes green having tested none of the SQL write
paths. That is exactly how the #162 `lane_upsert` bugs shipped.

`db-integration` therefore runs `bun test --reporter=junit` and then
`bun run scripts/assert-db-tests-ran.ts`, which **fails the job** if the
DB-backed suites did not execute.

**Any new class of environment-gated test needs its own anti-skip assertion.**
A green run that tested nothing is worse than a red one — it produces a false
receipt.

Locally, the same trap applies: set `OPENBRAIN_TEST_DATABASE_URL` whenever a
test result is being used as evidence.

### Isolation invariants — do not weaken these

- **Per-run databases.** `open_brain_test_${{ github.run_id }}_${{ github.run_attempt }}`.
  Concurrent push and pull_request runs must not delete rows underneath each
  other.
- **`DB_NAME` and `DB_NAME_TEST` are separate databases.** The destructive
  `001_init` migration test runs `DROP TABLE`; pointing it at the live-suite
  database would clobber it.
- **UTF8 pinned explicitly** (`-E UTF8 -T template0`). A bare `createdb`
  inherits the cluster's `template1` encoding; a C/POSIX cluster defaults to
  `SQL_ASCII`, under which the snowball stemmers split multibyte accented
  characters and every non-English FTS assertion (#341) silently fails while
  ASCII-only English passes. Open Brain is UTF8 in production, so a non-UTF8
  test database is an invalid harness.
- **Digest-pinned image.** `pgvector/pgvector:pg18@sha256:212765b6…`. This job
  gates deploy; a mutable tag must not be able to change underneath it. To bump:
  `docker buildx imagetools inspect pgvector/pgvector:pg18`.
- **Host networking, not `services:`.** GitHub service containers rely on
  bridge-network port forwarding, which is broken on runners ct106/ct107 (only
  ct108 forwards). `docker run --network host` on a randomly-chosen free
  loopback port works on all three. Isolation still holds: unique container name
  and port per run, loopback-only listener, `if: always()` teardown.
- **CI credentials are throwaway.** `ci:ci` against an ephemeral loopback-only
  container destroyed at job end. Never a real Open Brain database, never a real
  credential in the workflow file.

### The restore drill (#298)

`OPENBRAIN_BACKUP_DRILL=1` makes the backup → verify → restore path
**mandatory**: with the flag set, missing prerequisites fail loudly instead of
skipping. `pg_dump`/`pg_restore` run via `docker exec` into the pinned container
rather than the runner's client tools, because `pg_dump` refuses to dump a
server newer than itself and the runner's client major version is whatever the
distro ships. `-e PGPASSWORD` with no value propagates the password by name, so
the credential never appears in `argv`.

---

## Gate 4 — deploy

`needs: [check, db-integration, python-package, python-provider, contract-parity]`.
All five must pass.

Triggers, and only these:
- `workflow_dispatch` with `deploy_production: true` **on `main`**
- a push of a `v*` tag

Runs on `[self-hosted, macOS, production-host]` with
`concurrency: { group: deploy-production-production, cancel-in-progress: false }` —
deploys queue, they never cancel each other mid-rollout.

Docker is deliberately absent from this runner: the production host must not run
it. That is why `db-integration` is pinned to the Linux runners.

---

## Runner topology

| runner | labels | role |
|---|---|---|
| ct106 / ct107 / ct108 | `self-hosted, Linux, rodaddy` | all validation; Docker-capable; ct106/ct107 cannot bridge-forward |
| production-host | `self-hosted, macOS, production-host` | production deploy only |

Runners see the shared volume as `/mnt`, the Mac sees it as `/Volumes`. Write
paths as `/mnt`.

---

## Adding a gate

1. **Write the failing case first.** A gate that has never failed on real input
   is unproven.
2. **Put it at the earliest gate that can run it.** Local beats CI.
3. **Assert it can fail.** Nonexistent paths, unset env vars, and empty file
   lists all produce exit 0.
4. **Say what it did not examine.** A gate that inspects only part of its
   subject — changed files, a sample — logs what it passed over. Otherwise a
   partial pass reads as a full one.
5. **Never make a gate green by weakening it.** Fix the code.

---

## Known gaps — WRITTEN, NOT ENFORCED

Measured 2026-07-30. Every row is a rule in `docs/CODING_STANDARDS.md` with no
mechanism behind it:

| rule | status |
|---|---|
| versioned `.githooks/` (#311) | **half-landed and inert**: `.githooks/` holds only `pre-push`, and `core.hooksPath` points at the untracked `.git/hooks` — so the tracked hook never runs |
| ruff / mypy / pytest at commit time | CI only |
| `tsc --noEmit` at commit time | CI only |
| package-docs generator | **does not exist yet** |
| `noUnusedLocals` / `noUnusedParameters` | `false` in `tsconfig.json` |
| bare-except, debug-leftover, naive-datetime checks | none |
| hardcoded-host check | none |

**None of these are enforced today.** They are the build list for the rebuild,
not a description of the current repository.

---

**See Also:**
- `docs/CODING_STANDARDS.md` — the rules these gates enforce
- `docs/CONFIG_REFERENCE.md` — every setting, and where it is defined
- `.github/workflows/ci.yml` — the live workflow
- `contracts/parity-paths.txt` — the paths that trigger parity
- `AGENTS.md` — pre-PR self-review gate, downstream rollout gate
