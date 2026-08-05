# Design decisions

## Why this directory exists

**Design content must not live only in GitHub issues.** The working tree cannot
see an issue body. Neither can `.qmd`, `rg`, or any agent doing a repo search
before it starts work. When a decision lives only in a closed issue, the next
agent does not find it, concludes it was never decided, and re-derives it —
usually differently.

Open Brain has already named this the single most repeated agent failure across
sessions: *"DIDNT WE ALREADY DESIGN THAT"* — roughly 15 occurrences. It is an
**agent retrieval failure, not a memory-system failure.** The trigger for this
directory was the R3 promotion authority model being re-derived from scratch
because it lived only in a doc that had been merged then reverted, plus in
issue bodies.

Two rules follow:

1. If a decision has rationale worth not re-litigating, it goes in a file here.
   An issue may still be where it was *made*; it is not where it *lives*.
2. Absence from the working tree is not proof of absence. Content can live on
   another branch or in a reverted commit — check
   `git log --all --oneline -- <path>` before concluding a design was never
   written.

Each file records the **decision** and its **rationale**, quotes load-bearing
wording verbatim, and names anything that later superseded it rather than
silently dropping it.

## Index

| File | Source issues | Summary |
|------|---------------|---------|
| [privilege-isolation-closed-brain.md](./privilege-isolation-closed-brain.md) | #118 | The law-client "Privilege Isolation" product model behind `src/source-refs.ts` — structured source refs, client/matter/ethical-wall isolation metadata, and matter-scoped retrieval that must **fail closed** when scope is missing. |
| [cognitive-tiering-dream-cycle.md](./cognitive-tiering-dream-cycle.md) | #12 | Tier-column-not-tables and access-log-not-counter rationale, plus the designed-but-unbuilt phases (consolidation, prune, 90-day discard expiry) that explain the orphan columns in migration 006. |
| [contract-is-the-agent-surface.md](./contract-is-the-agent-surface.md) | #172, #176 | `get_contract` is a contract-driven agent's *entire* knowledge, so help not in the contract is unreachable — and the non-leaking `share_candidate` rejection contract (label never value, bounded resubmission) that depends on it. |
| [shared-kb-canonical-namespace.md](./shared-kb-canonical-namespace.md) | #144, #154 | Fallback Policy v1 as an ordered merge/dedupe/tie-break algorithm, and why fallback triggers on **result count** rather than score thresholds (scores are not comparable across search modes). |
| [channel-scoped-recall.md](./channel-scoped-recall.md) | #130 | Default auto-injected recall is scoped to the active session/thread/parent channel; crossing channels requires explicit intent and the result must be source-labeled with its lane. |
| [qmd-derived-facts.md](./qmd-derived-facts.md) | #132 | qmd is GPU-only, so OB is the required distribution layer for repo knowledge — carrying curated facts with source pointers, explicitly **not** mirroring raw code chunks. Includes the `fact_type` metadata convention. |
| [admin-and-promoter-identities.md](./admin-and-promoter-identities.md) | #168 (rel. #159, #147) | Why `promoter` (least-privilege, lane→shared-kb) and `ob-admin` (human break-glass) are separate, and exactly which privileges `promoter` is denied. |
| [transcript-refs-and-citation-recall.md](./transcript-refs-and-citation-recall.md) | #288 | Transcript refs must be host-neutral (`collab/...`, never `/Volumes/` or `/mnt/`), and citation recall must report `source_not_stored` rather than invent a source. |
| [fleet-bus-c6-envelope-vs-body.md](./fleet-bus-c6-envelope-vs-body.md) | #291 | Coordination rides the typed envelope (`typed_signal`); `payload` is opaque and control-looking body text is inert. Never scrape payload or reply text for completion/stance/routing. |

## Harvest #522 index

Recorded 2026-08-03 from closed issue/PR history under the operator ruling on the
#522 canon harvest: decision records are files here, not canon rows. Each carries
its scope key as identity, the distilled rule, a verbatim quote, and its source.

| File | Source | Scope key |
|------|--------|-----------|
| [redaction-is-three-policies.md](./redaction-is-three-policies.md) | rodaddy/open-brain#77 (issue body) | `decision.redaction_is_three_policies_not_one` |
| [only-idempotent-writes-are-retried.md](./only-idempotent-writes-are-retried.md) | rodaddy/open-brain#74, #85 (comments by rodaddy) | `decision.only_idempotent_writes_are_retried` |
| [dream-once-is-dry-run-only.md](./dream-once-is-dry-run-only.md) | rodaddy/open-brain#75 (comment by rodaddy) | `decision.dream_once_is_dry_run_only` |
| [openbrain-memory-package-ownership.md](./openbrain-memory-package-ownership.md) | rodaddy/open-brain#66, #71 (issue bodies) | `decision.openbrain_memory_package_ownership_and_placement` |
| [dream-proposes-promoter-applies.md](./dream-proposes-promoter-applies.md) | issue #161 (comment by rodaddy, design correction 2026-06-19) | `architecture.dream_proposes_promoter_applies` |
| [openbrain-memory-is-the-canonical-client.md](./openbrain-memory-is-the-canonical-client.md) | issue #177 ("Make openbrain-memory importable/installable + canonical redaction") | `architecture.openbrain_memory_is_the_canonical_client` |
| [redaction-is-display-time.md](./redaction-is-display-time.md) | https://github.com/rodaddy/open-brain/issues/232 | `architecture.redaction_is_display_time_not_write_path` |
| [nats-consumes-fleet-nats.md](./nats-consumes-fleet-nats.md) | https://github.com/rodaddy/open-brain/issues/223 | `architecture.nats_consumes_fleet_nats_not_own_fork` |
| [context-pack-boundaries-contract-first.md](./context-pack-boundaries-contract-first.md) | https://github.com/rodaddy/open-brain/issues/220 | `architecture.context_pack_boundaries_and_contract_first` |
| [deploy-is-explicit-not-merge-triggered.md](./deploy-is-explicit-not-merge-triggered.md) | https://github.com/rodaddy/open-brain/issues/240 | `process.deploy_is_explicit_not_merge_triggered` |
| [new-transport-reuses-the-assembler.md](./new-transport-reuses-the-assembler.md) | https://github.com/rodaddy/open-brain/pull/262 | `architecture.new_transport_reuses_authoritative_assembler` |
| [audit-logging-carries-no-raw-values.md](./audit-logging-carries-no-raw-values.md) | https://github.com/rodaddy/open-brain/issues/269 | `architecture.audit_logging_no_raw_values` |
| [eval-gate-precedes-retrieval-change.md](./eval-gate-precedes-retrieval-change.md) | https://github.com/rodaddy/open-brain/issues/265 | `process.eval_gate_precedes_retrieval_change` |
| [server-deploys-before-client-publishes.md](./server-deploys-before-client-publishes.md) | https://github.com/rodaddy/open-brain/issues/265 | `process.server_deploys_before_client_publishes` |
| [log-rotation-is-app-config.md](./log-rotation-is-app-config.md) | https://github.com/rodaddy/open-brain/issues/193 | `architecture.log_rotation_is_app_config_not_host_tooling` |
| [pr-review-workflow-is-codex-on-core01.md](./pr-review-workflow-is-codex-on-core01.md) | https://github.com/rodaddy/open-brain/issues/231 | `architecture.pr_review_workflow_is_codex_on_core01` |
| [context-pack-owns-prompt-ready-bundles.md](./context-pack-owns-prompt-ready-bundles.md) | https://github.com/rodaddy/open-brain/issues/271 | `architecture.context_pack_owns_prompt_ready_bundles` |
| [nats-runs-as-a-dedicated-worker.md](./nats-runs-as-a-dedicated-worker.md) | issue #282 | `architecture.nats_runs_as_dedicated_worker_not_http_mode` |
| [client-parity-is-a-build-failure.md](./client-parity-is-a-build-failure.md) | issue #311 | `process.client_parity_is_a_build_failure` |
| [supersession-by-accumulated-support.md](./supersession-by-accumulated-support.md) | issue #396 (DREAM-7: Supersession) | `repo.open_brain.supersession_by_accumulated_support` |
| [reinforcement-is-not-confidence.md](./reinforcement-is-not-confidence.md) | issue #398 (DREAM-9: Semantic near-dupe merge) | `repo.open_brain.reinforcement_is_not_confidence` |
| [semantic-dupe-threshold-091.md](./semantic-dupe-threshold-091.md) | issue #398 (DREAM-9) | `repo.open_brain.semantic_dupe_threshold_091` |
| [dream-light-is-model-free.md](./dream-light-is-model-free.md) | issue #389 (Epic DREAM) / #390 (DREAM-1) | `repo.open_brain.dream_light_model_free_write_path` |
| [dream-stage-certainty-boundaries.md](./dream-stage-certainty-boundaries.md) | issue #389 (Epic DREAM) | `repo.open_brain.dream_stage_certainty_boundaries` |
| [four-b-mislabel-measurement-invalid.md](./four-b-mislabel-measurement-invalid.md) | issue #435 (DREAM-11) | `repo.open_brain.four_b_mislabel_measurement_invalid` |
| [review-rate-is-output-not-schedule.md](./review-rate-is-output-not-schedule.md) | issue #436 (DREAM-12) | `repo.open_brain.review_rate_is_output_not_schedule` |
| [no-second-query-path.md](./no-second-query-path.md) | issue #437 (Web service) | `repo.open_brain.no_second_query_path` |
| [authority-tiers-canon-decided-observed.md](./authority-tiers-canon-decided-observed.md) | issue #404 (SHAPE-4: authority) | `repo.open_brain.authority_tiers_canon_decided_observed` |
| [archaeology-survives-the-squash.md](./archaeology-survives-the-squash.md) | issue #407 (SHAPE-7: rename) | `repo.open_brain.archaeology_survives_the_squash` |
| [canon-small-and-canon-only.md](./canon-small-and-canon-only.md) | issue #438 (CANON-1) and #439 (CANON-2) | `repo.open_brain.canon_small_and_canon_only` |
| [canon-plus-index-two-halves.md](./canon-plus-index-two-halves.md) | issue #440 (SEARCH-1) | `repo.open_brain.canon_plus_index_two_halves` |
| [distillation-proposes-never-promotes.md](./distillation-proposes-never-promotes.md) | issue #382 (DISTILL-1) | `repo.open_brain.distillation_proposes_never_promotes` |
| [client-applies-no-salience.md](./client-applies-no-salience.md) | issue #380 (INGEST-1) | `repo.open_brain.client_applies_no_salience` |
| [supervisor-trips-before-it-notifies.md](./supervisor-trips-before-it-notifies.md) | issue #399 (DREAM-10: Loop supervisor) | `repo.open_brain.supervisor_trips_before_it_notifies` |
| [adoption-ceiling-is-pgvector-install.md](./adoption-ceiling-is-pgvector-install.md) | issue #405 (SHAPE-5) | `repo.open_brain.adoption_ceiling_is_pgvector_install` |
| [canon-two-level-pointer-not-body.md](./canon-two-level-pointer-not-body.md) | https://github.com/rodaddy/open-brain/issues/444 | `canon.two_level_pointer_not_body` |
| [canon-typed-promote-metadata.md](./canon-typed-promote-metadata.md) | https://github.com/rodaddy/open-brain/issues/445 | `canon.write_path.typed_promote_metadata` |
| [canon-scope-key-required.md](./canon-scope-key-required.md) | https://github.com/rodaddy/open-brain/issues/445 | `canon.lifecycle.scope_key_required` |
| [canon-lens-is-composition-not-voice.md](./canon-lens-is-composition-not-voice.md) | https://github.com/rodaddy/open-brain/issues/452 | `canon.lens_is_composition_not_voice` |
| [orchestration-is-downstream.md](./orchestration-is-downstream.md) | https://github.com/rodaddy/open-brain/issues/452 | `openbrain.scope.orchestration_is_downstream` |
| [index-names-state-contents.md](./index-names-state-contents.md) | https://github.com/rodaddy/open-brain/issues/448 | `naming.index_names_state_contents` |
| [canon-reconciler-dry-run-default.md](./canon-reconciler-dry-run-default.md) | https://github.com/rodaddy/open-brain/pull/493 | `canon.reconciler_files_to_ob_dry_run_default` |
| [min-client-versions-is-a-deprecation-floor.md](./min-client-versions-is-a-deprecation-floor.md) | https://github.com/rodaddy/open-brain/pull/497 | `release.min_client_versions_is_deprecation_floor` |

## Also recoverable from git, not rewritten here

Two design docs were merged and then reverted. They are intact in history and
should be restored from git rather than reconstructed:

| Doc | Lines | Restore with | Notes |
|-----|-------|--------------|-------|
| `docs/code-brain-design.md` | 437 | `git show a659c4a:docs/code-brain-design.md` | merged as `75a85a5`, reverted by `39e591e` / `19f9b86` |
| `docs/full-send-derivation-spec.md` | 280 | `git show 3f72bee:docs/full-send-derivation-spec.md` | merged as `3f72bee`, reverted by `2e185d1` / `19f9b86`; referenced by closed issue #380 |

## Where other settled design already lives

Not everything belongs here — much of the design corpus is already in the tree.
Notably: [`../dream-ethereal-runs.md`](../dream-ethereal-runs.md) (the R3
promotion authority model),
[`../agent-context-pack-contract.md`](../agent-context-pack-contract.md),
[`../memory-contract.md`](../memory-contract.md),
[`../identity-boundary.md`](../identity-boundary.md),
[`../agent-memory-adapter-contract.md`](../agent-memory-adapter-contract.md),
and [`../sme/`](../sme/) for review-lane knowledge.
