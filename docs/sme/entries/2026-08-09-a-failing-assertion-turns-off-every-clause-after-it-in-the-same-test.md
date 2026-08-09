---
lane: correctness
order: 69
---
## [2026-08-09] A failing assertion turns off every clause after it in the same test

**Severity:** HIGH
**Source:** #691 merge defect; `src/tools/__tests__/get-contract.test.ts` (the #271 boundary tripwire), healed by the #271 tripwire lane
**Scope key:** tripwires, boundary guards, and any single test whose later assertions enforce a security or contract decision; PRs that move a pinned version, hash, or count
**Status:** active

### Pattern

`expect()` throws on first failure, so every assertion after the first failing one in the same `it()` block never executes. For an ordinary test that is fine — it is red either way. For a TRIPWIRE it is a hole, because the test's job is not to be green; it is to REFUSE a specific class of change.

Concretely: the #271 tripwire pins two independently-versioned surfaces and then, further down the same block, asserts the exact top-level key set of the served contract and applies a negative filter rejecting any new key matching `/(hot|inject|push|bundle|_meta)/i`. Those last two clauses are the ones that actually enforce the boundary. #691 bumped `tool_contracts.agent_context_pack.version` 2 -> 3 and left the tripwire's stale literal in place, so the block aborted at the version line and the two enforcing clauses stopped running — measurable as 37 `expect()` calls on the red tree versus 44 on the healed one.

For the window the default branch stayed red, a PR could have advertised a push-shaped hot-memory key and the tripwire would not have refused it. It would have failed for the old reason and looked like the same known redness.

That is the trap worth naming: **a red tripwire and a disabled tripwire are indistinguishable in the test output.** Both show one failing test with a familiar message. Known redness is a strong anaesthetic — the second failure hides behind the first, and the longer the branch stays red the more normal the message looks.

The enabling defect is separate and mundane: a PR moved a pinned number and did not re-run the OTHER assertions of that number, because they lived in a file the diff did not touch. The PR's own gates were green.

### Review checks

- **When a PR moves a pinned value — a version, a hash, a count, a schema literal — grep for every other assertion of that value before merging, including in files the diff does not touch.** The pin-holders are by definition somewhere else; a green branch proves the branch's own tests, not the pins.
- On any test whose later assertions enforce a boundary, ask **what happens to the clauses BELOW an early failure.** If the answer is "they do not run," the enforcement is conditional on the rest of the file being green, and that is a property nobody is tracking.
- Prefer proving execution by **assertion count** over greenness for guard tests. A floor on `expect()` calls catches a silently truncated body; an exit code cannot express it. Pin a floor, not an equality, so adding assertions does not fail the gate.
- Splitting a multi-clause tripwire into separate `it()` blocks is the structural fix and is usually right; where a single block is deliberate (the clauses share expensive setup), the count assertion is the compensating control.
- **Never let a tripwire sit red on the default branch.** Its failure message stops carrying information the moment it becomes expected, and the whole value of a tripwire is that its redness is surprising. Heal it or revert what broke it; "known failure" is not a state a guard can survive in.
- When healing a red tripwire, the review question is never "what value makes it green." It is "does the thing that moved stay on the correct side of the decision this tripwire encodes" — answered from source, with the reasoning written next to the number so the next reader inherits it. A bumped literal with no rationale is indistinguishable from a silenced guard.
- A mutation clause written for a subject that is ALREADY red will pass off the pre-existing failure and report a survived mutant as a kill. Gate mutation clauses on a proven-green baseline.
