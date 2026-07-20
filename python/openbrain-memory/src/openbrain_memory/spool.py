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


class SpoolFullError(ValueError):
    """Raised when an append would exceed spool capacity."""


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


@dataclass(frozen=True)
class _SpoolUnit:
    lines: tuple[str, ...]
    records: tuple[SpoolRecord, ...] | None
    corrupted_line_count: int

    def signature(self) -> tuple[str | None, tuple[str, ...]] | None:
        if self.records is None:
            return None
        return (
            self.records[0].group_id,
            tuple(record.idempotency_key for record in self.records),
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
            existing_line_count = len(existing)
            existing_bytes = sum(len(line.encode("utf-8")) for line in existing)
            if (
                existing_line_count + len(batch_lines) > self.max_lines
                or existing_bytes + batch_bytes > self.max_bytes
            ):
                raise SpoolFullError(
                    "spool is full; append would exceed configured "
                    "max_lines/max_bytes limits"
                )
            self._write_lines([*existing, *batch_lines])
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
            "payload": redact_value(dict(payload)),
            "created_at": created_at,
        }
        if group_id is not None:
            record["group_id"] = group_id
            record["group_index"] = group_index
            record["group_size"] = group_size
        return json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"

    @classmethod
    def _group_indexed_lines(cls, lines: list[str]) -> list[list[tuple[int, str]]]:
        grouped: list[list[tuple[int, str]]] = []
        active_group_id: str | None = None
        for line_number, line in enumerate(lines, start=1):
            group_id = cls._raw_group_id(line)
            if group_id is not None and group_id == active_group_id:
                grouped[-1].append((line_number, line))
                continue
            grouped.append([(line_number, line)])
            active_group_id = group_id
        return grouped

    def _parse_units(self, lines: list[str], *, warn: bool) -> list[_SpoolUnit]:
        units: list[_SpoolUnit] = []
        grouped = self._group_indexed_lines(lines)
        for group in grouped:
            parsed: list[SpoolRecord] = []
            corrupted = 0
            for line_number, line in group:
                if not line.strip():
                    continue
                record = self._parse_record(line, line_number, warn=warn)
                if record is None:
                    corrupted += 1
                else:
                    parsed.append(record)
            if corrupted or not parsed:
                units.append(
                    _SpoolUnit(
                        lines=tuple(line for _, line in group),
                        records=None,
                        corrupted_line_count=corrupted,
                    )
                )
                continue
            first = parsed[0]
            valid_group = first.group_id is None or (
                len(parsed) == first.group_size
                and all(
                    record.group_id == first.group_id
                    and record.group_size == first.group_size
                    for record in parsed
                )
                and [record.group_index for record in parsed]
                == list(range(len(parsed)))
            )
            if not valid_group:
                if warn:
                    for line_number, _ in group:
                        self._warn_corrupted_record(line_number)
                units.append(
                    _SpoolUnit(
                        lines=tuple(line for _, line in group),
                        records=None,
                        corrupted_line_count=len(group),
                    )
                )
                continue
            units.append(
                _SpoolUnit(
                    lines=tuple(line for _, line in group),
                    records=tuple(parsed),
                    corrupted_line_count=0,
                )
            )
        return units

    @staticmethod
    def _raw_group_id(line: str) -> str | None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return None
        candidate = payload.get("group_id") if isinstance(payload, dict) else None
        return candidate if isinstance(candidate, str) and candidate else None

    def _parse_record(
        self,
        line: str,
        line_number: int,
        *,
        warn: bool,
    ) -> SpoolRecord | None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            if warn:
                self._warn_corrupted_record(line_number, exc_info=True)
            return None
        if not isinstance(payload, dict):
            if warn:
                self._warn_corrupted_record(line_number)
            return None
        try:
            idempotency = payload["idempotency_key"]
            operation = payload["operation"]
            if not isinstance(idempotency, str) or not idempotency.strip():
                raise ValueError("idempotency_key must be a non-empty string")
            if not isinstance(operation, str) or not operation.strip():
                raise ValueError("operation must be a non-empty string")
            record_payload = payload.get("payload", {})
            created_at = float(payload.get("created_at", 0))
            group_id, group_index, group_size = self._group_metadata(payload)
        except (KeyError, TypeError, ValueError):
            if warn:
                self._warn_corrupted_record(line_number, exc_info=True)
            return None
        if not isinstance(record_payload, dict):
            if warn:
                self._warn_corrupted_record(line_number)
            return None
        return SpoolRecord(
            idempotency_key=idempotency,
            operation=operation,
            payload=record_payload,
            created_at=created_at,
            group_id=group_id,
            group_index=group_index,
            group_size=group_size,
        )

    def records(self) -> list[SpoolRecord]:
        if not self.path.exists():
            return []
        self._reject_symlink(self.path)
        lines = self.path.read_text(encoding="utf-8").splitlines(keepends=True)
        return [
            record
            for unit in self._parse_units(lines, warn=True)
            if unit.records is not None
            for record in unit.records
        ]

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
        lines = self.path.read_text(encoding="utf-8").splitlines(keepends=True)
        units = self._parse_units(lines, warn=False)
        corrupted_line_count = sum(unit.corrupted_line_count for unit in units)
        for unit in units:
            if unit.records is None:
                continue
            for record in unit.records:
                pending_count += 1
                operation_counts[record.operation] = (
                    operation_counts.get(record.operation, 0) + 1
                )
                if oldest_created_at is None or record.created_at < oldest_created_at:
                    oldest_created_at = record.created_at
                if newest_created_at is None or record.created_at > newest_created_at:
                    newest_created_at = record.created_at

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
        results: list[JSON] = []
        lock_fd = self._lock()
        try:
            lines = (
                self.path.read_text(encoding="utf-8").splitlines(keepends=True)
                if self.path.exists()
                else []
            )
            snapshot = self._parse_units(lines, warn=True)
        finally:
            self._unlock(lock_fd)

        replayed_units: set[tuple[str | None, tuple[str, ...]]] = set()
        for unit in snapshot:
            if unit.records is None:
                continue
            unit_results: list[JSON] = []
            for record in unit.records:
                try:
                    unit_results.append(dispatcher(record))
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
                    break
            else:
                signature = unit.signature()
                if signature is not None:
                    replayed_units.add(signature)
                    results.extend(unit_results)

        if not replayed_units:
            return results
        lock_fd = self._lock()
        try:
            live_lines = (
                self.path.read_text(encoding="utf-8").splitlines(keepends=True)
                if self.path.exists()
                else []
            )
            remaining = [
                line
                for unit in self._parse_units(live_lines, warn=False)
                if unit.signature() not in replayed_units
                for line in unit.lines
            ]
            self._write_lines(remaining)
        finally:
            self._unlock(lock_fd)
        return results

    def _write_lines(self, lines: list[str]) -> None:
        payload = "".join(lines).encode("utf-8")
        original = self.path.read_bytes() if self.path.exists() else None
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory_fd = os.open(self.path.parent, directory_flags)
        tmp_name: str | None = None
        replaced = False
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
            )
            try:
                os.fchmod(fd, 0o600)
                self._write_all(fd, payload)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp_name, self.path)
            tmp_name = None
            replaced = True
            os.fsync(directory_fd)
        except Exception:
            if replaced:
                self._restore_after_failed_replace(original, directory_fd)
            raise
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except FileNotFoundError:
                    pass
            os.close(directory_fd)

    @staticmethod
    def _write_all(fd: int, payload: bytes) -> None:
        remaining = memoryview(payload)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("spool write made no forward progress")
            remaining = remaining[written:]

    def _restore_after_failed_replace(
        self,
        original: bytes | None,
        directory_fd: int,
    ) -> None:
        tmp_name: str | None = None
        try:
            if original is None:
                os.unlink(self.path)
            else:
                fd, tmp_name = tempfile.mkstemp(
                    prefix=f".{self.path.name}.restore.",
                    suffix=".tmp",
                    dir=self.path.parent,
                )
                try:
                    os.fchmod(fd, 0o600)
                    self._write_all(fd, original)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(tmp_name, self.path)
                tmp_name = None
            os.fsync(directory_fd)
        except Exception:
            logger.error(
                "Failed to restore spool after directory synchronization error",
                extra={"spool_path": str(self.path)},
                exc_info=True,
            )
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except FileNotFoundError:
                    pass

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
