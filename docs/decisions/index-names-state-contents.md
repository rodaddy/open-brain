# Index names state their contents

**Scope key:** `naming.index_names_state_contents`
**Source:** https://github.com/rodaddy/open-brain/issues/448
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The shared Development policy qmd index is named global_docs_instructions (renamed from 'fleet' on 2026-07-30), on the standing naming standard that an index name must state its CONTENTS rather than a scope the reader has to infer. Do not rename it to 'policy' or anything scope-shaped; aqmd's SHARED_INDEX and every bare-aqmd append point resolve to this name.

## Verbatim, from the source

> On **2026-07-30 Rico deliberately renamed** this index (from `fleet`) to `global_docs_instructions` ... on the standard "the name must state the CONTENTS, not a scope the reader has to infer."

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
