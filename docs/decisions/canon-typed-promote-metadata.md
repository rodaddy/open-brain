# Canon write path carries typed promote metadata

**Scope key:** `canon.write_path.typed_promote_metadata`
**Source:** https://github.com/rodaddy/open-brain/issues/445
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Canon membership is decided by explicit typed metadata on a promoted row, never by content keywords. Guidance lanes select on ob_session_events.metadata.candidate_type ('user_preference' or 'process_rule') AND memory_lifecycle_action='promote'; repo_facts select on ob_entities.entity_type='repo_fact' with an exact metadata.repo match written via upsert_repo_fact. A bare 'candidate' is deliberately not standing guidance -- promotion is the act that makes something canon.

## Verbatim, from the source

> Canon is marked by **explicit typed metadata on a promoted row** — never inferred from content. ... `profile_guidance` -> `ob_session_events.metadata.candidate_type = 'user_preference'` ... with `metadata.memory_lifecycle_action = 'promote'`. ... **A bare `candidate` is deliberately excluded**

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
