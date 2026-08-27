# Lane Contract — fixture

## Standing contract

Branch before work.

## Tightenings

Newest first. Every entry: what changed, and the observation that forced it.

<!-- THE RATCHET. Bounded at 15 live entries: overflow graduates into a
done-means check or a GOTCHAS.md entry. -->

### 2026-08-18 (round 32) — harvest of the live-observer lane

- **A surface proven only by injection is not live.** The deployed worker
  composed no observer and could never alarm.
- The closing gate asserts the DEFAULT composition, no override.

(provenance: PR #737.)

### 2026-08-17 (round 31) — harvest of the clone-path wave

- **The PR-body gate resolves relative paths against the primary checkout.**
  Pass `--body-file` an absolute path.

(provenance: PRs #727-#732.)

### 2026-08-16 (round 30) — harvest of the index lane

- **`aqmd` has no index in a fresh clone; it hangs, it does not error.**
  Query the primary checkout read-only.

(provenance: issue #711.)

## Class vocabulary

Nothing here.
