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
    - CaptureSettings: where a hook sends turns, and its watermark store
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
    - ``_DOCS/STANDARDS-python.md`` - the keystone pattern
    - ``openbrain.utils.logging_config`` - the sinks this module starts
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, ClassVar

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)
from pydantic.fields import FieldInfo
from pydantic_settings import (
    BaseSettings,
    JsonConfigSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

from openbrain.utils.logging_config import setup_logging

#: Repository root, derived from this file's location:
#: src/openbrain/config.py -> src/openbrain -> src -> <package root>.
#: Derived rather than configured, because a configurable path to the config is
#: a bootstrap problem.
PACKAGE_ROOT = Path(__file__).resolve().parents[2]

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


class _Base(BaseModel):
    """Shared behaviour for every settings section.

    ``BaseModel``, deliberately NOT ``BaseSettings``. Only :class:`Settings` is
    a ``BaseSettings``, and it holds the single environment source for the whole
    tree. This is the exemplar's shape
    (``docs/standards/python-exemplar/src/exemplar/config.py:131``) and the
    reason its documented precedence is true.

    MEASURED 2026-07-30, and the whole reason this is not ``BaseSettings``:
    when each section was its own ``BaseSettings`` with ``env_prefix``, each got
    an INDEPENDENT environment source that ran while the section was being
    constructed -- before :class:`Settings` ever consulted its own chain. A
    ``config.json`` supplying ``database.host`` then beat ``DB_HOST`` in the
    environment, which is the exact inversion
    ``_DOCS/STANDARDS-python.md:182`` documents:

        db.host = from-json.example     (env said from-env.example)

    Sections are plain models; the environment reaches them through
    :class:`LegacyFlatEnvSource` and the nested delimiter, both of which sit in
    ``Settings``' source chain where they can be ordered against the files.

    ``extra="forbid"`` rejects an unrecognised key in a config layer, so a typo
    in ``config.json`` fails loudly rather than sitting inert.
    """

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        # A `validation_alias` REPLACES the field name rather than adding to it,
        # so without this a JSON layer would have to spell keys `OPENBRAIN_DB_HOST`
        # instead of `host`, and `{"host": ...}` would be rejected as an extra.
        # Measured 2026-07-30, both errors at once:
        #
        #   database.OPENBRAIN_DB_HOST  Field required
        #   database.host               Extra inputs are not permitted
        populate_by_name=True,
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
    # Aliased like every other field. Without a declared alias a setting has no
    # environment spelling at all: LegacyFlatEnvSource maps by alias, so the
    # field exists in the model and cannot be set by an operator. Found
    # 2026-07-30 when a test tried to set them.
    segment_chars: PositiveInt = Field(
        default=6_000,
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_SEGMENT_CHARS", "EMBEDDING_SEGMENT_CHARS"
        ),
    )
    segment_overlap_chars: int = Field(
        default=1_200,
        ge=0,
        validation_alias=AliasChoices(
            "OPENBRAIN_EMBEDDING_SEGMENT_OVERLAP_CHARS",
            "EMBEDDING_SEGMENT_OVERLAP_CHARS",
        ),
    )

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


class CaptureSettings(_Base):
    """Where a hook sends captured turns, and who it says it is.

    The live capture adapter (``apps/hooks/stop.py``) needs three coordinates to
    reach the raw lane through ``openbrain_memory``, plus one local path for its
    watermark store. None of them bounds content; they are endpoint, credential,
    identity, and a file location.

    There is no namespace field. The capture factory transmits no namespace --
    the client sends ``X-Namespace`` only under ``delegate_namespace=True``, and
    passes no per-call namespace -- so the server writes to the token's own
    namespace (``src/tools/ingest-raw-turn.ts``: ``args.namespace ??
    auth.clientId``). A field the factory never sends would be dead config, so
    the namespace is not configurable here.

    ``base_url`` and ``token`` are OPTIONAL here, and the reason is the same one
    ``database`` uses a factory for: a process that never runs a hook -- the
    HTTP server, a migration -- must load without capture being configured. The
    requirement is enforced at USE time, in ``apps.hooks.session``, where a
    missing value raises a named error the entrypoint swallows. A required field
    here would instead fail every unrelated process at startup, and there is no
    correct default for either: a default endpoint sends a developer's turns to
    the wrong brain, and a default token is a credential in source.

    Attributes:
        base_url: The Open Brain service this hook writes to, or ``None`` when
            capture is not configured. Never hardcode a host
            (``open-brain/CLAUDE.md``).
        token: The bearer token, held as a ``SecretStr`` so it never reaches a
            log line, repr, or traceback, or ``None`` when capture is not
            configured.
        agent_id: How this capturer identifies itself to the server. This is
            identity for attribution, not authorisation -- the row lands in the
            token's namespace regardless (``src/tools/ingest-raw-turn.ts``).
        watermark_path: The SQLite file holding each session's read offset. A
            hook is a short-lived process, so this position must survive between
            invocations on disk; it is the one piece of local state capture
            keeps.
    """

    base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENBRAIN_CAPTURE_BASE_URL", "OPENBRAIN_BASE_URL"
        ),
    )
    token: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENBRAIN_CAPTURE_TOKEN", "OPENBRAIN_TOKEN"
        ),
    )
    agent_id: str = Field(
        default="openbrain-capture",
        validation_alias=AliasChoices(
            "OPENBRAIN_CAPTURE_AGENT_ID", "OPENBRAIN_CAPTURE_AGENT"
        ),
    )
    watermark_path: Path = Field(
        default=PACKAGE_ROOT / "data" / "capture-watermarks.sqlite",
        validation_alias=AliasChoices("OPENBRAIN_CAPTURE_WATERMARK_PATH"),
    )


class CanonSettings(_Base):
    """Where the ``SessionStart`` hook reads canon from, and the scope it reads under.

    Canon is the always-known layer -- who Rico is, the rules, this repo's facts
    -- that the ``SessionStart`` hook injects at the top of every session. It is
    the DEFAULT of ``agent_context_pack``: exactly the three structured-guidance
    sections (``profile_guidance``, ``process_guidance``, ``repo_facts``) and
    NOTHING episodic. Back-history -- lane events, working set, durable recall --
    is explicit-on-request (the resume flow) precisely because auto-loading it
    contaminates a fresh start (``_plans/canon-always-known.md`` "Default: canon
    only"; ``_ob/skills/brain/workflows/canon.md``).

    ``base_url`` and ``token`` share the SAME aliases capture uses
    (``OPENBRAIN_BASE_URL`` / ``OPENBRAIN_TOKEN``) because both reach the one
    Open Brain service the environment already points at; a canon-specific
    endpoint is a separate override for the rare case they diverge. They are
    OPTIONAL for the same reason capture's are: a non-hook process must load
    without them, and the requirement is enforced at use time in
    ``apps.hooks.session`` where a missing value raises a named error the
    entrypoint swallows -- an unconfigured canon declines to inject, it does not
    break the session it opens.

    The scope coordinates carry canon.md's own defaults verbatim
    (``platform=claude-code``, ``server_id=local``, ``channel_id=cli``,
    ``session_key=dev:open-brain``, ``repo=open-brain``). ``repo`` binds
    ``repo_facts`` EXACTLY -- the server never falls back to another repository
    (``src/tools/agent-context-pack.ts``), which is the "scoped, never falls back"
    property the canon model requires.

    ``sections`` is the override the ruling permits: it may widen or narrow the
    requested sections explicitly, but its DEFAULT is canon-only. Nothing here
    bounds content -- there is no size, truncation, or token field, by design.

    Attributes:
        base_url: The Open Brain service the hook reads canon from, or ``None``
            when unconfigured. Never hardcode a host (``open-brain/CLAUDE.md``).
        token: The bearer token, held as a ``SecretStr``, or ``None`` when
            unconfigured.
        agent: The agent identity sent as the pack's ``agent`` scope field.
        platform: The runtime platform scope field.
        server_id: The server/workspace scope field.
        channel_id: The channel scope field.
        session_key: The stable active-session scope field.
        repo: The repository slug ``repo_facts`` binds to exactly.
        sections: The sections to request. The canon-only default is the three
            structured-guidance sections; an operator may override it.
    """

    base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENBRAIN_CANON_BASE_URL", "OPENBRAIN_BASE_URL"
        ),
    )
    token: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENBRAIN_CANON_TOKEN", "OPENBRAIN_TOKEN"),
    )
    agent: str = Field(
        default="claude",
        validation_alias=AliasChoices("OPENBRAIN_CANON_AGENT"),
    )
    platform: str = Field(
        default="claude-code",
        validation_alias=AliasChoices("OPENBRAIN_CANON_PLATFORM"),
    )
    server_id: str = Field(
        default="local",
        validation_alias=AliasChoices("OPENBRAIN_CANON_SERVER_ID"),
    )
    channel_id: str = Field(
        default="cli",
        validation_alias=AliasChoices("OPENBRAIN_CANON_CHANNEL_ID"),
    )
    session_key: str = Field(
        default="dev:open-brain",
        validation_alias=AliasChoices("OPENBRAIN_CANON_SESSION_KEY"),
    )
    repo: str = Field(
        default="open-brain",
        validation_alias=AliasChoices("OPENBRAIN_CANON_REPO"),
    )
    #: The canon-only default: exactly the three structured-guidance sections the
    #: canon model names (``_plans/canon-always-known.md`` "The three lanes
    #: already exist"). NO episodic section -- no working_set, durable_memory,
    #: durable_lane_context, recovery, candidate_memory, or pointers -- because
    #: auto-loading back-history poisons a fresh start.
    sections: tuple[str, ...] = Field(
        default=("profile_guidance", "process_guidance", "repo_facts"),
        validation_alias=AliasChoices("OPENBRAIN_CANON_SECTIONS"),
    )

    @field_validator("sections", mode="before")
    @classmethod
    def _split_sections(cls, value: object) -> object:
        """Accept a comma- or space-separated string for the section override.

        The environment layer hands ``sections`` in as a plain string
        (``OPENBRAIN_CANON_SECTIONS=profile_guidance,repo_facts``); pydantic's
        default tuple coercion would treat that string as an iterable of
        characters. Split it on commas and whitespace, dropping empties, so the
        env override behaves like the CSV an operator writes. A tuple or list
        passed in code (as tests and the default do) is returned untouched.
        """
        if isinstance(value, str):
            return tuple(
                part for chunk in value.split(",") for part in chunk.split() if part
            )
        return value


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


#: The sections of :class:`Settings`, paired with the attribute each populates.
#:
#: ONE declaration, read by both :class:`LegacyFlatEnvSource` (which maps flat
#: variables onto these paths) and :func:`_accepted_variable_names` (which
#: decides whether a prefixed variable is a typo). Two hand-maintained lists
#: would drift, and the drift would present as "my setting does nothing" with
#: no error to search for.
#:
#: A section added to :class:`Settings` and not added here gets no flat
#: variables and no typo checking, silently -- so this tuple is asserted against
#: ``Settings.model_fields`` in ``tests/test_settings.py``.
_SECTION_MODELS: tuple[tuple[str, type[BaseModel]], ...] = (
    ("database", DatabaseSettings),
    ("embedding", EmbeddingSettings),
    ("capture", CaptureSettings),
    ("canon", CanonSettings),
    ("logging", LogSettings),
    ("server", ServerSettings),
)


class LegacyFlatEnvSource(PydanticBaseSettingsSource):
    """Map this repo's flat environment variables onto nested settings paths.

    ``DB_HOST`` becomes ``database.host``; ``PORT`` becomes ``server.port``.

    WHY THIS EXISTS. The flat spellings are the contract the running service
    already uses -- ``docs/CONFIG_REFERENCE.md`` records all 61 variables read
    across the codebase, and every one is flat. ``.env``,
    ``open-brain-local/local-clone.env``, ``play.env``, and the launchd plists
    all carry them. Requiring ``OPENBRAIN_DATABASE__HOST`` instead would mean
    rewriting every one of those before the Python service could start, so the
    flat names are kept and adapted here.

    A parent ``BaseSettings`` does NOT consult a nested ``BaseModel`` field's
    own ``validation_alias``. Measured 2026-07-30: with ``DB_HOST=env.example``
    set and ``Db.host`` declaring that alias, ``S().database.host`` returned the
    field default. The alias is only honoured when the section itself does the
    reading -- which is what made each section its own ``BaseSettings``, which
    is what broke precedence. This source is how the aliases are honoured
    without giving any section an independent environment source.

    The map is DERIVED from the field declarations rather than hand-written, so
    it cannot drift from them: adding an alias to a field is all it takes for
    that spelling to work here.
    """

    def __init__(
        self,
        settings_cls: type[BaseSettings],
        environ: Mapping[str, str],
    ) -> None:
        """Capture the environment to read.

        Args:
            settings_cls: The settings class being built.
            environ: Environment to read. Passed explicitly rather than taken
                from ``os.environ`` so the source is testable without mutating
                the process.
        """
        super().__init__(settings_cls)
        self._environ = environ

    def get_field_value(
        self, field: FieldInfo, field_name: str
    ) -> tuple[object, str, bool]:
        """Unused: this source supplies whole sections, not single fields.

        Required by the ``PydanticBaseSettingsSource`` interface. Returning
        "not found" is correct -- ``__call__`` below does the actual work.
        """
        return None, field_name, False

    def __call__(self) -> dict[str, object]:
        """Collect every flat variable present, grouped by section.

        Returns:
            A nested mapping of section name to the fields this source found.
            Sections with nothing set are omitted entirely, so this source never
            overrides a field it has no value for.
        """
        collected: dict[str, object] = {}

        for section_name, model in _SECTION_MODELS:
            values = self._section_values(model)
            if values:
                collected[section_name] = values

        return collected

    def _section_values(self, model: type[BaseModel]) -> dict[str, object]:
        """Read one section's fields out of the environment by their aliases.

        The first alias that is present wins, in declaration order, so
        ``OPENBRAIN_DB_HOST`` takes precedence over the older ``DB_HOST`` when
        both are set.
        """
        return _resolve_section_from_env(model, self._environ)


def _resolve_section_from_env(
    model: type[BaseModel], environ: Mapping[str, str]
) -> dict[str, object]:
    """Map one section model's fields from the environment by their aliases.

    The first alias present wins, in declaration order, so ``OPENBRAIN_DB_HOST``
    takes precedence over the older ``DB_HOST`` when both are set. Shared by
    :class:`LegacyFlatEnvSource` (which does this for every section) and
    :func:`load_capture_settings` (which does it for capture alone, without
    building the rest of the tree), so the two cannot drift.
    """
    values: dict[str, object] = {}

    for field_name, field in model.model_fields.items():
        for candidate in _alias_names(field):
            if candidate in environ:
                values[field_name] = environ[candidate]
                break

    return values


class Settings(BaseSettings):
    """The complete configuration, composed from its parts.

    Every module receives this object. Construct it once, at process start,
    through :func:`load_settings`.

    LOAD ORDER, highest precedence first:

    1. Keyword arguments passed to ``Settings(...)`` -- tests only.
    2. ``OPENBRAIN_``-prefixed environment variables, and the legacy flat
       spellings each field declares as a validation alias.
    3. ``secrets/config.<env>.json`` -- the per-environment layer.
    4. ``secrets/config.json`` -- the shared base layer.
    5. Field defaults declared above.

    A reader must never have to trace code to learn whether an environment
    variable beats a file. It does, and that is a property of the source chain
    in :meth:`settings_customise_sources` rather than a claim in prose.

    The two JSON layers are deep-merged by pydantic-settings, so a
    per-environment file that sets only ``log.level`` leaves its sibling log
    fields intact. Merging them by hand and passing the result to
    ``Settings(**values)`` is the documented failure this avoids: init kwargs
    are pydantic's HIGHEST-priority source, so the files would silently outrank
    the environment -- the exact reverse of the order above, with nothing
    logged. See ``_DOCS/STANDARDS-python.md`` on config.py.
    """

    #: Where the JSON layers live, and which environment's layer to load. Set by
    #: :func:`load_settings` immediately before construction, read by
    #: :meth:`settings_customise_sources`.
    #:
    #: ClassVar so pydantic treats these as plain class attributes rather than
    #: model fields. Without the annotation they become settable config keys,
    #: and ``extra="forbid"`` starts rejecting perfectly good files that happen
    #: not to mention them.
    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_nested_delimiter=ENV_NESTED_DELIMITER,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    _secrets_dir: ClassVar[Path] = PACKAGE_ROOT / "secrets"
    _env_name: ClassVar[str] = "local"
    #: Environment read by :class:`LegacyFlatEnvSource`. Set by
    #: :func:`load_settings` so the source is testable without mutating the
    #: process environment.
    _environ: ClassVar[Mapping[str, str]] = os.environ

    # Every submodel carries a default_factory, INCLUDING the two holding
    # required fields, matching the exemplar
    # (docs/standards/python-exemplar/src/exemplar/config.py:299).
    #
    # Without one, pydantic demands a `database` key be present in some source
    # before the submodel can be built at all -- and a deployment configured
    # purely through the flat environment, which is how the live service runs
    # (.env carries DB_HOST, PORT, EMBEDDING_BASE_URL), supplies no such key.
    # The factory lets each submodel build itself from its own env aliases.
    # Required fields still fail loudly when genuinely absent, naming
    # OPENBRAIN_DB_HOST.
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)  # type: ignore[arg-type]
    embedding: EmbeddingSettings = Field(default_factory=EmbeddingSettings)  # type: ignore[arg-type]
    # No required fields -- capture is optional so a non-hook process loads
    # without it (see CaptureSettings). The factory is still used for the same
    # reason the others are: it lets the submodel build from its own env aliases
    # when no source supplies a `capture` key.
    capture: CaptureSettings = Field(default_factory=CaptureSettings)
    # No required fields -- canon is optional like capture, so a non-hook process
    # loads without it. The SessionStart hook enforces base_url/token at use time
    # (see CanonSettings and apps.hooks.session).
    canon: CanonSettings = Field(default_factory=CanonSettings)
    logging: LogSettings = Field(default_factory=LogSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)

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

        This is the mechanism behind the load order in the class docstring, and
        the reason that order is true rather than merely claimed.
        pydantic-settings walks the returned tuple and takes the first source
        supplying each value.

        It also removes any need for a hand-written recursive merge: passing a
        LIST of files with ``deep_merge=True`` makes the library layer them.

        Args:
            settings_cls: The settings class being built. Passed to the JSON
                source, which reads ``model_config`` from it.
            init_settings: Keyword arguments passed to ``Settings(...)``.
            env_settings: ``OPENBRAIN_``-prefixed environment variables.
            dotenv_settings: ``.env`` file. Deliberately unused -- the layers
                live in ``secrets/``, and two competing file conventions is one
                too many. The repo's own ``.env`` is for libpq and tooling.
            file_secret_settings: Docker-style secrets directory. Unused; the
                JSON layers cover the same need explicitly.

        Returns:
            Sources in descending precedence.
        """
        # Read from the class because this hook is a classmethod and
        # pydantic-settings offers no per-call channel to reach it.
        # `load_settings` is the only sanctioned constructor precisely so this
        # coupling has exactly one place to go wrong.
        directory = cls._secrets_dir
        env = cls._env_name

        return (
            init_settings,
            # The nested spelling: OPENBRAIN_DATABASE__HOST.
            env_settings,
            # The flat spelling the running deployment actually uses: DB_HOST.
            # ABOVE the JSON layers, so an operator exporting a variable
            # overrides a committed file -- which is the documented order, and
            # was measurably inverted before this source existed.
            LegacyFlatEnvSource(settings_cls, cls._environ),
            # Both layers as ONE source, listed lowest-precedence FIRST:
            # deep_merge applies each file over the previous, so the
            # per-environment file has to come last to win.
            #
            # A missing file is not an error here. The base layer is optional by
            # design -- a deployment configured entirely through the environment
            # is valid, and is how the current service runs.
            JsonConfigSettingsSource(
                settings_cls,
                json_file=[
                    directory / "config.json",
                    directory / f"config.{env}.json",
                ],
                deep_merge=True,
            ),
        )


def _alias_names(field: FieldInfo) -> tuple[str, ...]:
    """Every environment spelling a field declares, in declaration order.

    Order matters: :class:`LegacyFlatEnvSource` takes the first one present, so
    a field declaring ``AliasChoices("OPENBRAIN_DB_HOST", "DB_HOST")`` prefers
    the prefixed spelling when both are set.

    Args:
        field: The field to inspect.

    Returns:
        The declared alias names. Empty when the field declares none.
    """
    alias = field.validation_alias

    if isinstance(alias, str):
        return (alias,)

    if isinstance(alias, AliasChoices):
        return tuple(
            choice for choice in alias.choices if isinstance(choice, str)
        )

    return ()


def _accepted_variable_names() -> frozenset[str]:
    """Every environment variable name the settings models recognise.

    Collects each field's declared aliases, its prefixed flat spelling, and the
    nested spelling the delimiter produces. Derived from the models themselves,
    so it cannot drift from them the way a hand-maintained list would.
    """
    names: set[str] = set()

    for section_name, model in _SECTION_MODELS:
        for field_name, field in model.model_fields.items():
            # The nested form the delimiter binds: OPENBRAIN_DATABASE__HOST.
            names.add(
                f"{ENV_PREFIX}{section_name}{ENV_NESTED_DELIMITER}{field_name}".upper()
            )
            # The prefixed flat form: OPENBRAIN_HOST.
            names.add(f"{ENV_PREFIX}{field_name}".upper())
            names.update(name.upper() for name in _alias_names(field))

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


def load_settings(
    environ: Mapping[str, str] | None = None,
    *,
    env: str = "local",
    secrets_dir: Path | None = None,
    configure_logging: bool = True,
) -> Settings:
    """Read the configuration, validate it, and start logging. Once, at start.

    The order is the point: settings are validated first, so a configuration
    failure reports through the process's own stderr rather than through a
    half-configured logger; then logging starts, so everything after this call
    logs into the configured sinks.

    This is the only sanctioned way to build :class:`Settings`. Constructing it
    directly skips the environment typo check and leaves the JSON layers bound
    to whatever a previous call set.

    Args:
        environ: Environment to read for the unknown-variable check. Defaults to
            the live process environment. The models themselves always read the
            live environment; this argument exists so the check is testable.
        env: Which per-environment JSON layer to load, as
            ``secrets/config.<env>.json``.
        secrets_dir: Directory holding the JSON layers. Defaults to
            ``secrets/`` beside the package.
        configure_logging: Start the logging sinks. Tests that do not want the
            session's sinks reconfigured pass ``False``.

    Returns:
        The validated settings, with logging configured unless opted out.

    Raises:
        UnknownEnvironmentVariableError: When a prefixed variable matches no
            setting.
        pydantic.ValidationError: On any missing or malformed setting, naming
            the field. Raised here, at start, rather than at first use.
        json.JSONDecodeError: When a config layer exists but is not valid JSON.
            Deliberately not caught: a malformed config silently falling back to
            defaults is how a deployment runs on settings nobody chose.
    """
    source = os.environ if environ is None else environ

    unknown = unknown_prefixed_variables(source)
    if unknown:
        raise UnknownEnvironmentVariableError(unknown)

    # Bind the JSON layers before construction. `settings_customise_sources` is
    # a classmethod and reads these off the class; see the note there for why
    # the coupling exists and why this function is the only place allowed to
    # create it.
    Settings._secrets_dir = (
        secrets_dir if secrets_dir is not None else PACKAGE_ROOT / "secrets"
    )
    Settings._env_name = env
    Settings._environ = source

    # No submodel is constructed here, and that is load-bearing rather than
    # tidy. Building `DatabaseSettings()` eagerly and passing it in makes it an
    # init kwarg -- pydantic's HIGHEST-priority source -- so the JSON layers
    # could never supply `database` or `embedding` at all. Measured 2026-07-30:
    # with a config.json naming database.host, that spelling raised
    # "OPENBRAIN_DB_HOST Field required" because the submodel had already been
    # built from the environment alone, before Settings ran its source chain.
    #
    # Letting Settings build them means every source in the chain applies to
    # nested fields too, which is what makes the documented load order true.
    settings = Settings()

    if configure_logging:
        setup_logging(settings.logging)
    return settings


def load_capture_settings(
    environ: Mapping[str, str] | None = None,
) -> CaptureSettings:
    """Resolve ONLY the ``capture`` section, without the rest of the tree.

    The ``Stop`` hook needs capture's coordinates and nothing else, and it runs
    in a process configured for exactly that: ``OPENBRAIN_BASE_URL`` and
    ``OPENBRAIN_TOKEN`` set, and the database and embedding variables that a
    server process carries absent. ``load_settings`` cannot serve it -- that
    builds the whole :class:`Settings`, and :class:`DatabaseSettings` and
    :class:`EmbeddingSettings` have required fields (``OPENBRAIN_DB_HOST``,
    ``OPENBRAIN_EMBEDDING_BASE_URL``), so a hook with only the two capture
    variables set fails validation on config it never uses. Swallowed by the
    entrypoint, that failure is a SILENT ZERO CAPTURE on every ``Stop``.

    This reads capture's own aliases (``OPENBRAIN_CAPTURE_*`` and the
    ``OPENBRAIN_BASE_URL`` / ``OPENBRAIN_TOKEN`` shorthands) directly, through
    the same resolver :class:`LegacyFlatEnvSource` uses, so the aliases and their
    precedence match the full load exactly. It does NOT read the JSON layers:
    capture is an environment-configured hook concern, and the layers carry the
    server's settings, not a hook's.

    Args:
        environ: Environment to read. Defaults to the live process environment;
            the argument exists so the resolver is testable without mutating it.

    Returns:
        The validated :class:`CaptureSettings`. ``base_url`` and ``token`` are
        ``None`` when unset, exactly as under the full load -- the requirement is
        enforced at use time in ``apps.hooks.session``, not here.

    Raises:
        UnknownEnvironmentVariableError: When a prefixed variable matches no
            declared setting -- a typo like ``OPENBRAIN_CAPTURE_BASE_RUL``. This
            is the same check ``load_settings`` runs; without it, capture's own
            resolver simply does not see the misspelled name, so ``base_url``
            resolves to ``None`` and every ``Stop`` DECLINES capture while the
            operator believes the endpoint is set -- a silent zero capture. The
            entrypoint swallows this into its content-free log path (only the
            error CLASS name is logged, never a value); the raised error names
            the misspelled VARIABLE, which is safe metadata, never its value.
    """
    source = os.environ if environ is None else environ

    # Validate BEFORE resolving, mirroring load_settings. A typo'd capture
    # variable is worse than a rejected one: the resolver ignores what it does
    # not recognise, so a misspelling loads clean as an unset endpoint and the
    # hook silently records nothing.
    unknown = unknown_prefixed_variables(source)
    if unknown:
        raise UnknownEnvironmentVariableError(unknown)

    values = _resolve_section_from_env(CaptureSettings, source)
    # Keyed by field NAME (``base_url``), not alias -- ``_Base`` sets
    # ``populate_by_name``, so ``model_validate`` accepts the names. A splat would
    # not type-check the heterogeneous mapping against each field's type.
    return CaptureSettings.model_validate(values)


def load_canon_settings(
    environ: Mapping[str, str] | None = None,
) -> CanonSettings:
    """Resolve ONLY the ``canon`` section, without the rest of the tree.

    The ``SessionStart`` hook needs canon's endpoint, token, scope, and section
    list and nothing else, and it runs in the same environment-configured hook
    process ``Stop`` does: ``OPENBRAIN_BASE_URL`` and ``OPENBRAIN_TOKEN`` set,
    the database and embedding variables a server process carries absent. The
    full ``load_settings`` cannot serve it -- that builds the whole
    :class:`Settings`, and :class:`DatabaseSettings` / :class:`EmbeddingSettings`
    have required fields a hook does not set, so a canon hook with only the two
    shared variables would fail validation on config it never uses. Swallowed by
    the entrypoint, that is a SILENT NO INJECTION on every session start.

    This mirrors :func:`load_capture_settings` exactly: it validates the whole
    prefixed environment for typos first (so a misspelled ``OPENBRAIN_CANON_*``
    is rejected rather than loading clean as an unset endpoint and declining
    canon silently), then resolves canon's own aliases through the same resolver
    :class:`LegacyFlatEnvSource` uses. It does NOT read the JSON layers: canon is
    an environment-configured hook concern.

    Args:
        environ: Environment to read. Defaults to the live process environment;
            the argument exists so the resolver is testable without mutating it.

    Returns:
        The validated :class:`CanonSettings`. ``base_url`` and ``token`` are
        ``None`` when unset, exactly as under the full load -- the requirement is
        enforced at use time in ``apps.hooks.session``, not here.

    Raises:
        UnknownEnvironmentVariableError: When a prefixed variable matches no
            declared setting -- the same check ``load_settings`` runs. Without
            it, a typo like ``OPENBRAIN_CANON_REP_O`` loads clean, canon reads
            its default scope, and the operator's override is silently ignored.
    """
    source = os.environ if environ is None else environ

    unknown = unknown_prefixed_variables(source)
    if unknown:
        raise UnknownEnvironmentVariableError(unknown)

    values = _resolve_section_from_env(CanonSettings, source)
    return CanonSettings.model_validate(values)
