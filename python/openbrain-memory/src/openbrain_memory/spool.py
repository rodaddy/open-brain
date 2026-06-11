from __future__ import annotations

import fcntl
import json
import logging
import os
import stat
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from .client import JSON
from .policy import idempotency_key, redact_value

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SpoolRecord:
    idempotency_key: str
    operation: str
    payload: Mapping[str, Any]
    created_at: float

    def redacted_payload(self) -> Mapping[str, Any]:
        return cast(Mapping[str, Any], redact_value(dict(self.payload)))

    def redacted(self) -> SpoolRecord:
        return SpoolRecord(
            idempotency_key=self.idempotency_key,
            operation=self.operation,
            payload=self.redacted_payload(),
            created_at=self.created_at,
        )


class JsonlSpool:
    def __init__(
        self,
        path: str | Path,
        *,
        max_lines: int = 1000,
        max_bytes: int = 1_000_000,
    ) -> None:
        if max_lines < 1:
            raise ValueError("max_lines must be >= 1")
        if max_bytes < 1:
            raise ValueError("max_bytes must be >= 1")
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        self.max_lines = max_lines
        self.max_bytes = max_bytes

    def append(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        key: str | None = None,
    ) -> str:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._reject_symlink(self.path)
        safe_key = key or idempotency_key()
        record = {
            "idempotency_key": safe_key,
            "operation": operation,
            "payload": dict(payload),
            "created_at": time.time(),
        }
        line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        if len(line.encode("utf-8")) > self.max_bytes:
            raise ValueError("spool record exceeds max_bytes")
        lock_fd = self._lock()
        try:
            flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(self.path, flags, 0o600)
            try:
                self._validate_fd(fd, self.path)
                os.fchmod(fd, 0o600)
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
            self._trim_locked()
        finally:
            self._unlock(lock_fd)
        return safe_key

    def records(self) -> list[SpoolRecord]:
        if not self.path.exists():
            return []
        self._reject_symlink(self.path)
        records: list[SpoolRecord] = []
        with self.path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        "Skipping corrupted spool record",
                        extra={
                            "spool_path": str(self.path),
                            "spool_line": line_number,
                        },
                        exc_info=True,
                    )
                    continue
                if not isinstance(payload, dict):
                    self._warn_corrupted_record(line_number)
                    continue
                try:
                    idempotency = str(payload["idempotency_key"])
                    operation = str(payload["operation"])
                    record_payload = payload.get("payload", {})
                    created_at = float(payload.get("created_at", 0))
                except (KeyError, TypeError, ValueError):
                    self._warn_corrupted_record(line_number, exc_info=True)
                    continue
                if not isinstance(record_payload, dict):
                    self._warn_corrupted_record(line_number)
                    continue
                records.append(
                    SpoolRecord(
                        idempotency_key=idempotency,
                        operation=operation,
                        payload=record_payload,
                        created_at=created_at,
                    )
                )
        return records

    def _warn_corrupted_record(
        self,
        line_number: int,
        *,
        exc_info: bool = False,
    ) -> None:
        logger.warning(
            "Skipping corrupted spool record",
            extra={
                "spool_path": str(self.path),
                "spool_line": line_number,
            },
            exc_info=exc_info,
        )

    def redacted_records(self) -> list[SpoolRecord]:
        return [record.redacted() for record in self.records()]

    def replay(self, dispatcher: Callable[[SpoolRecord], JSON]) -> list[JSON]:
        results = []
        lock_fd = self._lock()
        try:
            snapshot = self.records()
        finally:
            self._unlock(lock_fd)

        replayed_keys = set()
        for record in snapshot:
            try:
                results.append(dispatcher(record))
                replayed_keys.add(record.idempotency_key)
            except Exception:
                pass

        lock_fd = self._lock()
        try:
            remaining = [
                record
                for record in self.records()
                if record.idempotency_key not in replayed_keys
            ]
            self._rewrite_records(remaining)
        finally:
            self._unlock(lock_fd)
        return results

    def _trim_locked(self) -> None:
        if not self.path.exists():
            return
        lines = self.path.read_text(encoding="utf-8").splitlines(keepends=True)
        sizes = [len(line.encode("utf-8")) for line in lines]
        total = sum(sizes)
        while len(lines) > self.max_lines or total > self.max_bytes:
            lines.pop(0)
            total -= sizes.pop(0)
        self._write_lines(lines)

    def _rewrite_records(self, records: list[SpoolRecord]) -> None:
        lines = [
            json.dumps(
                {
                    "idempotency_key": record.idempotency_key,
                    "operation": record.operation,
                    "payload": dict(record.payload),
                    "created_at": record.created_at,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for record in records
        ]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._reject_symlink(self.path)
        self._write_lines(lines)

    def _write_lines(self, lines: list[str]) -> None:
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, "".join(lines).encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp_name, self.path)
        os.chmod(self.path, 0o600)

    def _reject_symlink(self, path: Path) -> None:
        try:
            mode = os.lstat(path).st_mode
        except FileNotFoundError:
            return
        if stat.S_ISLNK(mode):
            raise OSError(f"Refusing to use symlink spool path: {path}")

    def _validate_fd(self, fd: int, path: Path) -> None:
        mode = os.fstat(fd).st_mode
        if not stat.S_ISREG(mode):
            raise OSError(f"Spool path is not a regular file: {path}")

    def _lock(self) -> int:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._reject_symlink(self.lock_path)
        flags = os.O_CREAT | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(self.lock_path, flags, 0o600)
        try:
            self._validate_fd(fd, self.lock_path)
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
        except Exception:
            os.close(fd)
            raise
        return fd

    def _unlock(self, fd: int) -> None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def replay_records(
    records: Iterable[SpoolRecord],
    dispatcher: Callable[[SpoolRecord], JSON],
) -> list[JSON]:
    return [dispatcher(record) for record in records]
