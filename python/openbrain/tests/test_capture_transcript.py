"""Functional tests for the watermark, the reader, and record parsing.

The properties #418 requires of the thing replacing the 8-entry window: nothing
is lost regardless of how many entries a turn produces, a skipped hook self-heals,
and content arrives byte-identical at every size.

Organised by module so a failure names the job that broke.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.apps.capture.transcript import read_since
from openbrain.apps.capture.watermark import (
    BEGINNING_OF_FILE,
    NegativeOffsetError,
    WatermarkRegressionError,
    WatermarkStore,
)

#: A live Claude Code transcript, if this checkout has one.
#:
#: Tests using it are skipped when absent, so the suite still passes on a clean
#: machine -- but on a developer's machine they run against the real thing,
#: which is what caught every wrong assumption about record shape on 2026-07-31.
LIVE_TRANSCRIPT_DIR = Path.home() / ".claude" / "projects"


def operator_line(uuid: str, content: str, *, source: str = "typed") -> str:
    """Build one transcript line in the shape Claude Code actually writes."""
    return json.dumps(
        {
            "type": "user",
            "uuid": uuid,
            "promptSource": source,
            "sessionId": "s1",
            "cwd": "/repo",
            "parentUuid": None,
            "message": {"role": "user", "content": content},
        }
    )


def tool_result_line(uuid: str) -> str:
    """Build a tool-result line: type `user`, but nobody typed it."""
    return json.dumps(
        {
            "type": "user",
            "uuid": uuid,
            "sessionId": "s1",
            "userType": "external",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "content": "output"}],
            },
        }
    )


def assistant_line(uuid: str) -> str:
    return json.dumps({"type": "assistant", "uuid": uuid, "message": {"content": []}})


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


class TestNothingIsLostRegardlessOfEntryCount:
    """#418 acceptance: the entry count of a turn stops mattering."""

    @pytest.mark.parametrize("entries", [30, 553, 1_646])
    def test_a_turn_producing_many_entries_loses_nothing(
        self, tmp_path: Path, entries: int
    ) -> None:
        """30+ is #418's bar, 553 was the plan's worst case, 1,646 is measured.

        The operator turn is written FIRST, then the entries it produced. Under
        the window this replaces, reading only the newest entries meant the turn
        had already scrolled out.
        """
        path = tmp_path / "t.jsonl"
        lines = [operator_line("u1", "the turn that started it")]
        lines += [assistant_line(f"a{index}") for index in range(entries)]
        write_lines(path, lines)

        result = read_since(path, BEGINNING_OF_FILE)

        assert len(result.turns) == 1
        assert result.turns[0].content == "the turn that started it"

    def test_every_operator_turn_across_many_turns_arrives(
        self, tmp_path: Path
    ) -> None:
        """Fifty turns, each burying the last under tool traffic."""
        path = tmp_path / "t.jsonl"
        lines: list[str] = []
        for turn in range(50):
            lines.append(operator_line(f"u{turn}", f"turn {turn}"))
            lines += [assistant_line(f"a{turn}-{i}") for i in range(20)]
        write_lines(path, lines)

        result = read_since(path, BEGINNING_OF_FILE)

        assert [turn.content for turn in result.turns] == [
            f"turn {index}" for index in range(50)
        ]


class TestASkippedHookSelfHeals:
    """#418 acceptance: a missed hook costs nothing permanently."""

    def test_the_next_read_recovers_what_the_skipped_one_would_have_seen(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "first")])

        first = read_since(path, BEGINNING_OF_FILE)

        # Two more turns arrive; the hook that should have run between them does
        # not fire at all.
        write_lines(
            path,
            [
                operator_line("u1", "first"),
                operator_line("u2", "second"),
                operator_line("u3", "third"),
            ],
        )

        second = read_since(path, first.next_offset)

        assert [turn.content for turn in second.turns] == ["second", "third"]

    def test_a_read_with_nothing_new_returns_nothing_and_holds_position(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "only")])

        first = read_since(path, BEGINNING_OF_FILE)
        second = read_since(path, first.next_offset)

        assert second.turns == ()
        assert second.next_offset == first.next_offset

    def test_no_turn_is_delivered_twice_across_consecutive_reads(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        seen: list[str] = []
        offset = BEGINNING_OF_FILE
        lines: list[str] = []

        for batch in range(5):
            lines.append(operator_line(f"u{batch}", f"turn {batch}"))
            write_lines(path, lines)
            result = read_since(path, offset)
            seen += [turn.content for turn in result.turns]
            offset = result.next_offset

        assert seen == [f"turn {index}" for index in range(5)]
        assert len(seen) == len(set(seen))


class TestAPartiallyWrittenRecord:
    """A hook can fire mid-write. The tail must survive to the next read."""

    def test_a_half_written_record_is_not_consumed(self, tmp_path: Path) -> None:
        path = tmp_path / "t.jsonl"
        complete = operator_line("u1", "complete")
        path.write_text(f"{complete}\n" + '{"type":"user","uuid":"u2"', encoding="utf-8")

        result = read_since(path, BEGINNING_OF_FILE)

        assert [turn.content for turn in result.turns] == ["complete"]
        assert result.next_offset == len(complete) + 1

    def test_the_next_read_sees_the_completed_record_whole(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        complete = operator_line("u1", "complete")
        partial = operator_line("u2", "was still being written")
        path.write_text(f"{complete}\n{partial[:20]}", encoding="utf-8")

        first = read_since(path, BEGINNING_OF_FILE)
        path.write_text(f"{complete}\n{partial}\n", encoding="utf-8")
        second = read_since(path, first.next_offset)

        assert [turn.content for turn in second.turns] == ["was still being written"]

    def test_a_file_of_only_a_partial_record_yields_nothing(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        path.write_text('{"type":"user"', encoding="utf-8")

        result = read_since(path, BEGINNING_OF_FILE)

        assert result.turns == ()
        assert result.next_offset == BEGINNING_OF_FILE


class TestContentIsPreservedExactly:
    """Sizes are inputs, not thresholds.

    They bracket the 200,000 the replaced adapter cut at and continue past it,
    so a shortening reintroduced anywhere fails some case.
    """

    @pytest.mark.parametrize(
        "size", [1, 24, 1_500, 199_999, 200_000, 200_001, 500_000]
    )
    def test_length_is_unchanged(self, tmp_path: Path, size: int) -> None:
        path = tmp_path / "t.jsonl"
        content = "a" * size
        write_lines(path, [operator_line("u1", content)])

        result = read_since(path, BEGINNING_OF_FILE)

        assert len(result.turns[0].content) == size

    def test_content_is_byte_identical(self, tmp_path: Path) -> None:
        path = tmp_path / "t.jsonl"
        content = "line one\n  indented\ttabbed\nunicode: 你好 \U0001f600\n"
        write_lines(path, [operator_line("u1", content)])

        result = read_since(path, BEGINNING_OF_FILE)

        assert result.turns[0].content == content


class TestOnlyTheOperatorIsCaptured:
    """Measured 2026-07-31: `type == "user"` is mostly NOT the operator."""

    def test_a_tool_result_is_not_an_operator_turn(self) -> None:
        assert raw_turn_from_line(tool_result_line("t1")) is None

    def test_an_assistant_record_is_not_an_operator_turn(self) -> None:
        assert raw_turn_from_line(assistant_line("a1")) is None

    @pytest.mark.parametrize("source", ["typed", "queued"])
    def test_typed_and_queued_are_both_the_operator(self, source: str) -> None:
        turn = raw_turn_from_line(operator_line("u1", "hello", source=source))

        assert turn is not None
        assert turn.content == "hello"
        assert turn.is_human_prompt is True

    def test_injected_system_text_is_not_the_operator(self) -> None:
        """`promptSource: "system"` is text the operator never wrote."""
        assert raw_turn_from_line(operator_line("u1", "policy", source="system")) is None

    def test_a_record_with_no_prompt_source_is_declined(self) -> None:
        line = json.dumps(
            {"type": "user", "uuid": "u1", "message": {"content": "text"}}
        )

        assert raw_turn_from_line(line) is None

    def test_the_headers_every_transcript_opens_with_are_declined(self) -> None:
        """The first three lines of a real transcript carry no uuid at all."""
        for line in (
            '{"type":"last-prompt","leafUuid":"x","sessionId":"s"}',
            '{"type":"mode","mode":"normal","sessionId":"s"}',
            '{"type":"permission-mode","permissionMode":"default","sessionId":"s"}',
        ):
            assert raw_turn_from_line(line) is None

    @pytest.mark.parametrize("line", ["", "   ", "{not json", "[]", "null"])
    def test_unusable_lines_are_declined_without_raising(self, line: str) -> None:
        assert raw_turn_from_line(line) is None


class TestFieldsCarriedThrough:
    """A turn arrives with the identity that lets it be threaded to its session."""

    def test_identity_and_provenance_survive(self) -> None:
        turn = raw_turn_from_line(operator_line("u42", "text"))

        assert turn is not None
        assert turn.turn_uuid == "u42"
        assert turn.session_ref == "s1"
        assert turn.repo == "/repo"

    def test_a_null_parent_arrives_as_none(self) -> None:
        """`parentUuid` is null on the first turn of every session."""
        turn = raw_turn_from_line(operator_line("u1", "first"))

        assert turn is not None
        assert turn.parent_turn_uuid is None


class TestWatermarkStore:
    """One job: hold an integer per session, and only ever let it move forward."""

    def test_an_unknown_session_starts_at_the_beginning(self, tmp_path: Path) -> None:
        """Not at the end: a new session must have its whole transcript read."""
        store = WatermarkStore(tmp_path / "w.json")

        assert store.offset_for("never-seen") == BEGINNING_OF_FILE

    def test_an_advanced_offset_is_remembered(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("s1", 4096)

        assert store.offset_for("s1") == 4096

    def test_it_survives_a_new_store_object(self, tmp_path: Path) -> None:
        path = tmp_path / "w.json"
        WatermarkStore(path).advance("s1", 99)

        assert WatermarkStore(path).offset_for("s1") == 99

    def test_sessions_do_not_share_an_offset(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("s1", 10)
        store.advance("s2", 20)

        assert store.offset_for("s1") == 10
        assert store.offset_for("s2") == 20

    def test_moving_backward_is_refused(self, tmp_path: Path) -> None:
        """Backward means re-ingesting turns already stored."""
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("s1", 100)

        with pytest.raises(WatermarkRegressionError):
            store.advance("s1", 50)

    def test_a_refused_move_leaves_the_offset_untouched(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("s1", 100)

        with pytest.raises(WatermarkRegressionError):
            store.advance("s1", 50)

        assert store.offset_for("s1") == 100

    def test_a_negative_offset_is_refused(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.json")

        with pytest.raises(NegativeOffsetError):
            store.advance("s1", -1)

    def test_advancing_to_the_same_position_is_allowed(self, tmp_path: Path) -> None:
        """A read with nothing new re-commits the position it already held."""
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("s1", 10)
        store.advance("s1", 10)

        assert store.offset_for("s1") == 10

    def test_a_corrupt_store_reads_as_the_beginning(self, tmp_path: Path) -> None:
        """Re-reading duplicates turns; trusting garbage loses them."""
        path = tmp_path / "w.json"
        path.write_text("{ this is not json", encoding="utf-8")

        assert WatermarkStore(path).offset_for("s1") == BEGINNING_OF_FILE

    def test_no_staging_file_is_left_behind(self, tmp_path: Path) -> None:
        path = tmp_path / "w.json"
        WatermarkStore(path).advance("s1", 5)

        assert sorted(item.name for item in tmp_path.iterdir()) == ["w.json"]


class TestAReplacedTranscript:
    """A stored offset can outlive the file it pointed into."""

    def test_a_shortened_file_is_read_from_the_beginning(
        self, tmp_path: Path
    ) -> None:
        """A smaller file was replaced, so the stored offset means nothing."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line(f"u{i}", f"turn {i}") for i in range(10)])
        stale = read_since(path, BEGINNING_OF_FILE).next_offset

        write_lines(path, [operator_line("new", "the replacement")])
        result = read_since(path, stale)

        assert [turn.content for turn in result.turns] == ["the replacement"]

    def test_a_missing_file_is_not_an_error(self, tmp_path: Path) -> None:
        result = read_since(tmp_path / "absent.jsonl", 42)

        assert result.turns == ()
        assert result.next_offset == 42


class TestModuleIndependence:
    """The three jobs must not be able to hide each other."""

    def test_the_reader_holds_no_state_between_calls(self, tmp_path: Path) -> None:
        """Same arguments, same answer -- the cursor lives outside the reader."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "text")])

        assert read_since(path, BEGINNING_OF_FILE) == read_since(
            path, BEGINNING_OF_FILE
        )

    def test_the_watermark_never_touches_a_transcript(self, tmp_path: Path) -> None:
        """It stores an integer; whether a file exists is not its business."""
        store = WatermarkStore(tmp_path / "w.json")
        store.advance("/a/path/that/does/not/exist.jsonl", 1_000_000)

        assert store.offset_for("/a/path/that/does/not/exist.jsonl") == 1_000_000

    def test_record_parsing_never_touches_the_filesystem(self) -> None:
        """A line is parsed from a string, so a reader bug cannot mask one here."""
        assert raw_turn_from_line(operator_line("u1", "x")) is not None


@pytest.mark.skipif(
    not LIVE_TRANSCRIPT_DIR.is_dir(), reason="no live Claude Code transcripts present"
)
class TestAgainstARealTranscript:
    """The assumptions this module encodes, checked against a real file.

    Every rule in records.py came from measuring a live transcript. These keep
    that honest: if Claude Code changes the format, this fails here rather than
    silently capturing nothing in production.
    """

    @staticmethod
    def largest_transcript() -> Path | None:
        candidates = [
            path
            for path in LIVE_TRANSCRIPT_DIR.rglob("*.jsonl")
            if path.stat().st_size > 0
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda path: path.stat().st_size)

    def test_operator_turns_are_found_and_tool_results_are_not(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        result = read_since(path, BEGINNING_OF_FILE)
        user_records = sum(
            1
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.startswith('{"type":"user"') or '"type":"user"' in line
        )

        assert result.turns, "no operator turns found in a real transcript"
        assert len(result.turns) < user_records, (
            "every `user` record was treated as an operator turn; "
            "tool results are leaking into the lane"
        )

    @pytest.mark.parametrize("split_at", [0.1, 0.5, 0.9])
    def test_reading_in_two_parts_matches_reading_in_one(
        self, tmp_path: Path, split_at: float
    ) -> None:
        """The watermark's core promise, stated exactly, against real bytes.

        A read stopped at an arbitrary point and resumed must produce the same
        turns, in the same order, as one uninterrupted read. Split at three
        different points, because a boundary that happens to land between turns
        would prove nothing about one that lands mid-turn.
        """
        live = self.largest_transcript()
        if live is None:
            pytest.skip("no non-empty transcript found")

        # Work on a copy: nothing in this suite writes near a live transcript.
        path = tmp_path / "real.jsonl"
        path.write_bytes(live.read_bytes())

        whole = read_since(path, BEGINNING_OF_FILE)
        assert read_since(path, whole.next_offset).turns == (), (
            "a full read left bytes unconsumed"
        )

        boundary = int(path.stat().st_size * split_at)

        # The transcript truncated at the boundary is exactly what the reader
        # would have seen had the hook fired at that moment, mid-record.
        head_path = tmp_path / "head.jsonl"
        head_path.write_bytes(path.read_bytes()[:boundary])

        head = read_since(head_path, BEGINNING_OF_FILE)
        tail = read_since(path, head.next_offset)

        assert head.turns + tail.turns == whole.turns

    def test_no_turn_uuid_is_duplicated(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        turns = read_since(path, BEGINNING_OF_FILE).turns
        uuids = [turn.turn_uuid for turn in turns]

        assert len(uuids) == len(set(uuids))

    def test_every_captured_turn_has_content(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        for turn in read_since(path, BEGINNING_OF_FILE).turns:
            assert isinstance(turn.content, str)


def test_the_staging_file_is_replaced_atomically(tmp_path: Path) -> None:
    """os.replace is atomic, so a reader sees old or new, never truncated."""
    path = tmp_path / "w.json"
    store = WatermarkStore(path)
    store.advance("s1", 1)
    before = path.read_text(encoding="utf-8")

    store.advance("s1", 2)

    assert before != path.read_text(encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8")) == {"s1": 2}
    assert not any(item.name.endswith(".staging") for item in tmp_path.iterdir())


def test_the_store_creates_its_parent_directory(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "deeper" / "w.json"
    WatermarkStore(path).advance("s1", 7)

    assert path.is_file()
    assert os.access(path, os.R_OK)
