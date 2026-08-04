# Log rotation is app config, not host tooling

**Scope key:** `architecture.log_rotation_is_app_config_not_host_tooling`
**Source:** https://github.com/rodaddy/open-brain/issues/193
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Log rotation is an app config standard, not a host-specific newsyslog/logrotate hack: the Open Brain logger caps every file at a configurable 1MB default and rolls a small number of files so no log can grow unbounded on any deployment. Log budget is owned in-app so a new host inherits it automatically.

## Verbatim, from the source

> **1MB max per log file, rolling** (keep a small number of rotated files, e.g. 3-5, then discard oldest). Implemented as an **open-brain app config standard** so every deployment gets it by default — not host-specific rotation tooling.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
