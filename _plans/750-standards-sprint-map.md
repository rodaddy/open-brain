# Standards Sprint Map — #750

Status: WRITTEN, 2026-08-25. Not started.

The program behind #750. Handoffs slice ONE session out of this map; the map
is where the rest lives. Do not execute this file — execute the handoff that
cites it.

## The order is fixed and not negotiable

`_DOCS/CODING_STANDARDS.md:637-660`:

> Do not attempt a single sweeping "bring it up to standard" change. It
> produces an unreviewable diff, mixes mechanical reformatting with real
> behavioural fixes, and — the common failure — lands the rules before the
> mechanism that keeps them, so the repo drifts straight back.

Fixed order, each on its own branch and PR:
**1 enforcement → 2 formatter/linter → 3 type checking → 4 validated config →
5 documentation → 6 split oversized files.**

Splitting is LAST. The reason is mechanical: a lint rule that fires on 40
oversized files is a rule you will disable to get work done, unless the
enforcement that will hold you to it already exists and you accepted it
deliberately.

`_DOCS/STANDARDS-python.md:20-58` supplies the test every session applies:

> A rule is only as real as the mechanism that fires. LAW means a hook fails
> the commit. If no hook enforces it, it is not a law and must not be written
> as one.

By that test this repo currently has TWO laws: protected-branch and gitleaks.

## Template

`_DOCS/typescript-exemplar/` EXISTS and is complete — `.oxlintrc.json`,
`_githooks/` (5 hooks, 205-line pre-commit), CI, and `tests/enforcement.test.ts`
which proves each size rule fires against a real fixture. Steps 1-2 COPY from
it; they do not design.

(`STANDARDS-typescript.md:9` and `:619` both claim the exemplar does not
exist. Those lines are stale — correction filed as rodaddy/development#340.)

## Measured baseline (read-only audit 2026-08-25)

| Standard | Source | State |
|---|---|---|
| pre-commit checks | CODING:645 | branch + gitleaks ONLY |
| oxlint config | TS:192 | MISSING |
| prettier config | exemplar | MISSING |
| `erasableSyntaxOnly` | TS:45-53 | MISSING |
| `namespace` declarations | TS:55-59 | 20 |
| Files > 500 lines | CODING:274-279 | 40 of 244 (10 over 1,000) |
| `process.env` readers | TS:241-249 | 30 files |
| explicit `any` | TS:90-95 | 38 |
| `console.*` | TS:230 | 13 |
| CI `permissions:` | CODING:695 | 2 of 3 workflows |
| Actions by mutable tag | CODING:697 | 10 |

Re-measure with `scripts/standards-audit.sh` rather than trusting this table.

## Session 1 — DONE (2026-08-25)

`9ce687f` map + layer 0.1 + audit · `b2d4252` hook + config + CI + scripts ·
`d3df0fd` 17 enforcement tests, 0 fail. The hook rejects a violating STAGED
file by rule name, and blocked its own author's commit on a prettier
violation.

Numeric values as landed, sitting exactly at the tree's worst case with no
slack (head-verified: tightening any by one makes it report):

| rule | exemplar | landed | worst in tree |
|---|---|---|---|
| max-lines | 500 | 1849 | 1849 |
| max-lines-per-function | 50 | 535 | 535 |
| complexity | 10 | 129 | 129 |
| max-params | 4 | 11 | 11 |
| max-depth | 3 | 5 | 5 |

The ratchet session lowers these toward the exemplar column one notch at a
time. `tests/enforcement.test.ts` reads them live from
`bunx oxlint --print-config`, so it keeps proving the mechanism without edits
as they move.

## Sessions

Each is ONE handoff. Sized to finish under ~200k context with the head
orchestrating ≤15-minute workers (HANDOFF-BASE §2, §9). A session that ends
early writes the next handoff; a session that compacts was cut wrong.

| # | Session | Ends when |
|---|---|---|
| 1 | **Enforcement floor.** Port the exemplar pre-commit's staged-index checkout and fail-closed posture. Wire `tests/enforcement.test.ts`. CI runs the same commands. | A deliberately non-compliant commit is REJECTED by the named check, and CI repeats it. |
| 2 | **Mechanical reformat.** Run prettier across the tree, one commit, no logic. | `format:check` green; behavior unchanged; diff is whitespace by inspection. |
| 3 | **Source lint debt** (#752). 71 source violations across 7 rules, per-rule lanes. | `oxlint` reports 0 in source, or each remainder carries a reasoned per-line disable. |
| 4 | **Ratchet the ceilings.** Lower file/function/param/depth limits one notch; fix what breaks. Repeat as its own session per notch. | Ceilings at standard values or a documented remaining gap with a count. |
| 5 | **Type checking.** `erasableSyntaxOnly`; convert 20 `namespace` declarations; narrow `any` per-module. | `tsc --noEmit` green with the flag on; zero `namespace`. |
| 6 | **Validated config.** One module, schema-validated at boot, exits on invalid input. Retires 30 scattered `process.env` readers. | Boot with a deliberately invalid env EXITS non-zero with a named field. |
| 7 | **CI hardening.** `permissions:` on all 3 workflows; pin 10 tag-pinned actions by SHA. | Audit shows 3 of 3 and 0 by tag. |
| 8 | **Documentation.** TSDoc on public surfaces; `docs:check` in the hook. | `docs:check` green and blocking. |
| 9+ | **Structure.** Cut the circular edge, then rewrite each concern natively in `server/` and drop its `src/` import: types → logging → embedding → maintenance queue → NATS → REST → contract → source registry → tools. ONE CONCERN PER SESSION. | No `from "../src/..."` in `server/`; no `from "../server/..."` in `src/`. |

Sessions 1-8 are enforcement and mechanical. Session 9+ is the rewrite, and
it is the long part — one concern per session, not one session.

## Separate lanes, not in this map

- **#751** bun → Node 24 LTS. Runtime, test runner, lockfile, every launcher.
  `STANDARDS-typescript.md:80` — existing bun code flips when its own repo's
  migration lane lands. Sequencing against this map is deliberate: steps 1-2
  are runtime-independent, so either can land first. They must not land
  together.
- **#748** 62 catch sites with no log and no re-raise.
- **#463** the server-rewrite charter, which sessions 9+ execute against.

## Not in scope

core01 (operator ruling 2026-08-25).
