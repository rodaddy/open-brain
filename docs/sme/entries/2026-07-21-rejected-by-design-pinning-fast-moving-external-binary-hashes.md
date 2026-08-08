---
lane: security
order: 19
---
## [2026-07-21] Rejected by design: pinning fast-moving external binary hashes

**Severity:** N/A (standing design rejection)
**Source:** PR development#44 review swarm 2026-07-21, operator decision (Rico)
**Scope:** Any provider/adapter that spawns an external tool (uv, bun, git, gh)
**Status:** rejected-by-design — do NOT re-recommend

### Pattern

Reviewers repeatedly propose "also hash-pin the interpreter/tool binary"
(e.g. verify a sha256 of the `uv` executable before every spawn). This is the
upgrade-kill-shot pattern that caused the 2026-07-18/20 venv-pin disaster:
pinning a mutable, routinely-upgraded artifact means every legitimate upgrade
of that tool silently bricks all fail-closed consumers (stranded live sessions,
emergency re-pin ceremonies). Pin only the reviewed artifact we ship (the
wheel); treat the host toolchain as platform, verified by behavior (probe
receipts), not by byte identity.

### Review Questions

- Does this recommendation pin something the operator upgrades routinely and
  independently of this repo? If yes, it recreates the stranding class — reject.
- Is the integrity goal already met by behavioral proof (deterministic probe
  receipt, per-sha cache isolation)? Prefer that.
