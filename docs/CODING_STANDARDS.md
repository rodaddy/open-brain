# Open Brain — Coding Standards

**These are enforced at commit time, not remembered.** If a hook fails, a
standard was violated. Fix the code, not the hook.

Repo-local and authoritative for this repo. Development-wide policy lives in
`/path/to/open-brain/Development/_DOCS/CODING_STANDARDS.md`; where this file is
stricter or more specific, this file wins.

---

## Why this file exists

Measured in this repo on 2026-07-30, before the rebuild:

| what | count |
|---|---|
| independent content-bound definitions (`MAX_*_BYTES/CHARS/LEN`) | 36 across 25+ files |
| files hand-writing the same hash → embed → INSERT sequence | 18 |
| layers implementing the same 64 KB admission rule, 3 different behaviours | 4 |
| shared entry-write abstraction | 0 |
| named typed contracts — Python | 10 |
| named typed contracts — TypeScript | 0 |

A 101 KB `capture` through the documented provider path returned **no receipt
and exit code 0**. The write vanished. Not because any single line was wrong,
but because the same rule existed in four places and fixing one reached none of
the others.

Every rule below exists to prevent a specific failure that already happened
here.

---

## 1. Reuse, never re-implement

**A second implementation of an existing rule is a defect on sight — even when
it is correct today.** The next fix will reach one copy and not the others.

- Before writing a function, search for it: `aqmd search "<word>"` (~0.1s),
  then `rg`. `grep`/`find` are denied in this repo; use `rg`, `fd`, `sg`, `sd`,
  `mdfind`.
- If a rule needs to hold in more than one place, it gets **one definition**
  that the other places import. Not a copied constant. Not a re-typed check.
- Shared behaviour lives in `core/`. Anything imported by three or more modules
  belongs there.

---

## 2. Self-documenting packages

Every package directory carries an `__init__.py` with a full module docstring,
and a `README.md` **generated from it**. The docstring is the source; the README
is a build artifact. **Never hand-edit a generated README.**

This is not decoration. These docstrings are indexed into qmd and are the
retrieval surface for the whole repo — an undocumented package is a hole in
search, and what lives inside it cannot be found by anyone who does not already
know it is there.

```python
"""
[Package Name] - [one-line purpose]

[2-4 paragraphs: HOW this works architecturally]

Key Components:
    - Component: what it does and why it exists

Pattern/Convention:
    [how to use it; how to extend it]

Example:
    >>> from openbrain.thing import Thing
    >>> Thing(settings).run()

See Also:
    - related package
"""
```

- **The generator BLOCKS the commit.** Missing docstring, too-short docstring,
  or one lacking the required sections → the commit fails. It does not warn,
  skip, or exit 0. A generator that prints "skipped" and passes leaves exactly
  the undocumented package this rule exists to prevent.
- The docstring is written **before** the module it describes.
- Docstring and generated README are committed together, so they cannot drift.

---

## 3. Typing

- Python: `disallow_untyped_defs = true`. Every parameter and return typed.
  `str | None`, never `Optional[str]`. `from __future__ import annotations` at
  the top of every module.
- **Pydantic** owns config and models — one validated, typed object, not a dict
  passed around.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, **`noUnusedLocals` and `noUnusedParameters` on**. A
  dead variable in `distiller.ts` on 2026-07-30 only surfaced as a hard compile
  error; with these off it would have shipped.
- **Zod** is the TypeScript counterpart to Pydantic: the schema is the type
  (`z.infer`), declared once.
- No blanket `ignore_missing_imports`. Narrowest per-module exception, with a
  written reason.

---

## 4. Observability

Structured logging via **Loguru**, established once at application start and
inherited — never re-imported ad hoc per file.

Log at **five points**:

| point | level |
|---|---|
| entry | debug |
| exit / result | info |
| failure | error |
| fallback / degraded path | warning |
| guard triggered | warning |

- **Silence is never proof of success.** A successful operation emits its
  exit log; every degraded path emits a warning or error.
- `serialize=True` for machine-read output, `enqueue=True` so writes never
  block the caller, `contextualize()` to carry a correlation id across `await`
  boundaries.
- `message` is a **stable event name**, not a sentence — it is what Loki filters
  on. `logger.info("entry_chunk_write_finished", ...)`, not `logger.info("Wrote
  the chunks for entry " + id)`.
- **Never spread a raw error into a log entry.** A thrown object carries
  `err.request`, `err.config`, `err.client` with credentials attached. Fields
  are allowlisted **by name**, never enumerated.
- Never log secrets, tokens, auth payloads, or private user content.

---

## 5. Error handling

- `try/except/finally` around every external call, file operation, and hook
  invocation.
- **Never bare `except:`. Never `except ...: pass`.** A bound-but-unlogged
  handler is the same violation as an empty one — linting for empty blocks
  alone is insufficient.
- Every intentional fail-open is a **documented decision in the code**, not an
  accident.
- Retries: bounded attempts, log each failure with its attempt count, re-raise
  on exhaustion. Never unbounded, never silent.
- **Reject vs. degrade:** a size or validity check that raises loses 100% of
  the write, not the overflow. That is the recurring defect shape in this repo.
  Prefer a path that stores what it can and reports what it could not.
- A log sink cannot report its own failure through itself. `stderr` is the only
  non-recursive channel.

---

## 6. Recall means total recall

**Never truncate, cap, cut, or shorten anything on an Open Brain read or write
path.** Database size is the operator's decision alone.

- Long content is **split and embedded**, never refused or clipped. `chunking`
  exists so embeddings work; the full text stays whole on the parent row.
- Everything is vectorized: a long entry lands as a parent row holding the
  complete text with its own whole-text vector, plus chunk rows each carrying
  their own vector and a `parent_id`/`chunk_index` link.
- A bound that is genuinely structural — a pipe read size, a datatype maximum,
  a third-party API limit — is named once, documented with **what it is and
  whose it is**, and never applied silently.
- Enforced by `.claude/hooks/design-lookup-gate.ts`. A denial means adjust, not
  retry with different wording.

---

## 7. Structure

```
python/openbrain/
  core/           shared libraries — anything used by 3+ modules
  config/         Pydantic settings; the ONLY place a setting is defined
  observability/  Loguru init, correlation ids
  models/         Pydantic models — the types everything speaks in
  storage/        DB access; the ONE entry-write path
  embedding/      embed + segment
  capture/        realtime — what an agent says as it happens
  ingestion/      external sources — files, transcripts, backfills
  distillation/   turns → candidates
  dream/          light/ rem/ deep/ — each its own submodule
  recall/         search, context packs
  api/            mcp/ rest/ grading/
  cli/            thin entry points only
```

- Language is the outer boundary (separate toolchains); capability is the inner
  one.
- Small targeted modules. ~600 lines triggers a split review, 750 is a hard
  warning.
- Guard clauses and early returns over nesting. **Dispatch maps over long
  `if/elif` chains** — an unknown key is logged and raises explicitly.
- Relative imports for siblings, absolute across packages, never
  parent-relative (`from ..x import y`).
- Script entry points stay thin; logic lives in importable, testable functions.

---

## 8. Testing

- **Functional tests only**: varied inputs and their outputs at the public
  boundary. Never assert SQL shape or line coverage. Black-box the tool.
- A test that passes without the fix proves nothing. **Verify it fails when the
  change is stashed.**
- Postgres tests run against a real database. `OPENBRAIN_TEST_DATABASE_URL`
  unset means they **skip silently** — a green run may have tested nothing. Set
  it whenever a result is being used as evidence.
- When behaviour changes, **invert the old test** rather than deleting it, so
  the new guarantee is asserted where the old one was.

---

## 9. Commit-time enforcement

The pre-commit hook is where the teeth are. Each of these **blocks the commit**:

- `ruff format` (auto-format and re-stage) and `ruff check` — **not black**.
- `mypy` over the package path. **Verify the path in the hook matches the real
  package** — a hook adapted from another repo can typecheck a directory that
  does not exist and pass silently forever.
- The package-docs generator, in blocking mode.
- Bare `except:` / `except ...: pass`.
- Debug leftovers: `pdb`, `ipdb`, `set_trace`, stray `print()` in library code.
- Naive `datetime.now()` without a timezone.
- Hardcoded URLs and credential-shaped literals.
- Dependency manifest in sync with the project file.

Tests run at commit time too where they are fast enough to; the gate is
correctness, not ceremony.

---

## 10. Claims

Every claim about the system is one of: **RUNNING** (checked live this
session), **MERGED** (in main, unproven), **WRITTEN** (a file on disk), or
**PROPOSED** (somebody said it).

A claim inherits the weakest state in its chain. Never say done, complete,
fixed, working, or verified for anything below RUNNING — say "written, not
deployed" / "merged, unverified" / "proposed". State a verified fact plainly;
just never state a weaker kind of true as a stronger one.

---

**See Also:**
- `AGENTS.md` — the repo router; stack, hosts, commands, review gates
- `CLAUDE.md` — Claude-specific deltas
- `_plans/consolidation-2026-07-30.md` — the measured case for the rebuild
- `docs/dream-design.md` — Light/REM/Deep subsystem design
