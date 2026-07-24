# Language-Aware FTS Operations

Operator runbook for the language-aware full-text-search configuration
introduced in #341 (PR #368) and hardened by the #368 post-merge fixes:
enabling a non-English deployment default, what each role sees, the cost
profile of the unindexed path, monitoring, and rollback.

Audience: whoever operates a hosted Open Brain deployment (launchd service on
core01, or any environment that sets the process env).

## What the knob does

`OPENBRAIN_FTS_CONFIG` sets the deployment-default text-search configuration
for the public `search_brain` tool's keyword and hybrid modes. Accepted values
are the allowlisted Postgres-shipped regconfigs (`english`, `simple`,
`spanish`, `french`, `german`, `portuguese`) or a language token that resolves
to one (`de`, `de-DE`, `pt_BR`, ...). Anything unrecognized falls back to
`english`; a typo can never disable lexical search.

- `english` (default, or unset): keyword/hybrid use the stored GIN-indexed
  `search_vector` column -- byte-identical to pre-#341 behavior.
- Non-English config: keyword/hybrid recompute
  `to_tsvector('<config>', <same source columns>)` per row at query time.
  There is no index for that expression, so these are sequential scans over
  the candidate tables.

The env default only affects the public `search_brain` handler. Sibling
internal `executeSearch` consumers (e.g. `brain_answer`) keep the English
default unless they pass a config explicitly.

## Privilege boundary (who sees what)

The boundary applies to the **effective** config for keyword/hybrid searches,
whether it arrived via the request's `fts_config` argument or the env default:

| Caller role | Explicit non-English `fts_config` | Non-English via env default only | `search_mode: "vector"` |
|-------------|-----------------------------------|----------------------------------|-------------------------|
| `admin`, `ob-admin` | Applied | Applied | `fts_config` unused/ignored |
| `agent`, `readonly`, `discord`, `promoter` | Content-free permission denial | **Silently degrades to English** (indexed path, request succeeds) | `fts_config` unused/ignored; request succeeds |

Notes:

- The env-default degrade is deliberate: it preserves availability and the
  exact pre-#341 behavior/cost for ordinary roles instead of turning an
  operator env change into a fleet-wide denial. Only privileged roles pay the
  unindexed cost.
- Any caller may always explicitly request `english`, even when the env
  default is non-English.
- Vector mode performs no FTS, so `fts_config` neither denies nor influences
  execution there.

## Cost profile and the statement timeout

The non-default path recomputes `to_tsvector` for every candidate row in each
searched table on every keyword/hybrid query. Expect latency to scale with
table row counts, not with result `limit` -- the scan work happens before
`LIMIT` applies.

To bound worst-case database cost, every permitted non-default FTS statement
runs inside a transaction with a transaction-scoped
`SET LOCAL statement_timeout`:

- Knob: `OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS`
- Default: `5000` (milliseconds)
- Validation: must be a positive base-10 integer. Unset, blank, zero,
  negative, fractional, or non-numeric values fall back to the default; the
  raw env text is never interpolated into SQL.
- Scope: applied only when the effective config is non-default. The English
  GIN-indexed path never pays it and runs as a plain pooled query.
- A query that exceeds the bound fails that search with a Postgres
  `statement_timeout` error (surfaced as a tool error); it does not affect
  other connections, and `SET LOCAL` guarantees the pooled connection is
  returned with its default timeout intact.

## Enable

1. Set the env for the service process, e.g. in the deployment `.env`:

   ```env
   OPENBRAIN_FTS_CONFIG=german
   # optional, ms; default 5000
   OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS=5000
   ```

2. Restart the service (hosted core01: `launchctl kickstart -k` the
   `com.rico.open-brain` job, or the deployment SOP's restart step).

3. Verify:
   - An `admin`/`ob-admin` keyword search returns language-stemmed matches
     (e.g. german corpus: a query for `Haus` matches a document containing
     `Häuser`).
   - An ordinary-role (`agent`) keyword search still succeeds and behaves as
     English (degrade path) -- no permission errors from the env change.
   - Latency of admin keyword/hybrid searches is acceptable (see below).

## Monitor

- **Latency:** watch keyword/hybrid `search_brain` latency for privileged
  callers after enabling. The unindexed path is the only new slow path; if
  p95 approaches the statement timeout, either lower expectations, raise
  `OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS` deliberately, or roll back.
- **Timeout hits:** search errors containing `statement timeout` indicate the
  bound is firing. Frequent hits mean the corpus is too large for on-the-fly
  recompute; roll back or plan an indexed migration before widening use.
- **pg_stat_statements:** on-the-fly scans are visible as statements containing
  `to_tsvector('german'` (or the configured language) rather than
  `search_vector`. Track their `mean_exec_time`/`calls`:

  ```sql
  SELECT calls, mean_exec_time, left(query, 120)
  FROM pg_stat_statements
  WHERE query LIKE '%to_tsvector(''german''%'
  ORDER BY mean_exec_time DESC;
  ```

- **Sequential scans:** `pg_stat_user_tables.seq_scan` on `thoughts`,
  `decisions`, `relationships`, `projects`, `sessions` will rise with
  non-default search volume.

## Rollback

1. Unset `OPENBRAIN_FTS_CONFIG` (remove it from the env / `.env`).
2. Restart the service.
3. Behavior is byte-identical to the English-only deployment: all roles use
   the stored GIN-indexed `search_vector` column, no statement-timeout
   transaction wrapping, no schema or data changes to undo (the feature
   performs no migration and stores nothing).

`OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS` may stay set; it is inert while the
effective config is English.

## Related

- `src/tools/fts-config.ts` -- allowlist, env resolution, timeout validation.
- `src/tools/search-brain.ts` -- privilege gate, `runBoundedFtsQuery`
  execution boundary.
- `docs/README.md` "Search" section -- user-facing summary.
- `docs/sme/security.md` [2026-07-23] "Caller-selectable unindexed query modes
  need privilege, rate, and cost controls".
