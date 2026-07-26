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
  constants.py       bounds the provider enforces, each verified against
                     the adapter it replaces and cited by line
  config.py          the only place environment is read
  observability.py   thin adapter over rtech-obs; hook-specific policy only
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

**Logging is `rtech-obs`, not a local logger.**
`rtech-standards/OBSERVABILITY_CONTRACT.md` is normative — *"if an
implementation and this document disagree, this document wins and the
implementation is a bug"* — and it ships `rtech-obs` so nine repos do not each
grow their own logger. An earlier revision of this package grew one anyway; it
emitted loguru's internal `{"text":…, "record":{…}}` shape, which has none of
the five required top-level fields, an uppercase level, and no `host`. Every
contract Loki query missed it. `observability.py` now holds only the policy
`rtech-obs` cannot know.

**Nothing is written to stdout.** These are agent hooks: stdout is the
machine-readable return channel, so a log line there is a corrupted response,
not stray output. Two mechanisms are needed, not one. `stdout=False` handles the
normal path; but contract §5.1 also requires that an unwritable `LOG_FILE` not
be fatal, and `rtech-obs` honors that by adding a stdout sink — overriding
`stdout=False`. So `resolve_log_file()` guarantees a writable path (contract
location first, temp dir second) and that fallback never fires.

**No inline magic numbers.** Every limit is a named constant in
`constants.py`. A limit you cannot find is a limit nobody can tune when it
starts rejecting real work.

**A constant is declared when it is enforced, and cited by line.** The first
revision declared twelve constants — ten unused — and described them all as
carried over from the TypeScript adapter. None matched: `MAX_INPUT_BYTES` was
15× the adapter's value, the context-pack ceiling 5×, and one silently changed
unit from bytes to characters. A false provenance comment is worse than none,
because the next reader trusts it instead of checking. Bounds that make the two
runtimes disagree about whether the same request is valid are precisely the
drift this port exists to remove.

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
