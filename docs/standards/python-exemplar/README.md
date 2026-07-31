# python-exemplar

The worked example for [`_DOCS/STANDARDS-python.md`](../STANDARDS-python.md).

Three small applications sharing one configuration module and one utility floor.
Every rule in the standard is implemented here by code that runs, so a rule can
be checked against working software instead of argued about.

**When this and the standard disagree, this is wrong and gets fixed.** An
example that violates its own standard teaches the exception.

---

## Status

| | |
|---|---|
| Applications | WRITTEN — see progress below |
| Hooks | WRITTEN. **Not RUNNING here** — see [Why the hooks are not installed](#why-the-hooks-are-not-installed) |
| Tests | WRITTEN |

This directory is **not a git repository**, deliberately. It lives inside the
Development tree, and a `.git/` here would make it a nested repo — Development
would stop tracking its contents and record a gitlink instead, so the exemplar
would vanish from the history that is supposed to carry it.

Everything else a repository has is present and real: `_githooks/`,
`.github/workflows/`, `.gitignore`, `CODEOWNERS`, `SECURITY.md`. Only `.git/`
is absent, because only `.git/` changes behaviour.

---

## Why three applications

A shared `utils/` and a shared `config.py` are trivially "correct" when exactly
one caller uses them. Any layout works when there is nothing to share with.

Three independent consumers is where the design is actually tested. If `utils/`
is the wrong shape, if config assumed one app's needs, or if a helper really
belonged to one app rather than the floor — three callers expose it immediately
and one never will. The reach-across import rule
(`STANDARDS-python.md` § *`utils/` is the shared floor*) cannot be demonstrated
with a single app, because there is nothing to reach across to.

Each app is real, runnable, and covers a different problem domain:

| App | Command | Demonstrates |
|---|---|---|
| **monitor** | `uv run python -m exemplar.apps.monitor --env test` | async HTTP, retry with backoff, periodic scheduler, graceful shutdown, JSON persistence, FastAPI surface |
| **watch** | `uv run python -m exemplar.apps.watch --env test` | filesystem polling, validation, batch transform, manifest output. No network — fully deterministic tests |
| **hook** | `uv run python -m exemplar.apps.hook --env test` | schema-validated payloads, dict dispatch, idempotency, downstream forwarding with retry |

They share, and none of them re-implements:

```
src/exemplar/
├── config.py     ONE settings object. Reads config, validates, sets up logging.
├── models/       Pydantic models used across apps.
└── utils/        logging_config, datetime_helpers, http, paths.
```

---

## Quick start

```bash
uv sync                                              # create venv, install deps
uv run python -m exemplar.apps.monitor --env test    # run one
uv run pytest                                        # tests
uv run mypy src/exemplar tests                       # types, strict
uv run ruff format . && uv run ruff check .          # format + lint
```

Every command goes through `uv run`. Never bare `python`, never
`source .venv/bin/activate` — see `STANDARDS-python.md` § *LAW: `uv run` for
everything* for why that is a law and not a preference.

---

## Why the hooks are not installed

`_githooks/` holds real, executable hooks. They are **WRITTEN, not RUNNING**
here, because there is no `.git/` in this directory for them to attach to.

That distinction is the entire point of the standard, so it is stated rather
than glossed. To prove they actually block:

```bash
./scripts/dev/demo-hooks.sh
```

That clones this tree into `/Volumes/ThunderBolt/_tmp/`, runs `git init` **there**,
installs the hooks with `_githooks/install.sh`, then injects each violation in
turn and asserts the hook rejects it. It reports pass/fail per check and leaves
nothing behind in Development.

A hook that has never been proven to fail is not enforcement. Three separate
mechanisms in the repos this standard was derived from looked like enforcement
and were not:

1. A global `core.hooksPath` shadowed the repo's own `.git/hooks/`, so tracked
   hooks never fired and no `commit-msg` existed at all.
2. `generate_folder_docs.py` returned 0 unconditionally, and no hook called it —
   despite three documents describing it as pre-commit enforced.
3. The pre-commit `mypy` check targeted `src/b1x_telegram_listener/`, a package
   that does not exist in that repo, and printed a green pass every run.

Receipts for 1 and 3: naive `datetime.now()` in committed code at
`threads.py:70` and `poster_service.py:90`, and a `config.py` of 1524 lines
against a documented 750-line limit.

---

## Layout

```
python-exemplar/
├── _githooks/              pre-commit, commit-msg, pre-push, post-merge, install.sh
├── .github/workflows/      CI running the same commands as the hooks
├── docs/                   ADRs — decisions and why they were made
├── scripts/dev/            demo-hooks.sh, generate_folder_docs.py
├── secrets/                gitignored EXCEPT *.example and README.md
├── src/exemplar/
│   ├── config.py           the keystone
│   ├── models/             Pydantic only, no logic
│   ├── utils/              the shared floor
│   └── apps/{monitor,watch,hook}/
└── tests/                  mirrors src/
```

`data/` and `logs/` are created at runtime and gitignored.

---

## Reading order

To learn the standard from the code, in this order:

1. **`pyproject.toml`** — the whole toolchain and why each rule family is on
2. **`src/exemplar/config.py`** — the keystone: sources, precedence, validation
3. **`src/exemplar/utils/logging_config.py`** — three sinks, and why all three
4. **`src/exemplar/apps/monitor/`** — the richest app; retry, scheduling, state
5. **`_githooks/pre-commit`** — what actually blocks a commit
6. **`tests/`** — including a test that proves it can fail

---

## See also

- [`_DOCS/STANDARDS-python.md`](../STANDARDS-python.md) — the standard this implements
- [`_DOCS/CODING_STANDARDS.md`](../CODING_STANDARDS.md) — cross-language rules
- `docs/adr/` — why specific choices were made
