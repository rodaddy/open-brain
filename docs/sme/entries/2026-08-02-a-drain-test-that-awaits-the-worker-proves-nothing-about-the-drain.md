---
lane: gotcha-agent
order: 24
---
## [2026-08-02] A drain test that awaits the worker proves nothing about the drain

**Severity:** MEDIUM
**Source:** PR for the maintenance-runner port onto `server/`, red-proof pass
**Scope:** any test asserting that `stop()`/`close()`/`shutdown()` DRAINS rather
than cancels; `server/maintenance/maintenance.pg.test.ts`
**Status:** fixed before review

### Pattern

Two independent mistakes made a lease-drain test pass under the exact defect it
existed to catch. Both are invisible in review because the test reads correctly
and the assertions are about real durable state.

**1. Awaiting the work before asserting.** The test did:

```ts
await stopping;
await tick;          // <- this is the bug
const row = await readRow(job.id);
expect(row.state).toBe("succeeded");
```

Awaiting the tick guarantees the handler finished no matter what `stop()` did,
so the row reads terminal even under a `stop()` that abandoned it. Deleting
`await this.tickPromise` from the runner — the literal PR #350 defect — still
passed 5/5. The assertion must bind to the moment `stop()` RESOLVES: read the
state immediately after `await stopping`, and join the worker only afterwards
so the test leaves nothing running.

**2. Opening the window at the wrong boundary.** The first version blocked
inside the HANDLER and called `stop()` once the handler had started. That proves
nothing either: a dispatched job is already tracked in the runner's `active`
set, and every implementation waits on that set. The recorded defect lives one
step EARLIER — between a claim committing its leases and those rows being
tracked. Reaching it requires `stop()` to be entered while `claimDueJobs` is
still in flight, which means wrapping the claim (let the real one commit, then
park it) rather than blocking the handler.

The general shape: **a lifecycle test is only as strong as the narrowest window
it can actually open, and awaiting the thing under test collapses the window.**

### Review Questions

- Does the test `await` the worker/tick/promise before reading the state that is
  supposed to prove the drain? If so it cannot fail, and it should be re-checked
  under a mutation before being trusted.
- Is the shutdown window opened at the point the defect actually occupies, or at
  a later point every implementation already handles? For claim-then-dispatch,
  handler-start is too late; the claim must be the seam.
- Was the assertion observed FAILING under a mutation that reintroduces the
  original defect, by name — not merely under some mutation?
- Does a "drain proven" claim rest on a fake queue? Both invariants here fail
  silently in durable state, so only a real database read can distinguish a
  drained row from an abandoned one.

---
