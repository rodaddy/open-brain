"""The gate's unblock state, written from Python instead of only read from TypeScript.

Purpose:
    A live TypeScript hook -- ``_ob/scripts/context-budget-gate.ts``, registered
    on six Claude Code events -- blocks task mutation after a compaction until it
    finds a fresh receipt in a shared JSON file. Before this package, only
    TypeScript could write that file, and the #420 settings cutover removed every
    hook registration that invoked the TypeScript writer. The reader stayed
    registered; its writers did not. This package is the missing half: the Python
    hooks that now own the lifecycle write the receipts the TypeScript gate reads.

Architecture:
    Four modules, one job each.

        ``evidence``   the shapes -- what a receipt and a compact cycle ARE
        ``state``      the file -- how they are read, merged, locked, and written
        ``filelock``   the cross-language advisory lock the write protocol needs
        ``scope``      which project slug a hook's ``cwd`` files receipts under

    The split is the boundary between "what the gate expects to find" and "how
    two languages share one file without corrupting it". A change to the schema
    touches only ``evidence``; a change to the write protocol touches only
    ``state``.

    ``scope`` is separate because it is the part with no JSON in it and the part
    most easily got wrong: the gate filters receipts by project slug, so a slug
    derived any other way produces a valid receipt filed where nothing looks for
    it.

Pattern/Convention:
    THE TYPESCRIPT MODULE IS THE SPECIFICATION, not a reference implementation to
    improve on. ``_ob/scripts/ob-memory-provider/receipt-state.ts`` defines the
    file's path, its schema literal, every field name and value, the freshness
    windows the reader applies, the advisory lock protocol, and the atomic-replace
    write. Python reproduces all of it byte-for-byte. Where a Python idiom would
    differ from the TypeScript behaviour, the TypeScript behaviour wins -- an
    "improvement" here is a file the gate cannot read, which fails CLOSED into a
    session that can no longer edit or commit.

    That is also why this does not reach for a storage library the way
    ``apps.capture.watermark`` reaches for SQLite. Watermarks are ours end to end;
    receipts are shared, and the solved problem was solved by the TypeScript
    module. Any other engine would be a different protocol and would not
    interoperate.

See Also:
    - ``_ob/scripts/ob-memory-provider/receipt-state.ts`` - the specification
    - ``_ob/scripts/context-budget-gate-state.ts`` - the reader that unblocks
    - ``_plans/issues/415-prov-6-receipt-construction-and-receipt-state.md``
"""

from __future__ import annotations

from openbrain.receipts.evidence import (
    MEMORY_CONTRACT,
    MEMORY_CONTRACT_SCHEMA_HASH,
    MEMORY_CONTRACT_SCHEMA_VERSION,
    RECEIPT_STATE_SCHEMA,
    CompactCycleEvidence,
    CompactCycleParticipant,
    ProviderReceiptEvidence,
    ReceiptMode,
    ReceiptOperation,
    ReceiptStatus,
    ReceiptTrigger,
    receipt_mode,
)
from openbrain.receipts.scope import (
    DevelopmentScope,
    resolve_development_scope,
)
from openbrain.receipts.state import (
    ReceiptStateError,
    attach_compact_cycle,
    default_receipt_state_path,
    ensure_compact_cycle,
    open_compact_cycle,
    record_provider_receipt,
    start_compact_cycle,
)

__all__ = [
    "MEMORY_CONTRACT",
    "MEMORY_CONTRACT_SCHEMA_HASH",
    "MEMORY_CONTRACT_SCHEMA_VERSION",
    "RECEIPT_STATE_SCHEMA",
    "CompactCycleEvidence",
    "CompactCycleParticipant",
    "DevelopmentScope",
    "ProviderReceiptEvidence",
    "ReceiptMode",
    "ReceiptOperation",
    "ReceiptStateError",
    "ReceiptStatus",
    "ReceiptTrigger",
    "attach_compact_cycle",
    "default_receipt_state_path",
    "ensure_compact_cycle",
    "open_compact_cycle",
    "receipt_mode",
    "record_provider_receipt",
    "resolve_development_scope",
    "start_compact_cycle",
]
