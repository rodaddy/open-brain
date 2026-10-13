"""Create verified additive gzip backups from an explicit source manifest."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import stat
import sys
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO, cast

CHUNK_SIZE = 1024 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class BackupFailure(StrEnum):
    """Stable categories for backup failures."""

    CANDIDATE_OBJECT = "manifest candidate must be an object"
    CANDIDATE_FIELDS = "manifest candidate requires path and source_sha256 strings"
    PATH_ESCAPE = "path escapes its declared root"
    ROUNDTRIP = "gzip roundtrip verification failed"
    SOURCE_CHANGED = "source changed during backup"
    NON_REGULAR = "source is not a regular file"
    HASH_CHANGED = "source hash changed"
    CANDIDATES_LIST = "manifest requires a candidates list"
    ROOT_OVERLAP = "output directory must be external to the source root"
    OUTPUT_ROOT = "output directory must pre-exist without symlinks"
    RECEIPT_LOCATION = "receipt must be inside the output directory"


class BackupError(Exception):
    """A source or backup invariant failed."""

    def __init__(self, failure: BackupFailure, path: Path | None = None) -> None:
        """Render a stable failure category with optional path context."""
        message = failure.value if path is None else f"{failure.value}: {path}"
        super().__init__(message)


def _digest_fd(file_descriptor: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    length = 0
    while block := os.pread(file_descriptor, CHUNK_SIZE, length):
        digest.update(block)
        length += len(block)
    return digest.hexdigest(), length


def _gzip_digest_fd(file_descriptor: int) -> tuple[str, int]:
    os.lseek(file_descriptor, 0, os.SEEK_SET)
    with (
        os.fdopen(os.dup(file_descriptor), "rb") as raw,
        gzip.GzipFile(
            fileobj=raw,
            mode="rb",
        ) as decompressed,
    ):
        digest = hashlib.sha256()
        length = 0
        while block := decompressed.read(CHUNK_SIZE):
            digest.update(block)
            length += len(block)
    return digest.hexdigest(), length


def _inside(path: Path, root: Path, failure: BackupFailure) -> Path:
    try:
        return path.absolute().relative_to(root)
    except ValueError as exc:
        raise BackupError(failure, path) from exc


def _directory_fd(root_fd: int, parts: tuple[str, ...], *, create: bool) -> int:
    current_fd = os.dup(root_fd)
    for part in parts:
        if part in {"", ".", ".."}:
            os.close(current_fd)
            raise BackupError(BackupFailure.PATH_ESCAPE)
        if create:
            with suppress(FileExistsError):
                os.mkdir(part, mode=0o700, dir_fd=current_fd)
        try:
            next_fd = os.open(part, DIRECTORY_FLAGS, dir_fd=current_fd)
        except BaseException:
            os.close(current_fd)
            raise
        os.close(current_fd)
        current_fd = next_fd
    return current_fd


def _candidate(candidate: object, source_root: Path) -> tuple[Path, str]:
    if not isinstance(candidate, dict):
        raise BackupError(BackupFailure.CANDIDATE_OBJECT)
    raw_path = candidate.get("path")
    expected_hash = candidate.get("source_sha256")
    if not isinstance(raw_path, str) or not isinstance(expected_hash, str):
        raise BackupError(BackupFailure.CANDIDATE_FIELDS)
    return _inside(
        Path(raw_path), source_root, BackupFailure.PATH_ESCAPE
    ), expected_hash


def _open_source(source_root_fd: int, relative: Path) -> tuple[int, int]:
    parent_fd = _directory_fd(source_root_fd, relative.parent.parts, create=False)
    try:
        source_fd = os.open(
            relative.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd
        )
    except BaseException:
        os.close(parent_fd)
        raise
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode):
        os.close(source_fd)
        os.close(parent_fd)
        raise BackupError(BackupFailure.NON_REGULAR, relative)
    return source_fd, parent_fd


def _create_gzip(
    source_fd: int,
    partial_fd: int,
    source_name: str,
    source_mtime: float,
) -> None:
    os.lseek(source_fd, 0, os.SEEK_SET)
    with (
        os.fdopen(os.dup(partial_fd), "wb") as raw,
        gzip.GzipFile(
            filename=source_name,
            mode="wb",
            fileobj=raw,
            mtime=int(source_mtime),
        ) as compressed,
        os.fdopen(os.dup(source_fd), "rb") as source,
    ):
        while block := source.read(CHUNK_SIZE):
            compressed.write(block)
    os.fsync(partial_fd)


def _source_is_pinned(source_fd: int, parent_fd: int, name: str) -> bool:
    pinned = os.fstat(source_fd)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    return (pinned.st_dev, pinned.st_ino) == (current.st_dev, current.st_ino)


@contextmanager
def _partial_file(parent_fd: int, name: str) -> Iterator[int]:
    partial_fd = os.open(
        name,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=parent_fd,
    )
    try:
        yield partial_fd
    finally:
        os.close(partial_fd)
        with suppress(FileNotFoundError):
            os.unlink(name, dir_fd=parent_fd)


def _verified_backup(
    source_fd: int,
    source_parent_fd: int,
    output_parent_fd: int,
    relative: Path,
    expected_hash: str,
) -> dict[str, object]:
    source_stat = os.fstat(source_fd)
    source_hash, source_length = _digest_fd(source_fd)
    if source_hash != expected_hash:
        raise BackupError(BackupFailure.HASH_CHANGED, relative)
    partial_name = f".{relative.name}.gz.partial.{os.getpid()}"
    with _partial_file(output_parent_fd, partial_name) as partial_fd:
        _create_gzip(source_fd, partial_fd, relative.name, source_stat.st_mtime)
        if _gzip_digest_fd(partial_fd) != (expected_hash, source_length):
            raise BackupError(BackupFailure.ROUNDTRIP, relative)
        if _digest_fd(source_fd) != (expected_hash, source_length):
            raise BackupError(BackupFailure.SOURCE_CHANGED, relative)
        if not _source_is_pinned(source_fd, source_parent_fd, relative.name):
            raise BackupError(BackupFailure.SOURCE_CHANGED, relative)
        output_name = f"{relative.name}.gz"
        os.link(
            partial_name,
            output_name,
            src_dir_fd=output_parent_fd,
            dst_dir_fd=output_parent_fd,
            follow_symlinks=False,
        )
    gzip_bytes = os.stat(
        output_name,
        dir_fd=output_parent_fd,
        follow_symlinks=False,
    ).st_size
    return {
        "status": "backed_up",
        "source": str(relative),
        "output": str(relative.parent / output_name),
        "source_sha256": expected_hash,
        "source_bytes": source_length,
        "gzip_bytes": gzip_bytes,
    }


def _backup_one(
    source_root_fd: int,
    output_root_fd: int,
    relative: Path,
    expected_hash: str,
) -> dict[str, object]:
    source_fd, source_parent_fd = _open_source(source_root_fd, relative)
    output_parent_fd = _directory_fd(output_root_fd, relative.parent.parts, create=True)
    try:
        return _verified_backup(
            source_fd,
            source_parent_fd,
            output_parent_fd,
            relative,
            expected_hash,
        )
    finally:
        os.close(output_parent_fd)
        os.close(source_parent_fd)
        os.close(source_fd)


def _write_receipt(receipt: BinaryIO, row: dict[str, object]) -> None:
    receipt.write((json.dumps(row, sort_keys=True) + "\n").encode())
    receipt.flush()
    os.fsync(receipt.fileno())


def _load_candidates(manifest_path: Path) -> list[object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    candidates = manifest.get("candidates") if isinstance(manifest, dict) else None
    if not isinstance(candidates, list):
        raise BackupError(BackupFailure.CANDIDATES_LIST)
    return cast(list[object], candidates)


def _roots(source_root: Path, output_root: Path) -> tuple[Path, Path]:
    source_root = source_root.resolve(strict=True)
    output_absolute = output_root.absolute()
    if (
        output_absolute == source_root
        or source_root in output_absolute.parents
        or output_absolute in source_root.parents
    ):
        raise BackupError(BackupFailure.ROOT_OVERLAP, output_absolute)
    if not output_absolute.is_dir() or output_absolute.is_symlink():
        raise BackupError(BackupFailure.OUTPUT_ROOT, output_absolute)
    output_resolved = output_absolute.resolve(strict=True)
    if output_resolved != output_absolute:
        raise BackupError(BackupFailure.OUTPUT_ROOT, output_absolute)
    return source_root, output_resolved


def _run_candidates(
    candidates: list[object],
    source_root: Path,
    source_root_fd: int,
    output_root_fd: int,
    receipt: BinaryIO,
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for candidate in candidates:
        counts["considered"] += 1
        try:
            relative, expected_hash = _candidate(candidate, source_root)
            row = _backup_one(
                source_root_fd,
                output_root_fd,
                relative,
                expected_hash,
            )
        except (BackupError, FileExistsError, FileNotFoundError, OSError) as exc:
            counts["failed"] += 1
            raw_source = candidate.get("path") if isinstance(candidate, dict) else None
            row = {"status": "failed", "source": raw_source, "error": str(exc)}
        else:
            counts["backed_up"] += 1
            counts["source_bytes"] += cast(int, row["source_bytes"])
            counts["gzip_bytes"] += cast(int, row["gzip_bytes"])
        _write_receipt(receipt, row)
    return dict(counts)


def run_backup(
    manifest_path: Path,
    source_root: Path,
    output_dir: Path,
    receipt_path: Path,
) -> dict[str, int]:
    """Create verified gzip copies while leaving every source path unchanged."""
    source_root, output_dir = _roots(source_root, output_dir)
    receipt_relative = _inside(
        receipt_path,
        output_dir,
        BackupFailure.RECEIPT_LOCATION,
    )
    candidates = _load_candidates(manifest_path)
    source_root_fd = os.open(source_root, DIRECTORY_FLAGS)
    output_root_fd = os.open(output_dir, DIRECTORY_FLAGS)
    receipt_parent_fd = _directory_fd(
        output_root_fd,
        receipt_relative.parent.parts,
        create=True,
    )
    receipt_fd = os.open(
        receipt_relative.name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=receipt_parent_fd,
    )
    try:
        with os.fdopen(receipt_fd, "wb") as receipt:
            return _run_candidates(
                candidates,
                source_root,
                source_root_fd,
                output_root_fd,
                receipt,
            )
    finally:
        os.close(receipt_parent_fd)
        os.close(output_root_fd)
        os.close(source_root_fd)


def main() -> int:
    """Run the constructive-only manifest backup command."""
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    counts = run_backup(args.manifest, args.source_root, args.output_dir, args.receipt)
    sys.stdout.write(json.dumps(counts, sort_keys=True) + "\n")
    return 1 if counts.get("failed", 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
