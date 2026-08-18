# Run spec — 2026-08-17: wrap failure fix + #724 residuals + cheap closures

Status: PROPOSED (this whole file). Operating mode: **Graph Mode v1.1**
(`_DOCS/GRAPH_MODE_SOP.md`, RATIFIED 2026-08-17; "RLVR" is a retired lineage
alias — `docs/sop-rlvr-lanes.md` remains the repo-local briefing source until
its next conversion pass). Tier: **T1** overall — shared code and gates —
with two lanes T2-flagged below (live service mutation; client contract
change). Every lane carries a red-first done-means check **authored by a
different actor than the implementation** (`done-means-author`); harvest is
the hard barrier before any next dispatch.

Merge target: `wip/2026-08-07` (the active integration branch; it is already
9+ commits ahead of `origin/main` and existing lanes target it).

## Evidence base (verified this session, 2026-08-17)

- Wrap root cause: capture hook creates the base lane `agent='openbrain-capture'`
  (`python/openbrain/src/openbrain/config.py:517`); manual wrap sends the
  session's own scope; `establishExactStartScope`
  (`server/tools/session-lifecycle.ts:61-100`, the #646 one-way fill) refuses
  the mismatch. Diagnosis posted:
  https://github.com/rodaddy/open-brain/issues/724#issuecomment-5321252178
- v23/v24 "skew" = test-isolation leak from the Development repo's
  `_ob/scripts/ob-memory-provider.test.ts` (fixtures `opaque-session_abc123`,
  correlation `12345678-…`) writing to the real receipts file because
  `receipt-state.ts:132` falls back to `~/.local/state` when `XDG_STATE_HOME`
  is unset and the suite never sets it.
- Push to `wip/2026-08-07` is BLOCKED: pre-push typecheck fails on an
  uncommitted WIP edit `scripts/setup-client-hook-env.test.ts:319`
  (`(string | undefined)[]` → `string[]`, the dev#98 crossing suite).
- Lane worktrees already parked: `lane/719-precommit-gate` (53e1722, has
  commits), `fix/721-mgvl-guard-earned` (afc5525, no commits),
  `fix/722-done-means-fixture-hookspath` (afc5525, no commits). #720 already
  merged as 38719c9.

## Phase 0 — unblock the branch (controller-owned, sequential, ~20 min)

**0a. Finish the dev#98 crossing suite WIP** (micro-lane; it blocks every push).
The suite is complete except the one tsc error at
`scripts/setup-client-hook-env.test.ts:319`.
Done-means: `bunx tsc --noEmit` green AND
`bun run test:isolated scripts/setup-client-hook-env.test.ts` green.
Commit on `wip/2026-08-07` with its own message; push (this also lands the
stranded scribe commit 445cb59).

**0b. Tear down the three parked worktrees (operator ruling 2026-08-17: no
worktree exists without work actively being done).** All three have sat idle
since Aug 10. Their state survives without them: `lane/719-precommit-gate`'s
commits live on the branch (53e1722), #721/#722's worktrees are at afc5525
with zero commits, and all three journals are already in `_plans/worklog/`.
`git worktree remove` each + `git worktree prune`. When Phase 2 re-dispatches
those lanes, isolation is per-lane CLONES under
`{temp_workspace}/open-brain/_scratch/` per Graph Mode v1.1 §1 — not
worktrees, and torn down by the lane's own teardown field the same session.

**0c. Classify the remaining dirty files.** `AGENTS.md` +
`_DOCS/STANDARDS-{core,git,python,typescript}.md` look like a standards-sync
output; diff, and if they are exactly `sync-repo-standards` output, commit as
`docs(standards): sync`; anything else is reported to Rico, not committed.

## Phase 1 — #724 P0 residuals (the actual fix work)

**Lane A — backlog re-embed (data recovery). Highest priority.**
Branch `lane/724-backlog-reembed`. Charter: rows captured Aug 14–17 stored but
unindexed. First MEASURE: watermark query (newest embedded-row age vs newest
raw-row age, per namespace) against `open_brain_local_20260724`; then determine
whether the restored worker's maintenance pipeline drains the backlog
retroactively; if not, build/run the backfill through the EXISTING maintenance
path (`python/openbrain-memory/src/openbrain_memory/maintenance.py` /
worker pipeline — no new mechanism; UNVERIFIED which entrypoint until the lane
reads it).
Done-means (red-first): a probe script asserting (1) embedded watermark ≥
newest raw row for the Aug 14–17 window, (2) a `durable_memory` recall of known
Aug-15-window content returns it. Runs red today by construction.

**Lane B — wrap fix (#724 item 4).**
Branch `lane/724-wrap-scope`. OPERATOR DECISION REQUIRED first (ledger rule —
decisions reviewed with Rico):
  - Option (a) RECOMMENDED: manual `wrap`/`checkpoint` discovers the lane's
    existing scope — the server already returns an existing lane verbatim when
    the request does NOT claim complete exact scope
    (`server/tools/session-lifecycle.ts:149-180`), so the client's wrap path
    stops asserting its own exact scope against a hook-owned lane and validates
    by session_key + namespace instead. Server untouched; the isolation
    predicate stays intact. `docs/memory-contract.md:151` already specs
    session_wrap by session_key without exact scope.
  - Option (b): CLI refuses wrap on hook-owned lanes with "hook-owned; use
    capture". Cheaper, but leaves manual wrap dead permanently.
Done-means (red-first): fake-transport test in
`python/openbrain-memory/tests/` reproducing the exact failure (existing lane
`agent='openbrain-capture'`, wrap from a differently-scoped session) — fails on
current code, passes after. Plus `uv run mypy` / `ruff` zero errors.
Downstream-rollout classification per `docs/downstream-rollout.md` (client
behavior change → check mcp2cli/Hermes applicability).

**Lane C — make the silence loud (watermark alarm). T2 flag: touches the
running local service.**
Branch `lane/724-embed-watermark-health`. Charter: expose
newest-embedded-age vs newest-raw-age in the worker's `3110/health` (the
process that CAN observe it — the runbook documents why 3100 cannot), alarm
when the gap exceeds N hours. Structure: extend the EXISTING health surface,
not a new checker (`docs/core01-nats-worker-runbook.md` owns the health
contract; lane reads it first).
Done-means (red-first): test that a fixture DB with stale embeddings turns the
health field unhealthy; live receipt: `curl 3110/health` shows the watermark
fields after deploy of the local clone.

**Lane D — forensics: what removed the plist (timeboxed 45 min, may not
close).** Branch none (read-only investigation). Audit
`scripts/local-clone-deploy.sh` for the strand path (deploy without
`OPENBRAIN_NATS_WORKER_LABEL` + bootout), sweep shell/session history and
launchd logs around Aug 14 10:53. Deliverable: findings comment on #724;
if the strand path is real, file a scoped issue for it. Not a closure lane.

**Lane E — test-isolation leak (Development repo, not this one).**
Branch in `/Volumes/ThunderBolt/Development`: pin `XDG_STATE_HOME` to a fixture
dir in `_ob/scripts/ob-memory-provider.test.ts` (or the runProvider receipts
path override if one exists — lane verifies which). Done-means: run the suite,
then assert the live `~/.local/state/.../receipts.json` mtime/content
unchanged. Commits land in the Development repo per its own git rules.

## Phase 2 — cheap closures (parallel small lanes + a verify sweep)

**2a. Finish the three parked gate lanes** (journals already written, defects
already reproduced):
  - **#719** `lane/719-precommit-gate` — resume at 53e1722; done-means already
    chartered in `_plans/worklog/fix-719-2026-08-10.md`.
  - **#722** `fix/722-done-means-fixture-hookspath` — pin fixture
    `core.hooksPath` (or `GIT_CONFIG_GLOBAL=/dev/null`) in the two done-means
    fixtures; done-means: `705-…` and `712-…` checks green on untouched tree.
  - **#721** `fix/721-mgvl-guard-earned` — MGVL_IN_VERIFY_LANE must be EARNED,
    not inherited; done-means: red-first shell test proving an inherited env
    var no longer yields PASS.
  Each lane re-dispatches from its surviving branch into a fresh clone under
  `_scratch/` (the parked worktrees are gone as of Phase 0b), merges to
  `wip/2026-08-07`, and closes its issue with receipts + `scribe-emit`.

**2b. #707** — one SME entry heading fix + `bun scripts/build-sme-indexes.ts`;
done-means: `sme-per-entry-files.sh` green. Trivial, controller may do inline
(T0).

**2c. Verify-and-close sweep** over the remaining stale-blocker candidates that
look already-fixed by landed work: **#618, #622, #632, #641, #670, #672**.
One verifier lane per issue (the repo's `verifier` agent contract): re-run the
covering done-means check / reproduce the original defect; if green, close
with the receipt; if red, comment findings and LEAVE OPEN. No issue is closed
on "referenced work is closed" alone — that is the candidate signal, not the
proof. Epics and heavy items (#296–#300, #463, #563, #571, #674, #682, #685,
#702) are explicitly OUT of scope for this run.

## Order and parallelism (Graph Mode v1.1 — the parallel frontier)

1. Phase 0 (controller, sequential — nothing pushes until 0a lands; 0b tears
   down the parked worktrees).
2. **Frontier-wide dispatch**: A, B, C, D, E, 2a(×3), 2b share no conflict
   surface (verified: different files/repos per lane) → ALL dispatch
   simultaneously, each in its own clone under
   `{temp_workspace}/open-brain/_scratch/`. Workers at **LOW effort** with
   fully front-loaded briefs (v1.1 routing rule); effort raised only by
   explicit operator direction. Done-means checks authored by
   `done-means-author`, not the implementing lane.
3. **Small landings at the controller** — the single serial merge point.
   Done → verify receipt → merge → issue close → `scribe-emit`
   (best-effort; refusal pre-cutover costs nothing), one lane at a time AS
   THEY REPORT. Never batch the wave; never park a green PR.
4. **Ceremony budget spent once**: lanes self-verify with one receipt per
   claim class; the controller spot-checks the definitional receipt. Full
   independent re-verification (verifier lane in a fresh clone) is reserved
   for the two T2 lanes — C (live service) and B (client contract /
   isolation-adjacent). Triple-proving the T1 lanes is the deviation.
5. Verify sweep (2c) runs last against the merged state.
6. Harvest is the HARD BARRIER: lane lessons → `docs/lane-contract.md`
   Tightenings before any further dispatch; then tracking-scribe (mirrors,
   SME entries), `aqmd up`, teardown audit (every lane report's `teardown`
   field verified — zero worktrees, zero stray clones), dirty-state
   reconciliation, decisions pass WITH Rico (the wrap-option ruling is
   already recorded; anything discovered mid-run queues here).
7. Every lane report uses the v1.1 11-field format (model / branch / pr /
   red / green / root-cause / deviations / refusals-and-violations /
   teardown / claim-states / lessons); a missing field sends it back.
   Checked-claim outcomes are three-valued: confirmed / killed / unverified.

## Success criteria for the session

- Push unblocked; wip branch green through pre-push.
- Aug 14–17 backlog recallable (Lane A receipt).
- Manual wrap works or refuses loudly (Lane B, per decision).
- Watermark gap visible in worker health (Lane C receipt).
- #719, #721, #722, #707 closed with receipts; 0–6 of the verify-sweep
  issues closed with receipts.
- #724 updated: items 1/3/4 done, item 2 findings posted; #724 itself stays
  OPEN unless all four items land (closing it is Rico's call).

## Known risks

- Lane A may reveal the backfill needs a new entrypoint — if so it stops at a
  measured proposal rather than inventing pipeline structure mid-lane.
- Lane C deploys to the running local clone; it follows the runbook's deploy
  path and verifies 3100 unaffected, same as the interim repair did.
- The verify sweep may close as few as zero issues; that is a correct outcome.
