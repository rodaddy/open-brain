---
lane: correctness
severity: MEDIUM
status: resolved
order: 107
provenance: "PR #998, issue 864 L5 drop-folder-collector move; found by writing the end-to-end test, not by review"
---

# A dependency field declared but unfilled at the composition root typechecks green

Declaring an optional dependency field and reading it in the handler is half a
wiring change. The other half is filling it at the composition root, and
omitting that half is invisible to every automated gate.

In PR #998 the first commit declared `MemoryToolDependencies.dropCollectorBounds`
(`server/tools/types.ts`) and read it in the `collect_drop_folder` handler
(`server/tools/source-registry.ts`), but `server/main.ts` never filled it. The
field is optional, so `bunx tsc --noEmit` was exit 0; the handler falls back to
`DEFAULT_DROP_COLLECTOR_BOUNDS`, so every test was green. The runtime behavior
was that all five `DROP_COLLECTOR_*` deployment overrides were silently dropped
on that path — a behavior change with no failing signal anywhere.

The reviewable rule: an optional dependency field is a defect until something
proves a non-default value reaches the consumer. Read the composition root and
confirm the field appears there; a declaration plus a read is not a wire.

The proof is a test that carries a non-default value end to end, not a shape
assertion. #998 closed it with `server/capture/drop-folder-bounds.test.ts`,
which builds a real three-level directory tree and shows `discoverFiles`
returning strictly fewer files under a configured depth of 1 than under the
default depth of 8, with both values arriving through `parseServerConfig` and
the dependency field. A regression at any link in that chain fails there.

The same shape closed #986 (operator-doctor) and #987 (`promotionKillSwitch`),
which is what makes it a pattern rather than one lane's miss.
