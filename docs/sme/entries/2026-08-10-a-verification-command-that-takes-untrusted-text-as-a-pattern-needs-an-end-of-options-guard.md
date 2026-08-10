---
lane: gotcha-agent
order: 71
---
## [2026-08-10] A verification command that takes untrusted text as a pattern needs an end-of-options guard

**Severity:** MEDIUM
**Source:** PR #716 (the #710 issue-artifacts landing lane), `_plans/worklog/land-artifacts-2026-08-10.md`
**Scope:** verification and superset-check shell in `scripts/done-means/*.sh`, lane harness one-liners, any `rg`/`grep`/`sed` call whose pattern comes from a file's own lines
**Status:** active

### Pattern

A pre-rebase superset check looped over the lane branch's added lines and asked
whether each one was present in the root blob:

```sh
rg -qF "$line" root-copy.md      # WRONG
rg -qF -- "$line" root-copy.md   # correct
```

Diff-derived lines routinely start with `-`. Without `--`, ripgrep parses that
leading `-` as a flag rather than as the first character of the pattern, and the
check reported **seven false MISSING lines** — content that was in fact present.
The lane self-caught it, but the failure mode is what makes it review-worthy:
not an error, not a crash, but a **plausible-looking wrong answer** in exactly
the direction that invites a destructive decision. Believing those seven would
have meant "root is not a superset, keep the branch side", i.e. reintroducing
stale graph-file content over newer root content.

This is the same family as round 19's `rg -r` (silently the REPLACE flag) and
the two `rg -E` incidents (`--encoding`, not extended-regex) — a flag-shaped
argument accepted as a flag and the command still exiting 0. Third distinct
spelling; treat it as a standing class, not three coincidences.

Reviewer checks:

- Any `rg`, `grep`, or `sed` whose pattern is **interpolated from data** — file
  lines, diff output, issue titles, branch names, `$line`/`$1` — must carry `--`
  before the pattern. Ask where the pattern came from, not whether it looks safe
  in the sample.
- `-F` does NOT imply `--`. Fixed-string matching disables regex interpretation,
  not option parsing; the two are separate stages and only `--` stops the second.
- The same block bit again while harvesting this very entry:
  `rg -h "^order:" docs/sme/entries/*.md` printed ripgrep's own help instead of
  the matches, because `-h` is `--help`. Use `--no-filename`. Short flags whose
  meaning you inferred from another tool are the recurring vector.
- A superset/equality check that can only report "missing" is one-directional
  and cannot distinguish "genuinely absent" from "the query was malformed". Where
  the verdict authorizes a drop or an overwrite, require a positive control — a
  line known to be present and one known to be absent — so a broken query fails
  loudly instead of confirming the alarming direction.
