"""The advisory lock two languages use to take turns on one JSON file.

Purpose:
    ``receipts.json`` is written by Python hooks and, today, still by the
    TypeScript provider. Both must serialise against each other, and neither can
    do that with a lock that lives inside one process. This module reproduces the
    exact protocol ``withReceiptLock`` implements in
    ``_ob/scripts/ob-memory-provider/receipt-state.ts`` so a Python writer and a
    TypeScript writer contend correctly rather than interleaving.

Architecture:
    An ``O_CREAT | O_EXCL`` lockfile beside the state file. That flag pair is a
    single atomic filesystem operation: exactly one of two racing processes gets
    the file, the other gets ``EEXIST``. It is the cross-language part -- both
    languages issue the same ``open(2)`` -- which a Python-only primitive
    (``threading.Lock``, ``fcntl.flock`` semantics differing per platform, a
    library's own scheme) would not be.

Pattern/Convention:
    A LOCK MUST BE RECLAIMABLE. A hook process killed between taking the lock and
    releasing it would otherwise wedge the file permanently, and the gate would
    then never see another receipt. So a lock whose mtime is old enough is
    declared stale and stolen -- but only under a SECOND lock (``.lock.reclaim``),
    so two processes cannot both decide to steal it and both believe they hold
    it.

    THE TOKEN IS WHY RELEASE IS SAFE. The holder writes ``pid:millis:uuid4`` into
    the lockfile and, on release, only unlinks it if the content still matches. A
    process whose lock was stolen while it was slow therefore cannot delete the
    NEW holder's lock on its way out.

    This module deliberately hand-writes what looks like a solved problem. The
    solved problem is "lock a file in Python"; the actual problem is "use the
    same lock the TypeScript module already uses", and only reproducing its
    protocol solves that one.

See Also:
    - ``_ob/scripts/ob-memory-provider/receipt-state.ts`` - the specification
    - ``openbrain.receipts.state`` - the only caller
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

#: How long a writer waits for another process's lock before giving up, matching
#: ``LOCK_WAIT_MS`` in ``receipt-state.ts``. A receipt write is microseconds of
#: work, so reaching this means the other holder is wedged, not merely busy.
LOCK_WAIT_SECONDS = 5.0

#: How old a lockfile must be before it is treated as abandoned, matching
#: ``STALE_LOCK_MS``. Comfortably longer than any honest hold.
STALE_LOCK_SECONDS = 30.0

#: How long to sleep between attempts, matching ``LOCK_RETRY_MS``.
RETRY_SECONDS = 0.01

#: The permissions a lockfile is created with: owner-only, like the state file it
#: guards. Receipts name sessions and projects, so the whole tree is private.
_PRIVATE_FILE = 0o600


class LockTimeoutError(TimeoutError):
    """The lock was held by another process for longer than the wait allows.

    Raised rather than silently proceeding: writing the state file without the
    lock is what corrupts it, and a hook that cannot record a receipt should fail
    into its caller's swallow rather than produce a file the gate then rejects.
    """

    def __init__(self, path: Path) -> None:
        """Name the lock that could not be taken."""
        super().__init__(f"receipt state lock timed out: {path}")


@contextmanager
def receipt_lock(state_path: Path) -> Iterator[None]:
    """Hold the advisory lock for ``state_path`` for the duration of the block.

    Args:
        state_path: The state file being guarded. The lock itself is
            ``<state_path>.lock``, the name the TypeScript writer uses.

    Yields:
        Nothing. The block runs with the lock held.

    Raises:
        LockTimeoutError: Another process held the lock past
            :data:`LOCK_WAIT_SECONDS` and it was not stale enough to reclaim.
        OSError: The lock directory could not be created or written.

    Example:
        >>> import tempfile, pathlib
        >>> with tempfile.TemporaryDirectory() as directory:
        ...     target = pathlib.Path(directory) / "receipts.json"
        ...     with receipt_lock(target):
        ...         (target.with_suffix(".json.lock")).exists()
        True
    """
    lock_path = _lock_path(state_path)
    token = _token()
    _acquire(lock_path, token)
    try:
        yield
    finally:
        _release(lock_path, token)


def ensure_private_parent(path: Path) -> None:
    """Create ``path``'s directory owner-only, and keep it that way.

    Args:
        path: The file whose parent directory is being prepared.

    ``mkdir`` applies its mode only when it CREATES the directory, so an existing
    directory with looser permissions would keep them. The explicit ``chmod``
    after is what makes the guarantee hold either way -- the same two-step the
    TypeScript ``ensurePrivateParent`` performs.
    """
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    parent.chmod(0o700)


def _lock_path(state_path: Path) -> Path:
    """The lockfile guarding ``state_path``: its own name with ``.lock`` added.

    Built by appending to the NAME rather than with ``with_suffix``, which would
    replace ``.json`` instead of following it and would name a different file
    from the one TypeScript locks.
    """
    return state_path.with_name(state_path.name + ".lock")


def _token() -> str:
    """A value unique to this holder: process, moment, and a random id.

    All three matter. The pid alone repeats after a wrap; the timestamp alone
    collides between two processes in the same millisecond; the uuid alone hides
    who holds it when a wedged lock is being diagnosed by hand.
    """
    return f"{os.getpid()}:{int(time.time() * 1000)}:{uuid.uuid4()}"


def _acquire(lock_path: Path, token: str) -> None:
    """Take the lock, waiting for and if necessary reclaiming the current holder.

    Raises:
        LockTimeoutError: The wait elapsed with the lock still held by a holder
            that was not stale.
    """
    ensure_private_parent(lock_path)
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while not _create_owned_lock(lock_path, token):
        if _lock_is_stale(lock_path) and _reclaim_stale_lock(lock_path, token):
            return
        if time.monotonic() >= deadline:
            raise LockTimeoutError(lock_path)
        time.sleep(RETRY_SECONDS)


def _create_owned_lock(lock_path: Path, token: str) -> bool:
    """Create the lockfile atomically and stamp it, or report it already exists.

    Returns:
        ``True`` when this process created it, ``False`` when another holds it.

    ``O_EXCL`` is the whole mechanism: create-if-absent is one atomic syscall, so
    two processes racing cannot both succeed. Everything after it is bookkeeping.
    """
    try:
        descriptor = os.open(
            lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _PRIVATE_FILE
        )
    except FileExistsError:
        return False

    try:
        os.write(descriptor, token.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

    # `os.open`'s mode is masked by the process umask, so the file can land more
    # permissive than asked. The explicit chmod is what actually guarantees it.
    lock_path.chmod(_PRIVATE_FILE)
    return True


def _reclaim_stale_lock(lock_path: Path, token: str) -> bool:
    """Steal an abandoned lock, under a second lock so only one stealer wins.

    Returns:
        ``True`` when this process now holds ``lock_path``.

    Without the reclaim lock, two processes that both observed the same stale
    lock would both unlink it and both create their own, and both would believe
    they held it -- which is worse than the wedge being reclaimed, because it is
    silent. Staleness is re-checked after taking the reclaim lock: by then the
    original holder may have finished and a NEW holder taken it, and that one is
    not abandoned.
    """
    reclaim_path = lock_path.with_name(lock_path.name + ".reclaim")
    reclaim_token = _token()
    if not _create_owned_lock(reclaim_path, reclaim_token):
        return False

    try:
        if not _lock_is_stale(lock_path):
            return False
        lock_path.unlink(missing_ok=True)
        return _create_owned_lock(lock_path, token)
    finally:
        _release(reclaim_path, reclaim_token)


def _release(lock_path: Path, token: str) -> None:
    """Unlink the lock, but only while this process is still its holder.

    A lock that was reclaimed out from under a slow process now belongs to
    someone else, and unlinking it would hand a third process a lock two of them
    think they hold. Comparing the token before unlinking is what prevents that.
    """
    try:
        if lock_path.read_text(encoding="utf-8") == token:
            lock_path.unlink(missing_ok=True)
    except FileNotFoundError:
        return


def _lock_is_stale(lock_path: Path) -> bool:
    """Whether the lockfile is older than the abandonment window.

    A lock that vanished between the failed create and this check is NOT stale --
    it is gone, and the caller's next create attempt will simply succeed.
    """
    try:
        age = time.time() - lock_path.stat().st_mtime
    except FileNotFoundError:
        return False

    return age > STALE_LOCK_SECONDS
