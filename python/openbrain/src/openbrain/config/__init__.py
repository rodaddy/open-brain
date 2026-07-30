"""openbrain.config - the one place a setting is defined.

Purpose:
    Configuration for every Open Brain process, declared once and validated at
    start. Every other module receives a typed ``Settings`` object; none of
    them reads the environment for itself.

    This exists because the opposite pattern is already measured in this repo.
    ``docs/CONFIG_REFERENCE.md`` records 61 environment variables read inline
    as ``process.env.X ?? default`` across ``src/``, with the default written
    as a literal beside each use. The same variable read in two files can carry
    two different defaults, and nothing detects the divergence. That is the
    configuration form of the defect that produced four copies of one admission
    rule.

Architecture:
    One ``BaseSettings`` model per concern -- database, embedding, log, server
    -- composed into a single ``Settings``. Pydantic performs the coercion and
    the validation, so per-setting parsing logic is not rewritten.

    Nested binding means ``OPENBRAIN_DATABASE__HOST`` reaches
    ``Settings.database.host``. The flat spellings already deployed in this repo
    (``DB_HOST``, ``PORT``, ``LOG_LEVEL``) are attached as validation aliases,
    so an existing deployment keeps working without a second definition of the
    same setting.

Key Components:
    - Settings: the composed object every module receives
    - load_settings: read and validate once, at process start
    - DatabaseSettings, EmbeddingSettings, LogSettings, ServerSettings

Pattern/Convention:
    Add a setting here or not at all. A module that needs one receives it.

    Secrets are ``SecretStr``, so a password cannot reach a repr, a log line,
    or a traceback by accident.

    Nothing here bounds content. These settings configure endpoints, timeouts,
    credentials, and feature flags. What Open Brain may remember is not
    configurable; see ``docs/CODING_STANDARDS.md`` section 6.

Example:
    >>> from openbrain.config import load_settings
    >>> settings = load_settings()
    >>> settings.embedding.dimensions
    768

See Also:
    - ``docs/CONFIG_REFERENCE.md`` - every variable and its current read site
    - ``openbrain.observability`` - configured from ``Settings.log``
"""

from __future__ import annotations

from .settings import (
    ENV_NESTED_DELIMITER,
    ENV_PREFIX,
    DatabaseSettings,
    EmbeddingSettings,
    LogSettings,
    ServerSettings,
    Settings,
    load_settings,
    unknown_prefixed_variables,
)

__all__ = [
    "ENV_NESTED_DELIMITER",
    "ENV_PREFIX",
    "DatabaseSettings",
    "EmbeddingSettings",
    "LogSettings",
    "ServerSettings",
    "Settings",
    "load_settings",
    "unknown_prefixed_variables",
]
