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
    group_id: str | None = None
    group_index: int | None = None
    group_size: int | None = None

    def redacted_payload(self) -> Mapping[str, Any]:
        return cast(Mapping[str, Any], redact_value(dict(self.payload)))

    def redacted(self) -> SpoolRecord:
        return SpoolRecord(
            idempotency_key=self.idempotency_key,
            operation=self.operation,
            payload=self.redacted_payload(),
            created_at=self.created_at,
            group_id=self.group_id,
            group_index=self.group_index,
            group_size=self.group_size,
        )


@dataclass(frozen=True)
class SpoolStatus:
    path: str
    exists: bool
    pending_count: int
    max_lines: int
    max_bytes: int
    oldest_created_at: float | None
    newest_created_at: float | None
    operation_counts: Mapping[str, int]
    corrupted_line_count: int


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
        """Append one replayable record."""
        return self.append_batch([(operation, payload, key)])[0]

    def append_batch(
        self,
        records: Iterable[tuple[str, Mapping[str, Any], str | None]],
    ) -> list[str]:
        """Append an ordered record group atomically or leave the spool unchanged."""
        pending = list(records)
        if not pending:
            return []
        created_at = time.time()
        safe_keys = [record[2] or idempotency_key() for record in pending]
        group_id = idempotency_key() if len(pending) > 1 else None
        batch_lines = [
            self._record_line(
                operation,
                payload,
                key,
                created_at,
                group_id=group_id,
                group_index=index if group_id is not None else None,
                group_size=len(pending) if group_id is not None else None,
            )
            for index, ((operation, payload, _), key) in enumerate(
                zip(pending, safe_keys, strict=True)
            )
        ]
        batch_bytes = sum(len(line.encode("utf-8")) for line in batch_lines)
        if len(batch_lines) > self.max_lines or batch_bytes > self.max_bytes:
            raise ValueError(
                "spool batch exceeds configured max_lines/max_bytes limits"
            )

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._reject_symlink(self.path)
        lock_fd = self._lock()
        try:
            existing = (
                self.path.read_text(encoding="utf-8").splitlines(keepends=True)
                if self.path.exists()
                else []
            )
            existing_groups = self._line_groups(existing)
            existing_line_count = sum(len(group) for group in existing_groups)
            existing_bytes = sum(
                len(line.encode("utf-8")) for group in existing_groups for line in group
            )
            while (
                existing_line_count + len(batch_lines) > self.max_lines
                or existing_bytes + batch_bytes > self.max_bytes
            ):
                if not existing_groups:
                    raise ValueError(
                        "spool batch exceeds configured max_lines/max_bytes limits"
                    )
                evicted = existing_groups.pop(0)
                existing_line_count -= len(evicted)
                existing_bytes -= sum(len(line.encode("utf-8")) for line in evicted)
            retained = [line for group in existing_groups for line in group]
            self._write_lines([*retained, *batch_lines])
        finally:
            self._unlock(lock_fd)
        return safe_keys

    @staticmethod
    def _record_line(
        operation: str,
        payload: Mapping[str, Any],
        key: str,
        created_at: float,
        *,
        group_id: str | None = None,
        group_index: int | None = None,
        group_size: int | None = None,
    ) -> str:
        record = {
            "idempotency_key": key,
            "operation": operation,
            "payload": dict(payload),
            "created_at": created_at,
        }
        if group_id is not None:
            record["group_id"] = group_id
            record["group_index"] = group_index
            record["group_size"] = group_size
        return json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"

    @staticmethod
    def _line_groups(lines: list[str]) -> list[list[str]]:
        groups: list[list[str]] = []
        active_group_id: str | None = None
        for line in lines:
            group_id: str | None = None
            try:
                payload = json.loads(line)
                candidate = (
                    payload.get("group_id") if isinstance(payload, dict) else None
                )
                if isinstance(candidate, str) and candidate:
                    group_id = candidate
            except json.JSONDecodeError:
                pass
            if group_id is not None and group_id == active_group_id:
                groups[-1].append(line)
                continue
            groups.append([line])
            active_group_id = group_id
        return groups

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
                    group_id, group_index, group_size = self._group_metadata(payload)
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
                        group_id=group_id,
                        group_index=group_index,
                        group_size=group_size,
                    )
                )
        return records

    @staticmethod
    def _group_metadata(
        payload: Mapping[str, Any],
    ) -> tuple[str | None, int | None, int | None]:
        values = (
            payload.get("group_id"),
            payload.get("group_index"),
            payload.get("group_size"),
        )
        if values == (None, None, None):
            return None, None, None
        group_id, group_index, group_size = values
        if not isinstance(group_id, str) or not group_id:
            raise ValueError("group_id must be a non-empty string")
        if isinstance(group_index, bool) or not isinstance(group_index, int):
            raise ValueError("group_index must be an integer")
        if isinstance(group_size, bool) or not isinstance(group_size, int):
            raise ValueError("group_size must be an integer")
        if group_size < 2 or group_index < 0 or group_index >= group_size:
            raise ValueError("invalid spool group bounds")
        return group_id, group_index, group_size

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

    def status(self) -> SpoolStatus:
        if not self.path.exists():
            return SpoolStatus(
                path=str(self.path),
                exists=False,
                pending_count=0,
                max_lines=self.max_lines,
                max_bytes=self.max_bytes,
                oldest_created_at=None,
                newest_created_at=None,
                operation_counts={},
                corrupted_line_count=0,
            )
        self._reject_symlink(self.path)
        operation_counts: dict[str, int] = {}
        oldest_created_at: float | None = None
        newest_created_at: float | None = None
        pending_count = 0
        corrupted_line_count = 0
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                    if not isinstance(payload, dict):
                        corrupted_line_count += 1
                        continue
                    operation = str(payload["operation"])
                    record_payload = payload.get("payload", {})
                    created_at = float(payload.get("created_at", 0))
                    self._group_metadata(payload)
                    if not isinstance(record_payload, dict):
                        corrupted_line_count += 1
                        continue
                except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                    corrupted_line_count += 1
                    continue

                pending_count += 1
                operation_counts[operation] = operation_counts.get(operation, 0) + 1
                if oldest_created_at is None or created_at < oldest_created_at:
                    oldest_created_at = created_at
                if newest_created_at is None or created_at > newest_created_at:
                    newest_created_at = created_at

        return SpoolStatus(
            path=str(self.path),
            exists=True,
            pending_count=pending_count,
            max_lines=self.max_lines,
            max_bytes=self.max_bytes,
            oldest_created_at=oldest_created_at,
            newest_created_at=newest_created_at,
            operation_counts=operation_counts,
            corrupted_line_count=corrupted_line_count,
        )

    def replay(self, dispatcher: Callable[[SpoolRecord], JSON]) -> list[JSON]:
        results = []
        lock_fd = self._lock()
        try:
            snapshot = self.records()
        finally:
            self._unlock(lock_fd)

        replayed_keys = set()
        blocked_groups: set[str] = set()
        for record in snapshot:
            if record.group_id in blocked_groups:
                continue
            try:
                results.append(dispatcher(record))
                replayed_keys.add(record.idempotency_key)
            except Exception:
                logger.warning(
                    "Spool replay failed",
                    extra={
                        "spool_path": str(self.path),
                        "spool_operation": record.operation,
                        "spool_key": record.idempotency_key,
                    },
                    exc_info=True,
                )
                if record.group_id is not None:
                    blocked_groups.add(record.group_id)

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

    def _rewrite_records(self, records: list[SpoolRecord]) -> None:
        lines = [
            self._record_line(
                record.operation,
                record.payload,
                record.idempotency_key,
                record.created_at,
                group_id=record.group_id,
                group_index=record.group_index,
                group_size=record.group_size,
            )
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
