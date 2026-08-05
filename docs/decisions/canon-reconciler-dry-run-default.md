# The files-to-Open-Brain reconciler is dry-run by default

**Scope key:** `canon.reconciler_files_to_ob_dry_run_default`
**Source:** https://github.com/rodaddy/open-brain/pull/493
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Canon reconciliation runs one direction only: files are the original, Open Brain rows are the projection. Declared-and-absent is written, drifted is rewritten, and standing-but-undeclared is REPORTED and never touched (it may be a hand-promoted operator rule, and retiring canon is a relegate write on the key, not a delete). Dry run is the default; --apply is the operator saying the file is the decision. --apply still exits 1 because a write is not an observation.

## Verbatim, from the source

> Direction is files → OB only. ... the file is the original and the rows the projection. So the pack wins: declared-and-absent is written, drifted is rewritten, and **standing-but-undeclared is reported and never touched**. ... Dry run is the default.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
