---
lane: gotcha-agent
order: 70
---
## [2026-08-10] A gate must not let its own reporting channel decide its verdict

**Severity:** HIGH
**Source:** Issue #712 (`lane/712-pre-push-writefailed`); second confirmed instance of the family opened by CLOSED #483
**Scope:** any gate, hook, or CI step that runs a child process and reads its success from anything other than the child's exit code — and any child whose behavior changes with the KIND of fd it inherits (pipe vs file vs tty)
**Status:** active

### Pattern

`_githooks/pre-push` ran `bun test` bare, letting it inherit git's stdout and
stderr. When the CALLER captures git's output (`git push ... | tail`, or any
wrapper that reads it), those fds are pipes, and bun 1.3.14 aborts partway
through writing the full-suite coverage table:

```
 src/validation-errors.ts       |  100.00 |   90.
error: An internal error occurred (WriteFailed)
```

It exits 1 having run a GREEN suite. Every piped push failed, with text
identical to a genuinely broken branch.

The generalisable defect is not bun's bug. It is that **the gate's verdict was
carried by its reporting channel.** The suite's real result (3372 pass, 0 fail)
existed and was discarded, because the process that produced it died trying to
print it.

### The measurement that mattered, and the fix that would have looked right

Redirecting each fd independently on the untouched primary:

| stdout | stderr | bun exit |
|---|---|---|
| PIPE | PIPE | 1 (WriteFailed) |
| FILE | FILE | 0 (3372 pass, 0 fail) |
| FILE | **PIPE** | **1 (WriteFailed)** |
| PIPE | FILE | 0 |

The failing writer is **stderr** — where bun's coverage table and pass/fail
summary go. The obvious fix (`bun test > log`) redirects only stdout, leaves the
defect 100% live, and looks correct in review. Any check for this class must pin
the fd that was actually measured, not the one that is conventional to redirect.

Also measured: a fully-draining `cat` consumer does NOT help, and the output
truncates mid-line — so this is the child's own write path against a pipe fd,
not a consumer that stopped reading. "Something downstream stopped reading" is
the wrong first hypothesis here.

### Why it is worse than an ordinary flaky gate

The failure depended on **how the caller captured output**, so from the
operator's seat the push failed "randomly" and then "randomly" worked. A gate
that fails identically for a green push and a broken one has stopped carrying
information, and intermittent-plus-indistinguishable is the exact profile that
makes `--no-verify` habitual — the decay this repo's gate work keeps fighting.

### Second instance of #483's family

CLOSED #483: the pre-push hook's inherited `GIT_DIR` changed the outcome of
`bun test`, and the difference was invisible in the verdict. Here the inherited
thing is stdout/stderr. **The rule both share: a gate must not let anything it
inherited from its caller decide its verdict.** Two instances make this a
family, not an incident — audit what else a hook passes down untouched.

### Review checks

- **Read the verdict from the exit code, never from the presence, shape, or
  survival of output.** If a step's success is inferred from parsed text, ask
  what happens when the writer dies mid-write.
- **A child process's output destination is part of its environment.** When a
  gate runs a child, send that child's stdout AND stderr somewhere the caller
  cannot make hostile (a log file), then replay for the human. A truncated
  replay must not be able to change the verdict.
- **Announce the redirect and name the log** (`nothing is adjusted silently`).
  Moving output is a self-made decision; a reader of the transcript should not
  have to wonder why the suite went quiet.
- **"The tests failed" and "the runner could not report" are different defects
  with different owners — the gate must say WHICH.** Collapsing them is what
  made #712 undiagnosable for two lanes: both presented as one bare
  `WriteFailed` plus a refused push.
- When a gate is fixed this way, keep a **mutant control**: a genuinely failing
  suite must still fail AND still be named a test failure. A fix that stops
  reading the exit code passes the happy-path clause and destroys the gate.

### Check-design lesson that came with it

The done-means check must drive **the real hook through a genuine pipe**
(round 28). But it should NOT couple itself to bun's internal ~214 KB stderr
threshold: a synthetic 4 MB stderr writer exits 0, and fixture suites of 300 and
1200 modules both exit 0 through a pipe, so the trigger is internal to bun's
reporter at real-suite scale. A check that depended on it **would go green the
day bun fixes the bug** — silently un-testing the hook's classification logic,
which is the part the repo actually owns. Reproduce the child's *observable
contract* (fd 2 is a FIFO → `WriteFailed`, exit 1) via a PATH shim, and keep the
HOOK, the pipe, and the stdin range real.

One false RED was caught doing this: the runner was first placed in
`package.json` `scripts.test`, but the hook invokes `bun test` DIRECTLY, not
`bun run test`, so the clause went red with "0 test files matching" — proving
the fixture wrong rather than the hook broken. **When a check goes red, read WHY
before believing it.**
