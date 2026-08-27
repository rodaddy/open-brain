---
lane: quality
order: 81
---
## [2026-08-08] Lane tooling gotchas: the shell, the validator, and the worktree

**Severity:** MEDIUM
**Source:** PRs #615, #616, #617, #619, #620, #621 (tooling + fixture lanes); PRs #623, #624 (#614 and #612 lanes); PRs #628, #630, #631 (enforcement-build lanes)
**Scope:** `scripts/validate-pr-body.ts`, `scripts/lane-bootstrap.ts`, `scripts/done-means/*.sh`, PR bodies, `.gitignore`
**Status:** active

### Pattern

A cluster of tooling behaviours that each produced a false green or a lost afternoon, collected because they recur and none is guessable from the tool's surface.

**`validate-pr-body.ts` reads `PR_BODY`/`PR_TITLE` from the ENVIRONMENT — not argv, not stdin.** Run it with neither set and it validates the empty string; in one observed path it printed failures and exited 0. Always confirm the literal `PR body validation passed` line, never the exit code alone. Found independently by the controller and the #613 lane.

**No `###` subheadings inside validator-required PR-body sections.** The section parser terminates on `startsWith("## ")`, which `### x` satisfies, so an h3 silently truncates the section. Use bold text instead.

**Bun names tests only on failure.** A gate that searches the suite log for a test name to prove execution false-negatives on a fully-passing run. Prove execution by asserting a non-zero pass count.

**`rg -E` is `--encoding`, not extended-regex.** Use `rg -e`.

**`sed -i` is not portable between this shell's GNU sed and the BSD examples**, and in-place sed has burned two lanes. Prefer the Edit tool, `awk` to a new file, or `> file && cp`.

**`lane-bootstrap` prints the worktree path but does not change your directory.** Relative commands after it still target the primary checkout — enter the printed absolute path explicitly. Also, `bunx --cwd` is not a thing; run `bunx` from inside the worktree.

**Never `git stash` in a checkout you do not exclusively own.** One `stash pop` popped ANOTHER session's pre-existing stash and left a `UU` conflict. Worktrees from `lane-bootstrap` are exclusively yours; the primary checkout never is.

**No absolute machine paths in tests or defaults.** A hardcoded `/Volumes/...` default died with `EACCES` on the Linux CI runner. Use repo-relative `_scratch/` (gitignored), as `src/operator-doctor.test.ts:32` does.

**Verify `.gitignore` outcomes by `git ls-files`, not by reading patterns** — a later rule can override the one you read. `.claude/*` nearly ate the pr-scribe agent. The clean-clone or fresh-worktree run of the done-means check is the only thing that catches this class; always finish with one.

**A suite that exits 0 can still leak rows.** The parity harness passed green for its whole life while seeding nine tables. Gates read the database, not the exit code — and clean up by the dimension the PRODUCER uses, not the dimension the test seeds, preferring the owning shared helper over per-suite patches.

**Citations to artifacts that do not exist yet are fabrications.** A PR number guessed before `gh pr create` is a guess in the grammar of a fact. Write the reference after the artifact exists.

**Mutation-test the gate itself when the PR's claim IS the gate.** Reintroduce each real failure mode and watch the gate fail; a gate observed only green is decoration.
