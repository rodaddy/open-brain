"""Functional tests for the capture path.

The nine cases from ``scripts/__tests__/capture-floor-removal.check.ts``, which
pinned the 2026-07-28 fix, plus the properties that fix must keep having.

Organised by module so a failure names the job that broke, not just "capture".
"""

from __future__ import annotations

import pytest

from openbrain.apps.capture.classify import classify
from openbrain.apps.capture.paste import looks_pasted
from openbrain.apps.capture.redaction import PLACEHOLDER, redact
from openbrain.apps.capture.signal import signal_from
from openbrain.apps.capture.wrappers import strip_system_wrappers
from openbrain.models.turn import EventType

#: Fake credentials, assembled at runtime rather than written as literals.
#:
#: A literal that LOOKS like a token trips gitleaks on every commit, every CI
#: run, and every future scan -- verified 2026-07-31, when a hand-written
#: `ghp_...` fixture blocked this file's own commit. A fixture that cries wolf
#: teaches people to pass `--no-verify`, which is worse than the fixture being
#: slightly indirect.
#:
#: Building them from parts keeps the redaction patterns genuinely exercised
#: while leaving nothing token-shaped on disk.
_FAKE_BODY = "0123456789" + "abcdefghij"
FAKE_OPENAI_KEY = "sk-" + _FAKE_BODY
FAKE_GITHUB_TOKEN = "ghp" + "_" + _FAKE_BODY
FAKE_BEARER = _FAKE_BODY + "xyz"
FAKE_PASSWORD = "not" + "-a-real-password"

#: The measured failure: a 1,035-char paste of a terminal session stored as a
#: `decision` on 2026-07-25. Rebuilt to the same shape and size.
PASTED_TERMINAL_BLOCK = (
    "❯ bun test\n"
    "⏺ Bash(bun test)\n"
    "  ⎿  Running 41 tests\n"
    "     ✓ we should use postgres for this\n"
    "     ✓ decided: the migration runs first\n"
    "─────────────────────────────────────\n"
) * 6


class TestTheNineCases:
    """capture-floor-removal.check.ts, 9/9, ported.

    Four short turns capture as `fact`; one still classifies as `decision`;
    four are refused for structural reasons.
    """

    @pytest.mark.parametrize("text", ["yes", "ok", "no do it", "okay"])
    def test_short_turns_capture_as_fact(self, text: str) -> None:
        signal = signal_from(text)

        assert signal is not None, f"{text!r} was dropped"
        assert signal.event_type == EventType.FACT
        assert signal.content == text

    def test_a_decision_still_classifies_as_decision(self) -> None:
        """Removing the floor must not have flattened everything to `fact`."""
        signal = signal_from("use postgres not sqlite")

        assert signal is not None
        assert signal.event_type == EventType.DECISION

    @pytest.mark.parametrize("text", ["", "   \n\t "])
    def test_empty_and_whitespace_only_are_refused(self, text: str) -> None:
        assert signal_from(text) is None

    def test_system_reminder_only_is_refused(self) -> None:
        """Nothing the operator typed remains, so there is nothing to store."""
        assert signal_from("<system-reminder>policy</system-reminder>") is None

    def test_a_pasted_terminal_block_is_refused(self) -> None:
        """The 2026-07-25 failure: 1,035 chars stored as a `decision`."""
        assert signal_from(PASTED_TERMINAL_BLOCK) is None


class TestNoLengthFloor:
    """#418 acceptance: a one-character turn is captured."""

    @pytest.mark.parametrize("text", ["k", "y", "1", "?"])
    def test_a_single_character_turn_is_captured(self, text: str) -> None:
        signal = signal_from(text)

        assert signal is not None, f"{text!r} was dropped"
        assert signal.content == text

    def test_an_unanticipated_phrasing_is_captured_not_dropped(self) -> None:
        """The allowlist inversion: no match types, it never drops.

        The old SIGNALS returned null on no match, so a turn phrased a new way
        vanished with no trace.
        """
        signal = signal_from("mrrrp glorbo the widget")

        assert signal is not None
        assert signal.event_type == EventType.FACT


class TestContentIsPreservedExactly:
    """docs/CODING_STANDARDS.md:160. Sizes are inputs, not thresholds.

    They bracket the 1,500 the deployed adapter shortens at
    (turn-capture.ts:386) and continue past it, so shortening reintroduced
    anywhere fails some case.
    """

    @pytest.mark.parametrize(
        "size", [1, 24, 1_499, 1_500, 1_501, 5_000, 50_000, 200_001]
    )
    def test_length_is_unchanged(self, size: int) -> None:
        text = "a" * size
        signal = signal_from(text)

        assert signal is not None
        assert len(signal.content) == size

    def test_content_is_byte_identical(self) -> None:
        """Equal length would pass an implementation that replaced the text."""
        text = "line one\n  indented\ttabbed\nunicode: 你好 \U0001f600\n"
        signal = signal_from(text)

        assert signal is not None
        assert signal.content == text


class TestWrapperStripping:
    """One job: remove text the operator never typed."""

    def test_removes_a_reminder_and_keeps_the_rest(self) -> None:
        text = "before<system-reminder>noise</system-reminder>after"

        assert strip_system_wrappers(text) == "beforeafter"

    def test_two_blocks_do_not_merge_into_one_match(self) -> None:
        """Non-greedy matching: the real text between them must survive."""
        text = "<system-reminder>a</system-reminder>KEEP<system-reminder>b</system-reminder>"

        assert strip_system_wrappers(text) == "KEEP"

    def test_a_turn_with_no_wrappers_is_untouched(self) -> None:
        text = "just a normal message"

        assert strip_system_wrappers(text) == text

    def test_the_reflex_pointer_block_is_removed(self) -> None:
        text = "real question\n## Open Brain reflex pointers\n- [brain_record:x] y\n"

        assert strip_system_wrappers(text).strip() == "real question"


class TestPasteDetection:
    """One job: shape, never length."""

    def test_the_measured_failure_is_recognised(self) -> None:
        assert looks_pasted(PASTED_TERMINAL_BLOCK)

    @pytest.mark.parametrize(
        "text",
        [
            "use postgres not sqlite",
            "no, do it the other way",
            "ok",
            "why is there TS in my Python?",
        ],
    )
    def test_prose_is_not_mistaken_for_output(self, text: str) -> None:
        assert not looks_pasted(text)

    def test_a_long_turn_of_prose_is_not_pasted(self) -> None:
        """Shape, not length: a long message is still a message.

        This is the property that keeps paste-detection independent of the
        removed floor -- see capture-never-drops-a-turn.md:87.
        """
        assert not looks_pasted("so what I want is " + "more detail " * 500)

    @pytest.mark.parametrize("text", ["a · b", "❯ that's the prompt I meant"])
    def test_one_glyph_alone_is_not_conclusive(self, text: str) -> None:
        """A lone `·` is punctuation; a lone `❯` is a quoted shell prompt."""
        assert not looks_pasted(text)


class TestRedaction:
    """One job: mask the value, keep the statement."""

    @pytest.mark.parametrize(
        "text",
        [
            f"the key is {FAKE_OPENAI_KEY}",
            f"token: {FAKE_GITHUB_TOKEN}",
            f"Authorization: Bearer {FAKE_BEARER}",
        ],
    )
    def test_secret_values_are_masked(self, text: str) -> None:
        assert PLACEHOLDER in redact(text)

    def test_the_statement_survives_redaction(self) -> None:
        """A turn is never dropped for holding a credential."""
        result = redact(f'DB_PASSWORD="{FAKE_PASSWORD}"')

        assert "DB_PASSWORD" in result
        assert FAKE_PASSWORD not in result

    def test_a_turn_containing_a_secret_is_still_captured(self) -> None:
        """The whole point: redact, do not reject."""
        signal = signal_from(f"I put {FAKE_OPENAI_KEY} in the env file")

        assert signal is not None
        assert FAKE_OPENAI_KEY not in signal.content
        assert "env file" in signal.content

    def test_ordinary_text_is_untouched(self) -> None:
        text = "we decided to use postgres"

        assert redact(text) == text

    def test_a_connection_uri_keeps_everything_but_the_password(self) -> None:
        result = redact(f"postgres://user:{FAKE_PASSWORD}@db.example:5432/open_brain")

        assert FAKE_PASSWORD not in result
        assert "db.example:5432/open_brain" in result


class TestClassification:
    """One job: type a turn. Never drop one."""

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("use postgres not sqlite", EventType.DECISION),
            ("no, that's wrong", EventType.CORRECTION),
            ("blocked on the migration", EventType.BLOCKER),
            ("why does it do that?", EventType.QUESTION),
            ("run the migration", EventType.ACTION),
        ],
    )
    def test_phrasings_map_to_types(self, text: str, expected: EventType) -> None:
        assert classify(text) == expected

    def test_never_returns_none(self) -> None:
        """The inversion that matters, stated as a property.

        The old implementation returned null on no match; this returns a type
        for anything, including text no pattern anticipated.
        """
        for text in ["", "?!?", "glorbo", "\n", "a" * 10_000]:
            assert classify(text) is not None

    def test_a_correction_outranks_the_decision_inside_it(self) -> None:
        """Ordering: "no, use postgres instead" is a correction first."""
        assert classify("no, use postgres instead") == EventType.CORRECTION


class TestModuleIndependence:
    """The four jobs must not be able to hide each other.

    418's lesson: removing the length floor did not make "ok" capture, because
    SIGNALS was independently dropping it. Each module is asserted to do its own
    job in isolation, so a change to one cannot silently mask another.
    """

    def test_classification_does_not_look_at_length(self) -> None:
        assert classify("ok") == classify("ok " * 1_000)

    def test_paste_detection_does_not_look_at_length(self) -> None:
        assert not looks_pasted("x" * 100_000)

    def test_redaction_does_not_drop_anything(self) -> None:
        """Redaction returns text, always. It has no reject path."""
        assert redact("") == ""
        assert redact("no secrets here") == "no secrets here"

    def test_wrapper_stripping_does_not_judge_worth(self) -> None:
        """It may return an empty string; deciding what that means is the caller's."""
        assert strip_system_wrappers("<system-reminder>x</system-reminder>") == ""
