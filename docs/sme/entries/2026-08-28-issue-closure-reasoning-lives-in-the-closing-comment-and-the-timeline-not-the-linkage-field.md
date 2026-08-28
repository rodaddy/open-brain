---
lane: gotcha-agent
order: 101
---
## [2026-08-28] Issue closure reasoning lives in the closing comment and the timeline, not the linkage field

**Severity:** MEDIUM
**Source:** docs/lane-contract.md round 27 (ledger item 32, 2026-08-09); graduated 2026-08-28 per decisions row 6
**Scope:** issue closure, `scripts/sync-issues.ts`, PR bodies
**Status:** active

### Pattern

- At merge the controller posts a CLOSURE COMMENT on the ISSUE: direction taken,
  why that direction over the alternatives, and the receipts (PR number, merge
  SHA, done-means check name). The generator renders `## Resolution` from the
  closing PR, but a PR body that never states WHY produces a Resolution section
  that faithfully preserves nothing. The comment lands the reasoning where the
  mirror already captures it, rather than depending on PR linkage.
- A closing PR body is a durable artifact, not a merge formality. It is
  reproduced byte-for-byte into the closed issue's artifact and is what a future
  `aqmd` search returns as the answer. Write it for the reader who arrives in six
  months with no session context.
- `closedByPullRequestsReferences` is EMPTY in this repo. Lanes squash-merge into
  a wip branch, not the default branch, so GitHub's auto-close linkage never
  registers: the field returned `[]` for #681 even though PR #687 demonstrably
  closed it. Closure comes from the TIMELINE instead. Any tooling that reads
  closure MUST use the timeline; the obvious field silently reports absence.
- Cross-referenced PRs are not a list of closing PRs. #659 is cross-referenced by
  four and closed by one. Use them ONLY to resolve a closing commit SHA to its
  PR; rendering candidates would put several directions on an issue that took
  one, and an ambiguous answer fails the ruling as surely as a missing one.

### Check

Reviewing a closure path or artifact renderer: confirm it reads the issue
timeline for the closer and never trusts `closedByPullRequestsReferences`;
confirm cross-references are used only for SHA-to-PR resolution, never as
closing-PR candidates. Reviewing a closing PR or merge: confirm the PR body
states the direction and why, and that a closure comment with receipts was posted
on the issue.
