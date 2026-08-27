---
lane: security
order: 90
---
## [2026-08-08] A guard written as "present AND wrong" leaves the absent branch unguarded

**Severity:** HIGH
**Source:** PR #664 (#662 validator lane), the #653 credentialed verify, Tightenings round 19
**Scope:** `src/` validators and scope guards; `scripts/done-means/662-absent-namespace-scope-proof.sh`
**Status:** active

### Pattern

A guard spelled "key present AND value wrong" never runs for the ABSENT case — and the absent branch inherits the exact dead end the guard was added to remove. #654 and #662 are ONE defect on two sides of one `if`.

### What to do

- When a fix special-cases a key, ENUMERATE the key's states — present-correct, present-wrong, absent — and say in the check header which branch handles each. A state you cannot name is a state nothing guards.
- **"The server always sends it" is not a reason to leave a validator's hostile-input branch dead-ended.** The lane object is the untrusted thing being validated. The dispatch's server-side hypothesis was reasonable and wrong; one live `tools/call` plus reading the column lists settled it in minutes. A lane rejects a briefed hypothesis ON EVIDENCE and writes the reasoning into the check header — never decides silently.
- **Absence and mismatch need DIFFERENT messages, because only one has a remedy.** Reusing the delegation advice for the absent case would pass a naive "mentions namespace" assertion while remaining a dead end with more words. Clauses assert what the message SAYS, not that a message exists.

### Corollary: `rg -r` is the REPLACE flag, not recursive

It silently emits mangled replacement text that reads as a single real hit. It joins the `rg -E` family: the failure mode is a plausible-looking WRONG ANSWER, not an error, which is why neither is caught by checking the exit code.

### Corollary: a gate that keeps failing on real defects is doing its job

The #578 gate's first credentialed run found the THIRD live defect in the very path it composes (#654's absent-case sibling). Resist reading a red gate as a broken gate: the verifier re-ran the fixed defects' own checks live, proved them fixed, and only then attributed the new failure.

Also observed: a per-run tally can UNDER-report entity creation — `attempted=1` while two namespaces appeared. Count the entities, not the attempts.
