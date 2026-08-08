---
lane: gotcha-agent
order: 67
---
## [2026-08-08] A top-level-`await` driver exits 0 when it throws, banking a false GREEN

**Severity:** HIGH
**Source:** #647 capture-liveness lane, self-caught during mutation testing (PR for `scripts/done-means/647-capture-liveness.driver.ts`)
**Scope:** any Bun/Node done-means driver, gate, or check script that calls `main()` at top level and reports its verdict through `process.exit`
**Status:** active

### Pattern

A driver written as

```ts
async function main(): Promise<void> {
  /* ... clauses ... */
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
```

reports the right verdict on every path **it reaches**. If anything throws before the final `process.exit` — a subject that crashes, a property read off an `undefined` block, a fake missing a method — the top-level `await` rejects, the runtime prints a stack trace, and **the process still exits 0**. The calling shell script reads success.

This is worse than a check that fails to start, because the trace scrolls past inside otherwise-normal output while the summary line says PASS. The #647 lane hit it for real: a mutation making `captureDegraded` true for an *absent* reading threw inside the warn branch, and the wrapper script reported the check as passing while the driver had crashed at clause `f-health`. The clause never ran, and its silence read as consent.

Note what did *not* catch it: the driver was fully green in every ordinary run, and the crash surfaced only under deliberate mutation. This is the round-9 Tightening ("a green clause is not evidence until it has been seen to fail") reappearing at the level of the harness rather than the clause.

Review checks:

- Any `await main()` / `main()` at module top level with no `.catch` → defect. The fix is explicit:

  ```ts
  main().catch((error: unknown) => {
    console.log(`FAIL  (driver) threw before completing: ${
      error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  ```

- Verify the exit code *directly*, not by reading the summary line: run the driver with a deliberately broken subject and check `$?` is non-zero. A driver whose crash path has never been executed has an unproven verdict channel.
- Wrapper shell scripts that use `set +e; bun "$DRIVER"; STATUS=$?` are correct in shape and **still** report success here — the defect is upstream of them, so do not treat a careful wrapper as coverage for this.
- Same class in Python drivers when `main()` is invoked outside `sys.exit(main())`, or when a bare `except` swallows before the verdict is computed.

### Why it matters

A done-means check exists to be the one thing that cannot be talked out of a verdict. A verdict channel that converts "crashed" into "passed" inverts exactly that guarantee, and it does so most reliably under the conditions the check was written for — a broken subject. Every clause downstream of the throw is silently skipped, so the more the subject is broken, the earlier the crash and the fewer clauses run.
