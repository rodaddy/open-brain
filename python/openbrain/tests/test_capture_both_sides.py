"""Capture records BOTH sides of the work, not just the operator's half (#447).

The defect these pin is a PORT REGRESSION, and the red-proof is stated in terms
of it: every test in :class:`TestTheAgentSideIsCaptured` fails on the pre-#447
parser, which returned ``None`` for every ``type == "assistant"`` record, and
passes on the restored one. Measured on the dogfood database before the fix --
389 operator turns against 15 assistant rows, all 15 of them ``PostCompact``
summaries rather than replies -- so the corpus REM grades held the questions and
none of the answers.

Organised by the claim each group makes, so a failure names the rule that broke:

    TestTheAgentSideIsCaptured   the reply lands, whole, as the assistant
    TestReasoningIsNeverStored   thinking/tool blocks stay out, by their own rules
    TestTheOperatorSideIsIntact  the half that already worked still works
    TestBothSidesReachTheLane    the spine delivers the conversation in order

The last group is the one that actually answers #447's title: a single
transcript, read once, yields both speakers in the order they spoke.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from conftest import (
    RecordingLane,
    assistant_line,
    assistant_says,
    operator_line,
    text_block,
    thinking_block,
    tool_use_block,
    write_lines,
)
from openbrain.apps.capture.deliver import deliver_new_turns
from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.models.turn import TurnRole

if TYPE_CHECKING:
    from pathlib import Path

#: A finding phrased the way the agent actually phrases one. Deliberately NOT a
#: word any classifier pattern would match: #447 is about whether the agent side
#: is stored at all, and a fixture that happened to look like a "decision" would
#: pass for the wrong reason.
FINDING = "The fleet index is 20% third-party code and buzz's checkout is dirty."


class TestTheAgentSideIsCaptured:
    """An assistant record becomes a turn. THE RED-PROOF GROUP (#447)."""

    def test_an_assistant_reply_becomes_a_turn(self) -> None:
        """The core regression: before #447 this returned None, silently."""
        turn = raw_turn_from_line(assistant_says("a1", text_block(FINDING)))

        assert turn is not None, (
            "the assistant side was dropped -- this is the #447 regression, "
            "where a session recorded the questions and none of the answers"
        )
        assert turn.content == FINDING

    def test_the_reply_is_attributed_to_the_assistant(self) -> None:
        """Role is a FACT per branch, never the model's USER default."""
        turn = raw_turn_from_line(assistant_says("a1", text_block(FINDING)))

        assert turn is not None
        assert turn.role is TurnRole.ASSISTANT

    def test_the_agent_side_is_not_counted_as_a_human_prompt(self) -> None:
        """``is_human_prompt`` stays the operator-only health-check signal.

        ``capture-never-drops-a-turn.md`` compares typed-in-transcript against
        ``is_human_prompt`` rows to detect operator-side loss. An assistant turn
        setting it would inflate that count and hide exactly what it watches for.
        """
        turn = raw_turn_from_line(assistant_says("a1", text_block(FINDING)))

        assert turn is not None
        assert turn.is_human_prompt is False

    def test_a_reply_carries_its_transcript_metadata(self) -> None:
        """Ordering and provenance are populated for the agent side too.

        ``occurred_at`` is THE ordering key -- the server sequences a session by
        ``(session_ref, occurred_at)`` -- so an assistant turn without it is
        stored but unorderable, which is how 20,535 backfilled rows were lost to
        sequencing once already.
        """
        turn = raw_turn_from_line(
            assistant_says("a1", text_block(FINDING), session="s9")
        )

        assert turn is not None
        assert turn.occurred_at is not None
        assert turn.session_ref == "s9"
        assert turn.turn_uuid == "a1"

    def test_several_text_blocks_are_joined_in_order(self) -> None:
        """One record can speak more than once; all of it is the reply."""
        turn = raw_turn_from_line(
            assistant_says("a1", text_block("first"), text_block("second"))
        )

        assert turn is not None
        assert turn.content == "first\nsecond"

    def test_prose_around_a_tool_call_is_kept_whole(self) -> None:
        """The interleaved shape is NORMAL -- 59 of 134 measured records.

        Declining a record because it also called a tool would drop precisely
        the replies that carry the most reasoning.
        """
        turn = raw_turn_from_line(
            assistant_says(
                "a1",
                text_block("before"),
                tool_use_block("Bash"),
                text_block("after"),
            )
        )

        assert turn is not None
        assert turn.content == "before\nafter"

    def test_a_long_reply_is_stored_byte_for_byte(self) -> None:
        """No length floor and no shortening on the agent side either."""
        long_finding = FINDING * 500
        turn = raw_turn_from_line(assistant_says("a1", text_block(long_finding)))

        assert turn is not None
        assert turn.content == long_finding

    def test_a_one_character_reply_is_stored(self) -> None:
        """"ok" from the agent is as capturable as "ok" from the operator."""
        turn = raw_turn_from_line(assistant_says("a1", text_block("k")))

        assert turn is not None
        assert turn.content == "k"


class TestReasoningIsNeverStored:
    """Chain-of-thought and machinery stay out -- each by its own settled rule."""

    def test_a_thinking_block_is_not_stored(self) -> None:
        """The hard rule: distilled events only, never raw reasoning."""
        turn = raw_turn_from_line(
            assistant_says("a1", thinking_block("let me work through this"))
        )

        assert turn is None, "chain-of-thought must never reach the lane"

    def test_thinking_beside_speech_contributes_nothing(self) -> None:
        """The spoken half lands; the reasoning half is not part of it."""
        turn = raw_turn_from_line(
            assistant_says(
                "a1", thinking_block("private reasoning"), text_block(FINDING)
            )
        )

        assert turn is not None
        assert turn.content == FINDING
        assert "private reasoning" not in turn.content

    def test_a_reply_that_only_called_tools_is_not_a_turn(self) -> None:
        """No spoken text is a real, ordinary record -- declined, not an error."""
        turn = raw_turn_from_line(assistant_says("a1", tool_use_block("Read")))

        assert turn is None

    def test_a_tool_call_never_contributes_its_arguments(self) -> None:
        """The open memory-versus-observability question stays open.

        ``capture-never-drops-a-turn.md``: "Do not resolve this by inference,
        and do not let it be resolved by accident."
        """
        turn = raw_turn_from_line(
            assistant_says("a1", text_block(FINDING), tool_use_block("Bash"))
        )

        assert turn is not None
        assert "Bash" not in turn.content
        assert "command" not in turn.content

    def test_an_empty_assistant_record_is_not_a_turn(self) -> None:
        """Declined for saying nothing, not for being the assistant."""
        assert raw_turn_from_line(assistant_line("a1")) is None

    def test_a_whitespace_only_block_is_not_speech(self) -> None:
        """There is no length floor, but blank is still nothing said."""
        assert raw_turn_from_line(assistant_says("a1", text_block("   "))) is None

    @pytest.mark.parametrize(
        "malformed",
        [
            {"type": "text"},
            {"type": "text", "text": None},
            {"type": "text", "text": 12},
        ],
        ids=["no-text-key", "null-text", "non-string-text"],
    )
    def test_a_malformed_block_is_passed_over(self, malformed: dict) -> None:
        """Report what was readable; never crash on a shape not seen before."""
        turn = raw_turn_from_line(assistant_says("a1", malformed, text_block(FINDING)))

        assert turn is not None
        assert turn.content == FINDING

    def test_an_assistant_record_with_no_uuid_is_declined(self) -> None:
        """No uuid means no server dedupe key, so there is nothing to store."""
        line = '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}'

        assert raw_turn_from_line(line) is None


class TestTheOperatorSideIsIntact:
    """The half that already worked is unchanged -- #447 adds, never trades."""

    def test_an_operator_turn_is_still_captured(self) -> None:
        turn = raw_turn_from_line(operator_line("u1", "roll that back a bit"))

        assert turn is not None
        assert turn.role is TurnRole.USER
        assert turn.is_human_prompt is True

    def test_a_tool_result_is_still_not_a_turn(self) -> None:
        """Type ``user`` without ``promptSource`` is machinery replayed as user.

        The measurement that forced the operator rule: 2,561 ``user`` records,
        only 234 typed by a person.
        """
        line = (
            '{"type":"user","uuid":"t1","sessionId":"s1",'
            '"message":{"content":[{"type":"tool_result","content":"output"}]}}'
        )

        assert raw_turn_from_line(line) is None

    def test_injected_system_text_is_still_not_the_operator(self) -> None:
        """``promptSource: system`` is text the operator never wrote."""
        line = operator_line("u1", "injected").replace('"typed"', '"system"')

        assert raw_turn_from_line(line) is None

    def test_a_mode_marker_is_still_not_a_turn(self) -> None:
        """The first lines of every transcript carry no uuid at all."""
        assert raw_turn_from_line('{"type":"mode","mode":"default"}') is None


class TestBothSidesReachTheLane:
    """#447's actual claim: one read yields the conversation, both speakers."""

    @pytest.mark.asyncio
    async def test_a_conversation_delivers_both_speakers_in_order(
        self, tmp_path: Path
    ) -> None:
        """THE PRODUCT PROOF at the spine boundary.

        Before #447 this delivered 2 turns -- the operator's two questions and
        neither answer. It now delivers 4, alternating, which is what makes the
        next session inherit what this one learned.
        """
        transcript = tmp_path / "session.jsonl"
        write_lines(
            transcript,
            [
                operator_line("u1", "why is the index empty?"),
                assistant_says("a1", text_block(FINDING)),
                operator_line("u2", "fix it"),
                assistant_says("a2", thinking_block("plan"), text_block("Fixed.")),
            ],
        )
        lane = RecordingLane()
        store = WatermarkStore(tmp_path / "watermark.sqlite")

        delivery = await deliver_new_turns(transcript, "s1", store, lane)

        assert delivery.delivered == 4, (
            "a conversation is both speakers -- delivering 2 is the #447 "
            "regression, where resume replays the questions and none of the "
            "answers"
        )
        assert [(turn["role"], turn["content"]) for turn in lane.turns] == [
            ("user", "why is the index empty?"),
            ("assistant", FINDING),
            ("user", "fix it"),
            ("assistant", "Fixed."),
        ]

    @pytest.mark.asyncio
    async def test_no_reasoning_reaches_the_lane(self, tmp_path: Path) -> None:
        """End-to-end guarantee, not just a parser property."""
        transcript = tmp_path / "session.jsonl"
        write_lines(
            transcript,
            [
                assistant_says(
                    "a1", thinking_block("SECRET REASONING"), text_block(FINDING)
                ),
                assistant_says("a2", tool_use_block("Bash")),
            ],
        )
        lane = RecordingLane()
        store = WatermarkStore(tmp_path / "watermark.sqlite")

        await deliver_new_turns(transcript, "s1", store, lane)

        delivered = " ".join(turn["content"] for turn in lane.turns)
        assert "SECRET REASONING" not in delivered
        assert "Bash" not in delivered

    @pytest.mark.asyncio
    async def test_the_watermark_advances_over_both_sides(
        self, tmp_path: Path
    ) -> None:
        """A second Stop re-delivers neither speaker's turns."""
        transcript = tmp_path / "session.jsonl"
        write_lines(
            transcript,
            [
                operator_line("u1", "go"),
                assistant_says("a1", text_block(FINDING)),
            ],
        )
        lane = RecordingLane()
        store = WatermarkStore(tmp_path / "watermark.sqlite")

        first = await deliver_new_turns(transcript, "s1", store, lane)
        second = await deliver_new_turns(transcript, "s1", store, lane)

        assert first.delivered == 2
        assert second.delivered == 0
