# Gate-layer audit — is the #705–#714 defect family extinct?

Status: **WRITTEN 2026-08-10**, from a full sweep of this repo's gate/hook layer
on the untouched primary checkout at `183d066` (branch `wip/2026-08-07`, clean
tree). Every verdict below was produced by running the thing, not by reading it.

**Answer: NO. The five filed members are fixed and hold. Four more members of
the same family are live, and two of them silently disabled the done-means
coverage of the very gate the family is about.**

## What the family is

Two shapes, from lane-contract rounds 27–30:

- **(A) A gate judging from the WRONG TREE** — the primary checkout instead of
  the branch/worktree under review. Members: #706, #709, #714.
- **(B) A gate letting its ENVIRONMENT decide the verdict** instead of the code
  — pipe writability (#712), inherited env (#705), inherited `GIT_DIR`
  (closed #483).

Root enabler: **#711** — an absolute `core.hooksPath` in the shared
`.git/config` made every worktree run the primary checkout's hooks.

The audit asked three questions of every gate: (1) which tree does it read, and
is that the tree under review? (2) what environment inputs can flip its verdict,
and does it announce or guard them? (3) does its own done-means drive the real
invocation path, or a seam?

## Per-gate table

| Gate | (1) Tree read | (2) Environment inputs | (3) Own check drives real path | Verdict |
|---|---|---|---|---|
| `_githooks/pre-push` — base selection | Branch's configured upstream, one `resolve_base`, announced | Announces base + source; refuses divergent `core.hooksPath` | Its check is **RED and blind** (#722) | **SOUND (fix), DEFECT (coverage)** |
| `_githooks/pre-push` — test verdict | n/a | Both fds → log file; verdict from exit code; `WriteFailed` named separately | Its check is **RED and blind** (#722) | **SOUND (fix), DEFECT (coverage)** |
| `_githooks/pre-push` — hooksPath assertion | Reads effective `git config` | The input under test; refuses, never guesses | `711-hookspath-relative.sh` 5/5, real `git hook run` + mutation control | **SOUND** |
| `_githooks/install.sh` | Repo-root-relative value | Writes relative `_githooks`; names the absolute-path damage | Covered by 711 clause (e) | **SOUND** |
| **pre-commit (absent)** | — | Repo `core.hooksPath` displaces the global gitleaks + LAW #8 hook | **No check exists** | **DEFECT — #719 (B)** |
| `.claude/hooks/merge-gate.ts` | GitHub server state via `gh`; receipts from comments only | Refuses on any `gh`/JSON failure, never fails open | Clauses 1–8 hermetic; clause 9 skippable by env (#721) | **SOUND (gate), DEFECT (check)** |
| `.claude/hooks/pr-body-gate.ts` | `cd`-target reader → payload cwd; feeds `PR_HEAD_REF`; degrades to old behaviour | Refuses `cd -`, variable paths, detached HEAD; announces on refusal path | `709`, `714` GREEN; drive the real hook payload | **SOUND** |
| `scripts/validate-pr-body.ts` — review tree | Tree under review FIRST (#706) | `PR_REPO_DIR` / `PR_HEAD_REF` explicit | `706` GREEN | **SOUND** |
| `scripts/validate-pr-body.ts` — `OWN_TREE` fallback | **Primary checkout, for a branch it is not reviewing** | `import.meta.dir`-derived | No clause covers the fallback | **DEFECT — #720 (A)** |
| `scripts/verify-lane.ts` | Fresh worktree fetched to PR head; asserts `HEAD == headRefOid` | Spreads `process.env`, but re-entry markers are structured | Runs the check from the fresh tree | **SOUND** |
| `scripts/done-means/merge-gate-and-verify-lane.sh` | Own tree (`BASH_SOURCE`) | **Any non-empty `MGVL_IN_VERIFY_LANE` turns the only live clause into PASS** | Clause 9 is the real path — and it is the skippable one | **DEFECT — #721 (B)** |
| `scripts/done-means/705-pre-push-base-selection.sh` | Own tree | **Fixtures inherit global `core.hooksPath`** | Drives the shipped hook, but never reaches it | **DEFECT — #722 (B)** |
| `scripts/done-means/712-pre-push-pipe-safe.sh` | Own tree | **Fixtures inherit global `core.hooksPath`** | Real hook, real pipe, PATH shim — all blinded | **DEFECT — #722 (B)** |
| `.github/workflows/ci.yml` | `pull_request` checkout; explicit `base.sha`/`head.sha` | Fork PRs excluded; per-run isolated databases | n/a (is the real path) | **SOUND** |
| `.github/workflows/pr-body.yml` | `fetch-depth: 0`; body/title from event payload | `CONTRACT_PARITY_REQUIRED` computed from the diff, not assumed | n/a | **SOUND** |
| `.claude/hooks/design-lookup-gate.ts` | Session-scoped state | No env bypass found | — | **SOUND** |
| `.claude/hooks/design-contract.ts` | Static injection | None (no verdict) | — | **SOUND (not a gate)** |
| `.claude/hooks/hydration-stamp.ts` | `DM451_CANON_PACK` explicit input | Empty pack counted ABSENT, not healthy | `451` covers it | **SOUND** |
| Hardcoded roots in `598-`, `646-` | Primary checkout — **but only to source gitignored `.env`** | Credentials lookup, not code under review | — | **SOUND (by intent)** |

## Evidence for each defect

### #719 — pre-commit gate silently absent (Family B)

`core.hooksPath` selects **one** directory; git does not chain. `_githooks/`
ships only `pre-push` and `install.sh`, so the global hook's gitleaks scan and
LAW #8 protected-branch block do not run here.

```
$ git hook run pre-commit
error: cannot find a hook named pre-commit

$ git -c core.hooksPath=/Users/rico/.config/git/hooks hook run pre-commit
INF 0 commits scanned.  INF no leaks found
```

The positive control is the finding: gitleaks works, and this repo's config is
what stops it. A `.git/hooks/pre-commit` shim exists whose docstring says it
restores exactly this — and it is unreachable, because `core.hooksPath` makes
git ignore `.git/hooks` entirely. The repair was written and has never run.

Why it survived #711: that lane asserted the hooksPath **value**; nothing
asserts the directory is **complete**. An override is a replacement, not an
overlay.

### #720 — validator falls back to its own tree (Family A)

`validate-pr-body.ts:91` builds `OWN_TREE` from `import.meta.dir`, and
`requireDoneMeans` consults it when the review tree misses.

```
# review tree does NOT contain this check; primary checkout does
$ PR_REPO_DIR=<empty-tree> bun scripts/validate-pr-body.ts
Done-means resolved in the validator's own tree:
  /Volumes/.../open-brain/scripts/done-means/705-pre-push-base-selection.sh
```

Negative control — absent from both trees is still refused, proving the pass
comes from the fallback and not a slack matcher:

```
- Done-means: scripts/done-means/definitely-not-a-real-check-xyz.sh
=> must name an existing repo-relative path; not found (looked in: <faketree>, <primary>)
```

The primary checkout sits on the integration branch and accumulates every check
ever merged, so the fallback fires most readily exactly when a lane's own check
is missing.

### #721 — the only live clause is env-skippable, and records PASS (Family B)

```
$ MGVL_IN_VERIFY_LANE=fabricated-value bash scripts/done-means/merge-gate-and-verify-lane.sh
CLAUSE 9 (LIVE: verify-lane runs a real PR check and posts a SHA-bearing receipt):
  PASS — SKIP-BY-GUARD: already running inside verify-lane (MGVL_IN_VERIFY_LANE=fabricated-value)
$ echo $?
0
```

Full green, exit 0, verify-lane never exercised. `verify-lane.ts:479` sets a
structured `pr-<n>` and maintains `MGVL_VERIFY_LANE_PRS`; the guard validates
neither. The recursion it prevents is real (331 worktrees, 2026-08-08) — the
defect is that the guard is asserted rather than earned, and that a skip is
recorded as a pass. `issue-resolution-artifacts.sh` in the same directory does
it right: it counts skips and prints "skipped is not passed."

### #722 — both pre-push checks are RED on untouched main (Family B)

Neither `705-` nor `712-` pins `core.hooksPath` in its fixtures, so each
inherits the operator's global value and trips #711's assertion — which runs
before the `--explain` early exit. Every clause then parses a refusal.

Sweep of every done-means check that builds a git fixture; the correlation is
exact:

| check | pins `core.hooksPath`? | live status |
|---|---|---|
| `711-hookspath-relative.sh` | YES | GREEN 5/5 |
| `709-hook-feeds-head-ref.sh` | YES | GREEN |
| `714-head-ref-resolves-remote.sh` | YES | GREEN |
| `705-pre-push-base-selection.sh` | **NO** | **RED 5/6** |
| `712-pre-push-pipe-safe.sh` | **NO** | **RED 6/6** |

Both fixes are intact. Proof for #705 — same shipped hook, same fixture shape,
with the one missing line:

```
$ git -C $F config core.hooksPath _githooks
$ (cd $F && ./_githooks/pre-push --explain)
  base: main — fallback (no configured upstream, no origin/main)
  changed: python/openbrain-memory=no python/openbrain=no parity=no
```

For #712, the shipped hook still redirects both fds to `TEST_LOG`, reads the
verdict from `TEST_EXIT`, and classifies `WriteFailed` separately.

The danger is not the red. It is that both checks emit confident, specific,
**false** regression claims — "the packages are no longer separately gated",
"redirecting stdout alone does not fix #712" — about a hook that does neither.
That is how a genuine regression later gets waved through as "that one's always
red", and it leaves the gate with the most family history carrying no working
done-means coverage.

## Explicit SOUND list (negative results)

These were driven and found correct — worth recording so the next audit does not
re-litigate them:

1. **`_githooks/pre-push` base selection** — one `resolve_base`, upstream-first,
   announced on every run. Verified live: `base: origin/wip/2026-08-07 —
   configured upstream`.
2. **`_githooks/pre-push` test verdict** — verdict from exit code; both fds off
   any caller-supplied pipe; "tests failed" and "runner could not report" named
   separately.
3. **The #711 hooksPath assertion** — `711-hookspath-relative.sh` 5/5, using
   real `git hook run` against a real linked worktree, with a mutation control
   (clause d) proving the assertion is not blanket-refusing.
4. **`merge-gate.ts`** — reads GitHub server state, not any local tree, so
   Family A cannot reach it. Receipts parsed from **comments only**, never the
   lane-editable body. Fails closed on every `gh`/JSON error.
5. **`pr-body-gate.ts`** — post-#709/#714 it reads the `cd` target, refuses to
   guess (`cd -`, variable paths, detached HEAD), degrades to the old payload
   cwd rather than to a guess, and announces on the **refusal** path.
6. **`verify-lane.ts`** — Family-A-proof by construction: fresh worktree fetched
   to the PR head, `HEAD == headRefOid` asserted before running, check resolved
   from the fresh tree, so a check missing at head cannot pass.
7. **CI workflows** — `pull_request` checkout with explicit `base.sha`/`head.sha`;
   fork PRs excluded; per-run isolated databases.
8. **Hardcoded primary-checkout paths in `598-` and `646-`** — resolve only the
   gitignored `.env`, which legitimately lives in the primary checkout and is
   absent from every lane worktree. Credentials lookup, not a wrong-tree code
   read. Not a Family A member.
9. **`BASH_SOURCE`-derived roots** — 45 of 47 done-means checks self-locate, so
   they travel correctly with a worktree.

## Filed issues

| Issue | Family | Summary |
|---|---|---|
| [#719](https://github.com/rodaddy/open-brain/issues/719) | B | pre-commit gate absent; gitleaks + LAW #8 silently off |
| [#720](https://github.com/rodaddy/open-brain/issues/720) | A | validator's `OWN_TREE` fallback passes checks absent from the branch |
| [#721](https://github.com/rodaddy/open-brain/issues/721) | B | live clause records PASS on any inherited `MGVL_IN_VERIFY_LANE` |
| [#722](https://github.com/rodaddy/open-brain/issues/722) | B | both pre-push checks RED on untouched main; false regression claims |

All four are blocked-by-nothing and appear on both frontier A and frontier B of
`bun scripts/issue-graph.ts`. None was fixed in this lane, per its charter.

## The generalisable lesson

Every one of the four is the family reproducing through a **new surface**: not
the gates this time, but the gates' own checks and the gaps between a fixed
value and a complete mechanism.

- #719: fixing a config **value** (#711) does not prove the directory it points
  at is **complete**. An override replaces; it does not overlay.
- #722: a fix that adds an assertion to a hook can **blind every check that runs
  that hook in an unpinned fixture** — and the blinded checks keep emitting
  their original, now-false, regression text. A check must distinguish "I could
  not parse the output" from "the subject regressed"; they are different
  defects with different owners.
- #721: a skip is not a pass, and a guard read from an inherited variable must
  validate the value's **shape**, not its mere presence.
- #720: a fallback tree is still a tree, and Family A survives in fallbacks long
  after the primary lookup is repaired.
