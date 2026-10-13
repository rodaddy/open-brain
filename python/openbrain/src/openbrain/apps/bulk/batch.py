"""Recursively ingest dated Claude history through the existing bulk spine."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable, Iterator, Sequence
from datetime import date, datetime
from pathlib import Path

from openbrain.apps.bulk.formats import InputFormat
from openbrain.apps.bulk.ingest import BulkLane, ingest, parse_file
from openbrain.apps.bulk.run import _lane as build_lane
from openbrain.apps.bulk.staging import StagingStore
from openbrain.config import load_capture_settings
from openbrain.models.turn import RawTurn

DEFAULT_STAGING_NAME = ".openbrain-bulk-staging.sqlite"


def default_staging_path(root: Path) -> Path:
    """Place the default staging sqlite beside, never inside, the scanned root."""
    resolved = root.resolve()
    return resolved.parent / f"{resolved.name}{DEFAULT_STAGING_NAME}"


class InvalidTurnTimestampError(ValueError):
    """A parsed Claude turn carries an unusable source timestamp."""

    def __init__(self) -> None:
        """Build the content-free fixed diagnostic."""
        super().__init__("Claude turn has an invalid occurred_at timestamp")


class MissingDeliveryEndpointError(ValueError):
    """The mutating batch lacks a configured delivery endpoint."""

    def __init__(self) -> None:
        """Build the content-free fixed diagnostic."""
        super().__init__("bulk delivery endpoint is not configured")


class InvalidHistoryRootError(ValueError):
    """The requested history root is absent or is not a directory."""

    def __init__(self) -> None:
        """Build the fixed content-free root diagnostic."""
        super().__init__("history root must be an existing directory")


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the recursive Claude-history command line."""
    parser = argparse.ArgumentParser(prog="openbrain-bulk-ingest-claude-history")
    parser.add_argument("root", type=Path, help="root containing Claude JSONL files")
    parser.add_argument("--from-date", type=date.fromisoformat, required=True)
    parser.add_argument("--to-date", type=date.fromisoformat, required=True)
    parser.add_argument("--staging-path", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.from_date > args.to_date:
        parser.error("--from-date must be on or before --to-date")
    return args


def discover_jsonl(root: Path) -> list[Path]:
    """Return every physical JSONL file below ``root`` in stable path order."""
    if not root.is_dir():
        raise InvalidHistoryRootError
    return sorted(
        (
            path
            for path in root.rglob("*.jsonl")
            if path.is_file() and not path.is_symlink()
        ),
        key=lambda path: (len(path.relative_to(root).parts), path.as_posix()),
    )


def _dated_turns(
    paths: Iterable[Path], start: date, end: date, counts: dict[str, int]
) -> Iterator[RawTurn]:
    """Yield parsed Claude turns whose own date is inside the inclusive range."""
    for path in paths:
        for turn in parse_file(path, InputFormat.CLAUDE):
            counts["parsed"] += 1
            if turn.occurred_at is None:
                counts["undated"] += 1
                continue
            if _eligible(turn, start, end):
                counts["eligible"] += 1
                yield turn


def _eligible(turn: RawTurn, start: date, end: date) -> bool:
    """Return whether a turn's source timestamp falls in the inclusive range."""
    if turn.occurred_at is None:
        return False
    try:
        occurred = datetime.fromisoformat(turn.occurred_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise InvalidTurnTimestampError from error
    return start <= occurred.date() <= end


def _count_file(path: Path, start: date, end: date, counts: dict[str, int]) -> bool:
    """Count one file's dated turns; return False when a timestamp is invalid."""
    try:
        sum(1 for _ in _dated_turns([path], start, end, counts))
    except InvalidTurnTimestampError:
        return False
    return True


def _runtime(session_key: str) -> tuple[BulkLane, str]:
    """Build the existing raw lane and its resumable delivery identity."""
    settings = load_capture_settings()
    lane = build_lane(settings, session_key)
    if settings.base_url is None:
        raise MissingDeliveryEndpointError
    return lane, str(settings.base_url)


def _report(**counts: int) -> None:
    """Print the content-free batch receipt in its stable field order."""
    sys.stdout.write(
        " ".join(f"{name}={value}" for name, value in counts.items()) + "\n"
    )


def run(argv: Sequence[str] | None = None) -> int:
    """Discover, parse, date-filter, stage, and deliver Claude history."""
    args = _parse_args(argv)
    paths = discover_jsonl(args.root)
    counts = {"parsed": 0, "eligible": 0, "undated": 0}
    if args.dry_run:
        invalid = sum(
            not _count_file(path, args.from_date, args.to_date, counts)
            for path in paths
        )
        _report(
            discovered=len(paths),
            parsed=counts["parsed"],
            eligible=counts["eligible"],
            undated=counts["undated"],
            invalid=invalid,
            delivered=0,
            deduped=0,
            filtered=0,
            failures=0,
        )
        return 1 if counts["undated"] or invalid else 0

    turns = _dated_turns(paths, args.from_date, args.to_date, counts)
    staging_path = args.staging_path or default_staging_path(args.root)
    store = StagingStore(staging_path)
    store.bind_selection(args.root, str(args.from_date), str(args.to_date))
    lane, endpoint = _runtime(f"bulk-claude-history:{args.from_date}:{args.to_date}")
    store.bind_endpoint(endpoint)
    staged = store.stage(turns)
    result = ingest(store, lane, expected_namespace=store.bound_namespace())
    if result.namespace is not None:
        store.bind_namespace(result.namespace)
    _report(
        discovered=len(paths),
        parsed=counts["parsed"],
        eligible=counts["eligible"],
        undated=counts["undated"],
        delivered=result.sent,
        deduped=counts["eligible"] - staged + result.duplicates,
        filtered=result.filtered,
        failures=result.quarantined,
    )
    return 1 if counts["undated"] or result.filtered or result.quarantined else 0


def main(argv: Sequence[str] | None = None) -> int:
    """Console-script entrypoint."""
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
