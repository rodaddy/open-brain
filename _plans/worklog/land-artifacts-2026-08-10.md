# Landing the issue-artifacts work — attempt 5

Status: IN PROGRESS 2026-08-10. Truth labels per LAW 0 throughout.

## What this is

The generator change that makes a CLOSED issue artifact carry its own
resolution — `scripts/sync-issues.ts` renders a `## Resolution` section from the
closing PR's body, merge SHA and merge time, so an `aqmd` search that finds the
question also finds the answer. Operator ruling 2026-08-09, ledger item 32.

Four prior attempts died on gates, not on the work: the pre-push hook failed
every push on a green suite (#712, `WriteFailed` when git piped bun's stderr),
and the pr-body-gate resolved the Done-means script from the wrong tree (#709,
#706). Both are MERGED and live-proven as of this attempt.

## Pre-rebase dedupe measurement (2026-08-10)

Branch `lane/issue-artifacts-outcomes` at `daf6c46`, one commit on top of
`6e3198f`. Integration target `origin/wip/2026-08-07` at `36a2a7d`.

The reconcile commit `dbd4958` (now on origin, reachable from `36a2a7d`) already
landed this lane's GRAPH-FILE content in root. Measured before rebasing rather
than assumed:

- `scripts/done-means/issue-resolution-artifacts.sh`,
  `...driver.ts`, and `fixtures/issue-resolution-timelines.json` are
  **byte-identical** between `daf6c46` and `36a2a7d` (blob SHA comparison).
  The rebase drops these hunks with no decision to make.
- `docs/controller-contract.md`, `docs/issue-graph.md`,
  `docs/lane-contract.md` differ because root has MORE — rounds 29 (#709 and
  #712) landed after this branch was cut. Root verified a **superset**: every
  one of the lane's 46 + 1 + 13 added lines is present in the root blob.
  Resolution rule: keep root/upstream for graph files.
- Unique payload kept from the BRANCH: `scripts/sync-issues.ts` (+359/-25) and
  the regenerated `_plans/issues/*` mirrors.

Harness note, self-reported: the first superset check reported seven false
MISSING lines because `rg -qF "$line"` parsed a leading `-` as a flag. Fixed
with `rg -qF --`. Same family as round 19's `rg -r` lesson — the failure mode
was a plausible-looking wrong answer, not an error.

## Timeline — LANDED

1. **Rebase** onto `36a2a7d` → `733fbb0`. ONE conflict, in
   `docs/controller-contract.md`, and it was a pure addition on the ROOT side
   (the tracking-scribe dispatch paragraph) against an empty branch side. Kept
   root; the resolved file then `diff`ed IDENTICAL to `36a2a7d`'s blob. The
   rebase dropped all three done-means artifacts and the graph-file hunks by
   itself because root already had them byte-for-byte, leaving 264 files:
   `scripts/sync-issues.ts` (+334/-25) and the `_plans/issues/` mirrors. Nothing
   was dropped that exists in neither — the superset check above is the proof.
2. **Done-means** `scripts/done-means/issue-resolution-artifacts.sh` — **16/16
   PASS**, including clause (e) re-checking live GitHub for #681's closer shape.
   `bunx tsc --noEmit` exit 0 (read directly, not through a pipe).
3. **Push** `134b0b8...733fbb0 (forced update)` with `--force-with-lease`.
   `pre-push: all checks passed ✓` on a green Bun suite — the #712 fix
   live-proven under a piped git. No `--no-verify`, no hook bypass.
4. **PR #716** created; the validator announced `Done-means resolved in the tree
   under review: <lane worktree>/scripts/done-means/...` — the #709 fix visibly
   working. `verify-lane.ts 716` → VERIFIED, receipt bound to `733fbb0` with
   `recheck-head` confirming check and receipt describe one commit. CI `validate`
   + GitGuardian green. Squash-merged **`242dc54`**; remote branch deleted, lane
   worktree removed, local branch deleted, `git worktree prune` run.
5. **Root regeneration**: `bun scripts/sync-issues.ts` →
   `344 issues (77 open, 267 closed), 267 with a Resolution`. Committed by
   explicit path as `25f9c9f` (staged set verified = 4 files, nothing swept).
   `aqmd up`: 268 updated, 1124 chunks embedded.
6. **#710 closed** with a direction-and-why comment (obligation 2b), then
   regenerated again → `a5bbcd4`, so its own artifact carries the rationale.

## The receipt

```
$ qmd search "derive the liveness seed from the ingest role set"

qmd://open-brain/_plans/issues/681-cutover-blocker-liveness-observer-blind-to-the-tool-role-dea.md:47 #4b3dcc
Title: #681 — [cutover-blocker] Liveness observer blind to the 'tool' role — dead 8 days (14,006 rows frozen), /health reads green
Score:  92%

Closed by **PR #687** — fix(capture): derive the liveness seed from the ingest role set (#681)

- Linkage: Closed by commit `31589d1d31230c1af80d5d7044fcef21cff96269`, which is the merge commit of this pull request.
```

The closed question now returns its answer.

## Observation worth harvesting

`sync-issues.ts` renders "Closed without a pull request" for #710 and #712,
because both were closed by CLI rather than by a PR closing keyword. That is the
renderer being honest, not a defect — and it is the argument FOR obligation 2b:
the reasoning has to live in a COMMENT, which the mirror captures regardless of
PR linkage, rather than depending on a linkage this repo's squash-into-wip flow
frequently does not create. Verified: #710's artifact carries the full closure
rationale via the discussion mirror.

Truth state (LAW 0): generator **MERGED** at `242dc54` and **RUNNING** locally
(executed against live GitHub, output committed, pushed, indexed). Nothing here
touches core01.
