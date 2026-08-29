---
lane: gotcha-agent
severity: MEDIUM
status: active
order: 106
provenance: "issue 864 L5 context-pack adapter lane, branch refactor/864-c9d-context-pack-adapters; found while diffing a server/ twin against the src/ tests"
---

# A log-record filter with no assertion passes vacuously after a rename

A test that filters captured log records by event name and then asserts nothing
about the filtered array cannot fail. It passes when the event fires, and it
passes just as green when a refactor renames the event and the filter matches
zero records.

This is the shape a twin adapter walks into. When a `server/` twin already
exists for a `src/` module, the twin's log event names and helper symbols were
written independently of the `src/` tests that will now run through the adapter,
so a name that drifted is invisible to `tsc`, to `oxlint`, and to the suite.
The filter narrows an array; an unread array is not an assertion.

What to check when reviewing or writing a twin adapter:

- Find the twin by exported SYMBOL across `server/`, not by filename. A shared
  basename is not evidence of a twin, and a differing basename does not rule
  one out.
- Diff the twin's log event names and helper symbols against the names the old
  tests reference, one by one, before repointing anything.
- Pair every log-record filter with a non-empty assertion — `expect(records.length).toBeGreaterThan(0)`
  or an assertion on a field of `records[0]` — so a renamed event fails loudly
  instead of narrowing to nothing.
- Rewrite a done-means driver that compared the `src/` side against the
  `server/` side into an identity check: the two imports must resolve to the
  SAME function. A comparison of a module against its own adapter is a
  self-comparison and proves nothing.

The general form is broader than logging: any test whose only step is to select
a subset by name goes silent when the name changes. The selection is not the
test; the assertion on what was selected is.
