"""Fleet-bus wire shapes for Open Brain's NATS transport.

Open Brain's realtime memory transport is a thin consumer of ``fleet-nats``
(``git@github.com:rodaddy/fleet-bus.git``, ``packages/fleet-nats``): the
canonical NATS transport + coordination library for the fleet. Rather than
reimplement the wire contract, we reuse fleet-nats's :class:`Envelope` and its
subject-slug convention.

fleet-nats is NOT published on PyPI and lives in a private monorepo
subdirectory, so it is NOT a normal installable dependency for this
lightweight client. We therefore import it *optionally*: if ``fleet_nats`` is
importable we defer to it; otherwise we fall back to a LOCAL mirror of the same
shape. The mirror is kept in sync with ``packages/fleet-nats`` (probed
2026-08-04 against fleet-bus ``2b20f97``). If the fleet contract changes, update
both — :mod:`tests.test_nats_wire_drift` fails when the clone is present and
this mirror has aged.

SUBJECT — upstream now owns it. fleet-bus ``2b20f97`` (2026-07-28) added
``fleet_nats.subjects.ob_context_pack(env)``, declaring the ``ob`` domain
Open-Brain-owned and fulfilling this module's former TODO. When ``fleet_nats``
is importable :func:`build_context_pack_subject` calls that builder directly and
NO local subject construction happens on that path — the subject tree is owned
by one library, which is the design this module always stated. The local mirror
survives only for environments without fleet-nats. Note that upstream renamed
``_slug`` to the public ``slug`` and added a ``>`` (NATS multi-token wildcard)
rejection; the local mirror carries both.

ENVELOPE — deliberately NOT delegated, unlike the subject. Upstream moved
``Envelope`` to ``fleet_core.spec`` and its ``to_bytes`` now emits two ADDITIONAL
wire keys, ``act`` and ``state`` (fleet's A2A/FIPA coordination fields), which
the pre-2b20f97 shape this transport's locked cross-language fixture encodes
does not contain. Calling the real ``Envelope.to_bytes`` would therefore put the
fleet path and the TS mirror (``src/nats-runtime.ts``) on DIFFERENT bytes for the
same message, breaking the byte-for-byte contract in
``tests/fixtures/nats-context-pack-wire.json`` — the exact drift that fixture
exists to catch. Until OB and the TS mirror adopt ``act``/``state`` together, the
envelope is built locally on BOTH paths so the wire is identical regardless of
whether fleet-nats happens to be installed. :data:`FLEET_NATS_AVAILABLE` records
importability for diagnostics; it no longer selects an envelope builder.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

# Kind constant for the OB memory context-pack request on the fleet bus.
CONTEXT_PACK_REQUEST_KIND = "context_pack_request"

# Mirror of fleet_core.spec.ENVELOPE_VERSION, re-exported as
# fleet_nats.envelope.ENVELOPE_VERSION (probed 2026-08-04 @ 2b20f97). Kept in
# sync so a locally-built envelope carries the version the fleet expects.
_FLEET_ENVELOPE_VERSION = 1

# The upstream subject builder, when the real library is importable. This is
# the ONLY fleet-nats symbol the transport delegates to; see the module
# docstring for why the envelope stays local on both paths.
_fleet_ob_context_pack: Callable[[str], str] | None
try:  # pragma: no cover - import availability is environment-specific
    from fleet_nats.subjects import (  # type: ignore[import-not-found]
        ob_context_pack as _imported_ob_context_pack,
    )

    _fleet_ob_context_pack = _imported_ob_context_pack
    FLEET_NATS_AVAILABLE = True
except Exception:  # pragma: no cover - fleet-nats optional / not installed
    _fleet_ob_context_pack = None
    FLEET_NATS_AVAILABLE = False


def _local_slug(value: str) -> str:
    """Local mirror of ``fleet_nats.subjects.slug`` (probed 2026-08-04 @ 2b20f97).

    Normalise a subject token: lowercased, spaces/dots to hyphens, no empties.
    A whitespace-only token would otherwise produce an invalid NATS subject
    like ``dev.ob..context_pack`` that the server rejects (message lost).

    ``>`` is REJECTED rather than normalised (upstream fleet-bus #222): it is the
    NATS multi-token wildcard and never a legitimate single token. Left through,
    an env token sourced from untrusted input turns into subject-token injection
    — ``{env}`` of ``>`` yields ``>.ob.memory.context_pack``, which subscribes
    across the whole tree. ``*`` is deliberately NOT rejected: it is how callers
    build single-token authorization grant patterns, and it cannot widen a
    subject beyond one token.
    """
    slug = value.strip().lower().replace(" ", "-").replace(".", "-")
    if not slug:
        raise ValueError(f"subject token normalises to empty: {value!r}")
    if ">" in slug:
        raise ValueError(
            "subject token may not contain the NATS multi-token wildcard "
            f"'>': {value!r}"
        )
    return slug


def build_context_pack_subject(env: str) -> str:
    """Build the OB memory context-pack subject ``{env}.ob.memory.context_pack``.

    Delegates to ``fleet_nats.subjects.ob_context_pack`` when fleet-nats is
    importable — upstream owns the ``ob`` domain as of fleet-bus ``2b20f97``, so
    on that path this function constructs NO subject text of its own. Without
    fleet-nats it falls back to the local mirror of the same shape: the fleet
    convention ``{env}.{domain}.{...}`` with the env token slugged. Only the env
    token is caller-controlled; the ``ob.memory.context_pack`` tail is a fixed,
    already-normalised literal (note the UNDERSCORE, which keeps it
    byte-identical to the pre-fleet flat subject minus the env prefix).
    """
    if _fleet_ob_context_pack is not None:  # pragma: no cover - needs fleet-nats
        return _fleet_ob_context_pack(env)
    return f"{_local_slug(env)}.ob.memory.context_pack"


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

    Built from the LOCAL mirror on every path, including when fleet-nats is
    importable. Upstream's ``Envelope.to_bytes`` gained ``act``/``state`` keys
    after this transport's cross-language wire fixture was locked, so delegating
    here would make the bytes depend on whether fleet-nats happens to be
    installed and would diverge from the TS mirror. See the module docstring.

    Args:
        msg_id: Unique message id (e.g. a uuid4 hex).
        ts: ISO-8601 UTC timestamp string.
        sender: The publisher identity (fleet ``from`` field).
        correlation_id: Links the reply back to this request.
        payload: Kind-specific body (OB identity + request body live here).
    """
    return _local_envelope_wire(
        msg_id=msg_id,
        ts=ts,
        sender=sender,
        correlation_id=correlation_id,
        payload=payload,
    )


def envelope_to_wire_bytes(envelope: dict[str, Any]) -> bytes:
    """Serialise a fleet Envelope wire dict to canonical compact UTF-8 JSON bytes.

    Mirrors ``fleet_nats.Envelope.to_bytes`` (probed 2026-08-04 @ 2b20f97, minus
    the post-lock ``act``/``state`` keys — see the module docstring): compact
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
    """Local mirror of the fleet ``Envelope`` wire body (probed 2026-08-04 @ 2b20f97).

    Kept 1:1 with the fleet ``Envelope`` wire body as of the shape this
    transport's cross-language fixture locks. Upstream has since added the
    ``act``/``state`` coordination keys; they are intentionally absent here so
    both languages stay on one wire (module docstring, ENVELOPE section).
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
