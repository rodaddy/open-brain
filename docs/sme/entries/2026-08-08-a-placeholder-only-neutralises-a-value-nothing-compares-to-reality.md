---
lane: gotcha-agent
order: 66
---
## [2026-08-08] A placeholder only neutralises a value nothing compares to reality

**Severity:** HIGH
**Source:** #636 neutrality scrub (PR for `feat/636-neutrality-scrub`); eight defects found auditing an inherited partial scrub
**Scope:** any find-and-replace sweep over literals — neutrality scrubs, renames, redaction, anonymising fixtures
**Status:** active

### Pattern

A sweep that replaces environment-specific literals treats every match as an *example*. Some matches are not examples: they are compared against something real, and swapping the text does not neutralise the value — it silently disables whatever the value was for. The failure is invisible because the sweep's own diff looks uniform and correct.

Six distinct instances in one scrub, each a different flavour of "compared against reality":

- **Compared against the filesystem.** `DEFAULT_DEVELOPMENT_ROOT` and `APPROVED_TEMP_WORKTREE_ROOTS` are matched against real directories. Pointed at a path that exists nowhere, every scope resolved to `None` and the gates fell permanently silent — the exact failure the function's own docstring described.
- **A skip condition.** `test_receipts_gate_crosslang` skips itself when its gate path is not a file. The placeholder converted the suite's ONLY cross-language proof into a permanent silent skip that still reported green. Restoring it moved the package from 581 passed / 26 skipped to 606 passed / 1 skipped — 25 tests had stopped running and nothing said so.
- **A byte-parity contract with code outside the repo.** The Python provider is a port of `_ob/scripts/policy-refresh-gate.ts`; `test_ts_parity` replays that gate's recorded answers. Editing only the Python side failed 7 cases. Scrubbing these means changing the external twin FIRST.
- **A recorded fixture.** `recorded.json` is a verbatim recording of that external gate. Editing a recording neutralises nothing; it just makes the port disagree with what it is a port of.
- **An operator handshake token.** `COLLAB_RETIRE_APPROVAL_VALUE` is compared for equality against a string the runbook tells the operator to export. The runbook was allowlisted, so only the code changed — a broken safety gate.
- **A real filename or a command to paste.** Six citations of `scripts/core01-deploy-local.sh`, a doc link, and `package.json` script names were rewritten to names that exist under neither spelling. A path in a "run this to clear the block" message that exists nowhere leaves the block unclearable.

A seventh instance came from picking the wrong neutral value rather than the wrong target: a network fixture moved to `192.0.2.0/24`, which is TEST-NET-1 (RFC5737) and **not** RFC1918. The code correctly rejected it as non-private and all 18 tests in the file failed. **The replacement must preserve the property under test** — for a private-LAN fixture that means another RFC1918 range, not the documentation range.

### Review checks

- For each replaced literal, ask what READS it. If the answer is the filesystem, an equality check, a skip condition, a recorded fixture, an external runtime, or a human pasting it, the literal is behaviour and must not be scrubbed — or must be scrubbed on both sides at once.
- Grep the new value. If it appears in exactly one place, the reference it used to have was probably broken by the sweep.
- Verify every renamed filename and link target still resolves (`ls`, or a link check), and every renamed script name against its documented callers.
- A test suite passing after a scrub is NOT sufficient: check the skip count too. Skips are how a scrub hides.
- Prefer a narrow `path:substring` exception over a file-wide allowlist entry, and make each exception carry its reason — a file-wide exemption blinds the check to a future real leak in the same file.

### Also proven here

The gate written to enforce the scrub had its own silent-success bug: the violation counter was incremented inside a `... | while read` pipeline, so it lived in a subshell and was discarded — the check printed VIOLATION lines and exited 0. Any `while` loop fed by a pipe cannot mutate the caller's state; use a here-string. A gate that reports failure and passes anyway is worse than no gate, and it is only caught by a **negative control**: inject a real violation and confirm the check fails.
