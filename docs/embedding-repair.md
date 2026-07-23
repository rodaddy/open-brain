# Stale-embedding detection and idempotent repair

Shared primitives for finding rows whose stored embedding no longer reflects
their source (or the current model) and repairing them safely. Lives in
`src/embedding-repair.ts` with the table registry in `src/embedding-targets.ts`.

These are **building blocks only**. This module does not:

- wire the Issue #343 spool/queue handler (it exposes `selectStale` +
  `repairOne` for a queue to drive per-unit, and `repairStaleBatch` for bulk
  script runs);
- add or run a database migration.

`scripts/backfill.ts` (`bun run backfill`) is preserved and now sources its
table -> text and table -> hash mappings from the same `EMBEDDING_TARGETS`
registry, so the two never drift.

## Embedding-bearing tables (current stored schema)

| Table               | embedding | content_hash | embedded_at | embedding_model | Embed text          | Source-hash input                       |
| ------------------- | :-------: | :----------: | :---------: | :-------------: | ------------------- | --------------------------------------- |
| `thoughts`          |     ✓     |      ✓       |      ✓      |        ✓        | content + tags      | `content`                               |
| `decisions`         |     ✓     |      ✓       |      ✓      |        ✓        | title \n rationale [\n context] [\n alternatives joined `", "`] [\n tags joined `" "`] | same as embed text                      |
| `relationships`     |     ✓     |      ✓       |      ✓      |        ✓        | name \n context \n notes | same as embed text                 |
| `projects`          |     ✓     |      ✓       |      ✓      |        ✓        | name \n description | same as embed text                      |
| `sessions`          |     ✓     |      ✓       |      ✓      |        ✓        | summary [\n key_decisions] [\n next_steps] [\n blockers] (each joined `". "`) | `summary + "\|" + project`              |
| `ob_session_lanes`  |     ✓     |      ✓       |      ✓      |        ✓        | topic [\n project]  | `session_key + "\|" + topic`            |
| `ob_session_events` |     ✓     |      ✓       |      ✓      |        ✓        | content             | content                                 |
| `ob_entities`       |     ✓     |      ✗       |      ✗      |        ✗        | `entity_type: name` | (no column — see migration contract)    |

Two texts are tracked per table because they legitimately differ:

- **Embed text** is what goes to the provider (thoughts append tags; sessions
  append their structured continuity fields).
- **Source-hash input** is the exact string each write path feeds to
  `contentHash(...)`. Comparing the stored `content_hash` to a freshly computed
  one detects that the source was edited without a re-embed. The lane hash
  formula (`session_key | topic`) is deliberately not the embed text — matching
  `firstWriteLaneContentHash()` in `src/tools/append-session-event.ts`.

`decisions` and `sessions` embed and hash strings that the registry MUST compute
identically to their live writers, or repair would flag every fresh row as
drifted, regenerate a different vector, and rewrite the dedup key. To keep the
two sides from ever diverging, both the registry and the writers call one shared
pure module, `src/embedding-canonical.ts`:

- `decisionCanonicalText()` — decisions embed and hash the SAME string:
  `title \n rationale [\n context] [\n alternatives joined ", "] [\n tags joined " "]`,
  used by `log_decision` and `POST /api/v1/decisions`.
- `sessionSourceHashInput()` — `summary + "|" + project`, the hash input for
  `session_save`, `session_wrap`, and `POST /api/v1/sessions`.
- `sessionEmbedText()` — `summary [\n key_decisions] [\n next_steps] [\n blockers]`
  (each array joined with `". "`), the embed text for all three session writers.
  `session_wrap` has no `blockers` field, so that segment is simply absent — the
  builder is total over whichever fields a caller has. Historically `session_wrap`
  embedded the summary alone; it now shares this builder.

`alternatives` is a `jsonb` column and the session structured fields are
`text[]`; the shared builders coerce each safely (`coerceStringArray`) so a
legacy row that stored a jsonb value as its raw JSON text, `null`, or a scalar
degrades to "field absent" instead of corrupting the hash.

**Add-a-row rule:** when a new embedding column lands on any table, add one
entry to `EMBEDDING_TARGETS` and one row to the table above. The registry test
(`src/embedding-targets.test.ts`) fails until the name set matches, so a new
embedding-bearing table cannot silently escape repair coverage.

## Staleness reasons

Selected in priority order; a row may carry more than one:

| Reason         | Predicate                                              | Requires column   |
| -------------- | ----------------------------------------------------- | ----------------- |
| `missing`      | `embedding IS NULL`                                   | (always)          |
| `model_drift`  | `embedding_model IS DISTINCT FROM <current>`          | `embedding_model` |
| `source_drift` | stored `content_hash` != `hash(current source)`       | `content_hash`    |

A table that lacks the backing column **cannot** report the reason that depends
on it. `detectableReasons(target)` returns exactly what is runtime-truthful; a
requested-but-undetectable reason is dropped, never fabricated. For
`ob_entities` today, only `missing` is detectable.

`source_drift` is finalized in JS (the hash formula lives in TypeScript), so the
SQL narrows to `embedding IS NOT NULL AND content_hash IS NOT NULL` and the
exact comparison happens after projection.

## Repair safety invariants

- **Embeddings are generated outside DB locks.** `selectStale` (a plain SELECT)
  and the guarded UPDATE are separate round trips; the provider call in
  `repairOne` happens between them with no transaction open. A test asserts the
  embed call precedes the UPDATE.
- **No-overwrite guard (truthful, per real column).** The UPDATE carries a
  guard built from columns that actually exist on the target — it never
  fabricates provenance:
  - `content_hash` targets guard with
    `WHERE ... AND content_hash IS NOT DISTINCT FROM $observedHash`, where
    `$observedHash` is the stored hash seen at selection (NULL for a missing
    row). `IS NOT DISTINCT FROM` is NULL-safe, so a missing row (observed NULL)
    fills, a source-drifted row (observed = its stale stored hash) repairs and
    writes the fresh hash, and a row a concurrent writer re-embedded (its stored
    hash moved off the observed value) between selection and write matches zero
    rows — `repairOne` returns `skipped_source_changed` rather than clobbering
    the newer embedding. The guard binds the OBSERVED hash, not the fresh one:
    guarding on the fresh hash would never match a drifted row and drift could
    never repair.
  - targets **without** `content_hash` (`ob_entities`) guard with
    `WHERE ... AND embedding IS NULL AND <src> IS NOT DISTINCT FROM $captured`
    for each declared `sourceGuardColumns` entry. `embedding IS NULL` alone stops
    a concurrent embedding write from being clobbered, but it does **not** stop
    writing an embedding built from now-stale `entity_type`/`name` after a
    concurrent source edit that left the embedding NULL. The NULL-safe source
    snapshot closes that gap: if any guarded source column changed since
    selection, the UPDATE matches zero rows and repair returns
    `skipped_source_changed`. These are real, physically present columns — no
    `content_hash` is invented. Add-a-row rule: a new target that lacks a
    `content_hash` column MUST declare `sourceGuardColumns` (a registry test
    enforces this and that every guarded column is projected).
- **Idempotent / convergent duplicate delivery.** Repairing the same unchanged
  unit twice issues the identical guarded UPDATE (same vector shape, hash,
  model), so at-least-once delivery from a queue converges. A provider failure
  leaves the row untouched.
- **Bounded batches.** `selectStale` clamps `limit` to `[1, MAX_BATCH=500]`,
  defaulting to `DEFAULT_BATCH=100`.
- **Content-free failure classification.** Provider failures map to
  `retryable_failure` (`timeout` / `network` / `server_error`) or
  `permanent_failure` (`client_error` / `input_invalid` / `malformed_response` /
  `no_embedding_url`). The failure log records `{ table, id, code, retryable }`
  only — never the embed text.
- **Namespace scope is EXPLICIT and mandatory (bound on read AND write).**
  Every `selectStale` / `repairOne` / `repairStaleBatch` call requires a
  `scope`. Omission is **not** a scope: there is no unscoped default, and a
  missing or empty scope throws before any query or provider call. A scope is
  one of two named shapes:
  - `{ namespaces: [...] }` — the safe, mandatory path: a **non-empty**
    auth-derived allowlist (blank/whitespace-only entries are stripped; an
    all-blank list fails closed). BOTH the selection SELECT and the guarded
    UPDATE bind it, so an id-only read or write can never cross a namespace
    boundary. Targets with a `namespace` column add `namespace = ANY($n::text[])`;
    targets isolated via a foreign key (`ob_session_events` → `ob_session_lanes`
    via `lane_id`, declared as `namespaceVia`) add a correlated
    `EXISTS (SELECT 1 FROM <parent> WHERE <parent>.<key> = <target>.<fk> AND
    <parent>.namespace = ANY($n::text[]))`.
  - `{ global: true }` — a **separately named, explicit** intentionally-global
    path for a global-role caller (e.g. an admin backfill). It emits no
    namespace predicate, but it is a deliberate, self-documenting choice at the
    call site, never an accidental default.

  All table/column identifiers come from the static registry (allowlisted); the
  namespace value list is always parameterized. A target that declares neither
  binding cannot be scoped: supplying a `{ namespaces: [...] }` scope for it
  **fails closed** (throws) rather than returning or mutating unscoped rows.
  Callers must pass an auth-derived namespace list; the primitive does not
  resolve auth. Every target in the registry declares exactly one binding (a
  test enforces this).

## `ob_entities` migration contract (documentation only — not applied)

`ob_entities` has an `embedding` column (`010_entity_links.sql`) but no
`content_hash`, `embedded_at`, or `embedding_model`. Repair therefore supports
only `missing` detection there and writes only the `embedding` column — it does
**not** invent provenance. Because it cannot guard on a hash, it declares
`sourceGuardColumns: ["entity_type", "name"]` so the guarded UPDATE snapshot-
guards those real source columns (in addition to `embedding IS NULL`) and never
writes an embedding built from source text that changed since selection.

To make model-drift and source-drift detectable for entities, a future
migration (verify the next free number before authoring — the latest committed
migration is **028**; this lane intentionally adds no migration to avoid a
number collision) would add the smallest column set:

```sql
-- 0NN_entity_embedding_provenance.sql  (illustrative — do not apply from here)
ALTER TABLE ob_entities
  ADD COLUMN IF NOT EXISTS content_hash    TEXT,
  ADD COLUMN IF NOT EXISTS embedded_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;
```

When that lands, flip `ENTITY_PROVENANCE` in `src/embedding-targets.ts` to full
provenance and point the entity write path (`src/tools/hydrate-entities.ts`,
`upsert-entity.ts`, `repo-facts.ts`) at `contentHash("entity_type: name")` so
the stored hash matches the registry's `sourceHash`. Until both are done, the
registry keeps entity provenance `false` and repair stays truthful.

The registry's `EntityTarget.sourceHash` is already defined (hashing
`"entity_type: name"`) so the migration + code flip is a one-line provenance
change plus the write-path hash — no new mapping to invent.
