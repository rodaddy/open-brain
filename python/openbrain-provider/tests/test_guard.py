"""Behaviour tests for the guard's own units.

The parity suite proves the whole thing matches the TypeScript. These prove the
individual rules directly, so a failure names the rule that broke instead of
only the case that noticed.
"""

from __future__ import annotations

import io
import json

import pytest

from openbrain_provider.cli_guard import main, read_bounded_stdin
from openbrain_provider.guard import (
    MAX_INPUT_BYTES,
    contains_forbidden_open_brain_command,
    guard_claude_command,
    tokens_invoke_open_brain,
)
from openbrain_provider.shell_lexer import (
    executable_substitutions,
    read_ansi_c_string,
    tokenize_shell_detailed,
)

CLI = "mcp2cli"
SVC = "open-brain"
FORBIDDEN = f"{CLI} {SVC} search_all"


def _payload(tool_name: str, command: str) -> bytes:
    return json.dumps(
        {"tool_name": tool_name, "tool_input": {"command": command}}
    ).encode()


def _is_block(output: str) -> bool:
    return output != "" and json.loads(output)["decision"] == "block"


class TestTheBlockedRoute:
    def test_a_direct_invocation_is_blocked(self) -> None:
        assert contains_forbidden_open_brain_command(FORBIDDEN)

    def test_an_absolute_path_does_not_evade_it(self) -> None:
        assert contains_forbidden_open_brain_command(f"/usr/local/bin/{FORBIDDEN}")

    @pytest.mark.parametrize("service", ["qmd", "n8n", "vaultwarden-secrets"])
    def test_other_services_stay_allowed(self, service: str) -> None:
        assert not contains_forbidden_open_brain_command(
            f"{CLI} {service} search --params '{{}}'"
        )

    def test_the_name_in_quoted_text_is_not_an_invocation(self) -> None:
        assert not contains_forbidden_open_brain_command(f"echo '{FORBIDDEN}'")

    def test_a_near_miss_binary_is_allowed(self) -> None:
        assert not contains_forbidden_open_brain_command(f"{CLI}x {SVC} search")

    def test_a_near_miss_service_is_allowed(self) -> None:
        assert not contains_forbidden_open_brain_command(f"{CLI} {SVC}x search")


class TestIndirection:
    @pytest.mark.parametrize(
        "command",
        [
            f"sudo -u root -- {FORBIDDEN}",
            f"command -- {FORBIDDEN}",
            f"env TEST=1 {FORBIDDEN}",
            f"nohup {FORBIDDEN} &",
            f"exec {FORBIDDEN}",
            f"eval '{FORBIDDEN}'",
            f"bash -lc '{FORBIDDEN}'",
            f"zsh -c $'{FORBIDDEN}'",
            f"printf x | xargs {FORBIDDEN}",
            f"find . -exec {FORBIDDEN} ;",
            f'echo "$({FORBIDDEN})"',
            f"`{FORBIDDEN}`",
        ],
    )
    def test_wrappers_do_not_evade_the_guard(self, command: str) -> None:
        assert contains_forbidden_open_brain_command(command), command

    def test_a_variable_holding_the_binary_is_resolved(self) -> None:
        assert contains_forbidden_open_brain_command(
            f"tool={CLI}; service={SVC}; $tool $service search_all"
        )

    def test_two_unresolvable_variables_still_block(self) -> None:
        """Unknown expansion is treated as possibly matching, by design."""
        assert contains_forbidden_open_brain_command("$tool $service search_all")

    def test_a_single_quoted_variable_cannot_expand_and_is_allowed(self) -> None:
        assert not contains_forbidden_open_brain_command(
            f"tool={CLI}; service={SVC}; '$tool' '$service' search_all"
        )

    def test_a_variable_reassigned_to_another_service_is_allowed(self) -> None:
        assert not contains_forbidden_open_brain_command(
            f"tool={CLI}; service=qmd; $tool $service search"
        )

    def test_recursion_is_bounded_and_returns_a_verdict(self) -> None:
        """Deep nesting terminates rather than recursing forever."""
        deep = FORBIDDEN
        for _ in range(8):
            deep = f"sh -c '{deep}'"
        assert contains_forbidden_open_brain_command(deep) in (True, False)


class TestKnownGapsArePinned:
    """These allow-verdicts are the TypeScript's, preserved on purpose.

    Both are lexing artefacts: ``(`` glues to the following word and ``then``
    lands in command position, so neither reaches the executable check.
    Changing them would change live enforcement -- open-brain#451's call.
    """

    def test_a_subshell_is_not_blocked(self) -> None:
        assert not contains_forbidden_open_brain_command(f"( {FORBIDDEN} )")

    def test_an_if_branch_is_not_blocked(self) -> None:
        assert not contains_forbidden_open_brain_command(
            f"if true; then {FORBIDDEN}; fi"
        )


class TestPayloadHandling:
    def test_only_shell_tools_are_inspected(self) -> None:
        assert guard_claude_command(_payload("Bash", FORBIDDEN)) != ""
        assert guard_claude_command(_payload("Shell", FORBIDDEN)) != ""
        assert guard_claude_command(_payload("Read", FORBIDDEN)) == ""

    @pytest.mark.parametrize(
        "raw",
        [
            b"not-json",
            b"",
            b"[1,2,3]",
            b'"text"',
            b"12",
            b"null",
            b'{"tool_name":"Bash"',
        ],
    )
    def test_unparseable_input_fails_open(self, raw: bytes) -> None:
        assert guard_claude_command(raw) == ""

    @pytest.mark.parametrize(
        "payload",
        [
            {"tool_name": "Bash"},
            {"tool_name": "Bash", "tool_input": {}},
            {"tool_name": "Bash", "tool_input": {"command": 42}},
            {"tool_name": "Bash", "tool_input": None},
            {"tool_name": "Bash", "tool_input": [FORBIDDEN]},
            {"tool_input": {"command": FORBIDDEN}},
            {},
        ],
    )
    def test_a_malformed_shape_fails_open(self, payload: dict[str, object]) -> None:
        assert guard_claude_command(json.dumps(payload).encode()) == ""

    def test_invalid_utf8_fails_open(self) -> None:
        assert (
            guard_claude_command(
                b'{"tool_name":"Bash","tool_input":{"command":"\xff\xfe"}}'
            )
            == ""
        )

    def test_non_ascii_is_handled_without_blocking(self) -> None:
        assert guard_claude_command(_payload("Bash", "echo é — ✓")) == ""


class TestOversizedPayloads:
    """Past the parse threshold the guard fails CLOSED for shell tools.

    Nothing is shortened or dropped: the payload is simply not parsed, and a
    shell call it cannot read is refused rather than waved through, so an
    oversized body is not a way around the guard.
    """

    def _oversized(self, **fields: object) -> bytes:
        return json.dumps({**fields, "padding": "x" * 70_000}).encode()

    def test_a_shell_tool_is_blocked_even_when_its_command_is_safe(self) -> None:
        raw = self._oversized(tool_name="Bash", tool_input={"command": "echo safe"})
        assert _is_block(guard_claude_command(raw))

    def test_a_non_shell_tool_is_still_allowed(self) -> None:
        raw = self._oversized(tool_name="Read", tool_input={"path": "/safe"})
        assert guard_claude_command(raw) == ""

    def test_a_tool_name_past_the_prefix_is_blocked(self) -> None:
        raw = json.dumps(
            {
                "padding": "x" * 70_000,
                "tool_name": "Read",
                "tool_input": {"command": "echo safe"},
            }
        ).encode()
        assert _is_block(guard_claude_command(raw))

    def test_a_nested_tool_name_does_not_count_as_the_top_level_one(self) -> None:
        raw = json.dumps(
            {
                "nested": {"tool_name": "Read"},
                "padding": "x" * 70_000,
                "tool_name": "Bash",
            }
        ).encode()
        assert _is_block(guard_claude_command(raw))

    def test_an_absent_tool_name_is_blocked(self) -> None:
        raw = self._oversized(tool_input={"command": "echo safe"})
        assert _is_block(guard_claude_command(raw))


class TestTokensInvokeOpenBrain:
    def test_a_literal_pair_matches(self) -> None:
        assert tokens_invoke_open_brain(CLI, SVC)

    def test_a_dynamic_executable_with_the_literal_service_matches(self) -> None:
        assert tokens_invoke_open_brain("$tool", SVC)

    def test_two_dynamic_tokens_match(self) -> None:
        assert tokens_invoke_open_brain("$tool", "$service")

    def test_a_literal_pair_naming_another_service_does_not(self) -> None:
        assert not tokens_invoke_open_brain(CLI, "qmd")

    def test_an_unrelated_binary_with_a_dynamic_argument_does_not(self) -> None:
        assert not tokens_invoke_open_brain("printf", "$service")


class TestShellLexer:
    def test_segments_carry_their_terminator(self) -> None:
        assert [s.terminator for s in tokenize_shell_detailed("a; b | c && d")] == [
            ";",
            "|",
            "&&",
            None,
        ]

    def test_quotes_are_removed_and_recorded(self) -> None:
        tokens = tokenize_shell_detailed("echo 'a b' \"c d\"")[0].tokens
        assert [t.value for t in tokens] == ["echo", "a b", "c d"]
        assert [t.has_single_quoted_part for t in tokens] == [False, True, False]

    def test_a_comment_ends_the_segment(self) -> None:
        segments = tokenize_shell_detailed("echo hi # a comment\necho bye")
        assert [t.value for t in segments[0].tokens] == ["echo", "hi"]

    def test_ansi_c_escapes_decode(self) -> None:
        parsed = read_ansi_c_string(r"$'a\tb\x41\101'", 0)
        assert parsed is not None
        assert parsed.value == "a\tbAA"

    def test_an_unterminated_ansi_c_string_is_not_a_span(self) -> None:
        assert read_ansi_c_string("$'never closed", 0) is None

    def test_substitutions_inside_single_quotes_do_not_execute(self) -> None:
        assert executable_substitutions("echo '$(whoami)'") == []

    def test_substitutions_outside_quotes_do_execute(self) -> None:
        assert executable_substitutions('echo "$(whoami)"') == ["whoami"]

    def test_nested_parens_close_correctly(self) -> None:
        assert executable_substitutions("$(echo $(id))") == ["echo $(id)"]


class TestTheEntrypoint:
    def test_it_writes_the_verdict_and_exits_zero(self) -> None:
        out = io.StringIO()
        assert main(io.BytesIO(_payload("Bash", FORBIDDEN)), out) == 0
        assert json.loads(out.getvalue())["decision"] == "block"

    def test_an_allowed_call_writes_nothing(self) -> None:
        out = io.StringIO()
        assert main(io.BytesIO(_payload("Bash", "git status")), out) == 0
        assert out.getvalue() == ""

    def test_a_broken_stream_still_exits_zero_and_writes_nothing(self) -> None:
        class Exploding(io.RawIOBase):
            def read(self, size: int = -1) -> bytes:
                raise OSError("stdin went away")

        out = io.StringIO()
        assert main(Exploding(), out) == 0  # type: ignore[arg-type]
        assert out.getvalue() == ""

    def test_it_stops_reading_one_byte_past_the_threshold(self) -> None:
        """A huge payload must not make the hook sit reading inside its timeout."""
        raw = read_bounded_stdin(io.BytesIO(b"x" * (MAX_INPUT_BYTES * 4)))
        assert len(raw) == MAX_INPUT_BYTES + 1

    def test_an_empty_stream_reads_as_empty_bytes(self) -> None:
        assert read_bounded_stdin(io.BytesIO(b"")) == b""
