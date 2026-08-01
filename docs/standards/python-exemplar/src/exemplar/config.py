"""Configuration. Runs first, validates everything, configures logging, gets passed down.

THIS MODULE IS THE KEYSTONE
    Nothing else in this application reads an environment variable, opens a
    config file, or configures a logging sink. Every component receives what it
    needs through its constructor. That single rule is what makes the rest
    testable: a service whose dependencies arrive as arguments can be handed
    fakes, while a service that reaches for ``os.environ`` in the middle of a
    method can only be tested by mutating global process state.

    It is also the one file exempt from the 500-line ceiling (see
    _DOCS/STANDARDS-python.md ## LAW: 500 lines maximum per file). It holds the
    complete typed surface of everything the application can be told to do, and
    splitting it scatters the one place a reader goes to find that out. The
    exemption is narrow and it is not a licence: the file is still organised in
    sections, and any *behaviour* beyond loading and validating belongs
    elsewhere.

WHY PYDANTIC AND NOT @dataclass
    The reference repos use ``@dataclass`` for config and consequently hand-roll
    validation -- b1x-message-coordinator has a ``_validate_critical_configs()``
    method whose entire job is re-checking things a type could have enforced at
    construction. With ``BaseSettings`` that method does not need to exist:
    values are parsed, coerced, and validated at load, and a bad one fails
    immediately with the field name and the reason.

    The difference in practice is *where* you find out. A dataclass accepts
    ``port="not a number"`` silently and fails hundreds of lines later inside
    the socket call. Pydantic fails at startup, naming ``ports.base``.

CONFIGURATION SOURCES, IN PRECEDENCE ORDER
    Highest wins. This order is stated here because a reader must never have to
    trace code to learn whether an environment variable beats a file:

    1. Explicit keyword arguments to ``Settings(...)``  -- tests only
    2. Environment variables (``EXEMPLAR_`` prefix, ``__`` nesting)
    3. ``secrets/config.{env}.json``                    -- per-environment
    4. ``secrets/config.json``                          -- shared defaults
    5. Field defaults declared below

    Nested values use a double underscore: ``EXEMPLAR_LOGGING__LEVEL=DEBUG``
    sets ``settings.logging.level``. A single underscore would be ambiguous the
    moment a field name contains one.

    That order is enforced by ``settings_customise_sources`` below, and the
    distinction between enforcing it and merely asserting it is not academic.
    This module previously read the JSON files itself and passed the result as
    keyword arguments to ``Settings(...)``. Init keyword arguments are pydantic's
    HIGHEST-priority source, so the files silently outranked environment
    variables -- the exact reverse of what these lines promised. Setting
    ``EXEMPLAR_LOGGING__LEVEL=CRITICAL`` against a file specifying ``DEBUG``
    produced ``DEBUG``, with no error and nothing in the logs to suggest the
    variable had been read and discarded.

    A documented precedence order that the code does not implement is worse than
    no documentation, because it is trusted. Declaring the chain to
    ``settings_customise_sources`` makes the order a property of the mechanism
    rather than a claim in a docstring that has to be independently kept true.

SHARED BY THREE APPLICATIONS
    ``monitor``, ``watch``, and ``hook`` all build the same ``Settings`` object.
    App-specific settings live in their own nested section, so an app reads its
    own section plus the shared ones and ignores the rest. This is deliberate:
    one config surface means one place to look, one validation pass, and one
    logging setup, instead of three that drift.

Key Components:
    - Settings: the root object. Built once, at startup, passed down.
    - LoggingSettings: sinks, levels, rotation. Consumed by utils.logging_config.
    - MonitorSettings / WatchSettings / HookSettings: per-app sections.
    - load_settings: the sanctioned constructor. Use this, not ``Settings()``.

Pattern/Convention:
    Every entry point starts the same way::

        settings = load_settings(env=args.env)   # reads, validates, sets up logging
        service = SomeService(settings.monitor, ...)   # inject the section

    Never ``import config`` deep inside a service to fetch a value. If a service
    needs something, it is a constructor parameter -- that is what makes it
    visible in the signature and replaceable in a test.

Example:
    >>> settings = load_settings(env="test")
    >>> settings.env
    'test'
    >>> settings.ports.monitor          # base 714 -> 7140
    7140

See Also:
    - exemplar.utils.logging_config: the only consumer of LoggingSettings
    - _DOCS/STANDARDS-python.md ## config.py -- the keystone
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator
from pydantic_settings import (
    BaseSettings,
    JsonConfigSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

from exemplar.utils.logging_config import setup as setup_logging

# --------------------------------------------------------------------------
# Constants. Named at module level, never inline in a field default -- a magic
# number in a default is invisible to anyone reading the class.
# --------------------------------------------------------------------------

#: Local development servers use 7100-7199 across the repo set (AGENTS.md). Each app gets
#: a digit appended to this base, so the three never collide.
PORT_BASE = 714

#: Project root, derived from this file: src/exemplar/config.py -> up three.
#: Deriving beats hardcoding -- it survives the repo being cloned anywhere.
PROJECT_ROOT = Path(__file__).resolve().parents[2]

Environment = Literal["test", "dev", "prod"]


# --------------------------------------------------------------------------
# Shared sections
# --------------------------------------------------------------------------


class PortSettings(BaseModel):
    """Ports for each app, derived from one base so they cannot collide.

    Derived rather than three independent fields: with three separate values
    somebody eventually sets two of them the same, and the failure is a bind
    error at startup on whichever app loses the race.
    """

    base: int = PORT_BASE

    @property
    def monitor(self) -> int:
        """Port for the monitor app's HTTP surface."""
        return int(f"{self.base}0")

    @property
    def hook(self) -> int:
        """Port for the hook app's receiver."""
        return int(f"{self.base}1")

    @field_validator("base")
    @classmethod
    def _within_reserved_range(cls, value: int) -> int:
        """Reject a base that would place ports outside the reserved range.

        AGENTS.md reserves 7100-7199 for local development servers. A base of
        714 yields 7140 and 7141; a base of 800 would yield 8000, colliding with
        whatever else on the machine already uses the conventional default.
        """
        if not (710 <= value <= 719):
            msg = (
                f"ports.base must be 710-719 so derived ports land in the "
                f"reserved 7100-7199 range; got {value}. "
                f"ACTION REQUIRED: set EXEMPLAR_PORTS__BASE to a value in range."
            )
            raise ValueError(msg)
        return value


class LoggingSettings(BaseModel):
    """Logging sinks and levels. The sole input to utils.logging_config.setup.

    Defaults are the safe production shape: INFO, all three sinks on, verbose
    tracebacks off. Local development turns up the level and the tracebacks;
    nothing has to be turned *off* to be safe.
    """

    level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    #: Plain-text rotating sink -- the one a human tails.
    file_sink: bool = True

    #: Structured JSON sink -- the one a log platform ingests. On by default:
    #: the moment there are two instances, grepping two plain files is guesswork.
    json_sink: bool = True

    directory: Path = Field(default_factory=lambda: PROJECT_ROOT / "logs")

    #: loguru size or time spec: "50 MB", "1 week".
    rotation: str = "50 MB"
    retention: str = "14 days"

    #: backtrace+diagnose. Shows local variable VALUES in tracebacks, which is
    #: excellent locally and a disclosure risk in production, where a frame may
    #: hold a token. Off by default; turned on explicitly in dev.
    verbose_tracebacks: bool = False


# --------------------------------------------------------------------------
# Per-app sections
# --------------------------------------------------------------------------


class MonitorSettings(BaseModel):
    """Settings for the URL health monitor app."""

    #: Seconds between check rounds.
    interval_seconds: int = Field(default=30, ge=5, le=3600)

    #: Per-request timeout. Must be well under interval_seconds or rounds
    #: overlap; enforced by a model validator on Settings.
    timeout_seconds: float = Field(default=10.0, gt=0, le=120)

    max_retries: int = Field(default=3, ge=0, le=10)

    #: Consecutive failures before a target is reported unhealthy. Above 1 so a
    #: single blip does not page anyone.
    failure_threshold: int = Field(default=2, ge=1, le=100)

    targets: list[HttpUrl] = Field(default_factory=list)

    state_file: Path = Field(
        default_factory=lambda: PROJECT_ROOT / "data" / "monitor.json"
    )


class WatchSettings(BaseModel):
    """Settings for the directory watcher app."""

    input_dir: Path = Field(default_factory=lambda: PROJECT_ROOT / "data" / "inbox")
    output_dir: Path = Field(default_factory=lambda: PROJECT_ROOT / "data" / "outbox")

    poll_seconds: int = Field(default=5, ge=1, le=600)

    #: Reject files larger than this before reading them. A size check after
    #: reading is not a check -- the memory is already allocated.
    max_file_bytes: int = Field(default=10_000_000, gt=0)

    #: Suffixes accepted. Allowlist, never a blocklist: a blocklist admits
    #: everything nobody thought of.
    allowed_suffixes: tuple[str, ...] = (".json", ".csv")


class HookSettings(BaseModel):
    """Settings for the webhook receiver app."""

    #: Where validated events are forwarded. None disables forwarding, which is
    #: the default so a fresh clone does not post to anything.
    forward_url: HttpUrl | None = None

    forward_timeout_seconds: float = Field(default=5.0, gt=0, le=60)
    max_retries: int = Field(default=3, ge=0, le=10)

    #: How many recently-seen event ids to remember for idempotency.
    dedupe_window: int = Field(default=1000, ge=0)

    #: Shared secret for signature verification. Never has a default -- a
    #: default secret is worse than none, because it looks configured.
    signing_secret: str | None = None


# --------------------------------------------------------------------------
# Root
# --------------------------------------------------------------------------


class Settings(BaseSettings):
    """Root configuration for all four applications.

    Built once at startup by ``load_settings`` and passed down explicitly.
    Constructing this directly skips logging setup, so prefer ``load_settings``
    everywhere except tests that specifically want a bare object.
    """

    model_config = SettingsConfigDict(
        env_prefix="EXEMPLAR_",
        env_nested_delimiter="__",
        # Reject unknown keys instead of ignoring them. A typo'd key in a config
        # file is otherwise silently dropped and the default is used, which
        # presents as "my setting does nothing" with no error to search for.
        extra="forbid",
        # Validate on assignment too, so `settings.logging.level = "LOUD"`
        # fails at the assignment rather than at the sink.
        validate_assignment=True,
    )

    # Where the JSON layers live, and which environment's layer to load. Set by
    # `load_settings` before construction, read by `settings_customise_sources`.
    #
    # ClassVar, so pydantic treats these as plain class attributes rather than
    # model fields -- without that annotation they would become settable config
    # keys, and `extra="forbid"` would start rejecting perfectly good files that
    # happen not to mention them.
    _secrets_dir: ClassVar[Path] = PROJECT_ROOT / "secrets"
    _env_name: ClassVar[str] = "test"

    env: Environment = "test"

    ports: PortSettings = Field(default_factory=PortSettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)

    monitor: MonitorSettings = Field(default_factory=MonitorSettings)
    watch: WatchSettings = Field(default_factory=WatchSettings)
    hook: HookSettings = Field(default_factory=HookSettings)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Declare the source chain, highest precedence first.

        This is the mechanism behind the precedence order in the module
        docstring, and the reason that order is now true rather than merely
        claimed. pydantic-settings walks the returned tuple in order and takes
        the first source that supplies each value.

        It also removes the need for a hand-written recursive merge. Passing a
        LIST of files with ``deep_merge=True`` makes the library layer them
        itself: a per-environment file that sets only ``logging.level`` leaves
        the sibling logging fields intact. This module used to do that with its
        own ``_deep_merge``, which was a solved problem re-solved locally.

        Args:
            settings_cls: The settings class being built. Passed through to the
                JSON source, which needs it to read ``model_config``.
            init_settings: Keyword arguments passed to ``Settings(...)``.
            env_settings: ``EXEMPLAR_``-prefixed environment variables.
            dotenv_settings: ``.env`` file. Deliberately unused -- this project
                keeps its layers in ``secrets/``, and two competing file
                conventions is one too many.
            file_secret_settings: Docker-style secrets directory. Unused; the
                JSON layers below cover the same need explicitly.

        Returns:
            Sources in descending precedence.
        """
        # The directory and environment are set by `load_settings` immediately
        # before construction. They live on the class because this hook is a
        # classmethod -- pydantic-settings offers no per-call channel to reach
        # it. `load_settings` is the only sanctioned constructor precisely so
        # this coupling has exactly one place to go wrong.
        directory = cls._secrets_dir
        env = cls._env_name

        return (
            init_settings,
            env_settings,
            # Both layers as ONE source: listed lowest-first, because
            # `deep_merge` applies each file over the previous, so the
            # per-environment file must come last to win.
            JsonConfigSettingsSource(
                settings_cls,
                json_file=[
                    directory / "config.json",
                    directory / f"config.{env}.json",
                ],
                deep_merge=True,
            ),
        )

    @model_validator(mode="after")
    def _check_cross_field_invariants(self) -> Settings:
        """Validate rules that span more than one field.

        Single-field rules belong on the field itself; these need two or more
        values and therefore have to run after the whole object is built.
        """
        # A per-request timeout at or above the poll interval means round N+1
        # starts while round N is still waiting, and the overlap compounds until
        # the process is doing nothing but timing out.
        if self.monitor.timeout_seconds >= self.monitor.interval_seconds:
            msg = (
                f"monitor.timeout_seconds ({self.monitor.timeout_seconds}) must be "
                f"less than monitor.interval_seconds ({self.monitor.interval_seconds}), "
                f"or check rounds overlap and queue indefinitely. "
                f"ACTION REQUIRED: lower the timeout or raise the interval."
            )
            raise ValueError(msg)

        # Forwarding to a real URL without a signing secret means the receiver
        # cannot tell our traffic from anyone else's. Allowed in test, refused
        # in prod -- fail closed on the environment that matters.
        if (
            self.env == "prod"
            and self.hook.forward_url
            and not self.hook.signing_secret
        ):
            msg = (
                "hook.signing_secret is required when hook.forward_url is set in prod. "
                "ACTION REQUIRED: set EXEMPLAR_HOOK__SIGNING_SECRET, or unset "
                "the forward URL."
            )
            raise ValueError(msg)

        return self


def load_settings(
    *,
    env: Environment = "test",
    secrets_dir: Path | None = None,
    configure_logging: bool = True,
    # `Any` is correct here and narrowing it would be a lie.
    # These are arbitrary Settings field overrides for tests, so the accepted
    # type is genuinely "whatever Settings accepts", which is not expressible
    # without duplicating the model. Pydantic validates every one of them at
    # construction, so nothing untyped survives past this call: an override with
    # the wrong shape raises with the field name, exactly like a bad config file.
    #
    # This comment is the point: a bare suppression with no stated reason is how
    # one outlives the thing it suppressed -- see STANDARDS-python.md ## Typing.
    **overrides: Any,  # ruff: ignore[any-type]
) -> Settings:
    """Build the application's settings and configure logging.

    The sanctioned entry point. Every application's ``main`` calls this exactly
    once, before constructing anything else.

    Args:
        env: Which environment's config layer to load.
        secrets_dir: Where the JSON layers live. Defaults to ``secrets/`` at the
            project root; overridable so tests never touch the real directory.
        configure_logging: Set up logging sinks as part of loading. True in
            every real entry point. Tests that build settings to inspect values
            pass False to avoid reconfiguring sinks for the whole session.
        **overrides: Highest-precedence values, for tests.

    Returns:
        Validated settings.

    Raises:
        ValueError: A config file is malformed, or a validation rule failed.
            Deliberately not caught -- an application whose configuration is
            wrong must not start, because every later failure would be a
            confusing symptom of this one cause.
        json.JSONDecodeError: A config file exists but is not valid JSON.
            Raised by pydantic-settings while reading the layer, and likewise
            not caught: a malformed config silently falling back to defaults is
            how a deployment runs with settings nobody chose.

    Example:
        >>> settings = load_settings(env="test", configure_logging=False)
        >>> settings.ports.monitor
        7140
    """
    # Bind the JSON layers before construction. `settings_customise_sources` is
    # a classmethod and reads these; see the note there for why the coupling
    # exists and why this function is the only place allowed to create it.
    Settings._secrets_dir = (
        secrets_dir if secrets_dir is not None else PROJECT_ROOT / "secrets"
    )
    Settings._env_name = env

    # `env` is passed explicitly so the caller's choice outranks any file that
    # names a different one -- a file claiming otherwise is stale. Everything
    # else comes from the source chain: env vars, then the JSON layers, then
    # field defaults, merged by pydantic-settings.
    settings = Settings(env=env, **overrides)

    if configure_logging:
        setup_logging(settings.logging, app_name="exemplar", env=settings.env)

    return settings
