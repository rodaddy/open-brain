---
lane: correctness
order: 31
---
## [2026-07-22] Seed (create) proof must bind merged:false and the exact namespace

**Severity:** MEDIUM (P2)
**Source:** PR #348 terminal audit, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/transport.ts` (`OpenBrainLiveClient.logMemory`),
any client that treats a `log_*` / upsert response as a fresh this-run creation
it will later mutate
**Status:** fixed-pre-merge

### Pattern

`log_thought` / `log_decision` return `{id, namespace, merged}` where
`merged = !isNew` (src/tools/log-thought.ts, log-decision.ts): the tool upserts
`ON CONFLICT (content_hash, namespace)`. The seeder ignored `merged` and
defaulted a missing `namespace` to the requested one. In a REUSED namespace
(see the adversarial reusable/truncated-run-id entry), a second run's seed
upserts onto a prior run's stranded row and returns `merged: true` with the
prior row's id — which the gate then adopted as a current-run creation and would
archive on teardown, tombstoning a row this run did not create (and, symmetric,
counting a prior row toward this run's scoring). The fix fails closed
content-free unless the response proves a fresh create: `merged` present and
`false`, a returned namespace EXACTLY equal to `opts.namespace` (no defaulting a
missing/other namespace), and a present id. Labels: `:merged-upsert`,
`:missing-merged`, `:namespace-mismatch`, `:missing-id`.

### Review Questions

- Does the create path assert the write actually CREATED a row (an explicit
  `merged: false` / `created: true` / affected-rows signal), or does it treat any
  2xx-shaped response as a new record it now owns?
- For an upsert-backed "create", can a merged response onto a pre-existing row
  be mistaken for this caller's row and later mutated/deleted?
- Is the returned namespace/scope required to EXACTLY equal the requested one,
  with no defaulting a missing field back to the request (which masks a write
  that landed elsewhere)?
- Is every rejection content-free (tool + reason), and is there a test for each
  of merged:true, missing/non-boolean merged, wrong/absent namespace, missing id?

### Note on canonicalization

`log_thought` returns `canonicalNamespace(ns)` and `log_decision` returns raw
`ns`. For the eval-live namespace (`eval-live-recall-<run-id>`),
`canonicalNamespace` is a no-op (it only rewrites the shared namespace), so the
exact-equality check is safe. A tool that seeds into the shared namespace would
need to compare against the canonical form — check the tool's actual return
transform before pinning exact-equality.
