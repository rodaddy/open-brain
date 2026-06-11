from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from typing import Any, Callable, Iterable, Mapping
import fcntl

from .client import JSON
from .policy import idempotency_key, redact_value


@dataclass(frozen=True)
class SpoolRecord:
    idempotency_key: str
    operation: str
    payload: Mapping[str, Any]
    created_at: float


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
            "payload": redact_value(dict(payload)),
            "created_at": time.time(),
        }
        line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
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
            for line in handle:
                if not line.strip():
                    continue
                payload = json.loads(line)
                records.append(
                    SpoolRecord(
                        idempotency_key=str(payload["idempotency_key"]),
                        operation=str(payload["operation"]),
                        payload=payload.get("payload", {}),
                        created_at=float(payload.get("created_at", 0)),
                    )
                )
        return records

    def replay(self, dispatcher: Callable[[SpoolRecord], JSON]) -> list[JSON]:
        results = []
        remaining = []
        lock_fd = self._lock()
        try:
            for record in self.records():
                try:
                    results.append(dispatcher(record))
                except Exception:
                    remaining.append(record)
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
                    "payload": redact_value(dict(record.payload)),
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
