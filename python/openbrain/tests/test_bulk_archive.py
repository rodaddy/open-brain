"""Functional tests for operator-only plaintext archival."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import pytest

from openbrain.apps.bulk import archive


@pytest.fixture(autouse=True)
def _no_active_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(archive, "_active_groups", lambda _root: set())


def _sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _fixture(tmp_path: Path, content: bytes = b"source\n") -> dict[str, Path]:
    source_root = tmp_path / "sources"
    backup_root = tmp_path / "backups"
    archive_root = tmp_path / "archive"
    source_root.mkdir()
    backup_root.mkdir()
    archive_root.mkdir()
    source = source_root / "project" / "session.jsonl"
    source.parent.mkdir()
    source.write_bytes(content)
    backup = backup_root / "project" / "session.jsonl.gz"
    backup.parent.mkdir()
    with gzip.open(backup, "wb") as target:
        target.write(content)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps({
            "candidates": [{"path": str(source), "source_sha256": _sha(content)}]
        })
    )
    backup_receipt = tmp_path / "backup-receipt.jsonl"
    backup_receipt.write_text(
        json.dumps({
            "status": "backed_up",
            "source": "project/session.jsonl",
            "output": "project/session.jsonl.gz",
            "source_sha256": _sha(content),
            "source_bytes": len(content),
            "gzip_bytes": backup.stat().st_size,
        })
        + "\n"
    )
    held = tmp_path / "held.json"
    held.write_text(json.dumps({"held_jsonl": []}))
    return {
        "source_root": source_root,
        "backup_root": backup_root,
        "archive_root": archive_root,
        "source": source,
        "manifest": manifest,
        "backup_receipt": backup_receipt,
        "held": held,
    }


def _run(paths: dict[str, Path]) -> dict[str, int]:
    return archive.run_archive(
        paths["manifest"],
        paths["backup_receipt"],
        paths["held"],
        paths["source_root"],
        paths["backup_root"],
        paths["archive_root"],
        paths["backup_root"] / "archive-receipt.jsonl",
        0,
    )


def test_archives_exact_source_after_backup_proof(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    counts = _run(paths)
    archived = paths["archive_root"] / "project" / "session.jsonl"
    assert counts == {"considered": 1, "archived": 1, "source_bytes": 7}
    assert not paths["source"].exists()
    assert archived.read_bytes() == b"source\n"


def test_archive_collision_preserves_both_files(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    archived = paths["archive_root"] / "project" / "session.jsonl"
    archived.parent.mkdir()
    archived.write_bytes(b"existing\n")
    counts = _run(paths)
    assert counts["failed"] == 1
    assert paths["source"].read_bytes() == b"source\n"
    assert archived.read_bytes() == b"existing\n"


def test_changed_source_is_left_in_place(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    paths["source"].write_bytes(b"changed\n")
    counts = _run(paths)
    assert counts["failed"] == 1
    assert paths["source"].read_bytes() == b"changed\n"
    assert not (paths["archive_root"] / "project" / "session.jsonl").exists()


def test_changed_backup_is_left_in_place(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    backup = paths["backup_root"] / "project" / "session.jsonl.gz"
    backup.write_bytes(b"not gzip")
    counts = _run(paths)
    assert counts["failed"] == 1
    assert paths["source"].read_bytes() == b"source\n"


def test_recreated_source_after_rename_is_preserved(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _fixture(tmp_path)
    original = archive._rename_exclusive

    def rename_then_recreate(*args: object) -> None:
        original(*args)  # type: ignore[arg-type]
        paths["source"].write_bytes(b"new writer data\n")

    monkeypatch.setattr(archive, "_rename_exclusive", rename_then_recreate)
    counts = _run(paths)
    assert counts["archived"] == 1
    assert paths["source"].read_bytes() == b"new writer data\n"
    assert (
        paths["archive_root"] / "project" / "session.jsonl"
    ).read_bytes() == b"source\n"
    receipt = (paths["backup_root"] / "archive-receipt.jsonl").read_text()
    assert '"source_recreated": true' in receipt


def test_held_source_is_visible_and_untouched(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    paths["held"].write_text(json.dumps({"held_jsonl": [str(paths["source"])]}))
    counts = _run(paths)
    assert counts == {"considered": 1, "held": 1}
    assert paths["source"].read_bytes() == b"source\n"


def test_open_session_group_is_held(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _fixture(tmp_path)
    monkeypatch.setattr(archive, "_active_groups", lambda _root: {"session"})
    counts = _run(paths)
    assert counts == {"considered": 1, "held": 1}
    assert paths["source"].read_bytes() == b"source\n"


def test_recent_source_is_held(tmp_path: Path) -> None:
    paths = _fixture(tmp_path)
    counts = archive.run_archive(
        paths["manifest"],
        paths["backup_receipt"],
        paths["held"],
        paths["source_root"],
        paths["backup_root"],
        paths["archive_root"],
        paths["backup_root"] / "archive-receipt.jsonl",
        604800,
    )
    assert counts == {"considered": 1, "held": 1}
    assert paths["source"].read_bytes() == b"source\n"


@pytest.mark.parametrize(
    "overlap", ["source-backup", "source-archive", "backup-archive"]
)
def test_all_root_overlaps_fail_before_receipt(tmp_path: Path, overlap: str) -> None:
    paths = _fixture(tmp_path)
    source = paths["source_root"]
    backup = paths["backup_root"]
    archived = paths["archive_root"]
    if overlap == "source-backup":
        backup = source
    elif overlap == "source-archive":
        archived = source
    else:
        archived = backup
    receipt = paths["backup_root"] / "archive-receipt.jsonl"
    with pytest.raises(archive.BackupError):
        archive.run_archive(
            paths["manifest"],
            paths["backup_receipt"],
            paths["held"],
            source,
            backup,
            archived,
            receipt,
            0,
        )
    assert not receipt.exists()


def test_activity_scan_failure_is_fail_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _fixture(tmp_path)

    def failed(_root: Path) -> set[str]:
        raise RuntimeError("scan unavailable")  # noqa: TRY003

    monkeypatch.setattr(archive, "_active_groups", failed)
    with pytest.raises(RuntimeError, match="scan unavailable"):
        _run(paths)
    assert paths["source"].read_bytes() == b"source\n"
    assert not (paths["backup_root"] / "archive-receipt.jsonl").exists()


def test_rename_exclusive_refuses_non_darwin_before_libc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(archive.sys, "platform", "linux")

    def forbidden(*_: object, **__: object) -> object:
        raise AssertionError  # renameatx_np must not be touched off macOS

    monkeypatch.setattr(archive.ctypes, "CDLL", forbidden)

    with pytest.raises(archive.UnsupportedPlatformError, match="linux"):
        archive._rename_exclusive(0, "source", 0, "archive")
