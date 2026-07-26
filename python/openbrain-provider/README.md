# openbrain-provider

The runtime lifecycle provider for Open Brain: the process an agent runtime
invokes on session start, capture, checkpoint, and reflex.

It replaces the TypeScript adapter that currently ships as a content-addressed
`sha256-<hash>` directory under `~/.local/share/openbrain-memory/adapters/`.
That layout is being retired (#420): it pins by hash, so a fix requires either
a hand-patch of an immutable install or a full re-materialization, and the hook
entries that call it embed an absolute path containing the hash. This package
is a normal uv workspace member with a normal console script.

## Status

Skeleton only (#411). Configuration and logging exist; request parsing,
receipts, dispatch, reflex recall, observation export, and the hook entry
points land in #412–#419.

There is deliberately **no console script yet**. The `ob-memory-provider`
command arrives with `cli_provider.py` in PROV-9 (#418). Declaring the entry
point early does not fail loudly — it installs a working-looking executable
into `.venv/bin` that dies on `ModuleNotFoundError`, and no lint, type, or test
gate reads entry-point targets. `tests/test_packaging.py` now resolves every
declared script so that cannot ship green again.

## Layout

```
src/openbrain_provider/
  constants.py   every bound the provider enforces, named
  config.py      the only place environment is read
  logger.py      the only place log sinks are installed
```

Business logic arrives as small domain modules under the same package. The rule
is one file that does one thing: one place to change when that thing breaks.

## Design rules this package holds to

**Config fails closed at construction.** Every config object is a frozen
dataclass that validates in `__post_init__`. An invalid value raises at boot,
not at first use — a provider that starts broken and finds out mid-session has
already dropped the write it was configured to make.

**Environment is read in exactly one function.** `load_config()`. Everything
downstream takes a `ProviderConfig`, which is also what makes configuration
injectable in tests without touching real environment variables. The adapter
being replaced read `process.env` at scattered call sites; that is how a
variable ends up spelled two ways.

**Nothing is written to stdout.** These are agent hooks. stdout is the
machine-readable return channel, so a log line there is a corrupted response,
not stray output. Logs go to stderr and optionally a file, always
`serialize=True` (one JSON object per line, no regex re-parsing downstream).

**No inline magic numbers.** Every limit is a named constant in
`constants.py`. A limit you cannot find is a limit nobody can tune when it
starts rejecting real work.

## Gates

From `python/` (workspace root) or from this directory:

```bash
uv sync
uv run --package openbrain-provider ruff format --check src tests
uv run --package openbrain-provider ruff check src tests
uv run --package openbrain-provider mypy src/openbrain_provider
uv run --package openbrain-provider pytest tests -q
```

`mypy` runs `strict = true` and `ruff` includes `D` (pydocstyle, google
convention): module, class, and function docstrings are gate failures here, not
warnings.
