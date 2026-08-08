---
lane: domain-backend
order: 7
---
## [2026-07-05] Retiring a legacy shared namespace must stay correct pre-migration

**Severity:** MEDIUM
**Source:** PR for #167 (retire collab namespace)
**Scope:** `src/shared-namespace.ts`, `src/read-policy.ts`, fallback call sites, `scripts/retire-collab-migration.ts`
**Status:** fixed in #167 PR

### Pattern

Retiring `collab` as the default `legacySharedNamespace` (default now empty,
fallback default now off) can make un-mirrored legacy rows invisible if the
code deploys before the data migration runs. The retirement kept an env escape
hatch (`SHARED_NAMESPACE_LEGACY` + `OPENBRAIN_LEGACY_SHARED_FALLBACK=1`) and
made the fallback helpers no-op on an empty legacy namespace, but merge order
still matters: migrate first, then deploy.

Two easy mistakes surfaced:
- An `INSERT ... SELECT` that omits `namespace` inherits the table default
  (`'collab'`), silently writing copies back into the retired namespace. Always
  set the target namespace explicitly in the column list.
- `ON CONFLICT (content_hash, namespace)` fails (`42P10`) against a *partial*
  unique index unless the conflict target repeats the index predicate
  (`WHERE content_hash IS NOT NULL`).

### Review Questions

- After removing a default fallback, is the code still correct if it deploys
  BEFORE the data migration? Is the merge/deploy order spelled out in the PR?
- Do canonicalization-dependent tools (`get_stats`, `list_namespaces`, repo-fact
  canonicalization) change client-visible output when the legacy namespace stops
  being canonicalized? Is that intended and documented?
- Does the migration copy preserve provenance (created_by/created_at) and set
  the destination namespace explicitly rather than relying on a column default?
- Is the migration idempotent via a real uniqueness guard (per-namespace
  content_hash), proven by a run-twice test?
