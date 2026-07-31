"""Persist health status across restarts. Atomic writes, tolerant reads.

WHY PERSISTENCE AT ALL
    Without it, every restart resets every target to UNKNOWN and the failure
    streak with it. A service that restarts the monitor to "fix" an alert would
    clear the alert, which is precisely backwards.

THE TWO RULES THIS MODULE EXISTS TO ENFORCE
    **1. Writes are atomic AND durable.** Write to a temporary file in the same
    directory, flush it to the physical device, replace it over the target, then
    flush the directory. ``Path.replace`` is atomic on POSIX and on Windows, so
    a reader sees either the entire old file or the entire new one -- never a
    half-written file.

    The naive version -- ``open(path, "w")`` then write -- truncates first. A
    crash, a full disk, or a container kill between truncate and write leaves a
    zero-byte or partial file, and the state that survived the crash is
    destroyed by the recovery attempt. This is the single most common way JSON
    state files get corrupted.

    Atomicity and durability are separate properties and both are needed. See
    ``_flush_to_device`` and the directory sync in ``save`` -- each documents a
    defect this module originally shipped with.

WHY THIS FILE HAND-WRITES SOMETHING, WHEN utils/http.py ARGUES AGAINST IT
    ``utils/http.py`` deleted its hand-rolled retry in favour of tenacity, and
    the reasoning there applies here too -- so it is worth being explicit about
    why this module reaches a different answer, because "use a library" is a
    rule with a real edge and pretending otherwise teaches the wrong lesson.

    The obvious candidate is ``atomicwrites``. It is correct, it is the
    canonical implementation, and reading it is what exposed both defects fixed
    below. It is also explicitly UNMAINTAINED -- the author archived it in 2022
    and asks people to vendor the logic instead.

    An unmaintained dependency is not the safe choice. It is a dependency that
    will never be fixed, on code that must keep working across OS releases. So
    the standard's order still holds -- library first -- but the library fails
    the "well-known AND maintained" test, and the remaining option is roughly
    forty lines of well-understood syscalls with the platform notes written
    down. That is a genuine "no other option" case, which is the exception the
    rule names.

    The tell that separates this from the retry case: there, the library existed
    and was healthy, and the hand-written version was re-deriving solved
    arithmetic. Here the hand-written version is the only maintained option, and
    its correctness comes from reading the reference implementation rather than
    from inventing one.

    **2. Reads are tolerant, but not silent.** A missing file is normal (first
    run) and returns empty. A CORRUPT file is not normal: it is logged at ERROR
    with the path, moved aside so it can be inspected, and then treated as
    empty. Crashing would make the app unstartable until someone hand-deletes a
    file; silently ignoring it would hide that state was lost. Neither is
    acceptable, so it does the third thing.

WHY JSON AND NOT A DATABASE
    The dataset is bounded by the number of targets, it is written once per
    round, and it must be readable by a human during an incident. A database
    would add an operational dependency for something a text file handles.
    Choosing the simpler mechanism when it genuinely suffices is the rule; this
    is the worked example of it.

Key Components:
    - StatusStore: load and save the full status map.

Pattern/Convention:
    The store owns the file path and nothing else. It does not decide health, it
    does not schedule, and it does not know what a good status is -- it moves
    validated models between memory and disk.

Example:
    >>> store = StatusStore(Path("data/monitor.json"))     # doctest: +SKIP
    >>> statuses = store.load()
    >>> store.save(statuses)

See Also:
    - exemplar.models.check.HealthStatus: what is persisted
    - _DOCS/STANDARDS-python.md ## Error handling (pattern 3: fallback with impact)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from loguru import logger
from pydantic import ValidationError

from exemplar.models import HealthStatus
from exemplar.utils.datetime_helpers import utc_now

#: Schema version written into every file. When the shape of HealthStatus
#: changes incompatibly, this is what lets a future version detect an old file
#: and migrate it instead of failing validation on every entry. Cheap now,
#: impossible to add retroactively once files exist in the wild.
SCHEMA_VERSION = 1


def _flush_to_device(fd: int) -> None:
    """Force a file descriptor's data onto the physical device.

    NOT simply ``os.fsync``, and the difference is a real bug this module
    originally shipped with.

    On macOS, ``fsync`` returns once the data reaches the drive, but does NOT
    ask the drive to flush its own write cache. Apple's ``fsync(2)`` man page
    says so directly and points at ``F_FULLFSYNC`` as the operation that
    actually guarantees the write survives power loss. So the original
    ``os.fsync``-then-replace here bought atomicity but not durability, on the
    exact platform this repo is developed on -- and it would have looked correct
    forever, because the failure only appears after an unclean shutdown.

    Everywhere else ``os.fsync`` is the right call, so the platform check is on
    the availability of the constant rather than on a hardcoded OS name.

    Args:
        fd: Open file descriptor to flush.
    """
    if sys.platform != "win32":
        import fcntl

        if hasattr(fcntl, "F_FULLFSYNC"):
            fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
            return

    os.fsync(fd)


def _flush_directory(directory: Path) -> None:
    """Force a directory entry onto the device, so the rename itself survives.

    The second half of the same defect. Flushing the FILE guarantees its
    contents are durable; it says nothing about the directory entry that gives
    the file its name. After ``replace``, a crash before the directory metadata
    reaches disk can leave the old name pointing at the old inode -- a durable
    write that is not visible under the name it was written to.

    Best-effort: on platforms where a directory cannot be opened for this
    (notably Windows), the failure is swallowed rather than turning a successful
    save into an error. The data is already safely written at this point; only
    the naming is at risk, and there is nothing further to be done about it.

    Args:
        directory: Directory whose entries should be flushed.
    """
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return

    try:
        _flush_to_device(fd)
    except OSError:
        logger.debug(f"STORE: could not flush directory {directory}")
    finally:
        os.close(fd)


class StatusStore:
    """Load and save the health-status map as a single JSON file.

    Not async. The file is small, written once per round, and ``os.replace`` is
    a single syscall -- introducing aiofiles here would add a dependency and a
    concurrency surface to save microseconds on an operation that happens every
    thirty seconds.
    """

    def __init__(self, path: Path) -> None:
        """Store the target path. The file is not touched until load or save.

        Args:
            path: Where the state file lives. Its parent is created on save.
        """
        self._path = path

    def load(self) -> dict[str, HealthStatus]:
        """Read the status map, tolerating absence and corruption.

        Returns:
            Status by target name. Empty on first run, or if the file was
            unreadable -- in which case the damaged file is preserved for
            inspection and the loss is logged at ERROR.
        """
        if not self._path.is_file():
            logger.info(f"STORE: no state file at {self._path}, starting fresh")
            return {}

        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            # Corrupt or unreadable. Preserve it, report the impact, continue
            # empty -- see the module docstring for why this is neither a crash
            # nor a silent ignore.
            self._quarantine(exc)
            return {}

        return self._parse(raw)

    def save(self, statuses: dict[str, HealthStatus]) -> None:
        """Write the status map atomically.

        Args:
            statuses: Status by target name.

        Raises:
            OSError: The write failed. Deliberately propagated -- a monitor that
                cannot persist state should say so, not continue believing it
                has durable state.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)

        document = {
            "schema_version": SCHEMA_VERSION,
            "saved_at": utc_now().isoformat(),
            # mode="json" so datetimes serialize to ISO strings rather than
            # datetime objects json cannot encode.
            "statuses": {
                name: status.model_dump(mode="json")
                for name, status in statuses.items()
            },
        }

        # Temp file in the SAME directory as the target. Not /tmp: os.replace is
        # only atomic within one filesystem, and a temp dir is frequently a
        # different mount, which silently degrades the replace into a copy.
        fd, tmp_name = tempfile.mkstemp(
            dir=self._path.parent,
            prefix=f".{self._path.name}.",
            suffix=".tmp",
        )
        tmp_path = Path(tmp_name)

        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2)
                handle.flush()
                # Flush before replace. Without it the rename can reach disk
                # before the data does, so a power loss leaves a correctly-named
                # file with garbage in it -- the exact failure atomicity was
                # supposed to prevent.
                #
                # `_flush_to_device`, not `os.fsync`: see that function for why
                # plain fsync is insufficient on macOS.
                _flush_to_device(handle.fileno())

            # Path.replace, not os.replace -- identical syscall, and ruff's PTH
            # family keeps path handling in one idiom. Atomic on POSIX and
            # Windows alike, which is the property this whole method is for.
            tmp_path.replace(self._path)

            # Flush the directory so the new name is durable too, not just the
            # bytes it points at.
            _flush_directory(self._path.parent)

            logger.debug(f"STORE: saved {len(statuses)} statuses to {self._path}")
        except OSError:
            # Clean up the temp file, then re-raise. Leaving it behind litters
            # the data directory with .tmp files after every failure.
            tmp_path.unlink(missing_ok=True)
            logger.error(f"STORE: failed to save state to {self._path}", exc_info=True)
            raise

    def _quarantine(self, exc: Exception) -> None:
        """Move an unreadable state file aside and report the impact."""
        damaged = self._path.with_suffix(f"{self._path.suffix}.corrupt")
        try:
            self._path.rename(damaged)
            moved = f" moved to {damaged.name}"
        except OSError:
            # Even the rename failed. Report it and carry on -- one unusable
            # file must not prevent startup.
            moved = " (could not be moved aside)"

        logger.error(
            f"STORE: state file {self._path} is unreadable ({exc}).{moved} "
            f"IMPACT: all targets restart at UNKNOWN and failure streaks are lost. "
            f"ACTION REQUIRED: inspect the file if the history matters; "
            f"otherwise no action -- state rebuilds on the next round."
        )

    def _parse(self, raw: object) -> dict[str, HealthStatus]:
        """Validate a parsed document into models, skipping bad entries.

        Per-entry tolerance is deliberate: one target whose stored shape is
        stale should not discard every other target's history. Each skip is
        logged, so "tolerant" never means "quiet".
        """
        if not isinstance(raw, dict):
            logger.error(
                f"STORE: {self._path} is valid JSON but not an object. "
                f"IMPACT: starting with empty state."
            )
            return {}

        stored = raw.get("statuses")
        if not isinstance(stored, dict):
            logger.error(
                f"STORE: {self._path} has no 'statuses' object. "
                f"IMPACT: starting with empty state."
            )
            return {}

        version = raw.get("schema_version")
        if version != SCHEMA_VERSION:
            # Not fatal today because there is only one version. The check
            # exists so the day a v2 appears, the mismatch is visible instead of
            # surfacing as a wall of validation errors.
            logger.warning(
                f"STORE: {self._path} has schema_version={version!r}, "
                f"expected {SCHEMA_VERSION}. Attempting to read anyway."
            )

        statuses: dict[str, HealthStatus] = {}
        for name, payload in stored.items():
            try:
                statuses[name] = HealthStatus.model_validate(payload)
            except ValidationError as exc:
                logger.warning(
                    f"STORE: dropping unreadable entry for target={name}: "
                    f"{exc.error_count()} validation error(s). "
                    f"IMPACT: this target restarts at UNKNOWN."
                )

        logger.info(f"STORE: loaded {len(statuses)} statuses from {self._path}")
        return statuses
