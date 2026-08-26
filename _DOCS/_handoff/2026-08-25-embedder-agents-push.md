# Handoff — land everything unmerged, then move Open Brain off the Mac (2026-08-25)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (73 lines). It
  overrides the base; this document overrides it. Its rule 13 (core01 out of
  scope) is SUPERSEDED by Rico's ruling 2026-08-25 evening: the service leaves
  the Mac, to core01 at minimum, likely to a new Postgres box in k3s.
- Run this session from a clean clone on a cc-* box (Rico ruling 2026-08-25),
  temp workspace `/mnt/collab/tmp_space/open-brain/`. The live clone and its
  database stay on the Mac (10.71.1.20) until State 7; anything that restarts
  the clone runs there over ssh.
- Rico is not a robot: every issue number in chat gets one plain sentence of
  what it is. Workers: Opus 5 low effort or Luna max; the repo's standard
  gauntlet (`review` skill) on every PR before merge.

## State 1 — ORIENT
- Local clone serves `ad3b59c` (head of `deploy/local-clone-20260825`), embedder `embed-gemma-dense` on k3s `ai/llama-swap` at `https://llama-swap.rodaddy.live/v1` — RUNNING (`curl -s http://10.71.1.20:3100/health` → embedding connected true)
- `main` = `99a293b` (#759 merged); `fix/757-embedding-host-allow` retired — MERGED (`git log -1 origin/main`)
- `fix/recall-serves-durable-memory` carries 9 commits over main: #744 recall fix (`e174f06`, `8f1f2a8`), #747 queue/distill fixes (`36a0b6e`, `a61b99d`, `acca7d7`), capture/maintenance fixes (`684b3a8`, `2a0eab1`), done-means (`b5a5f1d`), a handoff doc (`9466a3b`); origin has only up to `684b3a8` — WRITTEN (`git log --oneline origin/main..fix/recall-serves-durable-memory`)
- That branch fails 3 tests under `test:isolated`: distill null-namespace sweep, context-pack `requested_sections` receipt, migration 026 idempotent enqueue — WRITTEN (`_scratch/test-isolated-tn01.txt`)
- `fix/757-agents-embedder-host` @ `75ea217` (origin/main + `AGENTS.md` embedder amendment) plus this handoff and the session report; PR body at `_scratch/pr-body-agents-embedder.md` validates — WRITTEN, unpushed
- Push from the Mac is refused by `_githooks/pre-push:493` (tests the dirty working tree, not the tip) — RUNNING (#761); a clean checkout is not affected
- core01 (10.71.1.21:3100) is degraded: both workers 503, database not connected; cutover blockers #674 (serves `src/index.ts`, not `server/main.ts`) and #675 (deploy has no revision proof) are OPEN — RUNNING (`curl -s http://10.71.1.21:3100/health`)
- No plan exists for a k3s Postgres for Open Brain; CNPG clusters exist for authentik, listmonk, vaultwarden, webtier — RUNNING (`kubectl get svc -A | rg cnpg`)
- Last database backup on record is `core01-20260724`; the Mac's dogfood DB `open_brain_local_20260724` (178,282 vectors) has none newer — WRITTEN (`ls /Volumes/ThunderBolt/open-brain-local/backups`)
- CI: runner-resident bun 1.4.0 leaks into `check` (#760); re-run if observability tests fail — RUNNING
- Sprint #750 (coding standards) ON HOLD by Rico; dev checkout on the Mac is its dirty `sprint/standards-fmt` — leave it — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh` → 61)
Re-probe before dispatching anything (live state beats this doc):
- `curl -s -m 5 http://10.71.1.20:3100/health` → expect revision ad3b59c, embedding connected true
- `git ls-remote --heads origin fix/757-agents-embedder-host` → present once Rico or State 2 pushes
- `bun run test:isolated src/local-clone-mode.test.ts` on the cc box → proves the box has Postgres for the suite

## State 2 — LAND THE PAPERWORK
Branch: `fix/757-agents-embedder-host` — if origin lacks it, recreate from
`origin/main`: apply the two `AGENTS.md` lines from #757 comment 5419043410,
add this handoff and `_reports/2026-08/2026-08-25_E8241A16_embedding-cutover-session-2.md`,
push. Never the Mac's `sprint/standards-fmt`.
Retire: nothing until the PRs below merge; then `git branch -d` each merged branch.
Scribe: #757 — started: `gh issue comment 757 --body-file <file>`
Done-check: `git log -1 --stat`

## State 3 — AGENTS.md PR through the gauntlet
Tier: T1 — repo law every session reads
Deliverable: PR from `fix/757-agents-embedder-host` merged
Scope: that branch, `gh pr create --body-file _scratch/pr-body-agents-embedder.md`
Must NOT: `--no-verify`; merge without the gauntlet
Record: #757
Done-check: `rg -n 'llama-swap.rodaddy.live' AGENTS.md` on `origin/main` → 2 lines (RED: not yet run)

## State 4 — #744 + #747: make the branch green, PR, merge
Tier: T2 — changes what a bare recall and the maintenance queue do on main
Deliverable: `fix/recall-serves-durable-memory` at 0 fail on `test:isolated`, one PR per issue if the commits split cleanly (else one PR naming both), gauntlet, merged
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

## State 7 — Move off the Mac: backup, target, plan
Tier: T2 — data and a live service change hosts
Deliverable: (1) a fresh `pg_dump` of `open_brain_local_20260724` under `/Volumes/ThunderBolt/open-brain-local/backups/` with a restore receipt; (2) epic #762 updated with the target Rico picks (core01 now, k3s Postgres later) and a cutover checklist; (3) nothing executed against core01 or k3s
Scope: backup script under `scripts/`, epic #762
Must NOT: move data, point config at a new host, or drop anything without a backup receipt and Rico's go per step
Record: #762
Done-check: backup file exists and `pg_restore --list` reads it; checklist posted on #762 (RED: not yet run)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Which cc-* box hosts the session and whether it has Postgres for `test:isolated`. Re-probe in State 1.
- Whether the 9 commits on `fix/recall-serves-durable-memory` split into two clean PRs. State 4 decides.
- Cause of the embedder ingress 503 windows (20:57Z, 22:03–04Z, 22:19Z today). Infra; on #757.
- Bifrost's `tn01-llama` provider still targets dead `10.71.1.11:8080` (rtech-infra). Not this repo.
- `docs/local-clone-dogfood.md` example still shows `OPEN_BRAIN_EMBEDDING_HOST_ALLOW=10.71.1.11`; fold into State 3.
- Three untracked `.env.bak-20260825-*` in the Mac repo root; Rico's call.
