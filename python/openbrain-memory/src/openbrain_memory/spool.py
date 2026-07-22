"""Durable JSONL write-ahead spool with redact-before-persist replay.

Delivery semantics (at-least-once): a replay dispatch that succeeds is only
removed from the spool by the rewrite that follows the whole replay pass. A
crash after the dispatcher succeeded but before that rewrite persists leaves
the unit in place, so its records are re-delivered on the next drain with the
same ``idempotency_key``. Consumers that need exactly-once behavior must
dedupe on ``idempotency_key``; the Open Brain server does not currently
guarantee server-side dedup for every replayable operation.

Quarantine: a unit that fails ``quarantine_threshold`` consecutive replay
attempts moves atomically to the ``<spool-name>.quarantine.jsonl`` sidecar as
a content-free envelope line followed by the unit's original (already
redacted) record lines, and is never retried automatically. Consecutive
failure counts and the last replay-success time persist across process
restarts in the ``<spool-name>.retry-state.json`` sidecar; that sidecar is
crash-tolerant metadata only — losing it loses retry counters and the
last-success timestamp, never spool records.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import stat
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from .client import JSON
from .policy import idempotency_key, redact_value

logger = logging.getLogger(__name__)

# Single home for the consecutive-failure quarantine default (#296).
DEFAULT_QUARANTINE_THRESHOLD = 5
QUARANTINE_ENVELOPE_SCHEMA = "openbrain.spool_quarantine.v1"
RETRY_STATE_SCHEMA = "openbrain.spool_retry_state.v1"


class SpoolFullError(ValueError):
    """Raised when an append would exceed spool capacity."""


class SpoolUnitRetained(Exception):
    """Dispatcher signal: retain this unit without counting a replay failure.

    Raised by replay dispatchers for units that must stay parked in the spool
    (for example units parked under another namespace, #314). Retained units
    accrue no retry count and never quarantine.
    """


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
    # Content-free replay observability (#296): counts, keys, and unix times
    # only — never payloads and never error message bodies.
    quarantined_count: int = 0
    retry_counts: Mapping[str, int] = field(default_factory=dict)
    last_success_at: float | None = None


@dataclass(frozen=True)
class SpoolUnitOutcome:
    """Content-free outcome of one replay unit within a single pass."""

    status: str  # "replayed" | "failed" | "quarantined" | "retained"
    record_keys: tuple[str, ...]
    operations: tuple[str, ...]
    consecutive_failures: int = 0
    error_category: str | None = None
    first_failure_at: float | None = None
    last_failure_at: float | None = None


@dataclass(frozen=True)
class SpoolReplayReport:
    """Results plus per-unit outcomes for one replay pass."""

    results: tuple[JSON, ...]
    outcomes: tuple[SpoolUnitOutcome, ...]


@dataclass
class _UnitRetryState:
    consecutive_failures: int
    first_failure_at: float
    last_failure_at: float
    error_category: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "consecutive_failures": self.consecutive_failures,
            "first_failure_at": self.first_failure_at,
            "last_failure_at": self.last_failure_at,
            "error_category": self.error_category,
        }


@dataclass
class _RetryState:
    last_success_at: float | None
    units: dict[str, _UnitRetryState]


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
        quarantine_threshold: int = DEFAULT_QUARANTINE_THRESHOLD,
    ) -> None:
        if max_lines < 1:
            raise ValueError("max_lines must be >= 1")
        if max_bytes < 1:
            raise ValueError("max_bytes must be >= 1")
        if quarantine_threshold < 1:
            raise ValueError("quarantine_threshold must be >= 1")
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        self.quarantine_path = self.path.with_suffix(
            self.path.suffix + ".quarantine.jsonl"
        )
        self.retry_state_path = self.path.with_suffix(
            self.path.suffix + ".retry-state.json"
        )
        self.max_lines = max_lines
        self.max_bytes = max_bytes
        self.quarantine_threshold = quarantine_threshold

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
        retry_state = self._load_retry_state()
        quarantined_count = self._quarantined_count()
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
                quarantined_count=quarantined_count,
                retry_counts={},
                last_success_at=retry_state.last_success_at,
            )
        self._reject_symlink(self.path)
        operation_counts: dict[str, int] = {}
        oldest_created_at: float | None = None
        newest_created_at: float | None = None
        pending_count = 0
        lines = self.path.read_text(encoding="utf-8").splitlines(keepends=True)
        units = self._parse_units(lines, warn=False)
        corrupted_line_count = sum(unit.corrupted_line_count for unit in units)
        retry_counts: dict[str, int] = {}
        for unit in units:
            if unit.records is None:
                continue
            signature = unit.signature()
            if signature is not None:
                unit_state = retry_state.units.get(self._unit_key(signature))
                if unit_state is not None:
                    # Keyed by the unit's first record key: content-free and
                    # matches the spool_key used on quarantine receipts.
                    retry_counts[unit.records[0].idempotency_key] = (
                        unit_state.consecutive_failures
                    )
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
            quarantined_count=quarantined_count,
            retry_counts=retry_counts,
            last_success_at=retry_state.last_success_at,
        )

    def replay(self, dispatcher: Callable[[SpoolRecord], JSON]) -> list[JSON]:
        return list(self.replay_with_report(dispatcher).results)

    def replay_with_report(
        self,
        dispatcher: Callable[[SpoolRecord], JSON],
    ) -> SpoolReplayReport:
        """Replay whole units and report content-free per-unit outcomes.

        Delivery is at-least-once: dispatched-and-succeeded units are only
        removed by the rewrite at the end of the pass (see module docstring).
        A dispatcher may raise ``SpoolUnitRetained`` to park a unit without
        counting a failure; any other exception counts one consecutive
        failure, and a unit reaching ``quarantine_threshold`` consecutive
        failures moves to the quarantine sidecar in the same pass.
        """
        results: list[JSON] = []
        lock_fd = self._lock()
        try:
            lines = (
                self.path.read_text(encoding="utf-8").splitlines(keepends=True)
                if self.path.exists()
                else []
            )
            snapshot = self._parse_units(lines, warn=True)
            retry_state = self._load_retry_state()
        finally:
            self._unlock(lock_fd)

        now = time.time()
        outcomes: list[SpoolUnitOutcome] = []
        replayed_units: set[tuple[str | None, tuple[str, ...]]] = set()
        failed_updates: dict[str, _UnitRetryState] = {}
        quarantine_updates: dict[str, _UnitRetryState] = {}
        any_replayed = False
        for unit in snapshot:
            if unit.records is None:
                continue
            signature = unit.signature()
            if signature is None:
                continue
            unit_key = self._unit_key(signature)
            prior = retry_state.units.get(unit_key)
            record_keys = tuple(record.idempotency_key for record in unit.records)
            operations = tuple(record.operation for record in unit.records)
            unit_results: list[JSON] = []
            error: BaseException | None = None
            retained = False
            for record in unit.records:
                try:
                    unit_results.append(dispatcher(record))
                except SpoolUnitRetained:
                    retained = True
                    break
                except Exception as dispatch_error:
                    error = dispatch_error
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
            if retained:
                outcomes.append(
                    SpoolUnitOutcome(
                        status="retained",
                        record_keys=record_keys,
                        operations=operations,
                        consecutive_failures=(
                            prior.consecutive_failures if prior is not None else 0
                        ),
                    )
                )
                continue
            if error is None:
                replayed_units.add(signature)
                results.extend(unit_results)
                any_replayed = True
                outcomes.append(
                    SpoolUnitOutcome(
                        status="replayed",
                        record_keys=record_keys,
                        operations=operations,
                    )
                )
                continue
            update = _UnitRetryState(
                consecutive_failures=(
                    prior.consecutive_failures + 1 if prior is not None else 1
                ),
                first_failure_at=(
                    prior.first_failure_at if prior is not None else now
                ),
                last_failure_at=now,
                # Class name only — never error message bodies on disk or in
                # observability output.
                error_category=type(error).__name__,
            )
            crossed = update.consecutive_failures >= self.quarantine_threshold
            (quarantine_updates if crossed else failed_updates)[unit_key] = update
            outcomes.append(
                SpoolUnitOutcome(
                    status="quarantined" if crossed else "failed",
                    record_keys=record_keys,
                    operations=operations,
                    consecutive_failures=update.consecutive_failures,
                    error_category=update.error_category,
                    first_failure_at=update.first_failure_at,
                    last_failure_at=update.last_failure_at,
                )
            )

        if replayed_units or failed_updates or quarantine_updates:
            self._commit_replay_pass(
                replayed_units=replayed_units,
                failed_updates=failed_updates,
                quarantine_updates=quarantine_updates,
                prior_state=retry_state,
                any_replayed=any_replayed,
                now=now,
            )
        return SpoolReplayReport(
            results=tuple(results),
            outcomes=tuple(outcomes),
        )

    def _commit_replay_pass(
        self,
        *,
        replayed_units: set[tuple[str | None, tuple[str, ...]]],
        failed_updates: Mapping[str, _UnitRetryState],
        quarantine_updates: Mapping[str, _UnitRetryState],
        prior_state: _RetryState,
        any_replayed: bool,
        now: float,
    ) -> None:
        """Persist one replay pass: quarantine, spool rewrite, retry state.

        Crash-safety ordering (each write is individually atomic):
        1. quarantine sidecar (deduped on unit key, so a crash between steps
           1 and 2 cannot lose a unit and re-quarantines idempotently),
        2. main spool rewrite without replayed/quarantined units,
        3. retry-state sidecar. A crash before step 3 loses only retry
           counters / last-success metadata, never spool records.
        """
        lock_fd = self._lock()
        try:
            live_lines = (
                self.path.read_text(encoding="utf-8").splitlines(keepends=True)
                if self.path.exists()
                else []
            )
            live_units = self._parse_units(live_lines, warn=False)
            remaining_lines: list[str] = []
            remaining_keys: set[str] = set()
            quarantined_now: list[tuple[str, _SpoolUnit, _UnitRetryState]] = []
            for unit in live_units:
                signature = unit.signature()
                if signature is not None and signature in replayed_units:
                    continue
                unit_key = (
                    self._unit_key(signature) if signature is not None else None
                )
                if unit_key is not None and unit_key in quarantine_updates:
                    quarantined_now.append(
                        (unit_key, unit, quarantine_updates[unit_key])
                    )
                    continue
                remaining_lines.extend(unit.lines)
                if unit_key is not None:
                    remaining_keys.add(unit_key)
            if quarantined_now:
                self._append_quarantined_units(quarantined_now, now=now)
            self._write_lines(remaining_lines)
            units: dict[str, _UnitRetryState] = {}
            for unit_key in remaining_keys:
                update = failed_updates.get(unit_key)
                if update is not None:
                    units[unit_key] = update
                elif unit_key in prior_state.units:
                    units[unit_key] = prior_state.units[unit_key]
            self._write_retry_state(
                _RetryState(
                    last_success_at=(
                        now if any_replayed else prior_state.last_success_at
                    ),
                    units=units,
                )
            )
        finally:
            self._unlock(lock_fd)

    def _append_quarantined_units(
        self,
        entries: list[tuple[str, _SpoolUnit, _UnitRetryState]],
        *,
        now: float,
    ) -> None:
        self._reject_symlink(self.quarantine_path)
        existing_lines = (
            self.quarantine_path.read_text(encoding="utf-8").splitlines(
                keepends=True
            )
            if self.quarantine_path.exists()
            else []
        )
        existing_keys = {
            envelope.get("unit_key")
            for envelope in self._quarantine_envelopes(existing_lines)
        }
        new_lines: list[str] = []
        for unit_key, unit, state in entries:
            if unit_key in existing_keys:
                # Crash-window dedupe: the previous pass quarantined this unit
                # but crashed before the main-spool rewrite persisted.
                continue
            assert unit.records is not None
            envelope = {
                "schema": QUARANTINE_ENVELOPE_SCHEMA,
                "unit_key": unit_key,
                "record_keys": [
                    record.idempotency_key for record in unit.records
                ],
                "operations": [record.operation for record in unit.records],
                "consecutive_failures": state.consecutive_failures,
                "first_failure_at": state.first_failure_at,
                "last_failure_at": state.last_failure_at,
                "error_category": state.error_category,
                "quarantined_at": now,
                "line_count": len(unit.lines),
            }
            new_lines.append(
                json.dumps(envelope, sort_keys=True, separators=(",", ":")) + "\n"
            )
            new_lines.extend(unit.lines)
        if new_lines:
            self._atomic_write(self.quarantine_path, existing_lines + new_lines)

    @staticmethod
    def _quarantine_envelopes(lines: Iterable[str]) -> list[dict[str, Any]]:
        envelopes: list[dict[str, Any]] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(value, dict)
                and value.get("schema") == QUARANTINE_ENVELOPE_SCHEMA
            ):
                envelopes.append(value)
        return envelopes

    def _quarantined_count(self) -> int:
        if not self.quarantine_path.exists():
            return 0
        self._reject_symlink(self.quarantine_path)
        lines = self.quarantine_path.read_text(encoding="utf-8").splitlines(
            keepends=True
        )
        return len(self._quarantine_envelopes(lines))

    @staticmethod
    def _unit_key(signature: tuple[str | None, tuple[str, ...]]) -> str:
        group_id, record_keys = signature
        return json.dumps([group_id, list(record_keys)], separators=(",", ":"))

    def _load_retry_state(self) -> _RetryState:
        """Load retry metadata; corruption degrades to empty (counts only)."""
        empty = _RetryState(last_success_at=None, units={})
        if not self.retry_state_path.exists():
            return empty
        self._reject_symlink(self.retry_state_path)
        try:
            raw = json.loads(
                self.retry_state_path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError):
            return empty
        if not isinstance(raw, dict) or not isinstance(raw.get("units"), dict):
            return empty
        last_success_at = raw.get("last_success_at")
        units: dict[str, _UnitRetryState] = {}
        for unit_key, value in raw["units"].items():
            parsed = self._parse_unit_retry_state(unit_key, value)
            if parsed is not None:
                units[unit_key] = parsed
        return _RetryState(
            last_success_at=(
                float(last_success_at)
                if isinstance(last_success_at, int | float)
                and not isinstance(last_success_at, bool)
                else None
            ),
            units=units,
        )

    @staticmethod
    def _parse_unit_retry_state(unit_key: Any, value: Any) -> _UnitRetryState | None:
        if not isinstance(unit_key, str) or not isinstance(value, dict):
            return None
        failures = value.get("consecutive_failures")
        first_failure_at = value.get("first_failure_at")
        last_failure_at = value.get("last_failure_at")
        error_category = value.get("error_category")
        if isinstance(failures, bool) or not isinstance(failures, int):
            return None
        if failures < 1:
            return None
        if isinstance(first_failure_at, bool) or not isinstance(
            first_failure_at, int | float
        ):
            return None
        if isinstance(last_failure_at, bool) or not isinstance(
            last_failure_at, int | float
        ):
            return None
        if not isinstance(error_category, str):
            return None
        return _UnitRetryState(
            consecutive_failures=failures,
            first_failure_at=float(first_failure_at),
            last_failure_at=float(last_failure_at),
            error_category=error_category,
        )

    def _write_retry_state(self, state: _RetryState) -> None:
        self._reject_symlink(self.retry_state_path)
        payload = {
            "schema": RETRY_STATE_SCHEMA,
            "last_success_at": state.last_success_at,
            "units": {
                unit_key: unit_state.as_dict()
                for unit_key, unit_state in state.units.items()
            },
        }
        self._atomic_write(
            self.retry_state_path,
            [json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"],
        )

    def _write_lines(self, lines: list[str]) -> None:
        self._atomic_write(self.path, lines)

    def _atomic_write(self, path: Path, lines: list[str]) -> None:
        payload = "".join(lines).encode("utf-8")
        original = path.read_bytes() if path.exists() else None
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory_fd = os.open(path.parent, directory_flags)
        tmp_name: str | None = None
        replaced = False
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
            )
            try:
                os.fchmod(fd, 0o600)
                self._write_all(fd, payload)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp_name, path)
            tmp_name = None
            replaced = True
            os.fsync(directory_fd)
        except Exception:
            if replaced:
                self._restore_after_failed_replace(path, original, directory_fd)
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
        path: Path,
        original: bytes | None,
        directory_fd: int,
    ) -> None:
        tmp_name: str | None = None
        try:
            if original is None:
                os.unlink(path)
            else:
                fd, tmp_name = tempfile.mkstemp(
                    prefix=f".{path.name}.restore.",
                    suffix=".tmp",
                    dir=path.parent,
                )
                try:
                    os.fchmod(fd, 0o600)
                    self._write_all(fd, original)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(tmp_name, path)
                tmp_name = None
            os.fsync(directory_fd)
        except Exception:
            logger.error(
                "Failed to restore spool after directory synchronization error",
                extra={"spool_path": str(path)},
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
