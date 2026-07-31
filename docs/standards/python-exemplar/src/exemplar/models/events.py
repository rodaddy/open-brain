"""Models for inbound webhook events. Untrusted input, validated at the edge.

Everything here describes data that arrived over the network from someone else.
That is the defining property, and it drives every choice in this file: the
strictness, the size caps, the closed enum, and the refusal to accept unknown
fields.

WHY VALIDATION AT THE EDGE AND NOT AT USE
    A payload validated once, at the boundary, is a known shape everywhere
    downstream. A payload passed around as ``dict[str, Any]`` and checked at
    each use is checked slightly differently at each use, and the handler
    written last is the one that forgets.

    This is also the security boundary. Size caps and a closed event-kind set
    are cheap here and impossible to retrofit once a raw dict has been handed to
    three handlers.

See Also:
    - exemplar.apps.hook.router: dispatches on HookEventKind
    - _DOCS/STANDARDS-python.md ## Error handling
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from exemplar.utils.datetime_helpers import utc_now

#: Cap on the free-form payload. A webhook sender can post anything; without a
#: cap, a single large body is an out-of-memory condition. Enforced here as a
#: field constraint AND at the HTTP layer, because by the time this model runs
#: the bytes are already in memory -- this is the second line, not the first.
MAX_PAYLOAD_KEYS = 100

#: Cap on any single string value inside the payload.
MAX_VALUE_LENGTH = 10_000


class HookEventKind(StrEnum):
    """Event kinds this application knows how to handle.

    A closed set, deliberately. An unknown kind is rejected at validation with a
    message naming what IS accepted, rather than being routed to a handler that
    does not exist or silently dropped.

    Adding a kind is two edits -- a member here and an entry in the router's
    dispatch table -- and forgetting the second is caught by a test that asserts
    every member has a handler.
    """

    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"
    PING = "ping"


class HookEvent(BaseModel):
    """A validated inbound webhook event.

    Frozen: an event is a record of something that was reported to have
    happened. Handlers derive new values from it; none of them edits it.
    """

    model_config = ConfigDict(
        frozen=True,
        # Reject unknown top-level fields rather than ignoring them. A sender
        # that adds a field we do not model is a contract change, and finding
        # out at validation beats finding out when a handler silently misses it.
        extra="forbid",
    )

    #: Sender-supplied unique id. The basis of idempotency: the same id
    #: delivered twice is one event. Webhook senders retry on timeout, so
    #: duplicate delivery is normal operation, not an error case.
    event_id: str = Field(min_length=1, max_length=200)

    kind: HookEventKind

    #: When the SENDER says it happened. Distinct from received_at, and not
    #: trusted for ordering -- a sender's clock is not ours.
    occurred_at: datetime

    #: When WE received it. Set by us, so it is trustworthy and is what
    #: ordering and retention actually use.
    received_at: datetime = Field(default_factory=utc_now)

    #: Free-form body. Typed as Any because the shape genuinely varies by kind
    #: and by sender; constrained by the validators below rather than by type.
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("occurred_at")
    @classmethod
    def _must_be_timezone_aware(cls, value: datetime) -> datetime:
        """Reject a naive timestamp from the sender.

        Fires often in practice: many senders emit ISO strings with no offset.
        Rejecting is correct -- guessing a zone for someone else's timestamp
        produces a value that is wrong by hours and looks fine.
        """
        if value.tzinfo is None:
            msg = (
                "occurred_at must include a timezone offset. "
                "ACTION REQUIRED: the sender must emit ISO 8601 with an offset, "
                "e.g. 2026-07-30T15:04:05+00:00."
            )
            raise ValueError(msg)
        return value

    @field_validator("payload")
    @classmethod
    def _payload_within_limits(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Bound the payload's key count and string sizes.

        Two separate limits because they fail differently: many small keys
        exhaust memory through dict overhead, while one enormous string exhausts
        it directly. A cap on only one leaves the other open.
        """
        if len(value) > MAX_PAYLOAD_KEYS:
            msg = (
                f"payload has {len(value)} keys, limit is {MAX_PAYLOAD_KEYS}. "
                f"ACTION REQUIRED: the sender should post a reference, not a "
                f"whole document."
            )
            raise ValueError(msg)

        for key, item in value.items():
            if isinstance(item, str) and len(item) > MAX_VALUE_LENGTH:
                msg = (
                    f"payload[{key!r}] is {len(item)} characters, limit is "
                    f"{MAX_VALUE_LENGTH}. "
                    f"ACTION REQUIRED: the sender should post a reference to "
                    f"large content, not the content."
                )
                raise ValueError(msg)

        return value

    @property
    def dedupe_key(self) -> str:
        """Key used to recognise a redelivery of this same event.

        Kind is included alongside the id because some senders reuse an id
        across kinds -- an object's create and update events sharing the object
        id. Deduping on id alone would silently drop the update.
        """
        return f"{self.kind.value}:{self.event_id}"
