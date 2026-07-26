"""Bounds the provider enforces.

Only limits that are actually enforced live here. An earlier revision declared
twelve constants, ten of which had no callers, and described all of them as
"carried over from the TypeScript adapter". They were not: `MAX_INPUT_BYTES`
was 15x the adapter's value, `MAX_CONTEXT_PACK_MAX_TOKENS` 5x, and
`MAX_DISTILLED_*` silently changed unit from bytes to characters. A false
provenance comment is worse than no comment, because the next reader trusts it
instead of checking.

Every value below is verified against the adapter being replaced,
`ob-memory-provider.ts`, and cited by line. The remaining bounds arrive with the
slices that enforce them (#412-#419), each verified the same way.
"""

from __future__ import annotations

from typing import Final

#: Floor on a requested context-pack token budget.
#: Adapter line 159: `const MIN_CONTEXT_PACK_MAX_TOKENS = 100`.
#: A budget below this cannot fit even one useful section, so accepting it would
#: return a technically-valid empty pack instead of reporting the mistake.
MIN_CONTEXT_PACK_MAX_TOKENS: Final[int] = 100

#: Ceiling on a requested context-pack token budget.
#: Adapter line 160: `const MAX_CONTEXT_PACK_MAX_TOKENS = 20_000`, enforced at
#: line 1398. Matching it matters: a Python provider that accepts 100k while the
#: TS path rejects above 20k makes the two runtimes disagree about a valid
#: request, which is exactly the drift this port exists to remove.
MAX_CONTEXT_PACK_MAX_TOKENS: Final[int] = 20_000

#: Wall-clock ceiling on one package CLI invocation, in seconds.
#: Adapter line 220: `const PACKAGE_TIMEOUT_MS = 30_000`. Same bound, expressed
#: in seconds because that is what `subprocess` takes; converting at the call
#: site instead would put a magic 1000 in the dispatch path.
#:
#: An outbound call without a timeout is an unbounded wait on a subprocess that
#: may never return, which would hang the agent session the hook runs inside.
PACKAGE_TIMEOUT_SECONDS: Final[float] = 30.0
