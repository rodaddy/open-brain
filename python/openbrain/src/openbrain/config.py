"""Validated settings for every Open Brain process, and the logging setup.

Purpose:
    The single place a setting is defined, and the single place logging is
    configured. Every other module receives a typed ``Settings`` object; none of
    them reads the environment for itself, and none of them configures a sink.

Architecture:
    One ``BaseSettings`` subclass per concern, composed into ``Settings``.
    Pydantic does the coercion, the validation, and the error messages, so the
    same integer-parsing and "is this a positive number" logic is not rewritten
    per setting.

    Nested models bind to environment variables through a delimiter, so
    ``OPENBRAIN_DATABASE__HOST`` reaches ``Settings.database.host``. The legacy
    flat spellings this repo already uses (``DB_HOST``, ``PORT``) are attached
    per field as validation aliases, so existing deployments keep working
    without a second definition of the same setting.

    THIS MODULE IS THE KEYSTONE. ``load_settings`` validates the environment and
    then calls ``setup_logging``, so a process that has settings necessarily has
    logging, in that order, once. ``utils.logging_config`` is the only consumer
    of ``LogSettings``, and this is its only caller. Nothing else configures a
    sink; a module that wants to log imports the logger and uses it.

Key Components:
    - DatabaseSettings: connection coordinates and pool size
    - EmbeddingSettings: provider endpoint, model, and segmentation
    - LogSettings: level, sinks, and rotation
    - ServerSettings: bind address, port, and origins
    - Settings: the composed object every module receives
    - ConfigurationError: raised with the remediation, not just the complaint
    - load_settings: read, validate, and start logging -- once, at process start

Pattern/Convention:
    A setting is declared here and nowhere else. A module that needs one
    receives it; it does not reach for ``os.environ``.

    Validation happens at ``load_settings``, at process start, with the field
    named. A malformed value must never become a ``None`` that surfaces far
    from its cause -- that is how a bad integer becomes a ``NaN`` three call
    frames away from the typo that caused it.

    Every error here states the remediation, not only the complaint. "ACTION
    REQUIRED: set OPENBRAIN_DB_HOST" is actionable; "invalid configuration" sends
    the reader to the source to find out what the process wanted.

    Nothing here bounds content. These settings configure endpoints, timeouts,
    credentials, and feature flags. What Open Brain may remember is not
    configurable; see ``docs/CODING_STANDARDS.md`` section 6.

Example:
    >>> settings = load_settings()
    >>> settings.database.port
    5432
    >>> settings.embedding.dimensions
    768

See Also:
    - ``docs/CONFIG_REFERENCE.md`` - every variable, and where it is read today
    - ``docs/CODING_STANDARDS.md`` - section 3 typing, section 6 recall
    - ``docs/standards/STANDARDS-python.md`` - the keystone pattern
    - ``openbrain.utils.logging_config`` - the sinks this module starts
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Annotated

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from openbrain.utils.logging_config import setup_logging

#: Environment prefix for the nested form (``OPENBRAIN_DATABASE__HOST``).
#:
#: The repo currently uses both ``OPEN_BRAIN_*`` and ``OPENBRAIN_*`` for
#: different settings, which is why several fields below carry more than one
#: alias. New settings use this prefix only.
ENV_PREFIX = "OPENBRAIN_"

#: Separator between a nested model and its field in an environment variable.
ENV_NESTED_DELIMITER = "__"

#: A positive integer. Used for ports, pool sizes, and dimensions, where zero
#: and negative values are always a configuration error rather than a
#: meaningful "off" switch.
PositiveInt = Annotated[int, Field(gt=0)]

#: A positive number of milliseconds.
PositiveMs = Annotated[int, Field(gt=0)]


class ConfigurationError(ValueError):
    """A setting is missing, malformed, or inert, and the process cannot start.

    Carries the remediation with the diagnosis. Subclasses own their message
    text so a ``raise`` site stays one line and the wording lives with the type
    that means it -- the same reason ruff's TRY003 refuses long inline messages.

    Inherits ``ValueError`` so a pydantic ``model_validator`` can raise it:
    pydantic wraps ``ValueError`` from a validator into a ``ValidationError``
    naming the field, and would let any other exception type escape unwrapped.
    """


class OverlapExceedsSegmentError(ConfigurationError):
    """Segment overlap is not smaller than the segment, so nothing advances.

    An overlap greater than or equal to the segment size means each segment
    restates the whole of the one before it. That is an infinite loop, not a
    slow configuration.
    """

    def __init__(self, overlap: int, segment: int) -> None:
        """Name both values, since the wrong one is not knowable from here."""
        super().__init__(
            f"segment_overlap_chars ({overlap}) must be smaller than "
            f"segment_chars ({segment}); an overlap at or above the segment "
            f"size never advances through the text. "
            f"ACTION REQUIRED: lower OPENBRAIN_EMBEDDING__SEGMENT_OVERLAP_CHARS "
            f"below {segment}, or raise OPENBRAIN_EMBEDDING__SEGMENT_CHARS "
            f"above {overlap}."
        )


class InertRotationSettingError(ConfigurationError):
    """Log rotation is configured with no file sink to rotate.

    A setting that silently does nothing is how an operator comes to believe
    rotation is configured when it is not. The existing TypeScript
    operator-doctor reports this as a diagnostic
    (``src/operator-doctor.ts:410``); here it stops the process.
    """

    def __init__(self, names: str) -> None:
        """Name which rotation settings were set without a sink."""
        super().__init__(
            f"log rotation ({names}) is set but log.file is not; rotation "
            f"settings do nothing without a file sink. "
            f"ACTION REQUIRED: set OPENBRAIN_LOG_FILE to a writable path, or "
            f"unset {names}."
        )


class UnknownEnvironmentVariableError(ConfigurationError):
    """A prefixed environment variable matches no declared setting.

    A typo'd setting is worse than a rejected one: the process runs on defaults
    while its operator believes it is configured, and nothing anywhere says
    otherwise.
    """

    def __init__(self, names: tuple[str, ...]) -> None:
        """List every unrecognised name, so one run finds all the typos."""
        joined = ", ".join(names)
        super().__init__(
            f"unrecognised Open Brain environment variable(s): {joined}. "
            f"Every setting is declared in openbrain.config; a prefixed "
            f"variable matching none of them is a typo, and a typo that loads "
            f"silently leaves the process running on defaults. "
            f"ACTION REQUIRED: correct the spelling against "
            f"docs/CONFIG_REFERENCE.md, or remove the variable."
        )


class _Base(BaseSettings):
    """Shared settings behaviour.

    ``extra="forbid"`` rejects an unrecognised key passed to the constructor.

    It does NOT reject an unrecognised environment variable carrying the prefix.
    Measured 2026-07-30: with ``env_prefix="OPENBRAIN_"`` and ``extra="forbid"``,
    ``OPENBRAIN_NOPE=1`` loads clean. pydantic-settings only collects variables
    matching a declared field, so a typo is invisible to the model. Catching
    that needs an explicit scan of the environment -- see
    :func:`unknown_prefixed_variables`.
    """

    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_nested_delimiter=ENV_NESTED_DELIMITER,
        extra="forbid",
        frozen=True,
    )


class DatabaseSettings(_Base):
    """PostgreSQL connection coordinates.

    Attributes:
        host: Database host. Required -- there is no default, because a wrong
            default host is worse than a startup failure. Never hardcode this.
        port: Database port.
        name: Database name.
        user: Database role.
        password: Database password, held as a ``SecretStr`` so it does not
            appear in a repr, a log line, or a traceback.
        pool_max: Maximum pooled connections.
    """

    host: str = Field(validation_alias=AliasChoices("OPENBRAIN_DB_HOST", "DB_HOST"))
    port: PositiveInt = Field(
        default=5432,
        validation_alias=AliasChoices("OPENBRAIN_DB_PORT", "DB_PORT"),
    )
    name: str = Field(
        default="open_brain",
        validation_alias=AliasChoices("OPENBRAIN_DB_NAME", "DB_NAME"),
    )
    user: str = Field(validation_alias=AliasChoices("OPENBRAIN_DB_USER", "DB_USER"))
    password: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENBRAIN_DB_PASSWORD", "DB_PASSWORD"),
    )
    pool_max: PositiveInt = Field(
        default=10,
        validation_alias=AliasChoices("OPENBRAIN_DB_POOL_MAX", "DB_POOL_MAX"),
    )


class EmbeddingSettings(_Base):
    """Embedding provider configuration and text segmentation.

    Attributes:
        base_url: OpenAI-compatible ``/v1/embeddings`` endpoint.
        api_key: Provider credential, held as a ``SecretStr``.
        model: Model name as the provider knows it.
        dimensions: Vector width. Schema-coupled to the ``halfvec(768)``
            columns; changing it requires a column migration and a full
            re-embed. Not a tuning knob.
        timeout_ms: Wall-clock allowance for one embedding request.
        segment_chars: Size of each segment when text is longer than one
            request should carry.
        segment_overlap_chars: Overlap between consecutive segments, so a
            sentence spanning a boundary is embedded intact at least once.

    Segmentation is how long text is embedded, NOT a rule about what may be
    stored. Text longer than ``segment_chars`` is split, each segment embedded,
    and the vectors combined length-weighted then normalised. The complete text
    is stored whole regardless. See ``docs/CODING_STANDARDS.md`` section 6.
    """

    base_url: str = Field(
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_BASE_URL", "EMBEDDING_BASE_URL"
        )
    )
    api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_API_KEY", "EMBEDDING_API_KEY"
        ),
    )
    model: str = Field(
        default="embeddinggemma-300m-8bit",
        validation_alias=AliasChoices("OPENBRAIN_EMBEDDING_MODEL", "EMBEDDING_MODEL"),
    )
    dimensions: PositiveInt = Field(
        default=768,
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_DIMENSIONS", "EMBEDDING_DIMENSIONS"
        ),
    )
    timeout_ms: PositiveMs = Field(
        default=8_000,
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_TIMEOUT_MS", "EMBEDDING_TIMEOUT_MS"
        ),
    )
    segment_chars: PositiveInt = Field(default=6_000)
    segment_overlap_chars: int = Field(default=1_200, ge=0)

    @model_validator(mode="after")
    def _overlap_fits_within_segment(self) -> EmbeddingSettings:
        """Reject an overlap that is not smaller than the segment itself.

        Raises:
            OverlapExceedsSegmentError: When segmentation could never advance.
        """
        if self.segment_overlap_chars >= self.segment_chars:
            raise OverlapExceedsSegmentError(
                self.segment_overlap_chars, self.segment_chars
            )
        return self


class LogSettings(_Base):
    """Structured logging configuration.

    Consumed only by :func:`openbrain.utils.logging_config.setup_logging`,
    which :func:`load_settings` calls. Nothing else reads this model.

    Attributes:
        level: Minimum level emitted.
        file: Rotating file sink path, or ``None`` for no file sink.
        max_bytes: Rotation size when ``file`` is set.
        max_files: Retained rotations when ``file`` is set.
        json_file: Structured JSON sink path, or ``None`` for no JSON sink.
        serialize: Emit the console sink as JSON rather than human-readable.
        service_name: Service field on every log envelope.
        worker_name: Worker suffix, for deployments running more than one.
    """

    level: str = Field(
        default="INFO",
        validation_alias=AliasChoices("OPENBRAIN_LOG_LEVEL", "LOG_LEVEL"),
    )
    file: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENBRAIN_LOG_FILE", "LOG_FILE"),
    )
    max_bytes: PositiveInt = Field(
        default=1_000_000,
        validation_alias=AliasChoices("OPENBRAIN_LOG_MAX_BYTES", "LOG_MAX_BYTES"),
    )
    max_files: int = Field(
        default=3,
        ge=0,
        validation_alias=AliasChoices("OPENBRAIN_LOG_MAX_FILES", "LOG_MAX_FILES"),
    )
    json_file: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENBRAIN_LOG_JSON_FILE", "LOG_JSON_FILE"),
    )
    serialize: bool = Field(default=True)
    service_name: str = Field(
        default="open-brain",
        validation_alias=AliasChoices("OPENBRAIN_SERVICE_NAME", "SERVICE_NAME"),
    )
    worker_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENBRAIN_WORKER_NAME", "OPEN_BRAIN_WORKER_NAME"
        ),
    )

    @model_validator(mode="after")
    def _rotation_requires_a_file(self) -> LogSettings:
        """Fail when rotation is configured with nothing to rotate.

        Raises:
            InertRotationSettingError: When rotation is set without a sink.
        """
        if self.file is not None:
            return self

        explicit = self.model_fields_set & {"max_bytes", "max_files"}
        if explicit:
            raise InertRotationSettingError(", ".join(sorted(explicit)))
        return self


class ServerSettings(_Base):
    """HTTP server binding.

    Attributes:
        port: Listen port.
        bind_host: Interface to bind, or ``None`` for the runtime default.
        allowed_origins: CORS origins. Empty means none are permitted.
        run_migrations: Apply pending migrations at start.
    """

    port: PositiveInt = Field(
        default=3_100,
        validation_alias=AliasChoices("OPENBRAIN_PORT", "PORT"),
    )
    bind_host: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENBRAIN_BIND_HOST", "OPEN_BRAIN_BIND_HOST"),
    )
    allowed_origins: tuple[str, ...] = Field(
        default=(),
        validation_alias=AliasChoices("OPENBRAIN_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"),
    )
    run_migrations: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "OPENBRAIN_RUN_MIGRATIONS", "OPEN_BRAIN_RUN_MIGRATIONS"
        ),
    )


class Settings(_Base):
    """The complete configuration, composed from its parts.

    Every module receives this object. Construct it once, at process start,
    through :func:`load_settings`.
    """

    database: DatabaseSettings
    embedding: EmbeddingSettings
    log: LogSettings = Field(default_factory=LogSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)


def _accepted_variable_names() -> frozenset[str]:
    """Every environment variable name the settings models recognise.

    Collects each field's declared aliases plus its prefixed default spelling,
    across every settings model. This is derived from the models themselves, so
    it cannot drift from them the way a hand-maintained list would.
    """
    names: set[str] = set()

    for model in (
        DatabaseSettings,
        EmbeddingSettings,
        LogSettings,
        ServerSettings,
    ):
        prefix = model.model_config.get("env_prefix", "")
        for field_name, field in model.model_fields.items():
            names.add(f"{prefix}{field_name}".upper())

            alias = field.validation_alias
            if isinstance(alias, str):
                names.add(alias.upper())
            elif isinstance(alias, AliasChoices):
                names.update(
                    choice.upper()
                    for choice in alias.choices
                    if isinstance(choice, str)
                )

    return frozenset(names)


def unknown_prefixed_variables(environ: Mapping[str, str]) -> tuple[str, ...]:
    """Return prefixed environment variables that no setting recognises.

    ``extra="forbid"`` does not do this: pydantic-settings collects only the
    variables matching a declared field, so ``OPENBRAIN_NOPE=1`` is invisible to
    the model and loads clean. Measured 2026-07-30.

    Args:
        environ: The environment to inspect.

    Returns:
        The unrecognised names, sorted. Empty when everything is recognised.
    """
    accepted = _accepted_variable_names()
    return tuple(
        sorted(
            name
            for name in environ
            if name.upper().startswith(ENV_PREFIX) and name.upper() not in accepted
        )
    )


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Read the configuration, validate it, and start logging. Once, at start.

    The order is the point: settings are validated first, so a configuration
    failure reports through the process's own stderr rather than through a
    half-configured logger; then logging starts, so everything after this call
    logs into the configured sinks.

    Args:
        environ: Environment to read for the unknown-variable check. Defaults to
            the live process environment. The models themselves always read the
            live environment; this argument exists so the check is testable.

    Returns:
        The validated settings, with logging already configured.

    Raises:
        UnknownEnvironmentVariableError: When a prefixed variable matches no
            setting.
        pydantic.ValidationError: On any missing or malformed setting, naming
            the field. Raised here, at start, rather than at first use.
    """
    source = os.environ if environ is None else environ

    unknown = unknown_prefixed_variables(source)
    if unknown:
        raise UnknownEnvironmentVariableError(unknown)

    settings = Settings(
        database=DatabaseSettings(),  # type: ignore[call-arg]
        embedding=EmbeddingSettings(),  # type: ignore[call-arg]
    )

    setup_logging(settings.log)
    return settings
