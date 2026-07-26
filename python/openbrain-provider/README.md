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
  observability.py   the only place log sinks are installed
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

**Logging writes the shared envelope, without the shared package.**
`rtech-standards` ships `rtech-obs` as the reference implementation of
`OBSERVABILITY_CONTRACT.md`, and it would be the right dependency — but that
repo is **private** and this repo's CI passes no token, so no git URL can fetch
it. SSH fails host-key verification; HTTPS fails with `could not read
Username`. Both were tried, and the new `python-provider` CI job is what caught
the second one.

So `observability.py` writes the envelope directly: `timestamp`, `level`,
`service`, `host`, `message` at the top level, everything else under `context`.
The cost is real and worth naming — this is a second implementation of a shared
envelope, which is the drift the contract exists to prevent. It is mitigated by
being small, by using the contract's field names rather than a convenient
approximation, and by tests that assert conformance directly rather than
asserting whatever the code happens to emit. Swap in `rtech-obs` once it is
installable here; the public surface is shaped for a drop-in replacement.

**Nothing is written to stdout.** These are agent hooks: stdout is the
machine-readable return channel, so a log line there is a corrupted response,
not stray output. No sink in this module targets stdout, and §5.1's rule that an
unwritable `LOG_FILE` must not be fatal is honored by falling back to **stderr**
— the distinction that matters, since the obvious fallback is the one that
breaks the caller.

`resolve_log_file()` probes for a writable path — the contract location
`/mnt/logs/services/` if it exists (it is **not provisioned yet**), a temp
directory otherwise — and an operator-supplied path is probed too. An earlier
revision honored an explicit path unchecked; an unwritable one then fell
through to stdout and silently corrupted the hook's response. If no path works
at all, the fallback sink is **stderr**, never stdout.

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
