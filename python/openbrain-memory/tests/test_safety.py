"""Tests for redaction and memory content-safety policy."""

from __future__ import annotations

import pytest

from openbrain_memory import redact_text, redact_value


def token_sample(*parts: str) -> str:
    return "".join(parts)


def test_redaction_scrubs_common_secret_shapes():
    text = "\n".join(
        [
            "Authorization: Bearer " + token_sample("abcdefgh", "ijklmnop"),
            token_sample("OPENAI_", "API_", "KEY=") + token_sample("sk", "-secret"),
            "password: " + token_sample("hunt", "er2"),
            '"api_key": "json-secret"',
            "token: " + token_sample("sk", "-abcdefghijklmnopqrstuvwxyz"),
            token_sample("GITHUB_", "TOKEN=")
            + token_sample("ghp", "_abcdefghijklmnopqrstuvwxyz"),
            token_sample(
                "-----BEGIN ",
                "PRIVATE ",
                "KEY-----\nabc\n-----END ",
                "PRIVATE ",
                "KEY-----",
            ),
        ]
    )

    redacted = redact_text(text)

    assert "abcdefghijklmnop" not in redacted
    assert token_sample("sk", "-secret") not in redacted
    assert token_sample("hunt", "er2") not in redacted
    assert "json-secret" not in redacted
    assert token_sample("sk", "-abcdefghijklmnopqrstuvwxyz") not in redacted
    assert token_sample("ghp", "_") not in redacted
    assert token_sample("PRIVATE ", "KEY") not in redacted
    assert redacted.count("[REDACTED]") >= 4


def test_redaction_scrubs_unlabelled_cloud_and_token_shapes():
    aws_access_key = token_sample("AKIA", "ABCDEFGHIJKLMNOP")
    aws_secret = token_sample(
        "abcdEFGH", "ijklMNOP", "qrstUVWX", "yz012345", "6789+/ab"
    )
    slack_token = token_sample("xoxb-", "123456789012-", "abcdefghijklmnop")
    google_key = token_sample("AIza", "ABCDEFGHIJKLMNOPQRSTUVWX", "YZabcdefghi")
    jwt_token = token_sample(
        "eyJ",
        "hbGciOiJIUzI1NiJ9.",
        "eyJzdWIiOiJvcGVuLWJyYWluIn0.",
        "c2lnbmF0dXJlX3ZhbHVl",
    )
    text = "\n".join(
        [
            f"aws access {aws_access_key}",
            f"aws secret {aws_secret}",
            f"slack {slack_token}",
            f"google {google_key}",
            f"jwt {jwt_token}",
            "plain sentence with punctuation should stay visible",
        ]
    )

    redacted = redact_text(text)

    assert aws_access_key not in redacted
    assert aws_secret not in redacted
    assert slack_token not in redacted
    assert google_key not in redacted
    assert jwt_token not in redacted
    assert "plain sentence with punctuation should stay visible" in redacted
    assert redacted.count("[REDACTED]") == 5


def test_redaction_scrubs_labelled_alphanumeric_aws_secret():
    aws_secret = token_sample("abcdEFGH", "ijklMNOP", "qrstUVWX", "yz012345", "6789")

    redacted = redact_text(f"aws_secret_access_key={aws_secret}")

    assert aws_secret not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_stripe_style_underscore_keys():
    stripe_live = token_sample("sk", "_live_", "a" * 24)
    stripe_test = token_sample("pk", "_test_", "b" * 24)

    redacted = redact_text(f"stripe {stripe_live} and {stripe_test}")

    assert stripe_live not in redacted
    assert stripe_test not in redacted
    assert redacted.count("[REDACTED]") == 2


def test_redaction_scrubs_url_embedded_credentials():
    url = token_sample("postgres://", "admin:", "hunter2pw", "@10.0.0.1:5432/app")

    redacted = redact_text(f"db at {url}")

    assert "hunter2pw" not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_url_credentials_uppercase_scheme():
    # URI schemes are case-insensitive; keep 1:1 with the TS /i-compiled pattern.
    url = token_sample("HTTPS://", "admin:", "hunter2pw", "@host/x")

    redacted = redact_text(f"db at {url}")

    assert "hunter2pw" not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scans_large_input_in_linear_time():
    # ReDoS regression: the URL credential pattern once backtracked O(n^2) on
    # long input via an unanchored scheme prefix. A fixed scheme alternation
    # fixed it. 80k chars must redact well under a second.
    import time

    start = time.perf_counter()
    redact_text("a" * 80_000)
    redact_text("http" + ":x" * 40_000)
    assert time.perf_counter() - start < 1.0


def test_redaction_scrubs_labeled_long_secret():
    secret = token_sample("client_secret=", "Ab9" * 8, "xyz")

    redacted = redact_text(secret)

    assert "[REDACTED]" in redacted


def test_redaction_keeps_plain_url_without_credentials_visible():
    url = "https://github.com/rodaddy/open-brain"

    redacted = redact_text(f"see {url}")

    assert url in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_keeps_benign_40_character_hex_ids_visible():
    sha_like_id = token_sample("0123456789", "abcdef0123", "456789abcd", "ef01234567")

    redacted = redact_text(f"commit {sha_like_id}")

    assert sha_like_id in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_scrubs_bare_three_segment_non_jwt_token():
    token = token_sample(
        "AbCdEfGhIjKlMnOpQrStUv2",
        ".abcD3f",
        ".WxYzWxYzWxYzWxYzWxYz4",
    )

    redacted = redact_text(f"opaque token {token}")

    assert token not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_dash_bounded_bare_three_segment_token():
    token = token_sample(
        "-AbCdEfGhIjKlMnOpQrStUv2",
        ".abcD3f",
        ".WxYzWxYzWxYzWxYzWxYz4-",
    )

    redacted = redact_text(f"opaque token {token}")

    assert token not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_keeps_unlabeled_dash_identifier_visible():
    blob = token_sample("Aa1Bb2" * 4, "-", "Hh7Ii8" * 4)

    redacted = redact_text(f"opaque {blob}")

    assert blob in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_keeps_unlabeled_underscore_identifier_visible():
    blob = token_sample("Aa1Bb2" * 4, "_", "Hh7Ii8" * 4)

    redacted = redact_text(f"opaque {blob}")

    assert blob in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_scrubs_unlabeled_high_entropy_blob_with_base64_symbols():
    blob = token_sample("Aa1Bb2" * 4, "+=", "Hh7Ii8" * 4)

    redacted = redact_text(f"opaque {blob}")

    assert blob not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_unlabeled_high_entropy_blob_with_base64_slash():
    blob = token_sample("Aa1/Bb2" * 4, "+=", "Hh7/Ii8" * 4)

    redacted = redact_text(f"opaque {blob}")

    assert blob not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_keeps_benign_64_character_git_sha_visible():
    sha = token_sample(
        "68be7d3fa4",
        "6ec75266ea",
        "f407a4ed91",
        "1ac046588e",
        "a1148136a3",
        "2a516aca79",
        "6120",
    )
    assert len(sha) == 64

    redacted = redact_text(f"schema_hash {sha}")

    assert sha in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_keeps_git_sha_visible_when_later_text_has_symbol():
    sha = token_sample("0123456789", "abcdef0123", "456789abcd", "ef01234567")

    redacted = redact_text(f"commit {sha} path python/openbrain_memory")

    assert sha in redacted
    assert "[REDACTED]" not in redacted


@pytest.mark.parametrize(
    ("text", "visible"),
    [
        (
            "error at src/openbrain_memory/transport/"
            "streaming_response_handler_impl.py:412",
            "src/openbrain_memory/transport/streaming_response_handler_impl.py",
        ),
        (
            "branch fix/177-openbrain-memory-package-heuristic-redaction-followups",
            "fix/177-openbrain-memory-package-heuristic-redaction-followups",
        ),
        (
            "branch fix/OB177-openbrain-Memory-Package-Heuristic-Redaction2",
            "fix/OB177-openbrain-Memory-Package-Heuristic-Redaction2",
        ),
        (
            "branch feature/OB-1234-Redaction-Heuristic-Followups-v2-Final",
            "feature/OB-1234-Redaction-Heuristic-Followups-v2-Final",
        ),
        (
            "describe v0.1.1-12-gAbC1234RedactionBuildSuffix",
            "v0.1.1-12-gAbC1234RedactionBuildSuffix",
        ),
        (
            "GET /api/v1/namespaces/shared-kb/session-events"
            "?cursor=next_page_token_placeholder_here_xx",
            "/api/v1/namespaces/shared-kb/session-events",
        ),
        (
            "OB_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_CONFIG_VALUE set",
            "OB_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_CONFIG_VALUE",
        ),
        (
            "trace_id 7f3e-9a2b-4c1d-8e6f-longcorrelationidentifierstring",
            "7f3e-9a2b-4c1d-8e6f-longcorrelationidentifierstring",
        ),
        (
            "config openbrainmemorytransport.streaminghandler.configresolvermodule",
            "openbrainmemorytransport.streaminghandler.configresolvermodule",
        ),
    ],
)
def test_redaction_keeps_benign_symbol_identifiers_visible(
    text: str,
    visible: str,
):
    redacted = redact_text(text)

    assert visible in redacted
    assert "[REDACTED]" not in redacted


def test_redact_value_recurses_sensitive_keys():
    value = {
        "nested": {
            "access_token": "secret-token",
            "session_id": "session-123",
            "mcp_session_id": "session-456",
        },
        "safe": "visible",
    }

    assert redact_value(value) == {
        "nested": {
            "access_token": "[REDACTED]",
            "session_id": "[REDACTED]",
            "mcp_session_id": "[REDACTED]",
        },
        "safe": "visible",
    }


def test_redact_value_bounds_deeply_nested_values():
    value = "secret"
    for _ in range(1200):
        value = {"safe": value}

    redacted = redact_value(value)

    cursor = redacted
    for _ in range(32):
        assert isinstance(cursor, dict)
        cursor = cursor["safe"]
    assert cursor == "[REDACTED:depth]"
