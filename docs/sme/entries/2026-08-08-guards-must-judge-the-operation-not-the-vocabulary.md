---
lane: gotcha-agent
scope: hooks.guards
severity: MEDIUM
status: active
order: 50
provenance: "#637 (design-lookup-gate false positives), #618 (git guard heredoc matching), PR #629 (shared parser)"
---

## [2026-08-08] A guard that matches vocabulary taxes every lane; judge the operation

**Pattern.** A guard is written to stop a behavior, and the fastest way to
write it is a word list: if the text contains one of these words, refuse. That
works on the day it ships, because the first violations really do contain the
words. It degrades immediately afterwards, because the words appear in four
other places where no violation exists.

**Two receipts in this repo, same defect class.**

`#618` — the git guard matched protected-branch names inside heredoc TEXT
rather than in the command being run. A lane writing a doc ABOUT `main` was
refused as though it were pushing to `main`.

`#637` — the design-lookup gate's standing no-size-reduction wall matched
limitation vocabulary anywhere. Measured taxes across the 2026-08-07/08
sessions: `git worktree prune` (a command `AGENTS.md` MANDATES at cleanup)
refused twice inside commit messages; an operator quotation being harvested
into `docs/lane-contract.md`; a defect report describing behavior that already
existed; `information_schema.constraint_column_usage`, a catalog table name; and
an `AskUserQuestion` presenting the operator's OWN recorded #563 options.

**The four operations a word list cannot tell apart.** In every case the word
is present and no violation is:

1. **Command syntax** — the word is a verb or a flag (`git worktree prune`,
   `LIMIT 20`, `--max-count=20`). Discriminator: parsed POSITION, not presence.
2. **Identifiers** — the word names something that exists (a catalog table, a
   JSON key, a response field, a file path). Naming a thing is not proposing it.
3. **Attributed speech** — the operator's own words, quoted back. Guarding his
   authority by refusing to repeat him inverts the rule.
4. **Reporting** — describing an existing defect in the indicative. The
   write-ups of the very incidents that justify a guard get refused by it.

**What to do instead.** Parse, then classify, in order of decreasing structural
certainty — structure first because it is decidable, prose last because it is
not. `.claude/hooks/lib/shell-command-parse.ts` (PR #629) is the shared
tokenizer; `.claude/hooks/lib/reduction-intent.ts` (#637) is the four-pass
classifier built on it. Both are shared modules rather than copies, because
`sme.duplicated_selection_lists_diverge` applies: a fix landing in one copy
leaves the other still taxing lanes.

**Two things that must not be relaxed while doing this.**

- **Fail closed.** Anything the classifier cannot decide is a violation. The
  asymmetry that justified the guard is unchanged — a false refusal costs one
  reword, a false pass costs the thing the guard exists to prevent.
- **Do not let the escape hatch become the bypass.** Quoted command arguments
  are NOT stripped, so prose smuggled into a commit message is still judged as
  prose. An UNATTRIBUTED quotation is NOT exempt, or quote marks become a
  one-character bypass of the whole guard.

**Prove it two-sided, red-first.** A precision fix needs BOTH corpora in one
check: every recorded false positive must pass, and every true positive must
still be refused. One side alone is trivially satisfiable — delete the guard,
or refuse everything. Assert that true positives were refused by the RIGHT
clause, too; otherwise a guard that refuses everything scores a perfect
true-positive run. `scripts/done-means/637-gate-precision.sh` is the model.

**Corollary for the fixtures.** A precision check's fixtures ARE, by
construction, the text that trips the guard. Hold them in DATA FILES, not
inline in the checker, or every agent that edits the checker is refused by the
guard it is repairing. The #637 lane was refused twelve times while fixing the
#637 guard — including on an `import` whose module PATH carried a trigger stem,
on a read-only `rg`, and on a file rename.
