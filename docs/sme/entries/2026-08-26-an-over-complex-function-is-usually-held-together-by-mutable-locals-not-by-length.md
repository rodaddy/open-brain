---
lane: quality
order: 76
---
## [2026-08-26] An over-complex function is usually held together by mutable locals, not by length

**Provenance:** PR #806, issue #780. Severity: MEDIUM. Status: open.
**Scope:** any `complexity` / `max-lines-per-function` finding; review of a PR
that answers one by extracting helpers.

`buildAgentContextPackPayload` scored 129 on complexity across 535 lines. The
length was the symptom. What actually held it together was three mutable
locals — the surviving chars, whether the next admitted member still gets the
comma-free first slot, and an accumulated markers array — read and written by
each of nine sections in sequence.

That is why the function had grown instead of being split earlier. Extracting
any one section required passing all three in and getting two of them back, so
every candidate helper had a worse signature than the code it replaced, and
`max-params` was waiting on the other side. Splitting on line count alone
produces exactly that: helpers that take five arguments and return a tuple,
which trades one finding for another and makes the flow harder to read.

Naming the shared state as ONE object first is the move that unlocks the split.
Once the three locals became fields on a `PackAllocator` passed to each section,
every section became a function taking one options object and returning what it
contributed — and the file went 729 → 425 code lines across eight siblings with
no helper exceeding four parameters.

**What a reviewer should check** on a PR that answers a complexity finding:

- Did the author identify the shared MUTABLE state before extracting, or just
  cut at line boundaries? A helper list with no state object, where several
  helpers take the same three or four scalars, is the tell that the split
  fought the state instead of naming it.
- Do the new helpers hand state back through return tuples or out-parameters?
  That is the same coupling with more surface.
- Ordering that used to be visible as one inline sequence — array spreads,
  insertion into a map, a priority walk — is now decided by the ORDER OF A LIST
  passed to a composer. That is a real behavior surface with no compiler check
  behind it; confirm a test asserts the resulting order, and that the list is
  commented with what its order means.
- Two blocks merged into one parameterized helper need a reason they will not
  need to diverge. Two blocks kept separate need a reason they must. In this PR
  the two append-store sections merged (they differed only by key and reconciled
  counts) and the two recall sections did not (they trim in opposite
  directions) — both calls were stated and both are checkable.

**Also observed:** the extraction rewrote one boolean predicate into a
non-equivalent nested conditional, and the existing suite did not catch it. A
refactor claimed to be behavior-free is verified by reading each extraction back
against its original, not only by a green run — the tests cover the
combinations someone already thought of.
