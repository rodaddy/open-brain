"""Functional tests for the capture path's models.

These assert behaviour at the boundary -- what a model accepts, what it refuses,
and what it gives back -- not that particular fields exist.

The load-bearing test in this file is the drift check against
``openbrain_memory.agent``: two hand-maintained copies of one vocabulary is how
the TypeScript adapter came to declare eight event types while the Python client
declared nine (#409).
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from openbrain.models.turn import (
    DEFAULT_EVENT_TYPE,
    EventType,
    RawTurn,
    TurnSignal,
)

#: The authoritative vocabulary, in the package that owns it.
#:
#: Read from source rather than imported: openbrain-memory is deliberately NOT a
#: dependency of this package, and adding one so a test can run would be the
#: test dictating the architecture. Parsing the file keeps the packages
#: uncoupled while still failing loudly when the two lists diverge.
AGENT_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "openbrain-memory"
    / "src"
    / "openbrain_memory"
    / "agent.py"
)


def authoritative_event_types() -> set[str]:
    """Extract ``EVENT_TYPES`` from the client package without importing it.

    Uses ``ast`` rather than a regex: the value is a set literal spanning ten
    lines, and a regex over it would silently miss a member added on an unusual
    line, which is precisely the drift this exists to catch.
    """
    tree = ast.parse(AGENT_SOURCE.read_text())

    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if "EVENT_TYPES" in targets:
            value = ast.literal_eval(node.value)
            return set(value)

    message = f"EVENT_TYPES not found in {AGENT_SOURCE}"
    raise AssertionError(message)


class TestEventTypeVocabulary:
    """The closed set, and its agreement with the package that owns it."""

    def test_the_source_file_is_where_this_test_thinks_it_is(self) -> None:
        """Guard the guard.

        If openbrain-memory moves, the drift test below would raise rather than
        fail -- or worse, a rewritten helper could quietly return an empty set
        and pass. Asserting the path exists makes a move a loud, obvious failure
        with an actionable message.
        """
        assert AGENT_SOURCE.exists(), (
            f"cannot find {AGENT_SOURCE}. The drift check below is inert "
            f"without it. ACTION REQUIRED: update AGENT_SOURCE."
        )

    def test_matches_the_authoritative_list_exactly(self) -> None:
        """EventType and EVENT_TYPES must not drift apart.

        Set equality, not a subset test in either direction. A member here that
        the server does not accept writes no row and returns no receipt,
        silently (#431); a member there that is missing here cannot be produced
        at all. Both directions are data loss.
        """
        declared = {member.value for member in EventType}

        assert declared == authoritative_event_types()

    def test_serialises_as_a_plain_string(self) -> None:
        """StrEnum keeps the wire format unchanged."""
        assert EventType.FACT == "fact"
        assert f"{EventType.DECISION}" == "decision"

    def test_an_unaccepted_type_is_refused_at_construction(self) -> None:
        """A typo fails here, where it names the field.

        The alternative is what #431 describes: the value travels, the server
        writes nothing, and the call site sees success.
        """
        with pytest.raises(ValidationError, match="event_type"):
            TurnSignal(event_type="fct", content="x")  # type: ignore[arg-type]

    def test_the_default_is_a_member_of_the_accepted_set(self) -> None:
        """The fallback must never be the thing that gets silently dropped."""
        assert DEFAULT_EVENT_TYPE.value in authoritative_event_types()


class TestNoLengthFloor:
    """capture-never-drops-a-turn.md, enforced.

    The removed MIN_SIGNAL_CHARS = 24 discarded 73% of the operator's turns.
    Any floor re-introduces that at a different number, so these assert there is
    none -- at the smallest sizes a turn can have.
    """

    @pytest.mark.parametrize("text", ["x", "ok", "no", "yes", "go", "do it"])
    def test_short_turns_are_accepted(self, text: str) -> None:
        """Operator: "sometimes me saying okay is the equivalent of doubt"."""
        assert TurnSignal(content=text).content == text

    def test_a_single_character_is_a_valid_turn(self) -> None:
        """#418 acceptance criterion, at the model layer."""
        assert TurnSignal(content="k").content == "k"

    def test_defaults_to_fact_rather_than_refusing(self) -> None:
        """No match types the turn; it never drops it."""
        assert TurnSignal(content="anything").event_type == EventType.FACT


class TestContentIsPreservedExactly:
    """No shortening, at any size. docs/CODING_STANDARDS.md:160.

    Sizes are INPUTS, not thresholds. They bracket the 1,500 the deployed
    adapter shortens at (turn-capture.ts:386) and continue well past it, so a
    reintroduced cut anywhere fails some case. One fixed size would prove only
    that one size survives.
    """

    @pytest.mark.parametrize(
        "size", [1, 24, 1_499, 1_500, 1_501, 5_000, 50_000, 200_001, 500_000]
    )
    def test_signal_content_length_is_unchanged(self, size: int) -> None:
        text = "a" * size

        assert len(TurnSignal(content=text).content) == size

    @pytest.mark.parametrize("size", [1, 1_500, 200_000, 200_001, 500_000])
    def test_raw_turn_content_length_is_unchanged(self, size: int) -> None:
        text = "b" * size
        turn = RawTurn(turn_uuid="u1", content=text)

        assert len(turn.content) == size

    def test_content_is_byte_identical_not_merely_the_same_length(self) -> None:
        """Length equality would pass a model that replaced the text."""
        text = "line one\n  indented\ttabbed\nunicode: 你好 \U0001f600 \n"

        assert TurnSignal(content=text).content == text

    def test_leading_and_trailing_whitespace_is_kept(self) -> None:
        """Stripping is shortening. What was said includes how it was spaced."""
        text = "  ok  \n"

        assert TurnSignal(content=text).content == text


class TestStructurallyEmptyContent:
    """The ONLY content test: is there anything here at all."""

    @pytest.mark.parametrize("text", ["", " ", "   ", "\n", "\t", " \n\t "])
    def test_empty_or_whitespace_only_is_refused(self, text: str) -> None:
        with pytest.raises(ValidationError):
            TurnSignal(content=text)

    def test_the_error_says_there_is_no_length_floor(self) -> None:
        """The message must not read as 'too short', or someone will 'fix' it."""
        with pytest.raises(ValidationError) as caught:
            TurnSignal(content="")

        message = str(caught.value)
        assert "no length floor" in message
        assert "ACTION REQUIRED" in message

    def test_a_raw_turn_may_carry_empty_content(self) -> None:
        """The raw lane records what a line WAS, including an empty one.

        Deliberately different from TurnSignal: a signal is a judgement and an
        empty one is meaningless, but a transcript record with empty text is a
        fact about the transcript.
        """
        assert RawTurn(turn_uuid="u1", content="").content == ""


class TestModelsAreDistinct:
    """RawTurn and TurnSignal must not collapse into one shape."""

    def test_a_raw_turn_has_no_event_type(self) -> None:
        """An observation must not carry a judgement field.

        If it did, nothing could express 'stored but never classified', which is
        the normal state of every row in the raw lane.
        """
        assert "event_type" not in RawTurn.model_fields

    def test_a_signal_has_no_transcript_identity(self) -> None:
        """A judgement is about content, not about a transcript row."""
        assert "turn_uuid" not in TurnSignal.model_fields

    def test_unknown_fields_are_refused(self) -> None:
        """extra='forbid': a typo'd field name fails rather than vanishing."""
        with pytest.raises(ValidationError, match="contnet"):
            TurnSignal(content="x", contnet="typo")  # type: ignore[call-arg]

    def test_models_are_frozen(self) -> None:
        """A captured turn is a record of what happened; it is not editable."""
        signal = TurnSignal(content="x")

        with pytest.raises(ValidationError):
            signal.content = "y"  # type: ignore[misc]
