# No second query path

**Scope key:** `repo.open_brain.no_second_query_path`
**Source:** issue #437 (Web service)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Any future Open Brain web surface must NOT introduce a second query path to the same rows (no Drizzle, no second ORM), even though the fleet-standard king-dashboard stack uses drizzle-orm. It calls the existing data-layer module (`src/candidate-review.ts`) server-side, because two query paths against the same rows is how a namespace-isolation predicate gets forgotten in one of them. Separately, `src/grading-server.ts` documents loopback AS the auth boundary; binding wider requires real auth in the same change and that comment must be rewritten, not overridden.

## Verbatim, from the source

> Open Brain uses raw parameterized `pg`, and repo rules require it. [...] The web app calls that module server-side rather than re-querying through a second ORM — two query paths against the same rows is how a namespace-isolation predicate gets forgotten in one of them.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
