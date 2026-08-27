# Handoff — embedding cutover to TN01 (2026-08-25)

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
  overrides the base; this document overrides it.

## State 1 — ORIENT
- Local clone serves revision `ad3b59c`, embedding connected — RUNNING (`curl -s http://127.0.0.1:3100/health`)
- Embedder is `embed-gemma-dense` on llama-swap at `http://10.71.1.11:8080/v1` (TN01, RTX 5060 Ti) — RUNNING (`ssh 10.71.1.11 awk /^  embed-/ config.yaml` → 3 entries)
- Local MLX unit `com.local.mlx-embedding-server` booted out and disabled; plist left in place — RUNNING (`launchctl print-disabled gui/$(id -u)` → disabled; `launchctl list` → empty)
- PR #759 open and MERGEABLE, head `fix/757-embedding-host-allow` — RUNNING (`gh pr view 759 --json state,mergeable`)
- PR head is `7c3eb1b` (autostart child fix) over `b2643ed` (host opt-in) over origin/main `6065390` — RUNNING (`git -C <worktree> log --oneline -3`)
- Deployed ref `ad3b59c` is on local branch `deploy/local-clone-20260825` only, never pushed — WRITTEN (`git branch -a --list '*deploy*'`)
- The #744 recall fix `8f1f2a8` is on NEITHER origin/main NOR the PR head; #744 has no PR and is OPEN — RUNNING (`git merge-base --is-ancestor 8f1f2a8 origin/main` → rc 1)
- `test:isolated` on the deploy branch: 3808 pass / 3 fail / 35 skip; failures are memory-distill null-namespace, context-pack requested_sections, maintenance-queue live migration — WRITTEN (`_scratch/test-isolated-tn01.txt`)
- Pre-push on the origin/main-based PR branch with the TN01 embedder: 3407 pass / 531 skip / 0 fail (bare `bun test`, dogfood DB) — WRITTEN (#759)
- `embed-gemma-dense` matches the stored vector space, cos p50 0.974 over 1000 rows; `embed-qwen3-4b` is a different 2560-wide space — WRITTEN (`_scratch/embed-compare/`, posted on #757)
- Sprint #750 ON HOLD by Rico; dev checkout sits on `sprint/standards-fmt` with uncommitted lint edits — WRITTEN (`_DOCS/_handoff/2026-08-25-standards-session-2.md`)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh` → 61)
Re-probe before dispatching anything (live state beats this doc):
- `curl -s -m 5 http://127.0.0.1:3100/health` → expect revision ad3b59c, embedding connected true
- `gh pr view 759 --repo rodaddy/open-brain --json state,mergeable` → expect OPEN, MERGEABLE
- `git merge-base --is-ancestor 8f1f2a8 origin/main; echo $?` → expect 1 until #744 lands

## State 2 — LAND THE PAPERWORK
Branch: `fix/757-embedding-host-allow` in the worktree from `origin/main` — cut
it if absent; if the checkout is `main` or that branch is merged (PR #759),
switch first, never work there. The dev checkout's `sprint/standards-fmt` edits
are the held sprint's, not this session's: leave them untouched.
Retire: worktree `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/embedding-host-allow`
(`git worktree remove`) and branch `fix/757-embedding-host-allow` (`git branch -d`),
both after #759 merges. Nothing else (`git branch --merged origin/main` → main only).
Scribe: #757 — started: `gh issue comment 757 --body-file <file>`
Done-check: `git log -1 --stat`

## State 3 — Classify the 3 deploy-branch test failures
Tier: T1 — the answer decides whether #759 is safe to merge
Deliverable: a verdict per failure — known #750 sprint-branch failure, or new
Scope: `_scratch/test-isolated-tn01.txt`, #750 comments, read-only git history
Must NOT: fix any test; merge #759; run the suite against the dogfood DB as evidence
Record: #757
Done-check: `bun run test:isolated` on `fix/757-embedding-host-allow` → 0 fail, matching the pre-push run (RED: not yet run)

## State 4 — Merge #759 on Rico's approval
Tier: T2 — changes what `main` is and what the clone will next deploy
Deliverable: #759 merged, `main` carrying `b2643ed` and `7c3eb1b`
Scope: `gh pr merge 759` only
Must NOT: merge before State 3 returns clean; merge without Rico saying go
Record: #759
Done-check: `git merge-base --is-ancestor 7c3eb1b origin/main; echo $?` → 0 (RED: not yet run)

## State 5 — Redeploy the clone from main
Tier: T2 — restarts the machine's live memory service
Deliverable: clone healthy on a main-based ref, embedding connected, TN01 serving
Scope: `scripts/local-clone-deploy.sh`, the two launchd labels below
Must NOT: redeploy while `8f1f2a8` is off main — it carries the #744 recall fix
and #744 has no PR, so a bare-main deploy silently regresses recall; either land
#744 first or deploy a ref that includes `8f1f2a8`, and tell Rico which
Record: #757
Done-check: `curl -s http://127.0.0.1:3100/health` → healthy, embedding.connected true (RED: not yet run)

## State 6 — Amend the AGENTS.md two-hosts line
Tier: T1 — the line is repo law that every future session reads
Deliverable: `AGENTS.md` Stack bullet amended so TN01 is named the embedding provider
Scope: `AGENTS.md`, the "exactly two" hosts bullet only
Must NOT: write the wording yourself — ask Rico for his and paste it verbatim
Record: #757
Done-check: `rg -n 'TN01' AGENTS.md` → the amended bullet (RED: not yet run)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Deploying the clone from a bare `main` regresses recall until #744 lands.
  Whether to land #744 first or deploy an `8f1f2a8`-inclusive ref is Rico's
  call; State 5's Must NOT holds until he makes it.
- Why the autostart fix exists (macOS Local Network privacy attributes the
  grant to a launchd job's main process, so `exec`'d bun cannot reach TN01) is
  measured and recorded on #757; probe plists in `_scratch/tcc-probe/`.
- `embed-qwen3-4b` on TN01 is ungrouped, so llama-swap's implicit exclusive
  group evicts the pinned members when anyone requests it. Harmless as a test
  entry; group or remove it before anything relies on it. Not filed as an issue.
- Switching to `embed-qwen3-4b` would mean re-embedding all 178,282 vectors and
  changing nine `halfvec(768)` columns. Recorded on #757; its own issue if Rico
  wants it.
- `open-brain/.env` now points dev tools at TN01, so local tests that embed fail
  with network errors rather than skipping when TN01 is down.
- Rico rulings recorded today, not built: the AI box moves from TN01 to a K3S
  pod later with Bifrost as the long-term route; GPT-5.6 Luna max replaces Terra
  for REM (#758); a ~9B local model on TN01 for dream stages later (#757).
- Sprint #750 stays ON HOLD until Rico lifts it; it resumes from its own
  handoff `_DOCS/_handoff/2026-08-25-standards-session-2.md`.
