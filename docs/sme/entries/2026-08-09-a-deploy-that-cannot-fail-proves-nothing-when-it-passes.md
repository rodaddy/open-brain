---
lane: gotcha-agent
order: 69
---
## [2026-08-09] A deploy check the OUTGOING process can satisfy is not a check

**Severity:** HIGH
**Source:** Issue #675 (cutover-blocker B5); prior incident 2026-08-02 on the local clone
**Scope:** `scripts/core01-deploy-local.sh`, `scripts/local-clone-deploy.sh`, any deploy/restart verification
**Status:** active

### Pattern

A deploy that verifies itself by polling `/health` has no way to distinguish
"the new revision is serving" from "the old process never stopped." Both answer
200. The failure is not hypothetical — it happened on 2026-08-02 and the deploy
exited 0:

1. the restart is accepted,
2. the new entrypoint throws on config and dies,
3. launchd holds the service down for `ThrottleInterval` (30s) before retrying —
   **longer than the health poll runs** (20s on core01, 30s on the clone),
4. `curl /health` is answered by the process that never stopped,
5. success.

The stamp on disk said one revision; the running code was another. **A check
that cannot fail proves nothing when it passes.** core01 carried this shape for
seven more days than the clone did, with a *shorter* poll window, i.e. strictly
more exposed — and `.deployed-revision` was being written the whole time and
read by nothing.

### What a real proof asserts

Three assertions, before health, all required:

1. a listener exists and its pid **differs** from the pre-restart pid,
2. that listener's `cwd` **is** the runtime directory,
3. the runtime's `.deployed-revision` **matches** the sha this run shipped.

Reading the pre-restart pid is what makes the whole thing possible: without a
"before," *something is answering* and *the new thing is answering* are the same
observation.

Use `lsof` on the port. `launchctl print | grep pid` reports the **supervised**
pid — the launcher wrapper, not the process that binds the socket (measured:
wrapper 2407, listener 2476) — and `pgrep -f 'bun run ...'` matches stray
orphans holding no port. Only the socket knows who is serving `:PORT`.

### Three siblings that look verified and are not

- **An aggregate front hides a dead worker.** core01 fronts `:3101`/`:3102`
  behind `:3100`, and the front aggregates. Poll each worker port directly.
- **A revision proof is not a feature-live proof** (#659). The clone passed its
  revision proof at the right SHA while the feature stayed dark behind an env
  allowlist. Read the FEATURE's own key from `/health`, and parse the JSON —
  a substring match on the body is satisfied by the key appearing inside an
  error string that names it.
- **A rollback needs the same standard of proof.** A rollback that "succeeded"
  because the failed process still held the port leaves the broken revision
  serving under a reassuring log line — and a rollback is exactly when the
  operator stops looking. (Drop only the feature assertion: the previous
  revision predates the feature by definition.)

### Reviewer checklist

- Does the deploy read a pre-restart pid? If not, its success is unfalsifiable.
- Does the verification poll window **outlast** the supervisor's restart
  throttle? If the throttle lives only on the box, that number cannot be
  reasoned about at all — version the launch shape (this is why #675's B2 and
  B3 were one fix surface).
- Does it check each worker port, or only the aggregate front?
- Does it assert the FEATURE, or only the revision?
- Does packaging use `git archive` of a commit, or `tar` of the working tree?
  A `tar $REPO_DIR` ships a dirty runner file to production; the ref gate does
  NOT cover this — it asserts a git-*history* property and is a no-op outside
  CI, which is every operator-run deploy.
- On failure, is the failed runtime **moved aside** rather than deleted? It is
  the evidence for why the deploy failed.

### Companion trap: `set -euo pipefail` kills the proof's normal case

`lsof` exits non-zero when it matches nothing, and "nothing is listening" is the
NORMAL state of a first deploy. A bare `pid="$(lsof ... | head -1)"` therefore
aborts the deploy at exactly that case — silently, mid-script, with no error.
Caught in #675 only by the done-means **control** clause (a healthy deploy must
still pass); every failure clause was green while the happy path was dying one
line after the swap. Swallow the status explicitly (`|| true`) and let empty
mean "nobody".
