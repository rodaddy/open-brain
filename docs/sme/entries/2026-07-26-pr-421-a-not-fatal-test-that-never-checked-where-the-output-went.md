---
lane: correctness
order: 45
---
## PR #421 — a "not fatal" test that never checked where the output went

Severity: HIGH. Status: fixed in `0d110f1`. Provenance: PR #421, correctness and
adversarial lanes independently.

`resolve_log_file()` existed specifically to keep log records off stdout, because
these processes are agent hooks and stdout is the machine-readable return
channel. It then returned an operator-supplied `LOG_FILE` **unchecked**, on the
reasoning that silently relocating an operator's logs is worse than failing where
they can see it.

That reasoning was wrong about the consequence, not the principle: the failure is
not visible. An unwritable path fell through to a stdout sink and wrote 436 bytes
of log records onto the hook's response channel.

The reason it survived is the transferable lesson.
`test_unwritable_log_file_is_not_fatal` exercised the exact failing scenario and
passed, because it asserted the process kept running — which was never the risk.
The test named the right input and the wrong consequence.

### Review Questions

- When a function exists to guarantee an invariant, does every input path
  enforce it, or is one path exempted as "the caller asked for it"? An exemption
  is only safe if violating it fails loudly.
- For each test named after a hazard: does it assert the *hazard*, or something
  adjacent that happens to be true? "Process did not crash" is not "output was
  not corrupted."
- If a fallback exists for a resource being unavailable, where does the fallback
  write? Verify it is not the caller's data channel.
- Does the test capture the stream it claims to protect (`capsys`, an
  `io.StringIO` swap), or does it only inspect the happy-path destination?
