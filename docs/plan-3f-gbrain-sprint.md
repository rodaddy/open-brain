# Plan 3F: gbrain-Informed Graph Retrieval Sprint

Updated: 2026-07-08T00:15Z.

## Critical Read

Live GitHub and Project 8 are the source of truth. This plan is the local
controller for the sprint created from the gbrain audit, but board state wins
when it changes.

Confirmed live state when this plan was created:

- Open Brain repo: `rodaddy/open-brain`.
- Open Brain board: Project #8, Open Brain Work Board.
- Sprint umbrella: #265 `Sprint: gbrain-informed graph retrieval and operator hardening`.
- Sprint issues:
  - #266 `Add relational retrieval eval and no-regression fixtures`
  - #267 `Add graph-powered relational retrieval arm to search_brain`
  - #268 `Expose graph-expanded evidence safely in brain_answer and search_all`
  - #269 `Add privacy-safe MCP/tool request audit logging`
  - #270 `Add operator doctor/status surface for Open Brain health`
  - #271 `Evaluate lightweight hot-memory path through agent_context_pack`
- Related active non-sprint work:
  - #223 is open and blocked on fleet-bus/live NATS rollout plus parity/canary
    evidence. Do not close #223 from this sprint.
  - PR #264 was checked after the sprint was created and is not part of this
    sprint.

Current execution update, 2026-07-08T00:15Z:

- Planning PR #272 merged as `a838735`.
- #266 merged via PR #273 as `7cb7712` and is closed Done on Project #8.
- #267 PR #274 is open from `feat/267-graph-relational-search`; implementation
  commit `5fd66ed` is followed by plan-sync commits as board/HTML state changes.
  Project #8 has #267 In Review, Review Gate Initial Swarm Pending, and
  Validation CI Pending.
- #267 implementation adds the bounded relational parser, graph hydration, and
  RRF fusion path in `src/tools/search-brain.ts`.
- #267 local validation passed:
  `bun test src/tools/__tests__/search-brain-relational-retrieval.test.ts scripts/assert-db-tests-ran.test.ts`,
  `bun test src/tools/__tests__/search-brain.test.ts src/tools/__tests__/search-brain-relational-retrieval.test.ts`,
  `bunx tsc --noEmit`, `git diff --check`, and full `bun test`.
- Live-Postgres relational `search_brain` cases are present but local-skipped
  without `OPENBRAIN_TEST_DATABASE_URL`; the anti-skip guard now requires two
  relational live-Postgres testcases in CI.
- #223 remains open and Blocked.

Critical correction:

- Graphs help only when graph links are a retrieval signal. Open Brain already
  has `ob_entities`, `ob_links`, and `adjacent_context`; this sprint must not
  add a second graph store or a visual graph UI.
- #266 and #267 are a hard pair. #267 must not be marked ready, merged, or
  closed unless #266 proves relational lift and non-relational no-regression.

## Operating Boundary

- Mode: local implementation, validation, PRs, review, and board hygiene.
- No core01 deploy, live DB migration, hosted NATS setup, fleet-bus rollout, or
  downstream Hermes canary without explicit Rico approval.
- Use one focused branch/worktree per issue or tightly coupled issue pair under
  `/Volumes/ThunderBolt/_tmp/open-brain`.
- Keep Project 8 current before work starts, during review, and after
  validation/merge.
- Use the repo review gate for every non-trivial PR:
  - critical self-review receipt;
  - validation evidence;
  - downstream rollout classification;
  - review swarm sized to risk;
  - fix verification after material findings.
- If a PR touches `python/openbrain-memory/`, include the gotcha-agent lane from
  `docs/sme/gotcha-agent.md`.
- Do not treat a board update as implementation progress. If board/status work
  takes more than two rounds, move to the next safe implementation step or call
  a real blocker.

## Visual Companion Rule

This Plan 3F has an HTML/spec companion:

- repo source: `specs/plan-3f-gbrain-sprint.html`;
- repo assets: `specs/plan-3f-gbrain-sprint/`;
- verifier: `specs/plan-3f-gbrain-sprint.verify.sh`;
- finished Open Brain site output:
  `/Volumes/collab/sites/open-brain/plans/plan-3f-gbrain-sprint.html`;
- finished Open Brain site assets:
  `/Volumes/collab/sites/open-brain/plans/plan-3f-gbrain-sprint/`.

Rules for future updates:

- include a proper favicon, not a missing browser default;
- use generated bitmap imagery for the primary visual asset;
- save generated project assets under `specs/<artifact-name>/` for source and
  copy the finished output under `/Volumes/collab/sites/open-brain`;
- keep the HTML source linked to local assets;
- do not leave project-referenced images only under Codex generated-image cache
  paths;
- avoid decorative placeholder-only art. The image should communicate graph
  retrieval, bounded evidence, and operator control.

## 3F Structure

### F1 - Facts

- Open Brain current graph substrate:
  - `ob_entities` stores typed entities with namespace, metadata, and
    embeddings.
  - `ob_links` stores typed polymorphic links with relation, weight, namespace,
    metadata, and lifecycle fields.
  - `adjacent_context` reads one-hop linked context with namespace checks.
- Current gap:
  - `search_brain` fuses vector and keyword rows first, then attaches explicit
    links as metadata. Links do not currently produce retrieval candidates.
  - `search_all` and `brain_answer` currently suppress explicit link attachment
    in their search calls.
- gbrain prior-art finding:
  - Typed-edge relational recall is useful when the answer is only in an edge,
    not in the text body.
  - The valuable pattern is deterministic relational parsing, scoped seed
    resolution, bounded typed-edge fanout, hydration into normal search rows,
    RRF fusion, and A/B no-regression tests.
- Security invariant:
  - Namespace/read policy must apply at seed resolution, traversal, hydration,
    answer citation, and audit logging boundaries.

### F2 - Flow

The sprint runs in three paired tracks.

Pair A is the required first gate:

- #266 creates the eval/no-regression proof.
- #267 implements the graph retrieval arm.
- Preferred shape: two workers in parallel after a short shared interface
  decision. Worker A owns fixtures/evals. Worker B owns retrieval design and
  spike code. The controller decides whether to land as one PR or two PRs.
- Merge rule: if split, #266 lands first or #267 remains blocked until #266 is
  merged and passing. If combined, the PR closes both only when both acceptance
  surfaces are satisfied.

Pair B runs after Pair A:

- #268 wires graph-expanded evidence into answer/search surfaces.
- #271 decides whether hot memory belongs in `agent_context_pack`, MCP `_meta`,
  or should remain deferred.
- Merge rule: #268 can start after #267 exists; #271 must not implement prompt
  injection until exact-scope tests and the owning boundary are settled.

Pair C can run independently:

- #269 adds privacy-safe tool/audit logging.
- #270 adds a stable operator `doctor/status` surface.
- Merge rule: #270 can use #269's audit health if #269 lands first, but neither
  should block Pair A.

### F3 - Finish

Sprint completion requires:

- #266, #267, #268, #269, and #270 closed with verified PRs or explicitly
  deferred by Rico.
- #271 either closed with a boundary decision/implementation or intentionally
  left open with a clear post-graph next action.
- Project 8 fields current for #265-#271.
- No accidental closure of #223.
- No live deploy claimed unless a separate release/deploy run is approved and
  executed.

## Issue Order

### 1. Pair A setup - #266 and #267

Owning boundary:
Open Brain search retrieval quality.

Required setup before code:

- Refresh current `search_brain`, `adjacent_context`, `ob_entities`,
  `ob_links`, and relevant namespace/read-policy tests.
- Decide the smallest relation vocabulary for v1. Start with Open Brain-native
  operational relations, not gbrain's company/person relations.
- Decide whether the pair lands as:
  - one PR closing both #266 and #267; or
  - #266 eval PR first, then #267 implementation PR.

Hard gate:
#267 is not ready until #266 proves lift and no-regression.

### 2. #266 relational retrieval eval and no-regression fixtures

Owning boundary:
Eval harness and deterministic local fixtures.

Required local work:

- Add a fixture with at least 20 relational questions across Open Brain-native
  relations.
- Seed graph cases where the answer is not recoverable by text alone.
- Add graph-off vs graph-on result comparison.
- Add non-relational no-op/no-regression coverage.
- Add namespace leak tests.
- Add archived link/entity exclusion coverage.
- Keep the fixture local/CI runnable without live Open Brain or external
  services.

Verification:

- Focused eval/test command for the fixture.
- Existing relevant search/namespace tests.
- `bunx tsc --noEmit`.
- Full `bun test` if shared search helpers are touched.

### 3. #267 graph-powered `search_brain` retrieval arm

Owning boundary:
Server-side retrieval fusion in `search_brain`.

Required local work:

- Add a deterministic, precision-first relational query parser.
- Resolve seed entities only inside readable namespaces.
- Traverse `ob_links` with bounded depth and limit.
- Exclude archived links/entities.
- Hydrate graph candidates into normal search rows with source refs.
- Fuse graph candidates as a retrieval arm only when the parser fires and seeds
  resolve.
- Fail open on graph-arm errors, with bounded telemetry.
- Keep keyword/vector behavior unchanged for non-relational queries.

Verification:

- #266 eval gate passes.
- Focused graph/search tests.
- Namespace/read-policy regression tests.
- `bunx tsc --noEmit`.
- Full `bun test` if shared search or table projection code is touched.

### 4. #269 privacy-safe MCP/tool request audit logging

Owning boundary:
Operator auditability without persisted payload leakage.

Required local work:

- Store operation name, status, latency, caller identity/namespace source,
  declared parameter keys, unknown key count, and coarse payload size.
- Never store raw parameter values, prompt/body text, file paths, secret-shaped
  values, or unknown attacker-controlled key names by default.
- Bucket byte counts to reduce side-channel value.
- Add retention and disable controls.

Verification:

- Focused audit logger tests for redaction, declared keys, unknown keys, byte
  bucketing, disable/retention behavior, and failure paths.
- `bunx tsc --noEmit`.
- Relevant server/request tests.

### 5. #270 operator doctor/status surface

Owning boundary:
Operator-facing health diagnostics.

Required local work:

- Add stable JSON status/doctor output before any human UI.
- Cover runtime version, contract version, DB connectivity, migration status,
  embedding provider availability, qmd availability when configured, transport
  mode/availability, recent degraded provider failures, and audit/log health
  when available.
- Keep public health minimal.
- Require the appropriate auth or local command boundary for privileged detail.
- Omit secrets and raw env values.

Verification:

- Focused doctor/status tests.
- Auth/permission tests if exposed as MCP/HTTP.
- `bunx tsc --noEmit`.

### 6. #268 graph-expanded evidence in `brain_answer` and `search_all`

Owning boundary:
Answer/search consumers of graph-expanded retrieval evidence.

Required local work:

- Start only after #266/#267 are merged or available in the same working branch.
- Decide whether graph-expanded rows are default, opt-in, or only inherited
  through `search_brain`.
- Preserve extractive/cited answer behavior.
- Keep qmd federation separate and fail-open.
- Bound and redact any link path metadata.
- Classify downstream impact before merge.

Verification:

- Focused `brain_answer` and `search_all` tests.
- Namespace denial/leak regression tests.
- Existing answer/search suites.
- `bunx tsc --noEmit`.

### 7. #271 hot-memory path through `agent_context_pack`

Owning boundary:
Prompt-ready memory bundle contract, not generic MCP response mutation unless
explicitly decided.

Required local work:

- Run after graph retrieval quality is proven.
- Re-read `docs/agent-context-pack-contract.md`.
- Decide and document the owning boundary:
  - `agent_context_pack`;
  - MCP `_meta`; or
  - defer.
- If implemented, exact-scope filters must run before ranking/truncation across
  namespace, agent, platform, server, channel, thread, and session.
- Working state must be labeled as unpromoted working context and carry
  citations/source refs where applicable.

Verification:

- Contract tests.
- Exact-scope denial tests for every scope key.
- Downstream rollout classification.

## Worker Plan

Use standard steerable subagents only; do not use CSV row workers.

Recommended lanes:

- Controller:
  - owns board state, issue/PR state, integration, final correctness, and merge
    readiness.
- Pair A eval worker:
  - owns #266 fixture/eval shape and proves no-regression.
- Pair A implementation worker:
  - owns #267 parser/traversal/hydration/fusion, but cannot declare readiness
    without the eval gate.
- Operator hardening worker:
  - owns either #269 or #270, not both at once unless the controller decides the
    shared shape is small.
- Reviewer swarm:
  - required before non-trivial PR readiness, with SME and antagonist lanes.

## Per-Issue Loop

1. Refresh live issue, Project 8 item, current `origin/main`, and dirty state.
2. Move the item to the correct Project 8 state before dispatch:
   - active work: `In Progress`, `Review Gate: Not Started`,
     `Validation: Not Started`;
   - blocked dependency: `Blocked`, with exact blocker in `Next Action`.
3. Create a clean worktree from `origin/main` under
   `/Volumes/ThunderBolt/_tmp/open-brain`.
4. Identify the owning boundary before editing.
5. Implement the smallest correct owned change.
6. Run focused validation, then broaden tests when shared behavior is touched.
7. Commit, push, and open a PR with:
   - linked issue(s);
   - validation evidence;
   - critical self-review receipt;
   - downstream rollout classification;
   - no-deploy statement when applicable.
8. Run review swarm, fix material findings, and run fix verification.
9. Merge only after CI and review gates pass.
10. Close issues only when acceptance criteria are actually satisfied.
11. Update Project 8 and this plan immediately after merge/closure.

## Merge And Closure Gates

For #266/#267:

- Do not merge #267 without #266's relational lift/no-regression evidence.
- Do not close #265 until Pair A and the selected Pair B/C completion criteria
  are satisfied or explicitly deferred.

For #268/#271:

- Do not add prompt-placement behavior without exact-scope denial tests.
- Do not advertise new contract capability through `get_contract` until server
  code, tests, and downstream client support are ready or explicitly scoped.

For #269/#270:

- Do not persist raw MCP/tool payloads.
- Do not expose privileged status detail through public health.

For #223:

- Do not close from this sprint.
- Keep it open/blocked until fleet-bus/live NATS rollout, HTTP-vs-NATS parity,
  and canary evidence are complete.

## Stop Conditions

Stop only for:

- Live deploy, core01 mutation, DB migration, hosted NATS, or downstream Hermes
  canary requiring explicit approval.
- Missing review-swarm capability that prevents honest PR readiness.
- A graph/eval design that cannot prove non-relational no-regression.
- Namespace/read-policy ambiguity that cannot be settled from source.
- Validation failure that cannot be diagnosed without unavailable external
  state.
