"""Fleet-bus wire shapes for Open Brain's NATS transport.

Open Brain's realtime memory transport is a thin consumer of ``fleet-nats``
(``git@github.com:rodaddy/fleet-bus.git``, ``packages/fleet-nats``): the
canonical NATS transport + coordination library for the fleet. Rather than
reimplement the wire contract, we reuse fleet-nats's :class:`Envelope` and its
subject-slug convention.

fleet-nats is NOT published on PyPI and lives in a private monorepo
subdirectory, so it is NOT a normal installable dependency for this
lightweight client. We therefore import it *optionally*: if ``fleet_nats`` is
importable we defer to its ``Envelope``/``subjects`` so both sides agree on the
wire byte-for-byte; otherwise we fall back to a LOCAL mirror of the exact same
shape. The mirror is kept 1:1 with
``packages/fleet-nats/src/fleet_nats/envelope.py`` and ``subjects.py`` (probed
2026-07-08). If the fleet contract changes, update both.

fleet-nats has no ``ob_context_pack(env)`` subject builder yet; we mirror the
``{env}.<domain>...`` convention locally as ``{env}.ob.memory.context_pack``.

TODO(upstream): file a ``fleet_nats.subjects.ob_context_pack(env)`` builder so
this local helper can be deleted and the subject tree stays owned by one lib.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

# Kind constant for the OB memory context-pack request on the fleet bus.
CONTEXT_PACK_REQUEST_KIND = "context_pack_request"

# Mirror of fleet_nats.envelope.ENVELOPE_VERSION (probed 2026-07-08). Kept in
# sync so a locally-built envelope is byte-compatible with a fleet-nats one.
_FLEET_ENVELOPE_VERSION = 1

# True when the real fleet-nats library is importable in this environment. The
# transport works identically either way; this only records which path built
# the wire bytes (useful for diagnostics / tests).
try:  # pragma: no cover - import availability is environment-specific
    from fleet_nats import Envelope as _FleetEnvelope  # type: ignore[import-not-found]

    FLEET_NATS_AVAILABLE = True
except Exception:  # pragma: no cover - fleet-nats optional / not installed
    _FleetEnvelope = None  # type: ignore[assignment,misc]
    FLEET_NATS_AVAILABLE = False


def _local_slug(value: str) -> str:
    """Local mirror of ``fleet_nats.subjects._slug`` (probed 2026-07-08).

    Normalise a subject token: lowercased, spaces/dots to hyphens, no empties.
    A whitespace-only token would otherwise produce an invalid NATS subject
    like ``dev.ob..context_pack`` that the server rejects (message lost).
    """
    slug = value.strip().lower().replace(" ", "-").replace(".", "-")
    if not slug:
        raise ValueError(f"subject token normalises to empty: {value!r}")
    return slug


def _resolve_slug() -> Callable[[str], str]:
    if FLEET_NATS_AVAILABLE:
        try:  # pragma: no cover - only when fleet-nats installed
            from fleet_nats.subjects import (  # type: ignore[import-not-found]
                _slug as fleet_slug,
            )

            resolved: Callable[[str], str] = fleet_slug
            return resolved
        except Exception:  # pragma: no cover - defensive
            return _local_slug
    return _local_slug


def build_context_pack_subject(env: str) -> str:
    """Build the OB memory context-pack subject ``{env}.ob.memory.context_pack``.

    Mirrors the fleet convention ``{env}.{domain}.{...}`` (dot-delimited,
    env-prefixed, hierarchical). Uses fleet-nats's ``_slug`` when the library is
    importable so the env token is normalised identically on both sides; falls
    back to the local mirror otherwise. Only the env token is caller-controlled;
    the ``ob.memory.context_pack`` tail is a fixed, already-safe literal.
    """
    slug = _resolve_slug()
    return f"{slug(env)}.ob.memory.context_pack"


def build_request_envelope(
    *,
    msg_id: str,
    ts: str,
    sender: str,
    correlation_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Build the fleet ``Envelope`` wire dict for a context-pack request.

    The id and timestamp are CALLER-SUPPLIED (never generated here) so the
    library never touches ``time``/``random`` at import and stays deterministic
    under test — matching fleet-nats's own contract.

    Uses fleet-nats's real ``Envelope`` when importable (byte-for-byte wire
    parity); otherwise builds the identical local mirror.

    Args:
        msg_id: Unique message id (e.g. a uuid4 hex).
        ts: ISO-8601 UTC timestamp string.
        sender: The publisher identity (fleet ``from`` field).
        correlation_id: Links the reply back to this request.
        payload: Kind-specific body (OB identity + request body live here).
    """
    if FLEET_NATS_AVAILABLE and _FleetEnvelope is not None:  # pragma: no cover
        envelope = _FleetEnvelope.new(
            msg_id=msg_id,
            ts=ts,
            sender=sender,
            kind=CONTEXT_PACK_REQUEST_KIND,
            payload=payload,
            correlation_id=correlation_id,
        )
        wire = json.loads(envelope.to_bytes())
        assert isinstance(wire, dict)
        return wire
    return _local_envelope_wire(
        msg_id=msg_id,
        ts=ts,
        sender=sender,
        correlation_id=correlation_id,
        payload=payload,
    )


def envelope_to_wire_bytes(envelope: dict[str, Any]) -> bytes:
    """Serialise a fleet Envelope wire dict to canonical compact UTF-8 JSON bytes.

    Mirrors ``fleet_nats.Envelope.to_bytes`` (probed 2026-07-08): compact
    separators (``,``/``:``, no spaces) and NO key sorting, so the dict's
    insertion order (fleet field order: id, ts, from, kind, payload, to,
    task_id, channel, topic, correlation_id, version) is preserved. Optional
    envelope fields are emitted explicitly as ``null`` because
    :func:`build_request_envelope` already sets them to ``None``. This is the
    byte-for-byte contract the shared cross-language wire fixture locks; TS and
    Python must produce identical bytes for the same envelope.
    """
    return json.dumps(envelope, separators=(",", ":")).encode("utf-8")


def _local_envelope_wire(
    *,
    msg_id: str,
    ts: str,
    sender: str,
    correlation_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Local mirror of ``fleet_nats.Envelope.to_bytes`` shape (probed 2026-07-08).

    Kept 1:1 with the fleet ``Envelope`` wire body so a locally-built request is
    indistinguishable from one built by the real library.
    """
    if not msg_id:
        raise ValueError("Envelope.id must be non-empty")
    if not sender:
        raise ValueError("Envelope.sender must be non-empty")
    return {
        "id": msg_id,
        "ts": ts,
        "from": sender,
        "kind": CONTEXT_PACK_REQUEST_KIND,
        "payload": payload,
        "to": None,
        "task_id": None,
        "channel": None,
        "topic": None,
        "correlation_id": correlation_id,
        "version": _FLEET_ENVELOPE_VERSION,
    }
