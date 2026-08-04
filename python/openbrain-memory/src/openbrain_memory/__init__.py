"""
openbrain_memory - the Python client for Open Brain.

Purpose:
    The durable-memory client every Python agent runtime speaks through. It
    owns the wire contract with the Open Brain server, the first-class memory
    lifecycle (recall, reflex, capture, ingest, checkpoint, wrap), and the
    local spool that keeps a write from being lost when the server is
    unreachable.

Architecture:
    Layered, with each layer depending only on the one beneath it.

    ``client`` holds the transport and the contract: ``OpenBrainClient`` speaks
    MCP tool calls over HTTP, with a NATS transport alongside it for fleet
    deployments. Contract version and schema hash are pinned here so a client
    and server that disagree fail loudly rather than silently mis-parsing.

    ``runtime`` is the first-class boundary. ``FirstClassMemoryRuntime`` turns
    a lifecycle verb into a call plus a ``RuntimeReceipt`` that states whether
    the write became durable. Reads never spool and never fall back; writes may.

    ``spool`` is the durability floor. A write that cannot reach the server is
    appended to a JSONL spool and replayed later by the maintenance handler,
    so an unreachable server degrades throughput rather than losing content.

    ``cli`` adapts one JSON envelope on stdin to one lifecycle call, which is
    how non-Python runtimes drive it.

Key Components:
    - OpenBrainClient: transport and tool dispatch; HTTP and NATS
    - FirstClassMemoryRuntime: the lifecycle verbs and their receipts
    - RuntimeReceipt: whether a write is durable, and why it is not
    - JsonlSpool: append-and-replay durability for unreachable writes
    - MaintenanceRegistry: idempotent background handlers, including replay
    - DreamEngine: dream planning, dry-run by default
    - redact_text / redact_value: the redaction boundary for every error path
    - Protocol classes (MemoryClient, Transport, DirectClient, ...): named
      contracts that let implementations vary without callers changing

Pattern/Convention:
    Contracts are ``Protocol`` classes, declared once and implemented behind.
    Prefer adding an implementation of an existing Protocol over adding a new
    call shape.

    Every error crossing the package boundary passes through ``redact_text``.
    A raw exception carries request, config, and client state, which is how
    credentials leak into logs.

    Dream planning is dry-run by default. No archive, promote, demote, or tier
    mutation runs from planning unless the caller opts into a mutating wrapper.

Example:
    >>> from openbrain_memory import FirstClassMemoryRuntime, RuntimeConfig
    >>> from openbrain_memory import RuntimeScope
    >>> runtime = FirstClassMemoryRuntime(
    ...     RuntimeConfig.from_sources({}, environ=env),
    ...     RuntimeScope.from_mapping({"namespace": "rico"}),
    ... )
    >>> output = runtime.capture_distilled("a decision worth keeping")
    >>> output.receipt.durable
    True

See Also:
    - ``docs/memory-contract.md`` - the durable memory protocol
    - ``docs/downstream-rollout.md`` - what a contract change obliges
    - ``openbrain_provider`` - the runtime lifecycle provider that calls this
"""

from __future__ import annotations

from .agent import (
    EVENT_TYPES,
    AgentMemory,
    MemoryClient,
    MemoryContext,
    MemoryItem,
    MemoryPolicy,
    MemorySpool,
    unsupported_event_type,
)
from .client import (
    COMPATIBLE_CONTRACT_VERSIONS,
    CURRENT_CONTRACT_HEADER,
    CURRENT_CONTRACT_SCHEMA_HASH,
    CURRENT_CONTRACT_SCHEMA_VERSION,
    CURRENT_CONTRACT_VERSION,
    CURRENT_TOOL_HELP,
    DEFAULT_NATS_CONTEXT_PACK_SUBJECT,
    DEFAULT_NATS_ENV,
    PACKAGE_VERSION,
    REQUIRED_CONTRACT_TOOLS,
    FleetNatsDriver,
    NatsRequestReplyDriver,
    NatsTransport,
    OpenBrainClient,
    OpenBrainError,
    OpenBrainHTTPError,
    OpenBrainProtocolError,
    OpenBrainToolError,
    OpenBrainTransportUnavailableError,
    RealtimeTransportAvailability,
)
from .contract import (
    ContractValidationResult,
    validate_contract_manifest,
    validate_required_memory_contract,
)
from .dream import DreamAction, DreamClient, DreamEngine, DreamPolicy, DreamRun
from .maintenance import (
    SPOOL_REPLAY_JOB_KIND,
    MaintenanceHandler,
    MaintenanceRegistry,
    MaintenanceRegistryError,
    MaintenanceScheduler,
    SpoolReplayMaintenanceHandler,
)
from .policy import RetryExhaustedError, RetryPolicy, redact_text, redact_value
from .runtime import (
    DrainReport,
    FirstClassMemoryRuntime,
    ReceiptStatus,
    RuntimeConfig,
    RuntimeOutput,
    RuntimeReceipt,
    RuntimeScope,
)
from .schema import (
    ContractSchemaError,
    contract_field_to_json_schema,
    contract_input_to_json_schema,
    tool_contract_to_input_schema,
    tool_contracts_to_tool_schemas,
)
from .spool import (
    JsonlSpool,
    SpoolRecord,
    SpoolReplayReport,
    SpoolStatus,
    SpoolUnitOutcome,
    SpoolUnitRetained,
    replay_records,
)
from .turn_concepts import (
    DEFAULT_MAX_KEYS,
    TurnConcepts,
    extract_turn_concepts,
)

__all__ = [
    "EVENT_TYPES",
    "AgentMemory",
    "DEFAULT_MAX_KEYS",
    "TurnConcepts",
    "extract_turn_concepts",
    "DreamAction",
    "DreamClient",
    "DreamEngine",
    "DreamPolicy",
    "DreamRun",
    "MaintenanceHandler",
    "MaintenanceRegistry",
    "MaintenanceRegistryError",
    "MaintenanceScheduler",
    "MemoryClient",
    "MemoryContext",
    "MemoryItem",
    "MemoryPolicy",
    "MemorySpool",
    "OpenBrainClient",
    "OpenBrainError",
    "OpenBrainHTTPError",
    "OpenBrainProtocolError",
    "OpenBrainToolError",
    "PACKAGE_VERSION",
    "COMPATIBLE_CONTRACT_VERSIONS",
    "CURRENT_CONTRACT_HEADER",
    "CURRENT_CONTRACT_SCHEMA_HASH",
    "CURRENT_CONTRACT_SCHEMA_VERSION",
    "CURRENT_CONTRACT_VERSION",
    "CURRENT_TOOL_HELP",
    "DEFAULT_NATS_CONTEXT_PACK_SUBJECT",
    "DEFAULT_NATS_ENV",
    "REQUIRED_CONTRACT_TOOLS",
    "ContractValidationResult",
    "ContractSchemaError",
    "DrainReport",
    "FirstClassMemoryRuntime",
    "FleetNatsDriver",
    "JsonlSpool",
    "NatsRequestReplyDriver",
    "NatsTransport",
    "ReceiptStatus",
    "RetryExhaustedError",
    "RetryPolicy",
    "RealtimeTransportAvailability",
    "RuntimeConfig",
    "RuntimeOutput",
    "RuntimeReceipt",
    "RuntimeScope",
    "SPOOL_REPLAY_JOB_KIND",
    "SpoolReplayMaintenanceHandler",
    "SpoolRecord",
    "SpoolReplayReport",
    "SpoolStatus",
    "SpoolUnitOutcome",
    "SpoolUnitRetained",
    "contract_field_to_json_schema",
    "contract_input_to_json_schema",
    "OpenBrainTransportUnavailableError",
    "redact_text",
    "redact_value",
    "replay_records",
    "tool_contract_to_input_schema",
    "tool_contracts_to_tool_schemas",
    "unsupported_event_type",
    "validate_contract_manifest",
    "validate_required_memory_contract",
]
