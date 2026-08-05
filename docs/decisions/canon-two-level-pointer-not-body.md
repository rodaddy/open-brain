# Canon is a two-level pointer, not a body

**Scope key:** `canon.two_level_pointer_not_body`
**Source:** https://github.com/rodaddy/open-brain/issues/444
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Canon is a two-level design with exactly three lanes: profile_guidance (user.md), process_guidance (soul.md), and repo_facts. Churny detail -- coding standards, personas -- lives BELOW canon in qmd-indexed files; canon itself carries only the short pointer rule that survives churn. Do not put standards bodies or persona text into a canon lane.

## Verbatim, from the source

> Canon is the frontal-lobe layer mapped as recorded in `_plans/canon-always-known.md:104-107`: `user.md` → `profile_guidance`, `soul.md` → `process_guidance`, repo facts → `repo_facts`. Churny content, including coding standards and personas, lives **below canon**.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
