---
lane: security
order: 20
---
## [2026-07-21] Rejected by design: fd-pinning / TOCTOU theater inside the local trust boundary

**Severity:** N/A (standing design rejection)
**Source:** PR development#44 review swarm 2026-07-21, operator decision (Rico)
**Scope:** Local single-user adapter/hook code (Claude provider sandwich and peers)
**Status:** rejected-by-design — do NOT re-recommend

### Pattern

Reviewers propose closing the hash-then-spawn window with fd/inode pinning,
O_NOFOLLOW, or private immutable copies. In this deployment the artifact, the
cache, AND the adapter source itself are all writable by the same local user:
an attacker who can swap the wheel mid-window can more easily edit the adapter
script that performs the check. Hardening one millisecond window while the
whole verifier is user-writable is complexity without a threat model. The
correct mitigations here are the ones that catch ACCIDENTS: single sha over the
shipped artifact, per-sha cache dirs, deterministic probe receipts.

### Review Questions

- Is the proposed mitigation defending against an actor who already has write
  access to the code doing the defending? If yes — wrong trust boundary, reject.
- Does the accident-class equivalent (stale cache, wrong file, partial write)
  already fail closed via hash + probe? Then the TOCTOU add-on is theater.
