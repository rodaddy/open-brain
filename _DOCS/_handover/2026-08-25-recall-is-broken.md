# Handover — recall is broken (2026-08-25)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (28 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
- Recall serves only the working set and returns ok with zero items — WRITTEN
  (#744 D1, filed 2026-08-24, unverified against server)
- Capture writes are landing: 11647 rows, latest today — RUNNING (`psql -At -c
  "select count(*),max(created_at)::date from ob_session_events"` → 11647|2026-08-25)
- Embeddings are complete, so recall failing is NOT an embedding gap — RUNNING
  (`select count(*),count(embedding) from ob_session_events` → 11647|11647)
- August capture volume collapsed vs July — RUNNING (`select date_trunc('month',created_at)::date,count(*) from ob_session_events group by 1` → 1062 vs 7673)
- brain_answer cannot see session events; nothing promotes them — WRITTEN (#433)
- Local service is up on 127.0.0.1:3100, pid 21882, started 2026-08-25 00:11 —
  RUNNING (`lsof -tiTCP:3100 -sTCP:LISTEN` + `ps -o lstart`)
- Graph mode: converted — RUNNING (`ls scripts/done-means/` → 82 entries;
  docs/lane-contract.md and docs/controller-contract.md present)
Re-probe before dispatching anything (live state beats this doc):
- `psql -At -c "select count(*),max(created_at)::date from ob_session_events"`
  → expect a count above 11647 and today's date
- `lsof -tiTCP:3100 -sTCP:LISTEN` → expect one pid

## State 2 — LAND THE PAPERWORK
Branch: `fix/recall-serves-durable-memory` from `origin/main` — cut it if
absent; if the checkout is `main` or `fix/guard-label-not-codex` is merged
(PR #739), switch first, never work there.
Retire: `none` — `git branch --merged origin/main` names only `main`, and
`git worktree list` shows only the primary checkout.
Commit this handover: branch `fix/recall-serves-durable-memory`, path
`_DOCS/_handover/2026-08-25-recall-is-broken.md`, explicit-path staging,
`git commit -F` message file.
Scribe: #744 — started: `gh issue comment 744 --body "<session start note>"`
Done-check: `git log -1 --stat`

## State 3 — confirm D1 against the server
Tier: T1 — read-only diagnosis of a shared recall path; no live mutation
Deliverable: the code path where recall decides to serve `working_set` only,
named as file:line, plus whether durable memory is reachable and skipped or
never wired
Scope: read-only over src/ and server/; the dogfood database via psql
Must NOT: change behaviour, run migrations, or touch core01
Record: #744 comment naming the file:line for D1
Done-check: `rg -n 'not_durable_memory|working_set' src server` → the deciding branch (RED: not yet run)

## State 4 — prove the failure with an executable check
Tier: T1 — a new done-means check in a converted repo
Deliverable: `scripts/done-means/744-recall-serves-durable.sh` that recalls a
fact known to exist in ob_session_events and fails when item_count is 0
Scope: scripts/done-means/ only
Must NOT: weaken the assertion to make it pass; author it in the same pass as
any fix
Record: #744 comment carrying the RED output
Done-check: `bash scripts/done-means/744-recall-serves-durable.sh` → exit 1 (RED: not yet run)

## State 5 — explain the August capture collapse
Tier: T1 — diagnosis over shared capture path; no mutation
Deliverable: the reason August holds 1062 events against July's 7673, plus
the query saved as scripts/done-means/monthly-event-counts.sql (create it)
Scope: read-only psql over ob_session_events and ob_raw_turns; apps/capture/
Must NOT: backfill, re-embed, or delete any row
Record: new issue linked from #744, or a #744 comment if it is the same cause
Done-check: `psql -At -f scripts/done-means/monthly-event-counts.sql` → counts the explanation accounts for (RED: not yet run)

## State 6 — WAYFINDER QUOTA
Close: #744 once D1 has a named file:line and the State 4 check exists; tick
the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- D2/D3/D4 of #744 are unconfirmed against the server; this slice takes D1 only.
- Whether #433 is the same root cause as #744 D1 is UNVERIFIED — read #433
  before assuming they are separate.
- The prior session acted as doer rather than dispatching lanes; States 3-5
  are written to be dispatched, not executed by the head.
