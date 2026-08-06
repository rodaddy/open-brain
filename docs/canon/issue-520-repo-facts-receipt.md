# Issue #520 repository-fact closure receipt

**State:** RUNNING for the five dogfood database fact sets; WRITTEN for the reviewable canon-pack sources.

The 35 new facts were verified on 2026-08-05 against the five source commits named below and the local dogfood Open Brain. The older Development/king facts in the pack inventory were mirrored from live rows with their stored provenance; their historical source claims were not independently re-verified in this run. No credential values are recorded here. The write namespace was supplied by `OPENBRAIN_NAMESPACE` from the installed Open Brain environment.

## Write mechanism

The five thin repositories were seeded through `OpenBrainClient.call_tool("upsert_repo_fact", ...)`, the same `upsert_repo_fact` boundary used by the earlier repository seeding. Every write carried the complete `repoFactMetadata` provenance tuple:

- exact git-root basename in `repo`
- `source_commit`
- commit-pinned GitHub `source_url` for the exact source path
- `verified_at`
- `source_system = qmd`, `collection = canon-pack`, fact type, subject, staleness policy, and refresh hint

The committed TOML files are the reviewable source for all current Development and king-* repository facts. They intentionally do not use `openbrain-canon-reconcile --apply`: issue #588 tracks the repo-fact apply-path defect. The live writes used the direct Open Brain client and were independently read back.

## New facts written and read back

Each repository now has eight standing facts: the original 2026-06-18 baseline fact plus seven source-verified additions. A direct SQL read-back reported `8` rows and `8` rows with `source_commit`, `source_url`, and `verified_at` for every repository.

### king-trading

Source commit: `3330edb8a367279a3c5d2c983a1d38a711bf7bf0`

- `repo.king_trading.runtime_shape`
- `repo.king_trading.mode_and_ws_guard`
- `repo.king_trading.health_semantics`
- `repo.king_trading.pretrade_risk`
- `repo.king_trading.signal_subscription`
- `repo.king_trading.deploy_target`
- `repo.king_trading.ci_gates`

Read-back: all seven keys matched the stored repo, collection, path, subject, fact type, fact text, source commit, source URL, and verification timestamp.

### king-status

Source commit: `bc67563f9842652077caaddffeae5830289a09dc`

- `repo.king_status.runtime_shape`
- `repo.king_status.combined_status`
- `repo.king_status.admin_guard`
- `repo.king_status.board_mutations`
- `repo.king_status.strategic_storage`
- `repo.king_status.ci_scope`
- `repo.king_status.deploy_target`

Read-back: all seven keys matched the stored repo, collection, path, subject, fact type, fact text, source commit, source URL, and verification timestamp.

### king-ops

Source commit: `d29c642f02bce0314ff63f8d83e708fb50b69201`

- `repo.king_ops.service_boundary`
- `repo.king_ops.auth_mode`
- `repo.king_ops.allocator`
- `repo.king_ops.factory`
- `repo.king_ops.session_cas`
- `repo.king_ops.ci_scope`
- `repo.king_ops.deploy_contract`

Read-back: all seven keys matched the stored repo, collection, path, subject, fact type, fact text, source commit, source URL, and verification timestamp.

### king-market-data

Source commit: `e3cb1fccc73ad3906685446a0395b134ccfd1ee6`

- `repo.king_market_data.required_config`
- `repo.king_market_data.headless_start`
- `repo.king_market_data.session_api`
- `repo.king_market_data.nats_wire`
- `repo.king_market_data.bar_loading`
- `repo.king_market_data.tick_generation`
- `repo.king_market_data.test_preload`

Read-back: all seven keys matched the stored repo, collection, path, subject, fact type, fact text, source commit, source URL, and verification timestamp.

### king-reconciliation

Source commit: `5299409758dedc1afaab6bc2bfcc3e698c5d9e0c`

- `repo.king_reconciliation.identity`
- `repo.king_reconciliation.implemented_not_scaffold`
- `repo.king_reconciliation.pure_core`
- `repo.king_reconciliation.break_types`
- `repo.king_reconciliation.auth_mode`
- `repo.king_reconciliation.route_boundaries`
- `repo.king_reconciliation.deploy_gate`

Read-back: all seven keys matched the stored repo, collection, path, subject, fact type, fact text, source commit, source URL, and verification timestamp.

## Reviewable pack inventory

The twelve new pack files parse as 92 entries total. The five target packs contain the 35 source-verified additions plus their five older baseline rows; the other seven packs mirror live rows and stored provenance into reviewable files:

| Pack | Entries |
|---|---:|
| `development-repo-facts.toml` | 8 |
| `king-agents-repo-facts.toml` | 8 |
| `king-core-repo-facts.toml` | 8 |
| `king-dashboard-repo-facts.toml` | 7 |
| `king-infra-repo-facts.toml` | 6 |
| `king-ingest-repo-facts.toml` | 7 |
| `king-market-data-repo-facts.toml` | 8 |
| `king-ops-repo-facts.toml` | 8 |
| `king-reconciliation-repo-facts.toml` | 8 |
| `king-signals-repo-facts.toml` | 8 |
| `king-status-repo-facts.toml` | 8 |
| `king-trading-repo-facts.toml` | 8 |

The pre-existing `open-brain-repo-facts.toml` remains the source for open-brain itself and is not counted above.

## Database count receipt

```text
king-market-data  8  8
king-ops          8  8
king-reconciliation  8  8
king-status       8  8
king-trading      8  8
```

Columns are repository, standing fact count, and standing facts carrying all three drift-provenance fields.

## Validation scope

No production code or test was added. The applicable functional checks are canon-pack parsing, repository type checking, the focused canon test suite, Python package checks, direct Open Brain read-back, and PR-body contract validation. Final command receipts are recorded in the pull request.
