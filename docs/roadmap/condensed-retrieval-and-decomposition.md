# Condensed Retrieval And Dream Decomposition

Status: #192 local-complete decision, 2026-07-06.

## Decision

Open Brain supports cheap exact-UUID recall through `get_entry` compact render.
Callers that know an entry UUID can request:

```json
{"table":"thoughts","id":"<uuid>","render":"compact","max_chars":500}
```

The response is a bounded envelope with `content_preview`, `content_length`,
`content_truncated`, `source_ref`, and a `fetch_path` for the full row. The full
row remains the default for backward compatibility.

## Why This Shape

- It fixes the immediate token-cost problem without a schema migration.
- It reuses existing per-table readable-content projections where safe, with a
  full-summary compact projection for sessions so length/truncation are exact.
- It keeps server-side auth and namespace predicates as the exact same boundary
  as full `get_entry`.
- It gives clients an explicit full-fetch path when the compact preview is not
  enough.

## Deferred Work

Dream-driven decomposition remains the preferred long-term way to keep Open
Brain entries naturally small and linked. It should not mutate entries until the
DreamEngine dry-run-by-default rule has a scoped design and tests for:

- oversized-entry detection;
- proposed smaller replacement entries with links back to the source;
- dry-run review output;
- explicit operator or client approval before archive, promote, demote, or tier
  mutation;
- namespace-safe provenance for every generated replacement.

Track that in #247 before implementing mutating behavior. Do not fold it into
compact `get_entry` rendering.
