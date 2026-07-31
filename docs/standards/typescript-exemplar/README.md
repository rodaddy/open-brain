# TypeScript Exemplar

A worked example of `_DOCS/STANDARDS-typescript.md`. Four small apps sharing one
floor of utilities, config, models, and storage.

This is the TypeScript twin of `_DOCS/python-exemplar/`. The two are deliberately
the same shape, with the same thresholds and the same enforcement posture. Where
they differ, the difference is a property of the language and is explained in a
comment at the point of difference — not left for a reader to guess at.

> **State of this tree (2026-07-30):** every command below was RUN and its output
> observed while writing this file. Nothing here is described as working on the
> strength of having been written. Where a claim is weaker than "I watched this
> pass", it says so.

---

## What is in here

    src/exemplar/
      config.ts              the keystone: one module reads configuration
      models/check.ts        Zod schemas -- runtime validation AND static types
      utils/
        logging.ts           pino + AsyncLocalStorage correlation ids
        datetime.ts          the sanctioned replacements for ad-hoc Date
        http.ts              fetch + retry + timeout
      db/database.ts         node:sqlite, WAL, prepared statements
      apps/
        monitor/             a service: poll targets, decide, store, serve
        watch/               an event loop: fs.watch, debounced
        hook/                untrusted input: HMAC, constant-time, size-limited
        stats/               a CLI: aggregate what the monitor recorded

    tests/                   61 tests, including the ones that test the linter
    _githooks/               5 hooks + an installer that refuses to no-op
    scripts/dev/             demo-hooks.sh, generate-folder-docs.ts
    .github/workflows/ci.yml the same checks, where nobody can --no-verify them

---

## Quick start

    npm install
    npm run check          # lint + typecheck + test
    ./_githooks/install.sh # install the hooks into .git/hooks

Run an app:

    npm run monitor        # :7150
    npm run watch          # :7151
    npm run hook           # :7152
    npm run stats -- 24    # last 24h report, stdout

Ports come from one base (`715`) so the four cannot collide, and land inside the
`7100-7199` band AGENTS.md reserves for local dev servers.

---

## The enforcement, and how to check it yourself

Everything in this section was observed running. The commands are here so you do
not have to take that on faith.

### The linter

`npm run lint` runs **oxlint**, configured in `.oxlintrc.json`. Four control-flow
rules carry the same numbers as the Python side:

| Rule                                  | Limit | ruff equivalent |
| ------------------------------------- | ----- | --------------- |
| `complexity`                          | 10    | `C901`          |
| `max-depth`                           | 3     | `PLR1702`       |
| `no-else-return`                      | —     | `RET505`        |
| `no-empty` (`allowEmptyCatch: false`) | —     | `B012` / `E722` |

**Cyclomatic complexity** is decision points + 1: each `if`, `else if`, `case`,
loop, `catch`, `&&`, `||`, `??`, ternary, and `?.` adds one. A straight-line
function scores 1. Ten is McCabe's 1976 threshold.

The argument for it is not aesthetic. Complexity _N_ means _N_ independent paths,
so full branch coverage needs _N_ test cases — and nobody writes eleven test
cases for one function, so above the ceiling the uncovered paths are exactly
where the bugs live, invisible because the file has tests.

Its limit, stated honestly: it counts **branching**, not **size**. A 400-line
function that branches three times scores 4 and passes. It is a floor against
tangled control flow, not a ceiling on sprawl. `max-depth` sits next to it
because a function can score 8 (passing) while nested five levels deep (failing);
you need both or one leaks.

**This linter caught two functions in this very repo** while it was being wired
up — `requestWithRetry` at 12 and the hook request handler at 11. Both were
split, which is the fix the rule is designed to force. That is in the git history
rather than hidden.

### Why oxlint and not ESLint

The repo set pins `typescript ^7.0.2`. `typescript-eslint` 8.65.0 declares
`typescript: >=4.8.4 <6.1.0` and does not warn — it **throws on load**
(typescript-eslint#10940). Five workarounds were tried and all failed: the rules
package, the parser alone, a side-by-side TS 6.0.0-beta, TS 5.9.3 via nested
symlink, and npm-style `overrides`.

oxlint has no `typescript` peer dependency and its optional companion targets
`>=7.0.2001`, i.e. it is ahead of TS 7 rather than behind it.

**ESLint should be added back alongside oxlint once typescript-eslint supports
TS 7.** Running both is normal and is wanted here. What ESLint adds back is the
_type-aware_ rules oxlint cannot do without a type checker — chiefly
`no-floating-promises` and `no-misused-promises`. It is not here today only
because it cannot load, and a `lint` script that always throws teaches people to
ignore the linter.

### The tests that test the linter

    npm test

`tests/enforcement.test.ts` feeds oxlint and `tsc` snippets that **must** be
rejected and asserts the specific rule fires. This exists because a configured
rule is not an enforced rule: on the Python side, ruff silently **skipped**
`PLR1702` without `preview = true`, so the config looked right and enforced
nothing.

Proven by sabotage, not by assertion — with `complexity` and `max-depth` raised
to 99, the suite reports:

    ✖ a function past the ceiling is rejected
    ✖ four levels of nesting is rejected
    ℹ pass 9
    ℹ fail 2

and restoring them returns it to 61/61.

### The hooks

    ./scripts/dev/demo-hooks.sh

Copies this tree into the temp workspace, `git init`s it, installs the hooks, and
then commits **one deliberate violation per check**, asserting each is rejected
_by the named hook_ — an assertion that merely checks "the commit failed" is
satisfied by any unrelated global hook, which is how five false passes got
recorded on the Python side before the marker check was added.

Observed output, 2026-07-30:

    17 passed, 0 failed

covering: naive `Date`, nesting past `max-depth`, an empty `catch`, an
`any`-typed catch, a stray `console.log`, a bare `TODO`, a type error, **a clean
file being allowed**, four commit-message rejections, one commit-message
acceptance, and `install.sh` refusing to install underneath a shadowing
`core.hooksPath`.

That last one matters: `git config core.hooksPath` overrides `.git/hooks`
entirely, so an installer that copies files in regardless installs _nothing_,
reports success, and every commit passes while looking enforced.

### Two real defects the demo found

Both were found by running it, not by reading it:

1. **Prettier hard-skips any path containing a `.git/` segment**, and no flag
   turns that off. With the staged checkout living in `.git/pre-commit-staged`,
   prettier matched nothing, printed "No matching files", and exited 2 — so
   **every clean commit was blocked by a check that had examined zero files**.
   Verified directly: the identical file passes at a path without `.git/` in it.
   The staged checkout now lives in the temp workspace.

2. The commit-msg failures that followed were downstream of #1 — pre-commit
   blocked first, so commit-msg never ran, and its five tests reported failures
   that had nothing to do with commit messages.

### The docblock check

    npm run docs:check

Every module needs a real file-header docblock. A **placeholder counts as
missing**: an opening like "Module for handling things." restates the filename
and carries no information. Currently: `all 20 modules have a real file-header
docblock`, and the checker was confirmed to exit 1 on both a missing docblock and
a placeholder one before that was believed.

---

## Where the language genuinely differs from the Python twin

These are the deliberate divergences. Everything else is the same on purpose.

**Timezones fail quietly here, loudly there.** Python's `datetime.now()` returns
a _naive_ datetime that throws on first comparison with an aware one. JavaScript's
`new Date()` is always an absolute instant, so nothing ever throws — but every
method that _reads_ it applies the host's timezone. The JS failure is a wrong
answer, not a crash: the same code prints different things on a laptop in New
York and a container in UTC, and both look right. `utils/datetime.ts` is the
response, and the pre-commit hook greps for bare `new Date()`.

**Exhaustiveness is a compile-time guarantee.** `evaluator.describe()` uses a
`switch` with a `never` default, so adding a member to `CheckStatus` makes _that
function_ fail to compile and names the unhandled case. Python's `match` cannot
do this; an `if`/`elif` chain fails silently at runtime.

**Retry is stdlib, not a library.** Python uses `tenacity`. Here,
`AbortSignal.timeout` plus a small loop is the stdlib tier of the same LAW —
a hand-rolled `Promise.race` would leak the losing promise and never cancel the
socket, which is the actual reason not to write one.

**`node:sqlite`, not `better-sqlite3`.** `DatabaseSync` has been stdlib since
Node 22. `better-sqlite3` needs node-gyp, which fails to build on Node 26.

**Zod does double duty.** One `z.object` declaration gives runtime validation of
untrusted input _and_ the static type via `z.infer`. The Python side needs
Pydantic for the same job; the point is identical — parse at the boundary, and
below it the type is a fact rather than a hope.

---

## What this tree does NOT prove

Stated so nobody infers more than was checked:

- **CI has never run.** `.github/workflows/ci.yml` is WRITTEN, not RUNNING. This
  directory is not a git repository of its own and has no remote. The workflow
  runs the same commands that were verified locally, and the demo script is
  invoked through `bash` explicitly because its `/usr/bin/env bash` shebang
  resolves to a 5.x bash on a runner but the scripts were only ever executed on
  macOS with Homebrew bash.
- **The apps have not been run against a real target.** `monitor` has never
  polled a live URL, `hook` has never received a real webhook, and `watch` has
  never reacted to a real editor save. The logic is unit-tested; the wiring is
  not integration-tested.
- **`npm ci` has not been run**, because there is no `package-lock.json` in this
  tree yet. CI's `npm ci` step will fail until one is committed.
- **oxlint's rule set is smaller than ESLint's.** The type-aware rules are
  genuinely absent, not merely renamed. `no-floating-promises` in particular is
  a real gap: an unawaited promise will not be caught here today.

---

## See also

- `_DOCS/STANDARDS-typescript.md` — the standard this demonstrates
- `_DOCS/python-exemplar/` — the twin; divergence in _posture_ is a bug
- `_DOCS/CODING_STANDARDS.md` — the repo-set rules both inherit
- `.oxlintrc.json` — the linter config, with the reasoning in comments
