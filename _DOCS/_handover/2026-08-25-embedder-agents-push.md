# Handover — land everything unmerged, then start the move off the Mac (2026-08-25)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (88 lines). It
  overrides the base; this document overrides it. Rules 13, 17, 18 are new
  today: core01 in scope only for #762, push from a clean clone, embedder is
  a fleet service.
- Run from a clean clone on a cc-* box (Rico ruling 2026-08-25), temp
  workspace `/mnt/collab/tmp_space/open-brain/`. The live clone and its
  database stay on the Mac (10.71.1.20) until #762 executes; anything that
  restarts the clone runs there over ssh.
- Workers: Opus 5 low effort or Luna max. The repo's standard gauntlet
  (`review` skill) on every PR before merge. Every issue number spoken to
  Rico gets one plain sentence of what it is.

## State 1 — ORIENT
- Local clone serves `ad3b59c` (head of `deploy/local-clone-20260825`), embedder `embed-gemma-dense` on k3s `ai/llama-swap` at `https://llama-swap.rodaddy.live/v1` — RUNNING (`curl -s http://10.71.1.20:3100/health` → embedding connected true; `/v1/models` → 200)
- `main` = `99a293b` (#759 merged); no worktrees; `git branch --merged origin/main` → main only — MERGED (`git log -1 origin/main`)
- `fix/757-agents-embedder-host` @ `ba4cf03` (origin/main + AGENTS.md embedder amendment + this handover + HANDOVER-RULES 13/17/18) exists on the Mac only; PR body `_scratch/pr-body-agents-embedder.md` passes `scripts/validate-pr-body.ts` — WRITTEN (`git ls-remote --heads origin fix/757-agents-embedder-host` → empty)
- Push from the Mac is refused by `_githooks/pre-push:493` (tests the dirty working tree) — RUNNING (#761); a clean checkout is unaffected
- `fix/recall-serves-durable-memory` carries 9 commits over main: #744 recall fix (`e174f06`, `8f1f2a8`), #747 queue/distill fixes (`36a0b6e`, `a61b99d`, `acca7d7`), capture/maintenance fixes (`684b3a8`, `2a0eab1`), done-means (`b5a5f1d`), handover doc (`9466a3b`); origin has it only up to `684b3a8` — WRITTEN (`git log --oneline origin/main..fix/recall-serves-durable-memory`)
- That branch fails 3 tests under `test:isolated`: distill null-namespace sweep, context-pack `requested_sections` receipt, migration 026 idempotent enqueue — WRITTEN (`_scratch/test-isolated-tn01.txt`)
- core01 (10.71.1.21:3100) degraded, both workers 503, database not connected; blockers #674 (serves `src/index.ts`, not `server/main.ts`), #675 (deploy has no revision proof) OPEN — RUNNING (`curl -s http://10.71.1.21:3100/health`)
- No k3s Postgres exists for Open Brain; last database backup on record `core01-20260724`; the Mac's `open_brain_local_20260724` (178,282 vectors) has none newer — WRITTEN (`ls /Volumes/ThunderBolt/open-brain-local/backups`)
- CI: runner-resident bun 1.4.0 leaks into `check` (#760); re-run if observability tests fail — RUNNING
- Sprint #750 (coding standards) ON HOLD by Rico; the Mac dev checkout is its dirty `sprint/standards-fmt` (35 paths) — leave it — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh` → 61)
Re-probe before dispatching anything (live state beats this doc):
- `curl -s -m 5 http://10.71.1.20:3100/health` → expect revision ad3b59c, embedding connected true
- `git ls-remote --heads origin fix/757-agents-embedder-host` → present once Rico or State 2 pushes
- `bun run test:isolated src/local-clone-mode.test.ts` on the cc box → proves the box has Postgres for the suite

## State 2 — LAND THE PAPERWORK
Branch: `fix/757-agents-embedder-host` from `origin/main` — if origin lacks it,
recreate from `origin/main`: apply the AGENTS.md lines from #757 comment
5419043410, HANDOVER-RULES rules 13/17/18 from #757 comment 5419315526's
follow-up, and this handover; push. If the checkout is `main` or the branch is
merged, switch first, never work there. Never the Mac's `sprint/standards-fmt`.
Retire: none (`git branch --merged origin/main` → main; no worktrees).
Commit this handover: branch `fix/757-agents-embedder-host`, path
`_DOCS/_handover/2026-08-25-embedder-agents-push.md`, explicit-path staging,
`git commit -F` message file.
Scribe: #757 — started: `gh issue comment 757 --body-file <file>`
Done-check: `git log -1 --stat`

## State 3 — AGENTS.md + rules PR through the gauntlet
Tier: T1 — repo law every session reads
Deliverable: PR from `fix/757-agents-embedder-host` merged
Scope: that branch; `gh pr create --body-file _scratch/pr-body-agents-embedder.md`; fold the stale `10.71.1.11` example in `docs/local-clone-dogfood.md` into it
Must NOT: `--no-verify`; merge without the gauntlet
Record: #757
Done-check: `rg -n 'llama-swap.rodaddy.live' AGENTS.md _DOCS/HANDOVER-RULES.md` on `origin/main` → 3 lines (RED: not yet run)

## State 4 — #744 + #747: make the branch green, PR, merge
Tier: T2 — changes what a bare recall and the maintenance queue do on main
Deliverable: `fix/recall-serves-durable-memory` at 0 fail on `test:isolated`; one PR per issue if the commits split cleanly, else one PR naming both; gauntlet; merged
Scope: that branch; `src/distill-handler.ts`, `src/maintenance-queue.ts`, `server/tools/agent-context-pack.ts`, `src/tools/agent-context-pack.ts`, their tests, `src/db/migrations/026_maintenance_queue.test.ts`
Must NOT: weaken or skip the 3 failing tests; touch #750's lint edits; deploy
Record: #744, #747
Done-check: `git merge-base --is-ancestor 8f1f2a8 origin/main && git merge-base --is-ancestor acca7d7 origin/main; echo $?` → 0 (RED: not yet run)

## State 5 — #761: pre-push judges the pushed tip
Tier: T1 — shared gate on every push
Deliverable: `_githooks/pre-push` tests `<base>..<tip>` content, not the checkout's working tree; done-means check RED-first
Scope: `_githooks/pre-push`, `scripts/done-means/`
Must NOT: skip `bun test` for code changes; add an agent override
Record: #761
Done-check: new `scripts/done-means/*pre-push*` check exits 0 pushing a clean docs-only branch from a dirty checkout (RED: not yet run)

## State 6 — Redeploy the Mac clone from main
Tier: T2 — restarts the machine's live memory service
Deliverable: clone on a `main` ref carrying States 3–4, embedding connected
Scope: `scripts/local-clone-deploy.sh <ref>` over ssh on the Mac, `com.rico.open-brain-local-clone`
Must NOT: deploy before State 4 merges
Record: #757
Done-check: `curl -s http://10.71.1.20:3100/health` → revision = `origin/main` short SHA, embedding connected true (RED: not yet run)

## State 7 — #762: backup first, then the cutover checklist
Tier: T2 — data and a live service change hosts
Deliverable: (1) a fresh `pg_dump` of `open_brain_local_20260724` under `/Volumes/ThunderBolt/open-brain-local/backups/` with a `pg_restore --list` receipt; (2) the cutover checklist on #762 with the target Rico picks (core01 now, k3s Postgres later); (3) nothing executed against core01 or k3s
Scope: backup script under `scripts/`, epic #762
Must NOT: move data, point config at a new host, or drop anything without a backup receipt and Rico's go per step
Record: #762
Done-check: backup file exists and `pg_restore --list` reads it; checklist posted on #762 (RED: not yet run)

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Which cc-* box hosts the session and whether it has Postgres for `test:isolated`. Re-probe in State 1.
- Whether Rico pushes `fix/757-agents-embedder-host` from the Mac himself before the session starts; State 2 covers both cases.
- Whether the 9 commits on `fix/recall-serves-durable-memory` split into two clean PRs. State 4 decides.
- Target for the move (core01 first, or straight to a k3s CNPG cluster): Rico's call on #762 before State 7's checklist is final.
- Embedder ingress 503 windows and Bifrost's stale `tn01-llama` provider: rtech-infra#1110, not this repo.
- Two untracked `.env.bak-20260825-{1035,1103}` in the Mac repo root belong to the prior session; Rico's call.
- Open Brain capture event for today's lessons was NOT written: the direct provider's `--event capture` command could not be located from the SessionStart context this session. Lessons live in HANDOVER-RULES 13/17/18, #760, #761, #762, rtech-infra#1110, and Development `9c91d01c`.
