# openbrain_memory

<!-- generated from __init__.py -- do not edit by hand -->

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

---

Generated from the module docstring in `__init__.py`. To change this
file, edit that docstring and run
`python scripts/pytools/generate_package_docs.py --write`.
