# Root reconciliation — graph learnings stranded in worktrees (2026-08-10)

**Status: MERGED-pending — written to root and committed on `wip/2026-08-07`.
Not pushed if the #712 pre-push defect blocks; see the closing section.**

## The incident

The graph's own accumulated learnings — the harvest rounds that the RLVR lane
protocol exists to produce — were written into lane WORKTREES under
`/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/` and never made it back to the
root checkout. `aqmd up` indexes the ROOT repo only, so every round living in a
worktree was **functionally deleted from the knowledge base**: not searchable,
not readable by the next lane, not present for any agent that asks the repo how
it works. The rounds existed on disk and were invisible to the only mechanism
that surfaces them.

This is the coordination-file rule stated as an operator ABSOLUTE on
2026-08-09/10: `docs/lane-contract.md`, `docs/sop-rlvr-lanes.md`,
`docs/controller-contract.md`, `docs/issue-graph.md`, `docs/sme/` (+ entries),
`scripts/done-means/`, and `_plans/issues/` artifacts ALWAYS live in and are
written to the root checkout, never a worktree and never `_tmp`. Reading FROM a
worktree copy to salvage content is fine; the WRITE target is always root.

## What was measured

Three copies of `docs/lane-contract.md`:

| Copy | Lines | Rounds 27/28/29 |
|---|---|---|
| ROOT `/Volumes/ThunderBolt/Development/open-brain` | 1002 | 28 only |
| WT `lane-issue-artifacts-outcomes` | 1106 | 27, 28, 29(#709) |
| WT `lane-712-pre-push-writefailed` | 1118 | 28, 29(#709), 29(#712) |

**Neither worktree was a superset.** The fullest-by-line-count copy
(`lane-712`, 1118) is MISSING round 27 entirely, which only
`lane-issue-artifacts-outcomes` carries. Taking the longest file would have
silently dropped the round-27 operator ruling (ledger item 32). The reconciled
root file is the union of all three, which no single copy was.

Root's round 28 was NOT partial, contrary to the initial read: `diff` of root
lines 90–146 against the same section in both worktrees is byte-identical. The
apparent truncation was round 28 sitting directly against round 26 with 27 and
29 absent above it.

Verified before splicing, so the merge was a pure insertion rather than a
line-level reconcile:

- preamble (lines 1–89): byte-identical across all three copies
- round 26 and everything older: byte-identical across all three copies
- round 28 block: byte-identical across all three copies
- round 29 (#709) block: byte-identical between the two worktrees

The entire divergence was confined to which round blocks were PRESENT.

## What landed in root

Every file below was written to the root checkout. Nothing was adjusted
silently; each line is what the file gained.

1. **`docs/lane-contract.md`** — 1002 → 1166 lines, **+164, −0 (pure
   insertion)**. Recovered three round blocks in newest-first order:
   round 29 (#712 pre-push WriteFailed lane), round 29 (#709
   hook-feeds-head-ref lane), and round 27 (operator ruling on issue artifacts,
   ledger item 32). Round 28 and older left untouched.

   Verified by set comparison rather than by eye: `comm` against the sorted
   union of all three sources returns EMPTY in both directions — no line from
   any source is missing from the result, and no line in the result came from
   nowhere. No duplicated `###` headers. Line arithmetic exact:
   1002 + 48 (round 27) + 116 (two round-29 blocks) = 1166.

2. **`docs/issue-graph.md`** — ledger **entry 32** recovered ("Issue mirrors are
   ARTIFACTS: a completed node must show its outcome and why", resolved,
   operator ruling 2026-08-09 quoted verbatim, with the measured
   `closedByPullRequestsReferences`-is-empty trap and the four rejected options).
   One-line insertion.

3. **`docs/controller-contract.md`** — controller obligation **2b, "Close the
   node out loud"** recovered (13 lines): at merge the controller posts a
   closure comment on the ISSUE naming direction, why over the alternatives, and
   receipts (PR, merge SHA, done-means check).

4. **`docs/sme/entries/`** — two entries recovered:
   - `2026-08-10-a-check-that-supplies-the-input-under-test-proves-only-half-the-wiring.md`
   - `2026-08-10-a-gate-must-not-let-its-own-reporting-channel-decide-its-verdict.md`

   Both are `lane: gotcha-agent`. `docs/sme/gotcha-agent.md` regenerated with
   `bun scripts/build-sme-indexes.ts` (48 entries) — never hand-merged. The
   regenerated root lane file is **byte-identical** to the worktree's, which is
   the determinism receipt. No other lane file changed.

5. **`scripts/done-means/sme-per-entry-files.sh`** — count pin 232 → **234**,
   carrying both lanes' announcement comments. The pin is not a guess: root's
   measured dated-entry total, using the script's own clause-4 command
   (`fd -e md . docs/sme/entries -x rg -c '^## \[20'`), is **234** after the two
   recoveries. WT2's version is a strict superset of WT1's here (same #709
   comment plus its own #712 comment), so WT2's was taken whole.

6. **`scripts/done-means/`** — five check artifacts recovered, each present in
   one worktree and absent from root:
   - `709-hook-feeds-head-ref.sh` (identical in both worktrees)
   - `712-pre-push-pipe-safe.sh`
   - `issue-resolution-artifacts.sh`, `issue-resolution-artifacts.driver.ts`
   - `fixtures/issue-resolution-timelines.json`

**`docs/sop-rlvr-lanes.md` did NOT diverge** — byte-identical to both worktrees,
so it was not touched.

Every done-means file sharing a name between root and a worktree was diffed;
`sme-per-entry-files.sh` was the only one with differing content, and it is
accounted for above.

## What was deliberately NOT done

- No worktree branch was touched, no worktree was created, and none of the code
  diffs those lanes carry were pulled into root. Only graph-file CONTENT was
  salvaged. The lanes' own PRs remain theirs to land.
- No `rm`, no `/tmp`, no core01, no `--no-verify`.
- Staged by explicit path; `git diff --cached --name-only` verified against the
  intended set before committing.

## The rule this incident buys

A harvest round written to a worktree is not a harvest. The lane protocol's
value is that round N+1 can read round N; a round that `aqmd` cannot return has
not been captured, however carefully it was written. The write target for a
coordination file is root, in the same action that produces it — not at merge
time, because the merge may be days out or may never come, and the next lane
briefs from the contract in the meantime.

Two of the three copies here were also traps for a reconciler in a hurry: the
longest file was not the fullest, and root's round 28 looked truncated when it
was complete. Diff the round HEADERS and compare sections directly; do not size
the merge by line count.
