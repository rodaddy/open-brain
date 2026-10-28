"""openbrain_provider - the runtime lifecycle provider for Open Brain.

Purpose:
    The adapter an agent runtime invokes at session start, capture, checkpoint,
    and reflex. It is the Python replacement for the TypeScript
    ``ob-memory-provider.ts``, and it is the layer that decides what a runtime
    is allowed to send and what it gets back.

    This boundary matters more than its size suggests: the TypeScript adapter
    it replaces silently discarded captures it judged oversized, returning exit
    code 0 and no receipt. A provider that cannot say "this did not persist" is
    worse than one that fails.

Architecture:
    A thin, layered adapter. ``config`` loads and validates provider settings
    once, at start, and hands every other module a typed object rather than
    letting each read the environment for itself. ``observability`` establishes
    the logger at the same point, so every module inherits one configured sink
    instead of re-deriving one. ``vocabulary`` holds the event-type names,
    declared once here rather than restated per call site -- the duplication
    that produced two divergent copies in #412.

    Incremental by design (#409): configuration, observability, vocabulary, and
    the ``ob-guard`` PreToolUse guard are present. Request parsing, receipt
    construction, dispatch, reflex, and observation land in later slices.
    Nothing here is a placeholder; what is exported works, and what is absent
    is absent.

    The guard is deliberately NOT re-exported here. It is an enforcement tool
    invoked as a process by a hook, not a capability another module composes
    with, and importing it would imply a coupling that does not exist.

Key Components:
    - load_config / ProviderConfig: validated settings, read once at start
    - DispatchConfig, LogConfig: the typed sub-configurations
    - ConfigError: raised at boot on a bad setting, never at first use
    - configure_observability / logger: the single configured logging entry
    - EVENT_TYPES / is_valid_event_type: the one event vocabulary
    - guard / shell_lexer / cli_guard: the ``ob-guard`` PreToolUse guard, a
      standalone enforcement tool reached through its console script rather
      than this package's importable surface

Pattern/Convention:
    Configuration is read in ``config`` and nowhere else. A module that needs a
    setting receives it; it does not reach for the environment.

    An invalid setting fails at ``load_config`` with the setting named. A
    malformed value must never become a ``None`` or a ``NaN`` that surfaces far
    from its cause.

    A receipt always states durability. Returning nothing, or returning success
    without persisting, is the specific failure this package exists to prevent.

Example:
    >>> from openbrain_provider import configure_observability, load_config
    >>> config = load_config()
    >>> configure_observability(config.log)
    >>> config.dispatch.timeout_seconds
    30.0

See Also:
    - ``openbrain_memory`` - the client this provider dispatches through
    - ``docs/memory-contract.md`` - the durable memory protocol
    - ``docs/CODING_STANDARDS.md`` - section 4 observability, section 5 errors
"""

from __future__ import annotations

from .config import (
    ConfigError,
    DispatchConfig,
    LogConfig,
    ProviderConfig,
    load_config,
)
from .observability import SERVICE_NAME, configure_observability, logger
from .vocabulary import EVENT_TYPES, is_valid_event_type

__all__ = [
    "EVENT_TYPES",
    "SERVICE_NAME",
    "ConfigError",
    "DispatchConfig",
    "LogConfig",
    "ProviderConfig",
    "configure_observability",
    "is_valid_event_type",
    "load_config",
    "logger",
]
