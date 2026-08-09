---
lane: correctness
order: 68
---
## [2026-08-09] A hash computed over a hand-maintained mirror is a receipt that cannot move

**Severity:** HIGH
**Source:** #678 (cutover blocker B6); mirror `src/contract-schemas.ts` vs live Zod `src/tools/agent-context-pack.ts` / `server/tools/context-pack-args.ts`
**Scope key:** contract manifests, schema hashes, capability declarations, and any value documented as a drift/version receipt
**Status:** active

### Pattern

`schema_hash` is documented (docs/downstream-rollout.md:112) as "the authoritative drift receipt." It is computed over a payload containing `TOOL_CONTRACTS` — a HAND-MAINTAINED mirror of the Zod schemas that actually validate requests. So the receipt moves when the MIRROR moves, not when the CONTRACT moves.

Between #543 and #563 the live `agent_context_pack` schema gained `repo`, `prior_context`, and `continue_from`. Nobody edited the mirror. Result: the contract version AND the hash read identically on both sides of a real, client-facing shape change, and every downstream compatibility check returned the same verdict either way.

The failure is not a wrong value — it is a value that CANNOT change, which is strictly worse than a wrong one. A wrong receipt eventually mismatches something. A blind receipt reports agreement forever, and each passing check adds confidence that nothing has drifted.

Note the near-miss that makes this hard to catch: `src/contract.test.ts` pinned the exact hash as a literal. That test looks like precisely the guard against this defect, and it is not — it pins the hash of the MIRROR, so it stays green exactly when the mirror is stale. A test can pin the derived value and still be blind to the source.

### Review checks

- When a value is described as a receipt, a fingerprint, a drift detector, or a version, trace what it is actually computed OVER. If any input is hand-maintained, the receipt's sensitivity is bounded by someone remembering to update that input by hand — say so out loud in review.
- Ask the discriminating question: **what change to the real subject would leave this value unchanged?** If an answer exists, the receipt has a blind spot and the blind spot is the finding.
- A literal-pinning test over a derived value proves determinism, NOT freshness. Freshness needs an assertion tying the hand-maintained side to the authoritative source (here: mirror key set == Zod key set).
- Mirrors need a parity assertion in BOTH directions. A key in the source but not the mirror under-advertises; a key in the mirror but not the source advertises a parameter the strict schema will REJECT, which is the worse client experience because the manifest itself is lying.
- When more than one tree can serve (this repo has `src/index.ts` and `server/main.ts`), a mirror reconciled against one tree while the other drifted is accurate and still wrong on whichever surface is running. Pin every reachable tree.
- Bumping a hash and re-pinning its consumers are ONE change, never two. A bumped server with stale client pins converts a blind receipt into a hard downstream refusal — check the pin sites in the same diff.
