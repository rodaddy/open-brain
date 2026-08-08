---
lane: correctness
order: 29
---
## [2026-07-22] Destructive-teardown success must fail closed on an unrecognized response shape

**Severity:** MEDIUM (P2)
**Source:** PR #348 review swarm, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/transport.ts` (`OpenBrainLiveClient.archive`),
any client wrapper mapping a destructive tool's success body to a terminal
"already gone / cleanup clean" outcome
**Status:** fixed-pre-merge

### Pattern

`archive` mapped `archived === true` to `"archived"` and treated **every other
success** as `"already_absent"`. That default is a false-pass: a shape drift, a
differently-worded body, an empty body, or a success that did not actually
tombstone the row all collapsed to "the row is gone", so teardown reported clean
cleanup while a live record was stranded and the gate could still return PASS —
the exact mutation-safety guarantee the per-record teardown exists to provide.
For a destructive operation, only the tool's REAL success shapes are safe to
accept. `archive_entry` (src/tools/archive-entry.ts) has exactly two:
`{id, table, archived: true}` for a tombstoned row, and the EXACT plain-text
body "Already archived or not found" (trimmed, case-insensitive) for the
zero-row no-op. Accept only those — a structured `archived: false` (the server
never emits it), a broad substring ("not found" / "no rows"), or the marker in
mixed text are all rejected, because they could false-pass on unrelated output.
Every other success throws a content-free `LiveTransportError`
(`archive_entry:unrecognized-success`) so an ambiguous success can never be
counted as clean teardown.

### Review Questions

- Does a wrapper over a destructive/idempotent tool have a catch-all branch that
  maps *any* non-confirmed success to "already done / nothing to do"? That
  branch fails OPEN — invert it to fail closed on unrecognized shapes.
- Are the accepted positive shapes an explicit allowlist of the tool's REAL
  success bodies (confirmed-success OR an EXACT absent marker, not a broad
  substring), with everything else — including an invented `false` field or a
  marker in mixed text — throwing?
- Is the thrown label content-free (tool + marker), never the raw body — and is
  there a test proving an unrecognized success (including an empty body and a
  non-marker plain-text body) throws rather than silently passing?
- If the operation's response can be lost after a server-side commit, is that
  residual documented (a committed row can be stranded) rather than papered over
  with a broad query-shaped sweep that would violate mutation-safety?

### Follow-up [2026-07-22, PR #348 terminal audit]: destructive success must bind returned identity/table

The initial fix accepted `archived: true` alone. `archive_entry` actually
returns `{id, table, archived: true}`, and `archived: true` does not say WHICH
row was tombstoned. An echo for a different id/table, or a response missing them,
would be credited as this record's cleanup while the real record stayed live.
The terminal fix requires the returned `id`/`table` to EXACTLY match the
requested record; anything else throws `archive_entry:identity-mismatch`
(content-free). Extend the review question: for a destructive confirmed-success
shape, is the confirmation BOUND to the requested record's identity/table, not
just a bare `archived: true`? Tests must cover archived:true with a wrong id,
wrong table, and missing id/table.
