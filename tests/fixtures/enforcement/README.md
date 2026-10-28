# Enforcement fixtures

Deliberately non-compliant (and matching compliant) snippets fed to `oxlint` by
`tests/enforcement.test.ts` to prove each ceiling in `.oxlintrc.json` actually
fires.

**These files are broken on purpose.** They carry a `.ts.txt` suffix rather than
`.ts` so a normal `oxlint`/`tsc` run over the repo never picks them up as
source — a fixture that fails the repo's own lint is a fixture someone will
"fix", which quietly disarms the test that depends on it.

## Why only the *compliant* shapes are checked in

The rejected shapes are **generated** by the test, not stored here. The repo's
`.oxlintrc.json` is a ratchet whose ceilings start at what open-brain's existing
source already does and get tightened over time, so a stored "too many
parameters" file sized against a fixed number would quietly stop violating
anything the moment a ceiling moved — passing while proving nothing. The test
reads the live ceiling via `oxlint --print-config` and generates a fixture one
step past it.

The compliant shapes below are stable at any ceiling, so they stay on disk where
a human can read them:

- `options-object.ts.txt` — the rewrite `max-params` exists to produce.
- `guard-clauses.ts.txt` — the rewrite `max-depth` exists to produce.
- `swallowed-catch.ts.txt` — the one rejected shape that is not size-based, so
  no ceiling can drift out from under it.
