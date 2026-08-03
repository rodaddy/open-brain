"""The exact shapes the TypeScript gate expects to find in ``receipts.json``.

Purpose:
    Every field name, literal value, and enum member here is copied from
    ``_ob/scripts/ob-memory-provider/receipt-state.ts``. The gate does not
    negotiate: it filters candidate receipts on ``contract``,
    ``contractSchemaVersion``, ``contractSchemaHash``, ``mode``, ``trigger``, and
    ``fallbackAttempted`` (``receipt-state.ts`` ``findFreshReceipt``), so a
    receipt that differs in any one of them is silently skipped and the gate
    stays blocked.

Architecture:
    pydantic models with ``alias_generator`` doing the camelCase translation.
    The Python attribute names stay snake_case, as the rest of the package is;
    the SERIALISED names are camelCase, as TypeScript wrote them. Declaring the
    mapping once on the model beats writing a hand-maintained field-name table,
    which is the shape that drifts.

Pattern/Convention:
    THE CONTRACT TRIPLE IS NOT A PARAMETER. ``contract``,
    ``contract_schema_version``, and ``contract_schema_hash`` are fixed defaults
    that no caller may set: they identify WHICH memory-tools contract produced
    the receipt, and a caller that could vary them could write a receipt claiming
    a contract it does not implement. The TypeScript writer treats them the same
    way -- ``recordProviderReceipt`` takes an ``Omit<..., "contract" | ...>`` and
    fills them itself.

    Likewise ``fallback_attempted`` is the literal ``False``. The gate rejects any
    receipt where it is not exactly ``false``: the field records that no
    second-choice write path was used, so a durable receipt earned through a
    fallback is not evidence of the direct write the gate is waiting for.

See Also:
    - ``openbrain.receipts.state`` - the file this shape is written into
    - ``_ob/scripts/ob-memory-provider/receipt-state.ts`` - the specification
"""

from __future__ import annotations

from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

#: The ``schema`` literal at the top of the file. The TypeScript reader compares
#: it exactly and returns an EMPTY state on any mismatch, so a wrong value here
#: does not corrupt the gate -- it silently erases every receipt in the file from
#: the gate's view (``receipt-state.ts`` ``loadReceiptState``).
RECEIPT_STATE_SCHEMA: Final = "development.openbrain-memory-receipts.v1"

#: Which memory-tools contract produced a receipt. Part of the triple the gate
#: filters on; a receipt naming a different contract is skipped.
#:
#: Typed ``Final`` rather than left to inference so it stays a ``Literal`` and can
#: BE the model field's default. Inferred as a plain ``str`` it could not, and the
#: constant and the field would drift into two independent copies of the same
#: value -- exactly the split this triple exists to detect.
MEMORY_CONTRACT: Final = "2026-07-23.memory-tools.v23"

#: The contract's schema version, filtered on alongside :data:`MEMORY_CONTRACT`.
MEMORY_CONTRACT_SCHEMA_VERSION: Final = 1

#: The contract's schema hash, filtered on alongside :data:`MEMORY_CONTRACT`.
#: A literal, never recomputed here: it identifies the TypeScript-side contract
#: definition, and deriving it locally would let the two sides drift apart while
#: both looked self-consistent.
MEMORY_CONTRACT_SCHEMA_HASH: Final = (
    "4b69e9b437c96175531b049b6e3c2782f383334e9e1931e96e73835599e4a4a8"
)

#: What the receipt is evidence OF. ``recall`` is a read; the other three are
#: writes. The gate asks for different sets depending on which block it is
#: clearing (``context-budget-gate-state.ts``: capture clears on any of
#: capture/checkpoint/wrap, the post-compaction read-back clears only on recall).
ReceiptOperation = Literal["recall", "capture", "checkpoint", "wrap"]

#: How well the operation went, in the only three grades the gate distinguishes.
#: ``verified-remote`` means the service accepted it directly; ``durable-spool``
#: means it is queued on disk and will survive; ``failed`` is neither and never
#: unblocks anything.
ReceiptMode = Literal["verified-remote", "durable-spool", "failed"]

#: The raw outcome the transport reported, before :func:`receipt_mode` grades it.
ReceiptStatus = Literal["direct", "saved", "spooled", "failed", "lost"]

#: What caused the operation. ``compact`` is the one the post-compaction
#: read-back requires: ``recordProviderReceipt`` sets a cycle's
#: ``verifiedRecallAt`` only for a ``recall``/``compact``/``verified-remote``
#: receipt, and that timestamp is the whole unblock.
ReceiptTrigger = Literal[
    "compact", "pre-compact", "post-compact", "session-end", "explicit"
]

#: Which lifecycle hook joined a compaction cycle. ``gate`` is the TypeScript
#: gate itself, which opens a cycle when no hook has.
CompactCycleParticipant = Literal[
    "pre-compact", "post-compact", "session-start", "gate"
]


class _CamelModel(BaseModel):
    """Serialise as the TypeScript writer did: camelCase keys, no extra fields.

    ``populate_by_name`` lets Python construct with snake_case attribute names
    while ``by_alias=True`` dumps camelCase, so the two sides of the file agree
    without either language writing the other's naming convention by hand.
    ``extra="allow"`` on the reading path is deliberately NOT set here: these
    models are what Python WRITES, and writing a field the gate does not know
    about is how a shared file grows junk.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )


class ProviderReceiptEvidence(_CamelModel):
    """One durable-memory operation's receipt, in the gate's exact shape.

    Attributes:
        operation: What the receipt is evidence of.
        mode: The graded outcome -- see :func:`receipt_mode`, which is the only
            correct way to derive it.
        status: The raw transport outcome the mode was graded from.
        project: The Development project slug the session was working in. The
            gate filters on this, so a receipt filed under the wrong slug is
            invisible to it even when everything else matches.
        session_id: The Claude Code session id.
        trigger: What caused the operation.
        direct_attempted: Whether the direct (non-spool) path was tried. A
            ``recall`` receipt is only ``verified-remote`` when it was.
        recorded_at: When the operation completed, ISO-8601 with an explicit UTC
            offset. Every freshness window the gate applies is measured from
            here, so a naive or local-time value silently ages the receipt.
        correlation_id: The compaction cycle this belongs to, when it belongs to
            one. It must equal the cycle's ``id`` for the read-back to clear.
        fallback_attempted: Always ``False``, never settable.
        contract: Always :data:`MEMORY_CONTRACT`, never settable.
        contract_schema_version: Always
            :data:`MEMORY_CONTRACT_SCHEMA_VERSION`, never settable.
        contract_schema_hash: Always :data:`MEMORY_CONTRACT_SCHEMA_HASH`, never
            settable.
    """

    operation: ReceiptOperation
    mode: ReceiptMode
    status: ReceiptStatus
    project: str
    session_id: str
    trigger: ReceiptTrigger
    direct_attempted: bool
    recorded_at: str
    correlation_id: str | None = None

    # The four constants below are what the gate filters on to decide a receipt
    # was written by something implementing the contract it expects. They are
    # declared as single-value Literals so a caller CANNOT vary them: passing a
    # different value is a validation error, not a receipt that lies.
    fallback_attempted: Literal[False] = False
    contract: Literal["2026-07-23.memory-tools.v23"] = MEMORY_CONTRACT
    contract_schema_version: Literal[1] = MEMORY_CONTRACT_SCHEMA_VERSION
    contract_schema_hash: Literal[
        "4b69e9b437c96175531b049b6e3c2782f383334e9e1931e96e73835599e4a4a8"
    ] = MEMORY_CONTRACT_SCHEMA_HASH

    def trigger_key(self) -> str:
        """The key this receipt is filed under in ``triggerReceipts``.

        Returns:
            ``"<operation>:<trigger>:<correlationId or 'uncorrelated'>"``, the
            join ``recordProviderReceipt`` builds (``receipt-state.ts``). The
            literal ``"uncorrelated"`` is part of the format, not a placeholder:
            an uncorrelated receipt of the same operation and trigger must
            overwrite the previous uncorrelated one rather than accumulate.
        """
        correlation = self.correlation_id or "uncorrelated"
        return f"{self.operation}:{self.trigger}:{correlation}"


class CompactCycleEvidence(_CamelModel):
    """One compaction, and which lifecycle hooks took part in it.

    A compaction spans several hook invocations in different processes:
    ``PreCompact`` before the context is discarded, ``PostCompact`` after the
    summary exists, and ``SessionStart`` when the harness reopens. This record is
    what gives all of them ONE identity, so the gate can require that the recall
    it is waiting for belongs to THIS compaction rather than an older one.

    Attributes:
        id: The correlation id, a UUID4. A receipt's ``correlation_id`` must
            equal this for the read-back to clear.
        project: The Development project slug.
        session_id: The Claude Code session id, which is also this cycle's key in
            the file.
        started_at: When the cycle was opened, ISO-8601 with a UTC offset. The
            gate treats a cycle older than its window as absent.
        participants: The hooks that SUCCEEDED -- appended by
            :func:`~openbrain.receipts.state.record_provider_receipt` when a
            non-failed receipt arrives carrying this cycle's id.
        attempted_participants: The hooks that RAN, successful or not. Kept apart
            from ``participants`` because the TypeScript writer decides whether a
            repeat invocation opens a NEW cycle from this list -- a second
            ``pre-compact`` attempt means a second compaction, not a retry.
        verified_recall_at: When a ``recall``/``compact``/``verified-remote``
            receipt named this cycle. This single field is what clears the gate's
            post-compaction read-back block.
    """

    id: str
    project: str
    session_id: str
    started_at: str
    participants: list[CompactCycleParticipant] = Field(default_factory=list)
    attempted_participants: list[CompactCycleParticipant] = Field(
        default_factory=list
    )
    verified_recall_at: str | None = None

    # These lists are REPLACED, never appended to in place: the model is frozen
    # so a participant is added by rebuilding the record with `model_copy`.
    # Mutating a shared list is how two hook processes reading the same state end
    # up writing each other's participants.
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )

    def with_participant(
        self, participant: CompactCycleParticipant, *, attempted: bool
    ) -> CompactCycleEvidence:
        """Return this cycle with ``participant`` recorded, or itself unchanged.

        Args:
            participant: The hook to record.
            attempted: ``True`` to record it in ``attempted_participants`` (it
                ran), ``False`` to record it in ``participants`` (it succeeded).

        Returns:
            A new cycle carrying the participant, or ``self`` when it is already
            listed -- the lists are sets by intent, and the TypeScript writer
            guards the same way before appending.
        """
        current = self.attempted_participants if attempted else self.participants
        if participant in current:
            return self

        field = "attempted_participants" if attempted else "participants"
        return self.model_copy(update={field: [*current, participant]})


def receipt_mode(
    operation: ReceiptOperation,
    status: ReceiptStatus,
    *,
    durable: bool,
    direct_attempted: bool,
    fallback_attempted: bool,
) -> ReceiptMode:
    """Grade a raw transport outcome into the mode the gate filters on.

    Args:
        operation: What was attempted.
        status: What the transport reported.
        durable: Whether the write is known to survive this process -- accepted
            by the service, or committed to the on-disk spool.
        direct_attempted: Whether the direct path was tried at all.
        fallback_attempted: Whether a second-choice path was used.

    Returns:
        ``verified-remote`` when the service itself took it, ``durable-spool``
        when it is queued and will survive, ``failed`` otherwise.

    This is a straight port of ``receiptMode`` in ``receipt-state.ts`` and must
    stay one. The grading is the honesty of the receipt: it is what stops a
    spooled or failed write from reading as the verified one the gate is waiting
    for. In particular a ``recall`` can never be ``durable-spool`` -- a read that
    did not reach the service returned nothing, so there is no such thing as a
    queued recall.

    Example:
        >>> receipt_mode("recall", "direct", durable=False,
        ...              direct_attempted=True, fallback_attempted=False)
        'verified-remote'
        >>> receipt_mode("capture", "spooled", durable=True,
        ...              direct_attempted=True, fallback_attempted=False)
        'durable-spool'
        >>> receipt_mode("capture", "saved", durable=True,
        ...              direct_attempted=True, fallback_attempted=True)
        'failed'
    """
    if fallback_attempted:
        return "failed"

    if operation == "recall":
        return "verified-remote" if status == "direct" and direct_attempted else "failed"

    if status == "saved" and durable and direct_attempted:
        return "verified-remote"

    if status == "spooled" and durable:
        return "durable-spool"

    return "failed"
