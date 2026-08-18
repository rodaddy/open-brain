---
lane: gotcha-agent
order: 74
---
## [2026-08-09] A gate that judges from a tree other than the one being merged makes a false receipt the cheapest escape

**Severity:** HIGH
**Source:** Issues #705 and #706, fixed as one lane (PR for `lane/fix-gates-705-706`); a third instance found live during that lane's own push
**Scope:** any gate, hook, or check whose verdict depends on a base ref, a working tree, or a checkout it did not derive from the change under review
**Status:** active

### Pattern

A gate's job is to judge THIS change. The moment its base ref or its tree is
resolved from something other than the change — a hardcoded branch, the file's
own directory, an absolute `core.hooksPath` — the gate is answering a question
about a different artifact and reporting it as a verdict about this one.

Three instances, same family, all live in this repo:

1. **#706** — `scripts/validate-pr-body.ts` resolved the `Done-means` path
   against `resolve(import.meta.dir, "..")`, and `.claude/hooks/pr-body-gate.ts`
   spawns it from `$CLAUDE_PROJECT_DIR` (the primary checkout, on the base
   branch). A lane's done-means check is a NEW file on the lane branch, so every
   PR that introduced its own check was structurally refused.
2. **#705** — `_githooks/pre-push` hardcoded `origin/main`. Lanes branch from a
   wip branch 80 commits ahead, so every lane inherited that span's Python
   changes and ran a package gate on a zero-Python diff.
3. **Found during the fix** — `core.hooksPath` is an ABSOLUTE path to the
   primary checkout, so every lane worktree runs the primary's hooks, not its
   own. A lane fixing a hook structurally cannot exercise its own fix on push.

### Why it is worse than an ordinary false positive

Each of these had a legitimate-looking escape that was a lie: name a different,
pre-existing check that never judged this lane (#706); answer "not mine" to a
failure the push did not cause (#705). Both are false receipts, and a gate whose
cheapest escape is a false receipt trains that reflex — which is how a forced
gate decays into noise routed around with `--no-verify`.

### Review checks

- For every gate, ask: **which tree answered, and which ref did it compare
  against?** If the answer is not derived from the change under review, that is
  the defect — not the refusal it produced.
- `import.meta.dir`, `$CLAUDE_PROJECT_DIR`, `core.hooksPath`, and a hardcoded
  `origin/main` are the four spellings seen so far. Grep for them in anything
  that gates.
- The base/tree a gate chose must be ANNOUNCED in its normal output
  (`nothing is adjusted silently`). A verdict whose basis is invisible can only
  be reverse-engineered from a failure, and #705 sat undiagnosed that way.
- Widening WHERE a path may resolve must not widen WHAT may be named: keep the
  containment guard (no absolute paths, no `..` escapes) applied per candidate
  tree, and keep refusing a path that resolves nowhere.

### The check-design lesson that came with it

`@{upstream}` is a property of a BRANCH NAME. A pre-push hook receives a raw
SHA and a FULL ref; both `<sha>@{upstream}` and `refs/heads/x@{upstream}` fail —
the second as a hard "fatal: no such branch" — and both failures look identical
to "no upstream configured", so both fall through to the fallback silently.

Clauses (a)-(e) of this lane's own done-means check all PASSED against that
broken version, because every one of them exercised an `--explain` seam that
resolves from the symbolic `HEAD`. **A seam added to make a gate testable is not
the path that runs in production.** When a check drives a convenience entry
point, at least one clause must drive the real invocation shape — for a pre-push
hook, a genuine stdin range with a zero remote SHA.
