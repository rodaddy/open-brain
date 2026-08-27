---
lane: correctness
order: 79
---
## [2026-08-09] A pin derived before integration is stale the moment anything else merges

**Severity:** HIGH
**Source:** PR #687 (#681 integration), PR #688 (#675 integration), PR #701 (#271 tripwire heal) — three consecutive integrations, same two collisions
**Scope:** `EXPECTED_ENTRY_COUNT` and every hand-derived pin; `order:` in `docs/sme/entries/*.md`; `scripts/build-sme-indexes.ts`
**Status:** active

### Pattern

Two branches can each derive a pinned count HONESTLY and both still be wrong after the merge. PR #687 measured `EXPECTED_ENTRY_COUNT` as 235 on its own tree and was correct there; PR #701 then landed its own entry and main became 235 too. The merged truth is 236.

The freshness of a measurement is not a property of how carefully it was taken. It is a property of WHEN. A lane working alone cannot see this at all.

The companion failure is worse, because git reports it as success. Both branches independently chose `order: 68`, in two DIFFERENT entry files, so there was nothing for a textual merge to conflict on. The tree merged clean and the duplicate surfaced only when `build-sme-indexes.ts` was run by hand and warned. Three integrations in a row hit both collisions, which makes them a PROPERTY of running lanes in parallel, not an unlucky merge.

Root cause of the `order` half: it is a shared sequential ID allocated by reading the current maximum, which every concurrent lane reads identically. It will keep colliding as long as lanes run in parallel.

### What to do

- **Re-measure every pin AFTER integrating the upstream default branch.** Never carry a branch's own derivation across a merge, and never sum two branches' numbers.
- **Re-run the branch's own tooling after integrating**, even on a conflict-free merge. The class of defect a merge introduces is precisely the class no textual merge can see. A generated-file conflict is regenerated; a generated-file NON-conflict still needs the build.
- **A PR that moves a pinned value must re-run the other assertions of that value, including in files its diff never touches.** #691 bumped a tool contract 2 -> 3 with all its own gates green; the pin-holder was a test in an untouched file, so the branch was green and the merge was red. That is a controller defect — the cross-file pin check belongs in the merge pass.
- Resolve a duplicate `order` by moving it to the next free number, not by renumbering by date: `order` is an explicit sort field independent of the entry's date, and the corpus is deliberately not date-sorted.
- Enforcement gap, still open: `build-sme-indexes.ts` warns on a duplicate `order` and exits 0. A warning is the right severity for merge-time discovery and the wrong one for a gate — a merge that never runs the build ships the duplicate.
- `FETCH_HEAD` is per-worktree. `git merge FETCH_HEAD` in a freshly-added worktree dies with `could not open .git/worktrees/<name>/FETCH_HEAD` when the fetch ran elsewhere. Fetch inside the worktree you merge in; note the error names a missing FILE, which reads as a broken repository at a glance.
