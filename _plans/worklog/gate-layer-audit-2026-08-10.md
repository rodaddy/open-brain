# Gate-layer audit journal — 2026-08-10

Lane: audit the #705–#714 defect family for extinction. No fixes in this lane;
find, reproduce, file. Report: `docs/gate-layer-audit-2026-08-10.md`.

Baseline: primary checkout, `183d066`, `wip/2026-08-07`, clean tree, one
worktree (primary). Every verdict below came from running the thing.

## Order of work

1. Read lane-contract rounds 27–30 for the family's two shapes (A: wrong tree;
   B: environment decides the verdict) and the #711 root enabler.
2. Inventoried the layer: `_githooks/` (pre-push, install.sh), `.claude/hooks/`
   (5 gates + 2 lib), `scripts/validate-pr-body.ts`, `scripts/verify-lane.ts`,
   62 files in `scripts/done-means/`, 3 CI workflows.
3. Asked each gate the three audit questions, driving it rather than reading it.

## Findings, in the order they surfaced

**#719 — pre-commit absent.** Noticed `.git/hooks/pre-commit` dated Jul 21 while
`core.hooksPath=_githooks`. Git consults one directory and does not chain, so
that shim is unreachable and `_githooks/` has no pre-commit. `git hook run
pre-commit` → "cannot find a hook named pre-commit"; the same command with the
global path runs gitleaks successfully. The control is the finding. Family B.

**#720 — validator `OWN_TREE` fallback.** `validate-pr-body.ts:91` derives a
second tree from `import.meta.dir`. Reproduced with an empty review tree: a
check present only in the primary checkout resolved PASS. Negative control (a
name in neither tree) still refuses, which is what proves the pass comes from
the fallback. Family A, in the file #706/#709 already repaired.

**#721 — env-skippable live clause.** `merge-gate-and-verify-lane.sh:454` skips
clause 9 on any non-empty `MGVL_IN_VERIFY_LANE` and records it as **PASS**.
`MGVL_IN_VERIFY_LANE=fabricated-value bash …` → exit 0, full green, verify-lane
never run. `verify-lane.ts:479` sets a structured `pr-<n>`; the guard checks
neither shape nor `MGVL_VERIFY_LANE_PRS`. Family B.

**#722 — both pre-push checks RED on untouched main.** Ran the family's four
checks as a regression sweep: 706/709/714 GREEN, **705 RED**. Did not report it
as a #705 regression — diagnosed it first. Root cause: `705-…:146` inits its
fixtures without pinning `core.hooksPath`, so they inherit the operator's global
value and trip #711's assertion, which runs before the `--explain` exit. Proved
the hook itself sound by rebuilding the fixture with the one missing line.

Then swept the class rather than stopping at the instance: of the five checks
that build git fixtures, the three that pin hooksPath are GREEN and the two that
do not (705, 712) are RED. Ran 712 — **6/6 clauses failing**, every message
asserting a #712 regression that has not happened, including "redirecting stdout
alone does not fix #712" about a hook that redirects both fds. Widened #722 from
a single-check issue to the class and retitled it.

## Judgement calls worth recording

- **Two hardcoded primary-checkout paths were NOT filed.** `598-` and `646-`
  hardcode `REPO_ROOT`, which looks exactly like #706. Traced every use: both
  resolve only the gitignored `.env`. That file legitimately lives in the
  primary checkout and exists in no worktree, so this is a credentials lookup,
  not a wrong-tree code read. SOUND by intent, recorded as a negative result.
- **`verify-lane.ts` spreads `...process.env`** into the check it runs, which is
  the #705 silhouette. Not filed: the markers it adds are structured and the
  worktree/head assertions dominate the verdict. The exploitable half is the
  *consumer's* non-validation of the marker, which is #721.
- **The recursion guard in #721 is right and should not be removed** (331
  worktrees, measured 2026-08-08). Filed as "earn the guard, and a skip is not a
  pass", not "delete the guard".

## Process notes

- One slip: wrote a capture to `/tmp_out.log`. The read-only sandbox refused it.
  Re-ran into `{temp_workspace}/open-brain/_scratch/gate-audit/`. The refusal was
  the rule working; the reflex is still there in one-line redirects.
- No fixes attempted, per lane charter. No `--no-verify`, no `rm`, no core01.
- Scratch under `{temp_workspace}/open-brain/_scratch/gate-audit/` (issue bodies,
  fixtures, logs). No worktree created — the audit reads the primary deliberately,
  since the primary IS the tree several of these defects are about.

## State

- #719, #720, #721, #722 filed, blocked-by-nothing, on both frontiers.
- Report WRITTEN and committed; the four defects are PROPOSED fixes, unstarted.
- #705/#706/#709/#711/#712/#714 fixes themselves: verified intact this session.
