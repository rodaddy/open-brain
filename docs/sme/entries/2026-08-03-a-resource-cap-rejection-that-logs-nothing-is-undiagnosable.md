---
lane: domain-backend
order: 28
section: harvest-522
---
## [2026-08-03] A resource-cap rejection that logs nothing is undiagnosable

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/193; harvested in #522
**Scope key:** `sme.cap_rejections_must_be_logged_with_counts`
**Status:** active

### Pattern

A resource-cap rejection that emits no log is undiagnosable: you cannot distinguish a leak (resources accumulating without reaping) from a spike (genuine concurrency burst) after the fact. Every cap rejection must log at warn/info with the current count and the configured limit, and lifecycle create/expire events must be visible at the operational log level — putting them at debug means they are suppressed exactly when you need them.

Verbatim, from the source:

> **`src/transport.ts:138`** — the primary 503 rejection (`res.status(503).json({ error: "Too many active sessions" })`) has **NO log statement at all.** ... **Consequence:** we cannot tell leak-vs-spike ... from OB's logs, because the data isn't emitted.
