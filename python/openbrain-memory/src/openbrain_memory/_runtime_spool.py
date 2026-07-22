"""Private ordered-spool ownership for first-class lifecycle writes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from ._runtime_router import safe_error
from .agent import MemorySpool

# Client-internal provenance key stamped on EVERY spooled record payload and
# stripped before dispatch; it never reaches the server. Session_start-only
# stamping (#314) left lone non-start units bypassing namespace retention.
PARKED_NAMESPACE_KEY = "_parked_namespace"


class TrackingSpool:
    """Own ordered prerequisite/requested-write spooling for one runtime."""

    def __init__(self, spool: MemorySpool, *, namespace: str | None = None) -> None:
        self.spool = spool
        self.namespace = namespace
        self.last_key: str | None = None
        self.last_operation: str | None = None
        self.last_error: str | None = None
        self.pending_start: tuple[str, Mapping[str, Any], str | None] | None = None

    def reset(self) -> None:
        """Clear evidence and any uncommitted prerequisite from the prior call."""
        self.last_key = None
        self.last_operation = None
        self.last_error = None
        self.pending_start = None

    def append(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        key: str | None = None,
    ) -> str:
        """Defer lane setup until it can be atomically paired with the write."""
        if operation == "session_start":
            self.pending_start = (operation, self._parked(payload), key)
            self.last_operation = operation
            return key or "pending-session-start"
        try:
            if self.pending_start is not None:
                append_batch = getattr(self.spool, "append_batch", None)
                if not callable(append_batch):
                    raise RuntimeError(
                        "configured spool cannot atomically queue lane prerequisite"
                    )
                keys = cast(
                    list[str],
                    append_batch(
                        [
                            self.pending_start,
                            (operation, self._parked(payload), key),
                        ]
                    ),
                )
                result = keys[-1]
                self.pending_start = None
            else:
                result = self.spool.append(operation, self._parked(payload), key=key)
        except Exception as error:
            self.last_error = safe_error(error)
            raise
        self.last_key = result
        self.last_operation = operation
        return result

    def _parked(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Stamp namespace provenance on every spooled record payload.

        A shared spool file replayed by a runtime configured for another
        namespace must retain the record instead of silently transplanting
        its content — for lone non-start units just as for session_start
        (which #314 covered first). The marker is client-internal and is
        stripped before dispatch.
        """
        parked = dict(payload)
        if self.namespace is not None:
            parked[PARKED_NAMESPACE_KEY] = self.namespace
        return parked
