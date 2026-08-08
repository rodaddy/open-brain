---
lane: security
order: 37
section: harvest-522
---
## [2026-08-03] Privileged batch/promotion runners: a four-point review checklist

**Severity:** HIGH (stated in source)
**Source:** issue #145 / #156 (privileged runner design and swarm findings); harvested in #522
**Scope key:** `review.privileged_batch_runner_checklist`
**Status:** active

### Pattern

Review privileged batch/promotion runners for four specific defects: arbitrary source/target namespace flags (constrain to the one configured route and reject legacy aliases as targets), resumed state files whose stored source/target are not revalidated against current args, durable state defaulting into temp-workspace paths that get cleaned, and missing dry-run default / bounded --max-apply / kill switch / per-batch receipts. (The cursor-advance-past-failed-rows half is already captured in adversarial.md 2026-06-19.)

Verbatim, from the source:

> - HIGH: privileged runner accepts arbitrary `--source-namespace` and `--target-namespace`, creating too broad a cross-namespace promotion path. Fix required: constrain this legacy runner to configured legacy shared namespace -> canonical shared namespace only.
