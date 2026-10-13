"""Archive plaintext sources only after their additive gzip copies are proven."""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import stat
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import cast

from openbrain.apps.bulk.backup import (
    DIRECTORY_FLAGS,
    BackupError,
    BackupFailure,
    _candidate,
    _digest_fd,
    _directory_fd,
    _gzip_digest_fd,
    _inside,
    _load_candidates,
    _open_source,
    _source_is_pinned,
    _write_receipt,
)

RENAME_EXCL = 0x00000004
LSOF = "/usr/sbin/lsof"


class HeldSourceError(Exception):
    """A current activity gate held a source without treating it as corrupt."""


class UnsupportedPlatformError(OSError):
    """Exclusive archive rename needs macOS ``renameatx_np``."""

    def __init__(self, platform: str) -> None:
        """Name the unsupported platform."""
        super().__init__(
            f"bulk archive requires macOS renameatx_np; running on {platform}"
        )


def _rename_exclusive(
    source_parent_fd: int,
    source_name: str,
    archive_parent_fd: int,
    archive_name: str,
) -> None:
    """Atomically rename without replacing an existing archive.

    Raises:
        UnsupportedPlatformError: Off macOS, before ``renameatx_np`` is touched.
    """
    if sys.platform != "darwin":
        raise UnsupportedPlatformError(sys.platform)
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        source_parent_fd,
        os.fsencode(source_name),
        archive_parent_fd,
        os.fsencode(archive_name),
        RENAME_EXCL,
    )
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), source_name)


def _load_backup_rows(path: Path) -> dict[str, dict[str, object]]:
    rows: dict[str, dict[str, object]] = {}
    with path.open(encoding="utf-8") as source:
        for line in source:
            row = json.loads(line)
            if not isinstance(row, dict) or row.get("status") != "backed_up":
                continue
            relative = row.get("source")
            if not isinstance(relative, str) or relative in rows:
                raise ValueError("backup receipt requires unique source rows")  # noqa: TRY003
            rows[relative] = cast(dict[str, object], row)
    return rows


def _load_held(path: Path) -> set[str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    rows = value.get("held_jsonl") if isinstance(value, dict) else None
    if not isinstance(rows, list) or not all(isinstance(row, str) for row in rows):
        raise ValueError("held manifest requires held_jsonl strings")  # noqa: TRY003
    return set(rows)


def _validated_root(path: Path, failure: BackupFailure) -> Path:
    absolute = path.absolute()
    if not absolute.is_dir() or absolute.is_symlink():
        raise BackupError(failure, absolute)
    resolved = absolute.resolve(strict=True)
    if resolved != absolute:
        raise BackupError(failure, absolute)
    return resolved


def _group(relative: Path) -> str:
    parts = relative.parts
    if "subagents" in parts:
        index = parts.index("subagents")
        if index:
            return parts[index - 1]
    return relative.stem


def _active_groups(source_root: Path) -> set[str]:
    result = subprocess.run(
        [LSOF, "-Fn", "+D", str(source_root)],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode == 1 and not result.stdout and not result.stderr:
        return set()
    if result.returncode != 0 or result.stderr:
        raise RuntimeError("live source activity scan failed")  # noqa: TRY003
    groups: set[str] = set()
    for line in result.stdout.splitlines():
        if not line.startswith("n"):
            continue
        active = Path(line[1:])
        try:
            relative = active.relative_to(source_root)
        except ValueError as exc:
            raise RuntimeError("activity scan returned an external path") from exc  # noqa: TRY003
        if relative.suffix == ".jsonl":
            groups.add(_group(relative))
    return groups


def _overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def _proof_backup(
    backup_root_fd: int,
    relative: Path,
    expected_hash: str,
    row: dict[str, object],
) -> tuple[int, int]:
    if (
        row.get("source_sha256") != expected_hash
        or row.get("source") != str(relative)
        or row.get("output") != str(relative.parent / f"{relative.name}.gz")
    ):
        raise ValueError("backup receipt does not match candidate")  # noqa: TRY003
    parent_fd = _directory_fd(backup_root_fd, relative.parent.parts, create=False)
    try:
        backup_fd = os.open(
            f"{relative.name}.gz", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd
        )
    finally:
        os.close(parent_fd)
    try:
        backup_stat = os.fstat(backup_fd)
        if not stat.S_ISREG(backup_stat.st_mode):
            raise ValueError("backup is not a regular file")  # noqa: TRY003
        source_hash, source_bytes = _gzip_digest_fd(backup_fd)
        if (
            source_hash != expected_hash
            or row.get("source_bytes") != source_bytes
            or row.get("gzip_bytes") != backup_stat.st_size
        ):
            raise ValueError("backup hash or length proof failed")  # noqa: TRY003
        return source_bytes, backup_stat.st_size
    finally:
        os.close(backup_fd)


def _archive_one(  # noqa: PLR0913, PLR0915 -- one atomic verified move boundary
    source_root_fd: int,
    backup_root_fd: int,
    archive_root_fd: int,
    relative: Path,
    expected_hash: str,
    backup_row: dict[str, object],
    minimum_age_seconds: int,
) -> dict[str, object]:
    source_fd, source_parent_fd = _open_source(source_root_fd, relative)
    archive_parent_fd: int | None = None
    try:
        source_hash, source_bytes = _digest_fd(source_fd)
        if source_hash != expected_hash:
            raise BackupError(BackupFailure.HASH_CHANGED, relative)
        proven_bytes, gzip_bytes = _proof_backup(
            backup_root_fd, relative, expected_hash, backup_row
        )
        if source_bytes != proven_bytes or not _source_is_pinned(
            source_fd, source_parent_fd, relative.name
        ):
            raise BackupError(BackupFailure.SOURCE_CHANGED, relative)
        source_stat = os.fstat(source_fd)
        if time.time() - source_stat.st_mtime < minimum_age_seconds:
            raise HeldSourceError("source modified inside minimum age")  # noqa: TRY003
        archive_stat = os.fstat(archive_root_fd)
        if source_stat.st_dev != archive_stat.st_dev:
            raise OSError(errno.EXDEV, "source and archive must share a filesystem")
        archive_parent_fd = _directory_fd(
            archive_root_fd, relative.parent.parts, create=True
        )
        _rename_exclusive(
            source_parent_fd, relative.name, archive_parent_fd, relative.name
        )
        archived_stat = os.stat(
            relative.name, dir_fd=archive_parent_fd, follow_symlinks=False
        )
        if (archived_stat.st_dev, archived_stat.st_ino) != (
            source_stat.st_dev,
            source_stat.st_ino,
        ) or _digest_fd(source_fd) != (expected_hash, source_bytes):
            raise BackupError(BackupFailure.SOURCE_CHANGED, relative)
        recreated = True
        try:
            os.stat(relative.name, dir_fd=source_parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            recreated = False
        return {
            "status": "archived",
            "source": str(relative),
            "archive": str(relative),
            "source_sha256": expected_hash,
            "source_bytes": source_bytes,
            "gzip_bytes": gzip_bytes,
            "source_recreated": recreated,
        }
    finally:
        if archive_parent_fd is not None:
            os.close(archive_parent_fd)
        os.close(source_parent_fd)
        os.close(source_fd)


def activity_preflight(  # noqa: PLR1702 -- one bounded source snapshot
    manifest_path: Path,
    held_path: Path,
    source_root: Path,
    minimum_age_seconds: int,
) -> dict[str, int]:
    """Fail closed when any selected logical session is current or open."""
    source_root = source_root.resolve(strict=True)
    candidates = _load_candidates(manifest_path)
    held = _load_held(held_path)
    active_groups = _active_groups(source_root)
    source_root_fd = os.open(source_root, DIRECTORY_FLAGS)
    counts: Counter[str] = Counter()
    try:  # noqa: PLR1702 -- descriptor cleanup wraps one bounded snapshot
        for candidate in candidates:
            counts["considered"] += 1
            relative, _expected_hash = _candidate(candidate, source_root)
            if str(source_root / relative) in held or _group(relative) in active_groups:
                counts["held"] += 1
                continue
            source_fd, source_parent_fd = _open_source(source_root_fd, relative)
            try:
                if time.time() - os.fstat(source_fd).st_mtime < minimum_age_seconds:
                    counts["recent"] += 1
            finally:
                os.close(source_parent_fd)
                os.close(source_fd)
    finally:
        os.close(source_root_fd)
    return dict(counts)


def run_archive(  # noqa: PLR0913, PLR0915, PLR1702 -- operator inputs stay explicit
    manifest_path: Path,
    backup_receipt_path: Path,
    held_path: Path,
    source_root: Path,
    backup_root: Path,
    archive_root: Path,
    receipt_path: Path,
    minimum_age_seconds: int,
) -> dict[str, int]:
    """Move only proven, unchanged plaintext sources into an external archive."""
    source_root = source_root.resolve(strict=True)
    backup_root = _validated_root(backup_root, BackupFailure.OUTPUT_ROOT)
    archive_root = _validated_root(archive_root, BackupFailure.OUTPUT_ROOT)
    for first, second in (
        (source_root, backup_root),
        (source_root, archive_root),
        (backup_root, archive_root),
    ):
        if _overlap(first, second):
            raise BackupError(BackupFailure.ROOT_OVERLAP, second)
    receipt_relative = _inside(
        receipt_path, backup_root, BackupFailure.RECEIPT_LOCATION
    )
    candidates = _load_candidates(manifest_path)
    backup_rows = _load_backup_rows(backup_receipt_path)
    held = _load_held(held_path)
    active_groups = _active_groups(source_root)
    source_root_fd = os.open(source_root, DIRECTORY_FLAGS)
    backup_root_fd = os.open(backup_root, DIRECTORY_FLAGS)
    archive_root_fd = os.open(archive_root, DIRECTORY_FLAGS)
    receipt_parent_fd = _directory_fd(
        backup_root_fd, receipt_relative.parent.parts, create=True
    )
    receipt_fd = os.open(
        receipt_relative.name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=receipt_parent_fd,
    )
    counts: Counter[str] = Counter()
    try:  # noqa: PLR1702 -- per-candidate failures become durable receipt rows
        with os.fdopen(receipt_fd, "wb") as receipt:
            for candidate in candidates:
                counts["considered"] += 1
                try:
                    relative, expected_hash = _candidate(candidate, source_root)
                    absolute_source = str(source_root / relative)
                    if absolute_source in held or _group(relative) in active_groups:
                        counts["held"] += 1
                        row: dict[str, object] = {
                            "status": "held",
                            "source": str(relative),
                            "error": "source session is active or explicitly held",
                        }
                    else:
                        backup_row = backup_rows.get(str(relative))
                        if backup_row is None:
                            raise ValueError(  # noqa: TRY003, TRY301
                                "missing successful backup receipt"
                            )
                        row = _archive_one(
                            source_root_fd,
                            backup_root_fd,
                            archive_root_fd,
                            relative,
                            expected_hash,
                            backup_row,
                            minimum_age_seconds,
                        )
                        counts["archived"] += 1
                        counts["source_bytes"] += cast(int, row["source_bytes"])
                except HeldSourceError as exc:
                    counts["held"] += 1
                    raw_source = (
                        candidate.get("path") if isinstance(candidate, dict) else None
                    )
                    row = {"status": "held", "source": raw_source, "error": str(exc)}
                except (
                    BackupError,
                    FileExistsError,
                    FileNotFoundError,
                    OSError,
                    ValueError,
                ) as exc:
                    counts["failed"] += 1
                    raw_source = (
                        candidate.get("path") if isinstance(candidate, dict) else None
                    )
                    row = {"status": "failed", "source": raw_source, "error": str(exc)}
                _write_receipt(receipt, row)
    finally:
        os.close(receipt_parent_fd)
        os.close(archive_root_fd)
        os.close(backup_root_fd)
        os.close(source_root_fd)
    return dict(counts)


def main() -> int:
    """Run the operator-only plaintext archival command."""
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--backup-receipt", required=True, type=Path)
    parser.add_argument("--held", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--backup-root", required=True, type=Path)
    parser.add_argument("--archive-root", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--minimum-age-seconds", required=True, type=int)
    parser.add_argument("--activity-preflight", action="store_true")
    args = parser.parse_args()
    if args.activity_preflight:
        counts = activity_preflight(
            args.manifest,
            args.held,
            args.source_root,
            args.minimum_age_seconds,
        )
        sys.stdout.write(json.dumps(counts, sort_keys=True) + "\n")
        return 1 if counts.get("held", 0) or counts.get("recent", 0) else 0
    counts = run_archive(
        args.manifest,
        args.backup_receipt,
        args.held,
        args.source_root,
        args.backup_root,
        args.archive_root,
        args.receipt,
        args.minimum_age_seconds,
    )
    sys.stdout.write(json.dumps(counts, sort_keys=True) + "\n")
    return 1 if counts.get("failed", 0) or counts.get("held", 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
