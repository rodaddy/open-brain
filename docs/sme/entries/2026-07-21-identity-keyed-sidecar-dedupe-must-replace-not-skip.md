---
lane: correctness
order: 25
---
## [2026-07-21] Identity-keyed sidecar dedupe must replace, not skip

**Severity:** MEDIUM
**Source:** PR #317 review swarm, 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py` (`_append_quarantined_units`, `_remove_quarantined_entries`, `_commit_replay_pass`)
**Status:** fixed-pre-merge

### Pattern

The quarantine sidecar deduped on `unit_key` with skip semantics ("crash-window
dedupe"): if the key already had an envelope, the fresh copy was silently
dropped — while the same commit still removed the unit from the main spool. An
operator-restored (possibly edited) unit that re-failed to threshold therefore
lost its current lines from BOTH files, and the sidecar kept stale content and
stale counts. Idempotency for an identity-keyed store must be implemented as
REPLACEMENT: re-entry writes the fresh envelope + lines (one envelope per key
per pass, last write wins for in-batch duplicates), which preserves the
crash-window idempotency property AND the newest content. Pair it with
reconcile-on-success: a unit that replays successfully removes any stale
sidecar entry for its key in the same locked commit, closing the phantom-entry
window left by a crash between the sidecar append and the main-file rewrite.

### Review Questions

- Does any dedupe-by-key path skip (drop) the new copy while another step in
  the same commit removes the source copy? What happens when the key
  legitimately re-enters (restore → re-fail)?
- Is idempotency implemented as replacement (converges to one fresh entry) or
  as skip (silently discards newer content)?
- After a success, is stale sidecar state for the same identity reconciled in
  the same locked commit, covering the crash window of the original append —
  and ordered so a second crash strands a retryable unit, never a phantom?
- Do tests cover the restore → re-fail path, in-batch duplicate keys, and the
  crash-then-success sequence?
