"""Tests for provider configuration.

Functional, not shape-checking: each test supplies an environment a real
operator could produce and asserts the resulting behavior. None of them assert
on the text of a message or the internal spelling of a variable.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from openbrain_provider.config import (
    ConfigError,
    DispatchConfig,
    LogConfig,
    ProviderConfig,
    load_config,
)
from openbrain_provider.constants import (
    MAX_CONTEXT_PACK_MAX_TOKENS,
    MIN_CONTEXT_PACK_MAX_TOKENS,
    PACKAGE_TIMEOUT_SECONDS,
)


def test_empty_environment_yields_working_defaults() -> None:
    config = load_config({})

    assert config.log.level == "info"
    assert config.log.log_file is None
    assert config.dispatch.timeout_seconds == PACKAGE_TIMEOUT_SECONDS
    assert config.base_url is None
    assert config.context_pack_max_tokens is None


def test_values_are_read_from_the_environment() -> None:
    config = load_config(
        {
            "LOG_LEVEL": "debug",
            "LOG_FILE": "/tmp/ob-provider.log",
            "OPENBRAIN_PROVIDER_TIMEOUT_SECONDS": "12.5",
            "OPENBRAIN_BASE_URL": "http://127.0.0.1:3100",
            "OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": "8000",
        }
    )

    assert config.log.level == "debug"
    assert config.log.log_file == Path("/tmp/ob-provider.log")
    assert config.dispatch.timeout_seconds == 12.5
    assert config.base_url == "http://127.0.0.1:3100"
    assert config.context_pack_max_tokens == 8000


def test_whitespace_only_values_are_treated_as_unset() -> None:
    # An operator template that leaves `VAR=` or `VAR=" "` behind should get the
    # default, not a config object holding an empty string.
    config = load_config(
        {
            "LOG_LEVEL": "  ",
            "LOG_FILE": "   ",
            "OPENBRAIN_PROVIDER_TIMEOUT_SECONDS": "",
            "OPENBRAIN_BASE_URL": " ",
            "OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": "  ",
        }
    )

    assert config.log.level == "info"
    assert config.log.log_file is None
    assert config.dispatch.timeout_seconds == PACKAGE_TIMEOUT_SECONDS
    assert config.base_url is None
    assert config.context_pack_max_tokens is None


@pytest.mark.parametrize("level", ["WARN", "ERR", "CRIT", "TRACE", "verbose", "12"])
def test_non_conforming_log_levels_are_rejected(level: str) -> None:
    # `warn` in particular is the one that gets typed: it is valid in several
    # other stacks, and it silently splits the log pipeline's level queries.
    with pytest.raises(ConfigError):
        load_config({"LOG_LEVEL": level})


@pytest.mark.parametrize(
    "level", ["debug", "INFO", "Warning", "error", "CRITICAL", " info "]
)
def test_conforming_log_levels_are_accepted_case_insensitively(level: str) -> None:
    config = load_config({"LOG_LEVEL": level})

    assert config.log.level == level.strip().lower()


@pytest.mark.parametrize("raw", ["0", "-1", "-0.5", "nan", "inf", "-inf"])
def test_unusable_timeouts_are_rejected(raw: str) -> None:
    # Zero and negatives are nonsense; NaN and inf parse as floats and would
    # otherwise become an unbounded wait inside the agent session.
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_PROVIDER_TIMEOUT_SECONDS": raw})


def test_malformed_timeout_is_reported_not_defaulted() -> None:
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_PROVIDER_TIMEOUT_SECONDS": "thirty"})


@pytest.mark.parametrize("raw", ["0", "-5", str(MAX_CONTEXT_PACK_MAX_TOKENS + 1)])
def test_out_of_range_context_pack_budget_is_rejected(raw: str) -> None:
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": raw})


def test_context_pack_budget_at_the_ceiling_is_accepted() -> None:
    config = load_config(
        {"OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": str(MAX_CONTEXT_PACK_MAX_TOKENS)}
    )

    assert config.context_pack_max_tokens == MAX_CONTEXT_PACK_MAX_TOKENS


def test_malformed_context_pack_budget_is_reported_not_defaulted() -> None:
    # A typo'd budget must not silently fall back to the package default; the
    # operator asked for a specific number and deserves to hear that it failed.
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": "8k"})


def test_direct_construction_validates_too() -> None:
    # Validation lives on the dataclass, not on the loader, so config built in
    # a test or by a future caller gets the same guarantees.
    with pytest.raises(ConfigError):
        LogConfig(level="warn")

    with pytest.raises(ConfigError):
        DispatchConfig(timeout_seconds=0)

    with pytest.raises(ConfigError):
        ProviderConfig(
            log=LogConfig(),
            dispatch=DispatchConfig(),
            context_pack_max_tokens=-1,
        )


def test_config_is_immutable() -> None:
    config = load_config({})

    with pytest.raises(FrozenInstanceError):
        config.base_url = "http://elsewhere"  # type: ignore[misc]

    with pytest.raises(FrozenInstanceError):
        config.log.level = "DEBUG"  # type: ignore[misc]


@pytest.mark.parametrize(
    "url",
    [
        "not a url",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "$(whoami)",
        "http://127.0.0.1:3100 ; rm -rf /",
        "ftp://example.com",
        "http://",
        "//example.com",
        "example.com:3100",
        "http://example.com:notaport",
        "http://exa\nmple.com",
    ],
)
def test_unusable_base_urls_are_rejected(url: str) -> None:
    # This field was previously accepted unvalidated while the module docstring
    # promised it failed closed. It reaches an HTTP client and a subprocess
    # environment in later slices.
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_BASE_URL": url})


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:3100",
        "https://open-brain.example.com",
        "http://localhost",
        "https://example.com/base/path",
        "http://10.71.1.21:3100",
    ],
)
def test_usable_base_urls_are_accepted(url: str) -> None:
    config = load_config({"OPENBRAIN_BASE_URL": url})

    assert config.base_url == url


def test_context_pack_budget_below_the_adapter_floor_is_rejected() -> None:
    # The TypeScript adapter enforces MIN_CONTEXT_PACK_MAX_TOKENS = 100. A
    # Python provider that accepts 1 makes the two runtimes disagree about
    # whether the same request is valid.
    with pytest.raises(ConfigError):
        load_config({"OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": "1"})

    at_floor = load_config(
        {"OPENBRAIN_CONTEXT_PACK_MAX_TOKENS": str(MIN_CONTEXT_PACK_MAX_TOKENS)}
    )
    assert at_floor.context_pack_max_tokens == MIN_CONTEXT_PACK_MAX_TOKENS


def test_logging_env_vars_use_the_contract_names() -> None:
    # OBSERVABILITY_CONTRACT.md §5 names these. A package-prefixed variable is
    # invisible to the fleet tooling that sets LOG_LEVEL, so the operator sets
    # it and nothing changes.
    assert load_config({"LOG_LEVEL": "error"}).log.level == "error"
    assert load_config({"OPENBRAIN_PROVIDER_LOG_LEVEL": "error"}).log.level == "info"


@pytest.mark.parametrize(
    "url",
    [
        "http://alice:supersecret@example.com:notaport",
        "https://alice:supersecret@example.com:99999",
        "http://alice:supersecret@example.com ; rm -rf /",
        "ftp://alice:supersecret@example.com",
        "http://alice:supersecret@",
        "alice:supersecret@example.com",
    ],
)
def test_base_url_errors_do_not_leak_embedded_credentials(url: str) -> None:
    # Review finding (MEDIUM, security lane). urlsplit accepts userinfo, and
    # every validation error quoted the raw value. A config error at boot is
    # exactly what gets printed to a terminal, captured by a service manager, or
    # pasted into a bug report, so a malformed secret-bearing URL became
    # credential disclosure.
    with pytest.raises(ConfigError) as excinfo:
        load_config({"OPENBRAIN_BASE_URL": url})

    assert "supersecret" not in str(excinfo.value)


def test_base_url_errors_still_identify_the_problem() -> None:
    # Redaction must not make the message useless: the host has to survive, or
    # an operator cannot tell which of several configured URLs was rejected.
    with pytest.raises(ConfigError) as excinfo:
        load_config({"OPENBRAIN_BASE_URL": "http://alice:supersecret@example.com:bad"})

    message = str(excinfo.value)
    assert "example.com" in message
    assert "***" in message


def test_credential_free_urls_are_reported_verbatim() -> None:
    # No credentials means nothing to redact; the operator should see exactly
    # what they configured.
    with pytest.raises(ConfigError) as excinfo:
        load_config({"OPENBRAIN_BASE_URL": "ftp://example.com:3100"})

    assert "ftp://example.com:3100" in str(excinfo.value)


def test_unknown_variables_are_ignored() -> None:
    # The real environment is full of unrelated variables. Reading it must not
    # turn a neighbouring name into a configuration error.
    config = load_config({"PATH": "/usr/bin", "OPENBRAIN_SOMETHING_ELSE": "x"})

    assert config.log.level == "info"
