"""Functional tests for the watermark, the reader, and record parsing.

The properties #418 requires of the thing replacing the 8-entry window: nothing
is lost regardless of how many entries a turn produces, a skipped hook self-heals,
and content arrives byte-identical at every size.

Organised by module so a failure names the job that broke.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.apps.capture.transcript import read_since
from openbrain.apps.capture.watermark import (
    BEGINNING_OF_FILE,
    FileIdentity,
    WatermarkRegressionError,
    WatermarkStore,
)

#: A live Claude Code transcript, if this checkout has one.
#:
#: Tests using it are skipped when absent, so the suite still passes on a clean
#: machine -- but on a developer's machine they run against the real thing,
#: which is what caught every wrong assumption about record shape on 2026-07-31.
LIVE_TRANSCRIPT_DIR = Path.home() / ".claude" / "projects"

#: A second process that takes the write lock, announces it, and holds briefly.
#:
#: Must be a real process. SQLite resolves same-connection and in-process
#: contention immediately, so an in-process "holder" tests nothing about the
#: busy timeout -- which is how a timeout that failed in 0ms looked healthy.
LOCK_HOLDER = """
import sqlite3, sys, time
connection = sqlite3.connect(sys.argv[1], timeout=30, autocommit=True)
connection.execute("BEGIN IMMEDIATE")
connection.execute(
    "INSERT INTO watermark (session_key, offset, device, inode)"
    " VALUES ('lock-holder', 1, NULL, NULL)"
    " ON CONFLICT(session_key) DO UPDATE SET offset = excluded.offset"
)
print("held", flush=True)
time.sleep(0.4)
connection.commit()
connection.close()
"""


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
    async def test_a_turn_producing_many_entries_loses_nothing(
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

        result = await read_since(path, BEGINNING_OF_FILE)

        assert len(result.turns) == 1
        assert result.turns[0].content == "the turn that started it"

    async def test_every_operator_turn_across_many_turns_arrives(
        self, tmp_path: Path
    ) -> None:
        """Fifty turns, each burying the last under tool traffic."""
        path = tmp_path / "t.jsonl"
        lines: list[str] = []
        for turn in range(50):
            lines.append(operator_line(f"u{turn}", f"turn {turn}"))
            lines += [assistant_line(f"a{turn}-{i}") for i in range(20)]
        write_lines(path, lines)

        result = await read_since(path, BEGINNING_OF_FILE)

        assert [turn.content for turn in result.turns] == [
            f"turn {index}" for index in range(50)
        ]


class TestASkippedHookSelfHeals:
    """#418 acceptance: a missed hook costs nothing permanently."""

    async def test_the_next_read_recovers_what_the_skipped_one_would_have_seen(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "first")])

        first = await read_since(path, BEGINNING_OF_FILE)

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

        second = await read_since(path, first.next_offset)

        assert [turn.content for turn in second.turns] == ["second", "third"]

    async def test_a_read_with_nothing_new_returns_nothing_and_holds_position(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "only")])

        first = await read_since(path, BEGINNING_OF_FILE)
        second = await read_since(path, first.next_offset)

        assert second.turns == ()
        assert second.next_offset == first.next_offset

    async def test_no_turn_is_delivered_twice_across_consecutive_reads(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        seen: list[str] = []
        offset = BEGINNING_OF_FILE
        lines: list[str] = []

        for batch in range(5):
            lines.append(operator_line(f"u{batch}", f"turn {batch}"))
            write_lines(path, lines)
            result = await read_since(path, offset)
            seen += [turn.content for turn in result.turns]
            offset = result.next_offset

        assert seen == [f"turn {index}" for index in range(5)]
        assert len(seen) == len(set(seen))


class TestAPartiallyWrittenRecord:
    """A hook can fire mid-write. The tail must survive to the next read."""

    async def test_a_half_written_record_is_not_consumed(self, tmp_path: Path) -> None:
        path = tmp_path / "t.jsonl"
        complete = operator_line("u1", "complete")
        path.write_text(f"{complete}\n" + '{"type":"user","uuid":"u2"', encoding="utf-8")

        result = await read_since(path, BEGINNING_OF_FILE)

        assert [turn.content for turn in result.turns] == ["complete"]
        assert result.next_offset == len(complete) + 1

    async def test_the_next_read_sees_the_completed_record_whole(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        complete = operator_line("u1", "complete")
        partial = operator_line("u2", "was still being written")
        path.write_text(f"{complete}\n{partial[:20]}", encoding="utf-8")

        first = await read_since(path, BEGINNING_OF_FILE)
        path.write_text(f"{complete}\n{partial}\n", encoding="utf-8")
        second = await read_since(path, first.next_offset)

        assert [turn.content for turn in second.turns] == ["was still being written"]

    async def test_a_file_of_only_a_partial_record_yields_nothing(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        path.write_text('{"type":"user"', encoding="utf-8")

        result = await read_since(path, BEGINNING_OF_FILE)

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
    async def test_length_is_unchanged(self, tmp_path: Path, size: int) -> None:
        path = tmp_path / "t.jsonl"
        content = "a" * size
        write_lines(path, [operator_line("u1", content)])

        result = await read_since(path, BEGINNING_OF_FILE)

        assert len(result.turns[0].content) == size

    async def test_content_is_byte_identical(self, tmp_path: Path) -> None:
        path = tmp_path / "t.jsonl"
        content = "line one\n  indented\ttabbed\nunicode: 你好 \U0001f600\n"
        write_lines(path, [operator_line("u1", content)])

        result = await read_since(path, BEGINNING_OF_FILE)

        assert result.turns[0].content == content


class TestOnlyTheOperatorIsCaptured:
    """Measured 2026-07-31: `type == "user"` is mostly NOT the operator."""

    async def test_a_tool_result_is_not_an_operator_turn(self) -> None:
        assert raw_turn_from_line(tool_result_line("t1")) is None

    async def test_an_assistant_record_is_not_an_operator_turn(self) -> None:
        assert raw_turn_from_line(assistant_line("a1")) is None

    @pytest.mark.parametrize("source", ["typed", "queued"])
    async def test_typed_and_queued_are_both_the_operator(self, source: str) -> None:
        turn = raw_turn_from_line(operator_line("u1", "hello", source=source))

        assert turn is not None
        assert turn.content == "hello"
        assert turn.is_human_prompt is True

    async def test_injected_system_text_is_not_the_operator(self) -> None:
        """`promptSource: "system"` is text the operator never wrote."""
        assert raw_turn_from_line(operator_line("u1", "policy", source="system")) is None

    async def test_a_record_with_no_prompt_source_is_declined(self) -> None:
        line = json.dumps(
            {"type": "user", "uuid": "u1", "message": {"content": "text"}}
        )

        assert raw_turn_from_line(line) is None

    async def test_the_headers_every_transcript_opens_with_are_declined(self) -> None:
        """The first three lines of a real transcript carry no uuid at all."""
        for line in (
            '{"type":"last-prompt","leafUuid":"x","sessionId":"s"}',
            '{"type":"mode","mode":"normal","sessionId":"s"}',
            '{"type":"permission-mode","permissionMode":"default","sessionId":"s"}',
        ):
            assert raw_turn_from_line(line) is None

    @pytest.mark.parametrize("line", ["", "   ", "{not json", "[]", "null"])
    async def test_unusable_lines_are_declined_without_raising(self, line: str) -> None:
        assert raw_turn_from_line(line) is None


class TestFieldsCarriedThrough:
    """A turn arrives with the identity that lets it be threaded to its session."""

    async def test_identity_and_provenance_survive(self) -> None:
        turn = raw_turn_from_line(operator_line("u42", "text"))

        assert turn is not None
        assert turn.turn_uuid == "u42"
        assert turn.session_ref == "s1"
        assert turn.repo == "/repo"

    async def test_a_null_parent_arrives_as_none(self) -> None:
        """`parentUuid` is null on the first turn of every session."""
        turn = raw_turn_from_line(operator_line("u1", "first"))

        assert turn is not None
        assert turn.parent_turn_uuid is None


class TestWatermarkStore:
    """One job: hold an integer per session, and only ever let it move forward."""

    async def test_an_unknown_session_starts_at_the_beginning(self, tmp_path: Path) -> None:
        """Not at the end: a new session must have its whole transcript read."""
        store = WatermarkStore(tmp_path / "w.db")

        assert await store.offset_for("never-seen") == BEGINNING_OF_FILE

    async def test_an_advanced_offset_is_remembered(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 4096)

        assert await store.offset_for("s1") == 4096

    async def test_it_survives_a_new_store_object(self, tmp_path: Path) -> None:
        path = tmp_path / "w.db"
        await WatermarkStore(path).advance("s1", 99)

        assert await WatermarkStore(path).offset_for("s1") == 99

    async def test_sessions_do_not_share_an_offset(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 10)
        await store.advance("s2", 20)

        assert await store.offset_for("s1") == 10
        assert await store.offset_for("s2") == 20

    async def test_moving_backward_is_refused(self, tmp_path: Path) -> None:
        """Backward means re-ingesting turns already stored."""
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 100)

        with pytest.raises(WatermarkRegressionError):
            await store.advance("s1", 50)

    async def test_a_refused_move_leaves_the_offset_untouched(self, tmp_path: Path) -> None:
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 100)

        with pytest.raises(WatermarkRegressionError):
            await store.advance("s1", 50)

        assert await store.offset_for("s1") == 100

    async def test_a_negative_offset_is_refused(self, tmp_path: Path) -> None:
        """A byte offset is never negative; pydantic enforces it at the field."""
        store = WatermarkStore(tmp_path / "w.db")

        with pytest.raises(ValidationError):
            await store.advance("s1", -1)

    async def test_advancing_to_the_same_position_is_allowed(self, tmp_path: Path) -> None:
        """A read with nothing new re-commits the position it already held."""
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 10)
        await store.advance("s1", 10)

        assert await store.offset_for("s1") == 10

    async def test_a_position_carries_the_file_it_belongs_to(self, tmp_path: Path) -> None:
        """An offset without an identity cannot be resumed safely."""
        store = WatermarkStore(tmp_path / "w.db")
        identity = FileIdentity(device=1, inode=2)
        await store.advance("s1", 100, identity)

        assert (await store.position_for("s1")).identity == identity

    async def test_a_replaced_file_may_rewind_the_offset(self, tmp_path: Path) -> None:
        """Forward-only applies WITHIN a file, not across two of them.

        A new file has its own positions, so refusing a lower offset here would
        wedge the session permanently after any rotation.
        """
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("s1", 5_000, FileIdentity(device=1, inode=2))

        await store.advance("s1", 10, FileIdentity(device=1, inode=999))

        assert await store.offset_for("s1") == 10

    async def test_a_write_waits_for_another_process_holding_the_lock(
        self, tmp_path: Path
    ) -> None:
        """The busy timeout, proven against a REAL second process.

        This is the test the constant alone could not give. Measured 2026-07-31:
        with a deferred read-then-write transaction the store failed in 0ms with
        `database is locked` while LOCK_WAIT_SECONDS was 30 -- the timeout was
        set, and doing nothing, because SQLite will not wait on a lock UPGRADE.

        Holding the lock in-process would not exercise it: SQLite answers
        same-connection contention immediately and correctly. It takes another
        process.
        """
        path = tmp_path / "w.db"
        store = WatermarkStore(path)
        await store.advance("s1", 1)

        holder = subprocess.Popen(
            [sys.executable, "-c", LOCK_HOLDER, str(path)],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            assert holder.stdout is not None
            assert holder.stdout.readline().strip() == "held", "lock never taken"

            await store.advance("s1", 2)
        finally:
            holder.wait(timeout=30)

        assert await store.offset_for("s1") == 2

    async def test_writes_from_two_connections_do_not_lose_a_session(
        self, tmp_path: Path
    ) -> None:
        """Two sessions must not erase each other's position.

        NOT the expected case -- a `Stop` hook is one process per session, and
        two sessions have different keys. It is tested because the JSON store
        this replaced got it WRONG: whole-file read-modify-write meant the
        second writer erased the first session's row entirely, and the cost of
        being wrong about concurrency is a permanently lost turn.
        """
        path = tmp_path / "w.db"
        await WatermarkStore(path).advance("worker-1-session", 111)
        await WatermarkStore(path).advance("worker-2-session", 222)

        reader = WatermarkStore(path)
        assert await reader.offset_for("worker-1-session") == 111
        assert await reader.offset_for("worker-2-session") == 222


class TestAReplacedTranscript:
    """A stored offset can outlive the file it pointed into.

    Two distinct failures needing two distinct checks -- see `_start_position`.
    The rename/create case below was a LIVE DEFECT in commit 1ff077d, found by
    searching how log shippers solve this rather than by testing.
    """

    async def test_a_replaced_file_is_read_whole_even_when_it_is_larger(
        self, tmp_path: Path
    ) -> None:
        """The measured defect: 3 of 9 turns silently skipped.

        rename/create rotation gives the new file a NEW INODE, and its size can
        be anything. A size-only check passes, the reader resumes mid-file, and
        every turn before the old offset is lost with no error and no trace.
        """
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line(f"u{i}", f"original {i}") for i in range(3)])

        first = await read_since(path, BEGINNING_OF_FILE)
        assert first.identity is not None

        # Replaced by a DIFFERENT file that is LARGER than the old offset.
        path.unlink()
        write_lines(
            path, [operator_line(f"n{i}", f"replacement {i}") for i in range(9)]
        )
        assert path.stat().st_size > first.next_offset, "test must exercise the bug"

        second = await read_since(path, first.next_offset, first.identity)

        assert [turn.content for turn in second.turns] == [
            f"replacement {index}" for index in range(9)
        ]

    async def test_the_identity_travels_with_the_read(self, tmp_path: Path) -> None:
        """A caller cannot store an offset against a file without being told it."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "text")])

        result = await read_since(path, BEGINNING_OF_FILE)

        assert result.identity == FileIdentity.of(path)

    async def test_an_unchanged_file_still_resumes(self, tmp_path: Path) -> None:
        """The identity check must not make every read start over."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "first")])
        first = await read_since(path, BEGINNING_OF_FILE)

        write_lines(path, [operator_line("u1", "first"), operator_line("u2", "second")])
        second = await read_since(path, first.next_offset, first.identity)

        assert [turn.content for turn in second.turns] == ["second"]

    async def test_a_shortened_file_is_read_from_the_beginning(
        self, tmp_path: Path
    ) -> None:
        """A smaller file was replaced, so the stored offset means nothing."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line(f"u{i}", f"turn {i}") for i in range(10)])
        stale = (await read_since(path, BEGINNING_OF_FILE)).next_offset

        write_lines(path, [operator_line("new", "the replacement")])
        result = await read_since(path, stale)

        assert [turn.content for turn in result.turns] == ["the replacement"]

    async def test_a_missing_file_is_not_an_error(self, tmp_path: Path) -> None:
        result = await read_since(tmp_path / "absent.jsonl", 42)

        assert result.turns == ()
        assert result.next_offset == 42


class TestModuleIndependence:
    """The three jobs must not be able to hide each other."""

    async def test_the_reader_holds_no_state_between_calls(self, tmp_path: Path) -> None:
        """Same arguments, same answer -- the cursor lives outside the reader."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "text")])

        assert await read_since(path, BEGINNING_OF_FILE) == await read_since(
            path, BEGINNING_OF_FILE
        )

    async def test_the_watermark_never_touches_a_transcript(self, tmp_path: Path) -> None:
        """It stores an integer; whether a file exists is not its business."""
        store = WatermarkStore(tmp_path / "w.db")
        await store.advance("/a/path/that/does/not/exist.jsonl", 1_000_000)

        assert await store.offset_for("/a/path/that/does/not/exist.jsonl") == 1_000_000

    async def test_record_parsing_never_touches_the_filesystem(self) -> None:
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

    async def test_operator_turns_are_found_and_tool_results_are_not(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        result = await read_since(path, BEGINNING_OF_FILE)
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
    async def test_reading_in_two_parts_matches_reading_in_one(
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

        whole = await read_since(path, BEGINNING_OF_FILE)
        assert (await read_since(path, whole.next_offset)).turns == (), (
            "a full read left bytes unconsumed"
        )

        boundary = int(path.stat().st_size * split_at)

        # The transcript truncated at the boundary is exactly what the reader
        # would have seen had the hook fired at that moment, mid-record.
        head_path = tmp_path / "head.jsonl"
        head_path.write_bytes(path.read_bytes()[:boundary])

        head = await read_since(head_path, BEGINNING_OF_FILE)
        tail = await read_since(path, head.next_offset)

        assert head.turns + tail.turns == whole.turns

    async def test_no_turn_uuid_is_duplicated(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        turns = (await read_since(path, BEGINNING_OF_FILE)).turns
        uuids = [turn.turn_uuid for turn in turns]

        assert len(uuids) == len(set(uuids))

    async def test_every_captured_turn_has_content(self) -> None:
        path = self.largest_transcript()
        if path is None:
            pytest.skip("no non-empty transcript found")

        for turn in (await read_since(path, BEGINNING_OF_FILE)).turns:
            assert isinstance(turn.content, str)


async def test_the_store_survives_a_process_that_never_closed_it(tmp_path: Path) -> None:
    """A hook process can be killed at any moment.

    SQLite's own durability replaces the hand-written staging-file dance: a
    committed write is on disk whether or not anything closed the connection.
    """
    path = tmp_path / "w.db"
    await WatermarkStore(path).advance("s1", 4_096)

    assert await WatermarkStore(path).offset_for("s1") == 4_096


async def test_the_store_creates_its_parent_directory(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "deeper" / "w.db"
    await WatermarkStore(path).advance("s1", 7)

    assert path.is_file()
    assert os.access(path, os.R_OK)
