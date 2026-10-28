"""Functional tests for constructive-only transcript backups."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path

import pytest

from openbrain.apps.bulk import backup
from openbrain.apps.bulk.backup import BackupError, run_backup


def _manifest(path: Path, source: Path, source_hash: str) -> Path:
    path.write_text(
        json.dumps({
            "candidates": [{"path": str(source), "source_sha256": source_hash}]
        }),
        encoding="utf-8",
    )
    return path


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def test_backup_roundtrips_and_preserves_source(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "session.jsonl"
    content = b'{"role":"user","content":"keep me"}\n'
    source.write_bytes(content)
    output = tmp_path / "backups"
    output.mkdir()

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(content)),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["backed_up"] == 1
    assert source.read_bytes() == content
    with gzip.open(tmp_path / "backups" / "session.jsonl.gz", "rb") as backup:
        assert backup.read() == content


def test_existing_output_is_not_overwritten(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "session.jsonl"
    source.write_bytes(b"source\n")
    output = tmp_path / "backups" / "session.jsonl.gz"
    output.parent.mkdir()
    output.write_bytes(b"existing")

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"source\n")),
        source_root,
        tmp_path / "backups",
        tmp_path / "backups" / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert output.read_bytes() == b"existing"
    assert source.read_bytes() == b"source\n"


def test_changed_source_fails_without_output(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "session.jsonl"
    source.write_bytes(b"changed\n")
    output = tmp_path / "backups"
    output.mkdir()

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"original\n")),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert source.read_bytes() == b"changed\n"
    assert not (tmp_path / "backups" / "session.jsonl.gz").exists()


def test_symlink_source_is_refused(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    real_source = source_root / "real.jsonl"
    real_source.write_bytes(b"real\n")
    source = source_root / "link.jsonl"
    source.symlink_to(real_source)
    output = tmp_path / "backups"
    output.mkdir()

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"real\n")),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert source.is_symlink()
    assert real_source.read_bytes() == b"real\n"


def test_source_outside_root_is_refused(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = tmp_path / "outside.jsonl"
    source.write_bytes(b"outside\n")
    output = tmp_path / "backups"
    output.mkdir()

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"outside\n")),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert source.read_bytes() == b"outside\n"
    assert [path.name for path in output.iterdir()] == ["receipt.jsonl"]


def test_output_inside_source_is_refused_before_creation(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    output = source_root / "new-output"

    with pytest.raises(BackupError):
        run_backup(tmp_path / "missing.json", source_root, output, output / "receipt")

    assert not output.exists()


def test_nested_output_symlink_cannot_escape_root(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source = source_root / "nested" / "session.jsonl"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source\n")
    output = tmp_path / "backups"
    output.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (output / "nested").symlink_to(outside)

    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"source\n")),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert list(outside.iterdir()) == []
    assert source.read_bytes() == b"source\n"


def test_receipt_inside_source_is_refused_before_creation(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "session.jsonl"
    source.write_bytes(b"source\n")
    output = tmp_path / "backups"
    output.mkdir()
    receipt = source_root / "receipt.jsonl"

    with pytest.raises(BackupError):
        run_backup(
            _manifest(tmp_path / "manifest.json", source, _sha256(b"source\n")),
            source_root,
            output,
            receipt,
        )

    assert not receipt.exists()
    assert source.read_bytes() == b"source\n"


def test_replaced_source_path_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "session.jsonl"
    source.write_bytes(b"source\n")
    output = tmp_path / "backups"
    output.mkdir()
    original_create = backup._create_gzip

    def replace_after_copy(
        source_fd: int,
        partial_fd: int,
        source_name: str,
        source_mtime: float,
    ) -> None:
        original_create(source_fd, partial_fd, source_name, source_mtime)
        source.rename(source.with_suffix(".original"))
        source.write_bytes(b"source\n")

    monkeypatch.setattr(backup, "_create_gzip", replace_after_copy)
    counts = run_backup(
        _manifest(tmp_path / "manifest.json", source, _sha256(b"source\n")),
        source_root,
        output,
        output / "receipt.jsonl",
    )

    assert counts["failed"] == 1
    assert not (output / "session.jsonl.gz").exists()
    assert os.stat(source).st_ino != os.stat(source.with_suffix(".original")).st_ino
