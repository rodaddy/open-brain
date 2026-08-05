# `min_client_versions` is a deprecation floor

**Scope key:** `release.min_client_versions_is_deprecation_floor`
**Source:** https://github.com/rodaddy/open-brain/pull/497
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

min_client_versions in src/contract.ts is a deprecation floor, not a mirror of the current package version, and it sits inside the hashed contract payload so raising it changes schema_hash and requires updated parity fixtures. Do not bump it during a routine release; raising the minimum IS the deprecation mechanism and makes older clients fail contract validation loudly at session start. Releases set one version number across package.json and all three Python packages.

## Verbatim, from the source

> `min_client_versions` in `src/contract.ts` stays at `openbrain-memory: 0.1.15`. It is a **deprecation floor**, not a mirror of the current package version

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
