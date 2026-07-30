"""Validated settings for every Open Brain process.

Purpose:
    The single place a setting is defined. Every other module receives a typed
    ``Settings`` object; none of them reads the environment for itself.

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

Key Components:
    - DatabaseSettings: connection coordinates and pool size
    - EmbeddingSettings: provider endpoint, model, and segmentation
    - LogSettings: level, sink, and rotation
    - ServerSettings: bind address, port, and origins
    - Settings: the composed object every module receives
    - load_settings: read and validate once, at start

Pattern/Convention:
    A setting is declared here and nowhere else. A module that needs one
    receives it; it does not reach for ``os.environ``.

    Validation happens at ``load_settings``, at process start, with the field
    named. A malformed value must never become a ``None`` that surfaces far
    from its cause -- that is how a bad integer becomes a ``NaN`` three call
    frames away from the typo that caused it.

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
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Annotated

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

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
        timeout_ms: Wall-clock ceiling on one embedding request.
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

        An overlap greater than or equal to the segment size means each segment
        restates the whole of the one before it, so segmentation never advances
        through the text. That is an infinite loop, not a slow configuration.
        """
        if self.segment_overlap_chars >= self.segment_chars:
            raise ValueError(
                f"segment_overlap_chars ({self.segment_overlap_chars}) must be "
                f"smaller than segment_chars ({self.segment_chars}); an overlap "
                f"at or above the segment size never advances through the text"
            )
        return self


class LogSettings(_Base):
    """Structured logging configuration.

    Attributes:
        level: Minimum level emitted.
        file: Sink path, or ``None`` for stdout only.
        max_bytes: Rotation size when ``file`` is set.
        max_files: Retained rotations when ``file`` is set.
        serialize: Emit JSON rather than human-readable lines.
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
        """Warn-by-failing when rotation is configured with nothing to rotate.

        ``LOG_MAX_BYTES`` and ``LOG_MAX_FILES`` do nothing without ``LOG_FILE``.
        The existing TypeScript operator-doctor reports this as a diagnostic
        (``src/operator-doctor.ts:410``); here it is a startup error, because a
        setting that silently does nothing is how an operator comes to believe
        rotation is configured when it is not.
        """
        if self.file is None:
            explicit = self.model_fields_set & {"max_bytes", "max_files"}
            if explicit:
                names = ", ".join(sorted(explicit))
                raise ValueError(
                    f"log rotation ({names}) is set but log.file is not; "
                    f"rotation settings do nothing without a file sink"
                )
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

    A typo'd setting is worse than a rejected one. The process runs on defaults
    while its operator believes it is configured, and nothing anywhere says
    otherwise.

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
    """Read and validate the configuration once.

    Args:
        environ: Environment to read for the unknown-variable check. Defaults to
            the live process environment. The models themselves always read the
            live environment; this argument exists so the check is testable.

    Returns:
        The validated settings.

    Raises:
        ValueError: When a prefixed environment variable matches no setting.
        pydantic.ValidationError: On any missing or malformed setting, naming
            the field. Raised here, at start, rather than at first use.
    """
    source = os.environ if environ is None else environ

    unknown = unknown_prefixed_variables(source)
    if unknown:
        joined = ", ".join(unknown)
        raise ValueError(
            f"unrecognised Open Brain environment variable(s): {joined}. "
            f"Every setting is declared in openbrain.config.settings; a "
            f"prefixed variable matching none of them is a typo, and a typo "
            f"that loads silently leaves the process running on defaults."
        )

    return Settings(
        database=DatabaseSettings(),  # type: ignore[call-arg]
        embedding=EmbeddingSettings(),  # type: ignore[call-arg]
    )
