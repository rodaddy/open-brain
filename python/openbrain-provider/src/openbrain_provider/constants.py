"""Bounds and fixed values for the provider.

Every limit the provider enforces lives here as a named module-level constant.
Inline magic numbers are a standards violation and, more practically, a limit
you cannot find is a limit nobody can tune when it starts rejecting real work.

Values carried over from the TypeScript adapter being replaced; where a bound
was implicit there, it is named here.
"""

from __future__ import annotations

from typing import Final

# --- Input bounds ---------------------------------------------------------

#: Largest accepted stdin payload for a normal lifecycle event. A hook feeds
#: this from a runtime it does not control, so it is a trust boundary.
MAX_INPUT_BYTES: Final[int] = 1_000_000

#: Ingest carries whole turns and is deliberately larger than MAX_INPUT_BYTES.
#: Separate constant rather than a multiplier so the two can move apart.
MAX_INGEST_INPUT_BYTES: Final[int] = 8_000_000

#: Distilled content longer than this is rejected rather than silently cut.
#: Truncating a durable memory would persist a half-sentence as if it were the
#: whole thought.
MAX_DISTILLED_CONTENT_CHARS: Final[int] = 20_000

# --- Reflex bounds --------------------------------------------------------

#: Longest accepted reflex query.
MAX_REFLEX_QUERY_CHARS: Final[int] = 4_000

#: Most prior-context references accepted in one reflex request.
MAX_REFLEX_PRIOR_CONTEXT_ITEMS: Final[int] = 200

#: Longest accepted identity string (citation id, source ref component).
MAX_REFLEX_IDENTITY_CHARS: Final[int] = 512

# --- Context pack ---------------------------------------------------------

#: Characters per token, for converting a token budget into a character budget.
#: A deliberate approximation: the provider never tokenizes, it only bounds.
CONTEXT_PACK_CHARS_PER_TOKEN: Final[int] = 4

#: Ceiling on a requested context-pack token budget.
MAX_CONTEXT_PACK_MAX_TOKENS: Final[int] = 100_000

#: Derived character ceiling. Named so call sites never recompute the product.
MAX_CONTEXT_PACK_CHARS: Final[int] = (
    MAX_CONTEXT_PACK_MAX_TOKENS * CONTEXT_PACK_CHARS_PER_TOKEN
)

# --- Dispatch -------------------------------------------------------------

#: Wall-clock ceiling on one package CLI invocation. An outbound call without a
#: timeout is an unbounded wait on a subprocess that may never return, which
#: would hang the agent session the hook runs inside.
PACKAGE_TIMEOUT_SECONDS: Final[float] = 30.0

#: Largest accepted stdout from the package CLI. Bounded so a runaway child
#: cannot exhaust memory in the hook process.
MAX_PACKAGE_OUTPUT_BYTES: Final[int] = 4_000_000

# --- Correlation ----------------------------------------------------------

#: Correlation ids are bounded and shape-checked; an unbounded id would flow
#: into log fields and telemetry labels.
MAX_CORRELATION_ID_CHARS: Final[int] = 128
