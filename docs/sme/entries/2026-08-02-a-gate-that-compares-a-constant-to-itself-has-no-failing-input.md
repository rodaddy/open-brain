---
lane: correctness
order: 48
---
## [2026-08-02] A gate that compares a constant to itself has no failing input

**Severity:** HIGH
**Source:** PR (this change), `contracts/check-parity.ts`, `server/contracts/declaration.ts`
**Scope:** any parity/compatibility gate that compares a declared value to a computed one
**Status:** active

### Pattern

`server/contracts/declaration.ts` declared the rewrite's contract identity as
two hardcoded string literals, and `contracts/check-parity.ts` asserted those
literals equalled `buildContract()`. Both sides were fixed text that a human had
already made match, so the assertion could not fail for any state of the code it
claimed to police. Contract parity reported GREEN across every run while the
rewrite registry was missing a tool the frozen contract requires.

The gate was not weak, it was VACUOUS: it proved the `src` side (which really
derives from the builder) and merely echoed the server side back. The same
report line carried both, so the honest half lent its credibility to the half
that measured nothing.

Two second-order traps came with it. First, deriving both sides fixes the lie
but produces a comparison that passes by construction -- correct and still
worthless -- so the real assertion has to move to something the identity string
cannot express: does the implementation REGISTER what its contract promises.
Second, the obvious way to enumerate a registry (regex the source for
`registerTool(`) silently found ZERO tools in `server/tools`, because `src`
writes the tool name on the same line as the call and `server` writes it on the
next. A shortfall check over an empty set reports success, which would have
replaced one vacuous gate with another. Running the real registrar against a
recording stand-in cannot lie about what is registered; a zero-tool result now
throws rather than passing.

The final predicate reads the ledger the repo already keeps
(`provider_capability_status`: `implemented` vs `scaffold-declared`) so it fails
on the false CLAIM rather than on the unfinished port -- otherwise the only way
to green it is to lie in the manifest.

### Review Questions

- For every equality assertion in a gate: can BOTH sides change independently?
  If one is a literal a human keeps in sync with the other, the check has no
  failing input and proves nothing. Ask what edit would make it red.
- When a check is made honest by deriving a previously-hardcoded value, does the
  comparison still assert anything, or do the two sides now agree by
  construction? Derivation removes the lie; it does not by itself restore the
  signal.
- Does any registry/inventory scan report a plausible-looking ZERO or a suspicious
  count? Print the count and assert a floor. A pattern that matches nothing makes
  every downstream "nothing is missing" conclusion vacuous.
- Was the gate proven RED by fault injection on the real tree, or only observed
  green? A green gate is evidence of nothing until something has made it fail.
