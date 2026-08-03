# Recorded TypeScript-gate I/O — the parity fixtures

`recorded.json` is 33 real invocations of the LIVE TypeScript gates
(`_ob/scripts/context-budget-gate.ts` and `_ob/scripts/policy-refresh-gate.ts`),
captured 2026-08-02 by running `record-from-typescript.ts` against them. Each
entry holds the exact arguments, the exact stdin, and the **byte-exact stdout,
stderr, and exit code** the gate produced.

## Why these exist

The hook contract IS the bytes. A `decision` key spelled differently is an
unenforced gate; a recovery command rendered differently is a command the gate
then refuses. So "behaves similarly" is not the bar for this port — the bar is
the same bytes on the same input, and only a recording of the real thing can
state that.

They already earned it once: the recordings caught a blank line. `startup_context`
looked like it should have one after the `## Development Policy Refresh` heading,
and the TypeScript emits none — it builds the array with a `""` separator and
then calls `.filter(Boolean)`, which drops the separator along with an absent
fast-path block. Nobody would have written that from the source by eye.

## The cases are a SEQUENCE, not a set

Half of them only mean anything in order: a `post-compact` arms a session and the
next case proves the block. `test_ts_parity.py` replays the whole list against one
state directory for exactly that reason. Replaying each in a fresh directory would
test a different program.

## What is normalised

Only two things, because only two things differ between two runs of the *same*
program: ISO-8601 instants and freshly-generated v4 UUIDs (the compact-cycle
correlation id). Scratch paths are rewritten to the run's own temp directory.
Everything else — every word, every separator, every exit code — is compared
literally. A normaliser that reached further would hide the drift these exist to
catch.

## Re-recording

```bash
bun run record-from-typescript.ts
```

Writes `recorded.json` next to itself. Only re-record when the TypeScript gate's
behaviour has deliberately changed; re-recording to make a failing test pass
inverts what the fixture is for.
