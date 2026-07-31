# Python Standards

How Python applications in this repo set are structured, configured, logged,
typed, documented, and enforced.

A worked example implementing every rule here lives at
`_DOCS/python-exemplar/`. It is a real, runnable URL health monitor kept
deliberately small. When this document and the exemplar disagree, the exemplar
is wrong and should be fixed — a standard whose example does not follow it
teaches the exception, not the rule.

**Status of this document: WRITTEN.** The rules below are derived from two
production repos (`WorkStuff/b1x-telegram-admin`, `WorkStuff/b1x-message-coordinator`)
and from decisions Rico stated on 2026-07-30. Those repos are the *reference*,
not the gold standard — several rules here are deliberately stricter than what
either of them does today, and the differences are called out where they matter.

---

## The one idea behind all of it

**A rule is only as real as the mechanism that fires.**

This is not a slogan. It is the single most expensive lesson available from the
reference repos, and it was measured, not guessed:

`b1x-message-coordinator` tracks its git hooks in `scripts/git-hooks/`, installs
them into `.git/hooks/` byte-identically, and documents them as enforcement. A
global `core.hooksPath` pointing at `~/.config/git/hooks` silently shadows all
of them. Git consults `hooksPath` *instead of* `.git/hooks/` when it is set, so
none of those repo hooks have ever run, and the global directory contains no
`commit-msg` at all — meaning the JIRA-ticket rule the repo documents as
mandatory is not enforced anywhere.

The receipts are in the committed source:

- Naive `datetime.now()` at `router/routers/threads.py:70` and
  `integrations/slack/poster_service.py:90`, against a rule the repo's own
  `pre-commit` is written to block outright.
- `config.py` at 1524 lines, against a documented 750-line limit.

Nobody was careless. The hooks were written, tracked, installed, and
documented. They just never fired, and nothing said so. Tracked-but-shadowed
enforcement is worse than no enforcement, because it produces confidence
without producing checks.

So, throughout this document:

- **LAW** means a hook fails the commit. If no hook enforces it, it is not a law
  and must not be written as one.
- **Principle** means judgment, applied in review.

Do not inflate a principle into a law for emphasis. `b1x-telegram-admin` has a
`CONSTITUTIONAL_LAWS.md` declaring its contents "IMMUTABLE", "UNIVERSAL", and
"PERMANENT", containing exactly one law; its `CLAUDE.md` numbers a *different*
rule as LAW #3; and its descendant's hooks enforce LAWs #8, #9, and #10 that
appear in neither file. Three documents, three numbering schemes, no agreement.
The word stopped meaning anything.

---

## Toolchain

Fixed. These are not per-project choices.

| Concern | Tool | Not |
|---|---|---|
| Python version | **3.13 minimum** | anything older |
| Interpreter + deps | `uv` | pip, pip3, conda, pipx, poetry |
| Format + lint | `ruff` | black, flake8, isort, pylint |
| Types | `mypy` (strict) | pyright, no types, blanket `ignore_missing_imports` |
| Data + config | `pydantic` v2 | bare `@dataclass`, dicts, `configparser` |
| Logging | `loguru` | `logging`, `print` |
| Tests | `pytest` + `pytest-asyncio` | unittest |

Declare the floor in all three places so they cannot disagree:
`requires-python = ">=3.13"`, ruff `target-version = "py313"`, mypy
`python_version = "3.13"`. Raise repos that declare an older floor when you
touch them.

**`ruff` replaces black and the linters both.** `ruff format` is a
black-compatible formatter and `ruff check` covers what flake8/isort/pylint did,
in one tool and one config block. The reference repos run `black` plus separate
linters; that is the older arrangement and should not be copied into new work.

Commit `uv.lock` for applications and use locked/frozen installs in CI.

### LAW: `uv run` for everything

```bash
uv run python -m exemplar --env test
uv run pytest
uv run mypy src/
uv run ruff format .
uv run ruff check --fix .
```

Never `source .venv/bin/activate`. And be precise about which interpreter is
banned, because the blanket version of this rule is wrong in this repo set and
gets ignored for being wrong:

- **`/usr/bin/python3` is Apple's, not ours. Never use it.** It is frozen at an
  old version by licensing and silently lacks what modern code assumes.
- **Bare `python3` is the right interpreter in the wrong environment.** Here
  `python3` resolves to the uv-managed shim (`~/.local/bin/python3`, 3.13), so
  the interpreter is correct — but it lands in uv's bare site-packages with no
  project dependencies. The first import fails, and it reads as a broken machine
  rather than a wrong command. Use `uv run` inside a project, or `claudePy`,
  which prefers `$PWD/.venv/bin/python`.

Enforced in `~/.claude/settings.json`: `/usr/bin/python3`, `/usr/bin/python`,
`pip`, and `pip3` are in `permissions.deny`; `uv` and `claudePy` are allowed;
bare `python3` is unlisted, so it prompts rather than running silently.

---

## LAW: do not hand-roll a solved problem

Reach in this order, and stop at the first one that fits:

1. An existing helper in this repo
2. A well-known, **maintained** library
3. The standard library
4. Your own code

Custom code is the last resort, not the default. "I understand the algorithm"
is not a reason to write it; understanding it is what lets you evaluate the
library. Neither is "it's only forty lines" — the line count is not the cost.

**Why the rule bites hardest where you feel most competent.** Retry-with-backoff,
atomic file writes, layered config merging, connection pooling, and date parsing
are all things a good engineer can write correctly on a good day. The failure
mode is not that your version is wrong on the day you write it. It is that your
version encodes decisions you did not know you were making, in code nothing
exercises until an incident:

| You wrote | The decision you did not notice making |
|---|---|
| a retry loop | whether the delay before attempt N uses N or N-1 |
| jitter | additive (breaks your own max-delay bound) or subtractive |
| an atomic write | whether `fsync` actually reaches the device on this OS |
| a config merge | whether env vars beat files, or files beat env vars |

Each is invisible in review, passes its tests, and surfaces during the one event
it existed to survive.

**The tell that you are about to violate this:** you find yourself writing a
comment explaining why your implementation is correct. Documenting the
correctness of mechanism you chose to own is the smell — a library's correctness
is somebody else's maintained problem, and a paragraph of reasoning is what you
write instead of not having the problem. If the explanation is load-bearing, the
code should not be yours.

**The exception is real but narrow.** "No other option" means: no maintained
library covers it, or every candidate is abandoned. An **unmaintained** library
does not satisfy rule 2 — it is a dependency that will never be fixed, which is
worse than owned code, because owned code at least has an owner. When you land
in the exception, say so in the module docstring, name the library you rejected
and why, and note that its implementation is what you checked yours against.

### Worked examples, both from this standard's own exemplar

The exemplar shipped violating this rule three times. Each is now a documented
before/after, which is more useful than a clean file that never made the mistake:

- **`utils/http.py` — violation, corrected.** ~90 lines of retry loop, backoff
  arithmetic, a jitter algorithm, and a `random_units` parameter that existed
  *only so the jitter could be tested*. Production API surface serving a test is
  a reliable signal the mechanism should not be local. Replaced by `tenacity`:
  `stop_after_attempt` + `wait_exponential_jitter` + `retry_if_exception_type`.
  What survived is the part that is genuinely domain knowledge — the tuple of
  *which* exceptions deserve a retry.

- **`config.py` — violation, corrected, and it was hiding a live bug.** A
  hand-written `_deep_merge` fed the result into `Settings(**values)`. Init
  kwargs are pydantic's *highest*-priority source, so the JSON files silently
  outranked environment variables — the exact reverse of the precedence order
  the module docstring promised. `EXEMPLAR_LOGGING__LEVEL=CRITICAL` against a
  file saying `DEBUG` produced `DEBUG`, with nothing logged. Replaced by
  `settings_customise_sources` + `JsonConfigSettingsSource(deep_merge=True)`,
  which both deletes the merge and makes the documented order a property of the
  mechanism instead of a claim.

- **`apps/monitor/store.py` — the exception, and why it is not a loophole.** The
  atomic write stayed hand-written, because the canonical library
  (`atomicwrites`) is archived and unmaintained. But *reading* it exposed two
  real defects in the local version: on macOS `os.fsync` does not flush the
  drive's write cache (Apple's `fsync(2)` man page names `F_FULLFSYNC` as the
  operation that does), and the directory entry was never flushed at all, so the
  rename itself was not durable. Both fixed. The lesson is that "no maintained
  library" licenses you to own the code, not to skip reading the reference
  implementation.

---

## Layout

```
repo/
├── _githooks/              # tracked hooks; core.hooksPath points HERE
│   ├── pre-commit
│   ├── commit-msg
│   └── install.sh
├── src/
│   └── {package}/
│       ├── __init__.py     # full module docstring -> generates README.md
│       ├── __main__.py     # entry point: parse args, build config, run
│       ├── config.py       # THE keystone. See below.
│       ├── models/         # Pydantic models ONLY. No logic.
│       ├── services/       # business logic, one concern per module
│       ├── api/            # HTTP surface, if any
│       └── utils/          # shared helpers, imported by everything
├── tests/                  # mirrors src/ structure
├── scripts/                # helper scripts, in subdirectories
│   ├── deployment/
│   └── dev/
├── secrets/                # gitignored EXCEPT *.example and README.md
│   ├── README.md
│   └── config.example.json
├── data/                   # runtime state, gitignored
├── logs/                   # gitignored
├── pyproject.toml
├── AGENTS.md
├── CLAUDE.md               # @AGENTS.md import + Claude-specific delta
└── README.md
```

### LAW: 500 lines maximum per file

Over 500, split it. No exceptions except the one below.

**`config.py` is the documented exception.** It is the keystone (see next
section) and holds the full typed configuration surface; splitting it fragments
the one place a reader goes to learn what the application can be told to do. It
still must be *organized* — sections grouped, load order explicit — but it is
not required to fit in 500 lines.

That exception is narrow and deliberate. `b1x-message-coordinator` also has
`external_message_timers.py` at 1459 lines, `webhooks.py` at 1275, and
`storage.py` at 807. None of those is a keystone; all three are simply overdue
for splitting. Size limits erode one justified exception at a time.

### Principle: one class or function per module, where that is logical

A module should have one reason to change. `services/checker.py` holds the
checker. `services/scheduler.py` holds the scheduler. When a module starts
needing "and" to describe it, it is two modules.

"Where logical" is doing real work in that sentence: a model file holding three
tightly-coupled models is one concern, not three. Do not split so aggressively
that following a call means opening nine files.

### `utils/` is the shared floor

Anything used by more than one module goes in `utils/`, and every module imports
it from there. The failure this prevents is the reach-across import:
`services/checker.py` importing a helper from `api/routes.py` because that is
where it happened to be written first. That builds a dependency graph nobody
designed, and it is how a "small" refactor turns into a chain of import errors.

Typical contents: `logging_config.py`, `datetime_helpers.py`, `http.py`,
`paths.py`. If two modules need it, it belongs here — even if it is four lines.

### `scripts/`, in subdirectories

Every helper script lives under `scripts/`, in a subdirectory naming its
purpose (`deployment/`, `dev/`, `git-hooks/`). Nothing loose at the repo root,
and nothing loose at the `scripts/` root either.

`b1x-message-coordinator` gets the subdirectories right and then leaves eight
files at `scripts/` top level, three of them one-off migrations
(`fix_datetime_usage.py`, `fix_mixin_types.py`, `fix_import_errors.py`). A
finished migration script is finished; delete it or archive it. Its presence
implies it is still needed.

### `secrets/` — structure tracked, values ignored

```gitignore
secrets/*
!secrets/.gitkeep
!secrets/*.example
!secrets/README.md
```

Allowlist, not blocklist. The committed `*.example` files carry the full key
structure with placeholder values, so a new developer or agent can see exactly
what is required without any real value ever entering git. `secrets/README.md`
explains where the real values come from.

**Never commit a real credential**, and check what is already sitting in
`secrets/` before assuming the gitignore has covered you — an ignored file is
still a file on disk, and a service-account key in an untracked directory is
still a service-account key.

---

## `config.py` — the keystone

Config runs first, before anything else in the application. It reads
configuration, validates it, sets up logging, and hands both down to every
component. Nothing else reads environment variables or config files. Nothing
else configures logging.

That single rule is what makes an application testable, because it means every
component's dependencies arrive through its constructor and can be replaced in
a test.

### Structure

Pydantic `BaseSettings` at the top level, typed `BaseModel` sections beneath it,
grouped by concern.

```python
class LoggingSettings(BaseModel):
    """Logging sinks and levels. Consumed by utils.logging_config.setup()."""

    level: str = "INFO"
    json_sink: bool = True
    rotation: str = "50 MB"
    retention: str = "14 days"


class Settings(BaseSettings):
    """
    Root configuration. Built ONCE at startup, passed down explicitly.
    """

    model_config = SettingsConfigDict(
        env_prefix="EXEMPLAR_",
        env_nested_delimiter="__",
    )

    env: Literal["test", "dev", "prod"] = "test"
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
```

### LAW: Pydantic for every model. No bare dataclasses.

Not `@dataclass`, not `TypedDict`, not a dict passed around with string keys.
Pydantic validates and coerces at construction, so a bad value fails at the
boundary with a message naming the field — instead of surfacing 200 lines later
as an `AttributeError` on `None`.

This is a real upgrade over the reference repos, which use `@dataclass`
throughout and therefore hand-roll validation. `b1x-message-coordinator` has a
`_validate_critical_configs()` method existing solely to re-check things a
Pydantic type would have enforced for free at load. With Pydantic that method
does not need to exist.

### Fail fast, with the remediation in the message

An error message that says what broke and not what to do about it costs a
round trip.

```python
# WRONG - true, useless
raise FileNotFoundError("secrets file not found")

# RIGHT - says what, where, and what to do
raise FileNotFoundError(
    f"CRITICAL: secrets file not found at {path}. "
    f"ACTION REQUIRED: copy secrets/config.example.json to {path.name} "
    f"and fill in the values."
)
```

Required config missing is fatal — raise. Optional config missing degrades —
log at ERROR with the concrete impact, then continue.

### Explicit, documented load order

The module docstring states the order and which sources may override which. A
reader must never have to trace the code to learn whether an env var beats a
file.

---

## Logging

Set up by config, once, at startup. Never configured anywhere else.

### Required sinks

1. **Console** — human-readable, colorized, for local development
2. **Rotating file** — plain text, `logs/{app}-{env}.log`, size-rotated with
   retention
3. **Structured JSON** — one object per line, for log aggregation

All three are configured from `LoggingSettings`. JSON is what a log platform
ingests; the plain file is what a human tails; the console is what you watch
while working. Wanting all three is normal, so all three ship.

### Levels

| Level | Use for |
|---|---|
| `DEBUG` | Execution flow. Use liberally — it is off in prod and costs nothing. |
| `INFO` | Milestones: startup, shutdown, work completed. |
| `WARNING` | Recovered: a retry, a fallback engaging, optional config missing. |
| `ERROR` | Failed and needs attention. Always `exc_info=True`. |
| `CRITICAL` | Cannot continue. |

### Contextual prefixes and identifiers

Every message carries a component prefix and the identifiers needed to
correlate it:

```python
logger.debug(f"CHECK: starting target={target.name} url={target.url}")
logger.info(f"CHECK: ok target={target.name} status={status} latency={ms}ms")
logger.error(f"CHECK: failed target={target.name}: {e}", exc_info=True)
```

Without identifiers, a log line proves something happened but not to what,
which is the same as not having it when you are debugging one target out of
fifty.

---

## Typing

### LAW: mypy strict passes, with no `--ignore-missing-imports`

```toml
[tool.mypy]
strict = true
warn_unreachable = true
```

`--ignore-missing-imports` silences the entire class of error that catches a
wrong import path. If a third-party package genuinely ships no stubs, narrow the
exception to that package by name:

```toml
[[tool.mypy.overrides]]
module = ["some_untyped_lib.*"]
ignore_missing_imports = true
```

Every function gets parameter and return annotations, including `-> None`.
`from __future__ import annotations` at the top of every module.

Spellings that are not optional:

- **`str | None`, never `Optional[str]`.** One spelling per concept.
- **Type-only imports behind `if TYPE_CHECKING:`** so they cost nothing at
  runtime and cannot create import cycles.
- **ABSOLUTE imports everywhere, including siblings and `__init__.py`.**
  `from exemplar.db.engine import Database`, never `from .engine import Database`
  and never `from ..db.engine import Database`.

  Rico's rule, 2026-07-30. An absolute import states the full path to the thing
  it names, so you can read one line and know exactly what it points at. A
  relative import is a claim about where the *current* file sits, which is a
  fact the reader has to reconstruct — and `..`/`...` chains are the worst case,
  because miscounting one level silently resolves to a different module rather
  than failing.

  Absolute paths are also verifiable. ruff (F401 unused, and its import rules)
  and mypy resolve them against the real package, so a wrong or stale path is a
  linter error before the program runs. A wrong relative depth can still
  resolve to something that happens to exist.

  This also survives refactoring: moving a module changes the import in one
  obvious way instead of invalidating every `..` count in every file beneath it.

  The exemplar follows this — 24 absolute imports, zero relative (verified
  2026-07-30). This bullet previously said the opposite ("relative for siblings"),
  which contradicted both the rule and the worked example it describes.
- **Named module-level `UPPER_CASE` constants.** No inline magic numbers or
  bare string literals in logic.
- **Google-style docstrings** on functions, with `Args:` / `Returns:` /
  `Raises:` whenever the signature is not self-documenting.

A `# type: ignore` requires a comment saying why. `b1x-message-coordinator`
carries a `TODO_REMOVE_TYPE_IGNORES.md` at its root, which is what accumulates
when they are added silently.

Add `py.typed` only to packages you actually distribute. Applications and
private scripts do not get the marker.

---

## LAW: flat control flow

Rico's rules, 2026-07-30. These are enforced, not advisory — see the config
block at the end of this section.

### NEVER nest conditionals

A nested `if` inside an `if` is a hard anti-pattern. Not "avoid where
practical" — never.

The reason is testability, which is the same reason as the testing LAW below:
every nesting level multiplies the paths through a function. Three levels of
two-way branching is eight paths, and nobody writes eight tests for one
function, so most of those paths ship unexercised. Flat code has one path per
branch and each one is obvious.

Ways out, in order of preference. Note that a stack of sequential `if`s is
NOT the destination — it is just nesting laid on its side, and it is still one
branch per line to read and test. Rico's preference, 2026-07-30: **reach for an
enum plus a table before reaching for conditionals at all.**

```python
# 1. ENUM + TABLE -- the preferred shape. The rules become DATA, the function
#    becomes a loop, and complexity stops rising as rules are added.
class Rejection(StrEnum):
    """Why an order cannot be processed. The value IS the operator message."""
    NO_ITEMS = "order has no items"
    INACTIVE_CUSTOMER = "customer account is inactive"
    OVER_CREDIT = "order exceeds available credit"

#: Each rule is a predicate and the rejection it produces. Adding a rule is one
#: row -- no new branch, no change to the function, and the table itself can be
#: asserted on in a test without invoking `process` at all.
ORDER_RULES: tuple[tuple[Callable[[Order], bool], Rejection], ...] = (
    (lambda o: not o.items,                    Rejection.NO_ITEMS),
    (lambda o: not o.customer.active,          Rejection.INACTIVE_CUSTOMER),
    (lambda o: o.total > o.customer.credit,    Rejection.OVER_CREDIT),
)

def process(order: Order) -> Receipt:
    """Validate against every rule, then build the receipt."""
    for failed, reason in ORDER_RULES:
        if failed(order):
            raise OrderRejectedError(order.id, reason)
    return build_receipt(order)

# Complexity is now CONSTANT: one branch, regardless of how many rules exist.
# Ten more rules is ten more rows and the same single `if`.

# 2. GUARD CLAUSES -- correct, and much better than nesting, but each guard is
#    still a branch. Use when there are two or three checks that are genuinely
#    unrelated to each other, so a table would be ceremony.
def process(order: Order) -> Receipt:
    if not order.items:
        raise EmptyOrderError(order.id)
    return build_receipt(order)

# 3. EXTRACT A FUNCTION. If the inner block is doing its own job, it IS its
#    own job. The nesting was telling you where the seam was.

# 4. DICT DISPATCH or `match` -- for branching on a value or a shape. See below.
```

**Why enum over bare strings**, in every one of these shapes: an enum is a
closed set the type checker knows. `Rejection.NO_ITMES` is a mypy error;
`"no_itmes"` is a silent bug that ships. It also gives every reason exactly one
spelling, so log lines, tests, and API responses cannot drift apart.

### NEVER write a long if/elif chain

Replace with dict dispatch or `match`. An if/elif chain grows a branch per
case, so its complexity rises forever, and every new case means re-reading the
whole ladder to find where it belongs.

```python
# NO -- every new event type makes this longer and the function untestable
if event.kind == "push":
    handle_push(event)
elif event.kind == "tag":
    handle_tag(event)
elif event.kind == "release":
    handle_release(event)
# ... eight more

# YES -- dict dispatch. Adding a case is one line, and the table is data you
# can assert on directly in a test.
HANDLERS: dict[EventKind, Callable[[Event], None]] = {
    EventKind.PUSH: handle_push,
    EventKind.TAG: handle_tag,
    EventKind.RELEASE: handle_release,
}

handler = HANDLERS.get(event.kind)
if handler is None:
    raise UnknownEventError(event.kind)     # explicit, not a silent no-op
handler(event)

# YES -- `match` when the branching is on SHAPE rather than a single key,
# because a dict cannot express destructuring.
match response:
    case {"status": "ok", "data": [*items]}:
        return items
    case {"status": "error", "message": str(msg)}:
        raise UpstreamError(msg)
    case _:
        raise MalformedResponseError(response)
```

Dict dispatch is preferred over `match` for the flat single-key case: the table
is inspectable at runtime, testable without calling the function, and
extendable by another module.

### Enforcement

```toml
[tool.ruff]
preview = true              # PLR1702 requires it -- see the note below

[tool.ruff.lint]
select = ["PLR1702", "PLR0912", "C901", "RET", "TRY"]

[tool.ruff.lint.pylint]
max-nested-blocks = 3       # NOT ruff's default of 5
max-branches = 12

[tool.ruff.lint.mccabe]
max-complexity = 10
```

Three things that are easy to get wrong here, all verified on 2026-07-30:

- **`preview = true` is REQUIRED.** Without it, ruff prints
  `warning: Selection PLR1702 has no effect because preview is not enabled`
  and exits 0. The rule is configured, appears in `select`, and never fires —
  a check that reports success while examining nothing, which is precisely the
  defect this document opens with.
- **`max-nested-blocks = 3`, not 2.** PLR1702 counts every block type, not just
  conditionals. A legitimate `try:` → `async for` → `with` is three deep with
  no branching at all (`utils/http.py`'s tenacity loop is exactly this, and it
  is the library's required API shape). A limit of 2 bans correct structural
  code and teaches people to write `noqa`, at which point the rule means
  nothing. 3 still refuses `if`-in-`if`-in-`if`.
- **Select the rules INDIVIDUALLY, not the whole `PL` family.** `"PL"` drags in
  ~40 unrelated pylint rules; ten fired on the exemplar's own correct code
  (magic-value-comparison, too-many-arguments, import-outside-top-level). Rule
  sets that produce noise get blanket-ignored, which costs you the rules that
  mattered.

---

## LAW: test every input and output, not a coverage percentage

**Coverage percentage is not the bar and must not be configured as a gate.**
A percentage is satisfiable by code that calls functions without asserting
anything about them. It measures which lines executed, not which behaviours
were checked — and the two diverge exactly where it matters.

The bar is: **every input and output of a function.** For each function, a test
for each meaningful input class and each outcome it can produce:

- the normal case, asserted on the actual returned value
- each boundary: empty, zero, one, maximum, `None` where accepted
- each documented failure: every exception in the `Raises:` block, asserted
  with `pytest.raises`
- each branch: if the function can return two shapes, both are asserted

If that is tedious for a given function, the function has too many branches —
which is what the flat-control-flow LAW above is for. The two rules support
each other: flat code has few paths, and few paths is a testable function.

```python
# The shape. One behaviour per test, named for the behaviour.
def test_delay_for_first_attempt_is_not_delayed() -> None:
    assert RetryPolicy().delay_for(1, random_unit=0.0) == 0.0

def test_delay_for_caps_at_max() -> None:
    policy = RetryPolicy(max_delay_seconds=5.0)
    assert policy.delay_for(10, random_unit=0.0) == 5.0

def test_negative_attempts_rejected() -> None:
    with pytest.raises(ValidationError):
        RetryPolicy(max_attempts=-1)
```

**Prove the suite can fail.** A test that has never failed has not been shown
to test anything. When adding a test, break the code deliberately once and
confirm it goes red before committing it green. A suite that is green because
it asserts nothing is worse than no suite, because it is trusted.

### What enforces what

Be precise about this, because the whole document's thesis is that an
unenforced rule is a wish:

| Rule | Mechanism | Fires |
|---|---|---|
| No deep nesting | `PLR1702` (ruff config) | yes, pre-commit |
| No long if/elif chain | `PLR0912` + `C901` (ruff config) | yes, pre-commit |
| Named `except`, no bare | `BLE` (ruff) | yes, pre-commit |
| `raise ... from` | `B904` (ruff) | yes, pre-commit |
| No coverage gate | absence of config | n/a |
| Suite is non-vacuous | pre-push hook, see `## Git hooks` | yes, pre-push |
| Every input/output tested | **nothing — human review** | NO |
| Log detail sufficient to diagnose | **nothing — human review** | NO |

The last two rows are judgement calls no tool can make, and saying so is the
point. A reviewer asks for them; a linter cannot. Do not describe them as
mandatory checks — they are principles, per this document's own rule that
anything not in an enforcement table must not be called mandatory.

---

## LAW: fail loudly, or log enough to find it

The goal is that a failure is diagnosable from the logs alone, without
re-reading the code to guess what happened. Two halves:

**Fail hard when the failure is real.** Do not swallow, do not continue on
corrupt state, do not return a sentinel that a caller will mistake for success.
An exception that reaches the operator with a clear message and a traceback is
worth more than a graceful degradation nobody notices. The narrow exceptions —
supervisor loops, tolerant reads — must state in a comment why they qualify;
see `## Error handling` and `apps/monitor/service.py`'s `BLE001` block.

**Log enough at DEBUG to reconstruct the path.** Not print-debugging after the
fact — the logging is configured up front, so when something breaks, the
answer is already recorded. This is a `config.py` responsibility, which is why
that file is the keystone: one `LOGGING__LEVEL=DEBUG` turns on the detail
everywhere at once.

```python
# try/except/finally, with the failure carrying its context.
try:
    result = await client.request(method, url, timeout=t)
except RETRYABLE_EXCEPTIONS as exc:
    # Named exceptions, not bare `except`. The log line carries WHAT failed,
    # WHERE, and WHICH attempt -- enough to act on without opening the source.
    logger.warning(f"{label}: transport failure {method} {url} "
                   f"attempt={n}: {type(exc).__name__}: {exc}")
    raise TransportError(url, n, exc) from exc     # `from` keeps the cause
finally:
    # finally is for cleanup that must happen on both paths. Never for
    # control flow, and never swallowing the exception by returning from it.
    await cleanup()
```

Rules that follow from this:

- **Every `except` names its exception types.** Bare `except:` and
  `except Exception:` are refused by `BLE`; the rare justified case carries a
  comment explaining why it qualifies.
- **Always `raise ... from exc`.** Losing the cause is losing the only thing
  that says what actually went wrong.
- **Never `except ...: pass`.** Silent failure is the single most expensive
  thing in this document.
- **Error messages state the impact and the action.** `f"{path} unreadable
  ({exc}). IMPACT: starting with empty state. ACTION REQUIRED: ..."` — the
  operator should not have to infer either.
- **Log at the boundary, not in every function.** A DEBUG line per I/O call,
  per state transition, and per retry. A DEBUG line per statement is noise that
  buries the signal.

---

## Documentation

This is the part the reference repos do best, and the mechanism matters more
than the prose.

### LAW: every `__init__.py` has a full module docstring

Template:

```python
"""
[Module Name] - [one-line purpose]

[2-4 paragraphs: HOW this works architecturally, and WHY it is built this way.]

Key Components:
    - Component: what it does and why it exists

Pattern/Convention:
    [How to use this module.]
    [How to extend it.]

Example:
    >>> from package.module import Thing
    >>> thing = Thing(config)
    >>> thing.run()

See Also:
    - related.module
"""
```

### Docstring is the source. README.md is generated.

`scripts/dev/generate_folder_docs.py` walks every `__init__.py`, extracts the
module docstring with `ast`, and writes that folder's `README.md`. It runs in
`pre-commit`, and the generated file is staged alongside the source change.

This is the whole trick, and it is why the documentation stays true: there is
exactly one place to write it, the visible artifact is derived, and they commit
together so they cannot drift. Documentation rots when it is a second copy
someone has to remember to update.

**Never hand-edit a generated `README.md`.** Edit the docstring and let the hook
regenerate.

This is also the qmd retrieval surface. Once a repo is indexed, these docstrings
are what semantic search actually returns — so an undocumented package is a hole
in search, and the thing inside it cannot be found by anyone who does not
already know it exists.

### LAW: the generator BLOCKS. It does not skip.

A missing docstring, one under the minimum length, or one lacking the required
sections **fails the commit**. It does not warn, does not print "skipped", and
does not exit 0.

This is stated as a law because the reference implementation gets it wrong in
both possible ways, verified in source on 2026-07-30:

- `b1x-message-coordinator/scripts/git-tools/generate_folder_docs.py` counts a
  missing docstring into `skipped_count`, prints `⏭️ Skipped`, and **returns 0
  unconditionally**. It cannot fail a commit even when wired to one.
- **No hook calls it.** It appears in neither `.git/hooks/pre-commit` nor
  `scripts/git-hooks/pre-commit`, despite that repo's `CLAUDE.md`,
  `docs/CODING_GUIDELINES.md`, and the generator's own docstring all describing
  it as running in pre-commit.

So its 20+ generated READMEs were produced by someone running it by hand. The
mechanism the documentation calls automatic is, in the repo that invented it,
entirely manual — which is why `config.py` is 1524 lines and naive
`datetime.now()` sits in committed code. A generator that exits 0 on the
undocumented package leaves exactly the undocumented package it exists to
prevent.

Measured effect where it *is* run: `b1x-message-coordinator` carries 20+
generated READMEs and `__init__.py` docstrings from 70 to 322 lines.
`b1x-telegram-admin`, which has no generator at all, has zero generated READMEs
and docstrings of 0 to 28 lines, several empty. Same team, same written
conventions. Running the generator is the entire difference.

Write the docstring **before** the module it describes.

### Inline comments explain WHY

The code says what it does. Comments exist for what the code cannot say: the
reason, the constraint, the thing that was tried and failed.

```python
# Reason: Telegram rate-limits aggressively on entity lookups, so we cache
# access_hash values. Without this we hit FloodWaitError within ~40 requests.
```

Mark non-obvious logic with `# Reason:`.

---

## Error handling

Wrap every external operation — HTTP, file I/O, JSON parsing, database,
subprocess. Four patterns, chosen by what failure means:

1. **Critical** → raise with `ACTION REQUIRED:` and the fix.
2. **Recoverable** → retry with exponential backoff (2s, 4s, 8s), bounded, then
   raise. Log each attempt at WARNING with attempt number.
3. **Optional feature** → fall back, log at ERROR with the concrete `IMPACT:`.
4. **Background task** → log and continue; never let a periodic task kill the
   service. Catch `asyncio.CancelledError` separately and break cleanly.

### Principle: dict dispatch over if/elif chains

Three or more branches that map a value to an action become a dict:

```python
HANDLERS = {"http": check_http, "tcp": check_tcp, "ping": check_ping}
handler = HANDLERS.get(target.kind, check_unknown)
return await handler(target)
```

Extending it is one line and cannot forget a branch. Keep `if/elif` for one or
two cases, guard clauses, and genuinely complex boolean logic.

---

## Enforcement

### LAW: hooks live in `_githooks/` and `core.hooksPath` points at them

```bash
git config core.hooksPath _githooks
```

**Per-repo `core.hooksPath`, not copies in `.git/hooks/`.** This is the direct
lesson of the shadowing defect described at the top of this document. A hook
copied into `.git/hooks/` is silently overridden by any global `core.hooksPath`,
and git reports nothing. Setting it per-repo makes the repo's own hooks win,
keeps them tracked and reviewable, and means a fix reaches everyone on the next
pull instead of requiring each person to re-run an installer.

Verify, do not assume:

```bash
git config core.hooksPath          # must print _githooks
```

### What pre-commit enforces

| Check | Blocks commit |
|---|---|
| `ruff format` (auto-format, re-stage) | yes |
| `ruff check` | yes |
| `mypy` over the package path, strict | yes |
| `generate_folder_docs.py` in blocking mode | yes |
| No file over 500 lines (except `config.py`) | yes |
| No naive `datetime.now()` | yes |
| No bare `except:` or `except ...: pass` | yes |
| No `pdb`/`ipdb`/`set_trace`, no stray `print()` in library code | yes |
| No hardcoded URLs or credential-shaped literals | yes |
| Dependency manifest in sync with `pyproject.toml` | yes |

Anything not in that table is a principle, reviewed by a human, and must not be
described as mandatory.

That includes **LAW: do not hand-roll a solved problem**, which is named a LAW
for weight but is NOT mechanically enforced and cannot honestly be listed above.
No linter can tell a justified forty lines from an unjustified one — the
judgement is "does a maintained library cover this", and that is a human call at
review time. Naming the gap here rather than implying a hook exists is the same
rule as everywhere else in this document: a check that does not fire must not be
described as if it does.

The closest thing to a mechanism is the tell in that section — a comment
explaining why your implementation is correct. That is greppable by a reviewer
and is worth asking about in review, but it is a prompt for a conversation, not
a gate.

**Verify the mypy path in the hook actually matches the package.** A hook copied
from another repo will happily typecheck a directory that does not exist and
report success every single time. `b1x-message-coordinator`'s hook runs
`mypy src/b1x_telegram_listener/` — the package name of the repo it was adapted
*from*, which does not exist in the repo it now lives in. That check has never
examined a single file. Confirm with a deliberately broken annotation that the
hook actually fails.

### Timezone-aware datetimes only

`datetime.now()` returns a naive datetime. Comparing naive to aware raises;
storing naive loses information silently and is unrecoverable later.

```python
# WRONG
created_at = datetime.now()

# RIGHT
from exemplar.utils.datetime_helpers import utc_now
created_at = utc_now()          # datetime.now(timezone.utc)
```

---

## Testing

- `tests/` mirrors `src/`.
- `pytest-asyncio` with `asyncio_mode = "auto"`.
- `AsyncMock` for async, never `MagicMock` — a `MagicMock` on an async function
  returns a mock instead of a coroutine and the test passes while proving
  nothing.
- Mock where the name is *looked up*, not where it is defined.
- Prove a new test can fail before trusting it.
- **No coverage gates.** A percentage target is satisfiable without testing
  anything that matters. Test behaviour at the public boundary.

---

## Applying this to an existing repo

Do not big-bang it. In order, each landing on its own:

1. `_githooks/` + `core.hooksPath` — nothing else holds without this.
2. `ruff` replacing black/flake8/isort.
3. `mypy` strict, narrowing per-module overrides as you fix.
4. Pydantic models, starting at config.
5. The docstring generator and the `__init__.py` docstrings it needs.
6. Split anything over 500 lines.

Step 1 first, always. Every later step is a rule, and a rule with no mechanism
is a comment.
