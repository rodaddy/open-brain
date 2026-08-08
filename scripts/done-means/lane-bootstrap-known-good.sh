#!/usr/bin/env bash
# DONE-MEANS check for ledger item 15 (docs/issue-graph.md:261) —
# scripts/lane-bootstrap.ts: one command that stands up a KNOWN-GOOD lane
# environment.
#
#   bash scripts/done-means/lane-bootstrap-known-good.sh
#
# Ledger item 15 acceptance, from the decisions pass 2026-08-07:
#   "the script must carry a stated reason for the worktree (worktrees-need-a-
#    reason rule stays intact) and never creates silently. Teardown deliberately
#    NOT scripted: `git worktree remove` per AGENTS.md remains the manual,
#    agent-owned cleanup."
#
# WHY THIS CHECK EXISTS AT ALL. Tonight ~5 lanes hand-built their environments
# and each hit one of: missing .env, missing bun-types (deps never installed),
# or a pipe that swallowed a non-zero exit so a broken environment reported
# success. The failure mode is therefore NOT "the script errored" — it is "the
# script said fine and the environment was not". So this check refuses to
# accept the script's own output as evidence of a good environment. It goes
# INTO the worktree and drives the real compiler.
#
# ---------------------------------------------------------------------------
# What each clause proves, and why it is that specific probe
# ---------------------------------------------------------------------------
# CLAUSE 1 — refusal path. No --reason must exit NON-ZERO and NAME the rule.
#   Exit code alone is not enough: a script that dies on an unrelated crash
#   also exits non-zero. The stderr must name the worktrees-need-a-reason rule,
#   because the point of the constraint is that the human reading the lane
#   transcript learns WHY it refused.
#
# CLAUSE 2 — happy path, proven from inside the worktree, not from the report.
#   `bunx tsc --noEmit` is the probe precisely because it is what FAILED for
#   the lanes tonight: tsc cannot resolve `bun-types` unless `bun install`
#   genuinely completed, so a green typecheck is direct evidence that deps are
#   real. `test -f .env` is checked separately because a missing .env is a
#   distinct failure that tsc would not notice at all.
#
# CLAUSE 3 — --fresh-db. The printed OPENBRAIN_TEST_DATABASE_URL must actually
#   connect (`psql <url> -c 'select 1'`), and TWO runs must produce DIFFERENT
#   database names. The second half is the collision-proof requirement: a
#   fixed-name test DB is how two concurrent lanes silently truncate each
#   other's tables.
#
# CLAUSE 4 — teardown is PRINTED, NEVER EXECUTED. The output must contain the
#   `git worktree remove` and `dropdb` lines, AND the worktree must still exist
#   on disk after the run. This is the ledger's explicit rejection record
#   (docs/issue-graph.md:284) encoded as a test: a bootstrap script that also
#   removes things is the thing the operator turned down.
#
# ---------------------------------------------------------------------------
# Cleanup ownership
# ---------------------------------------------------------------------------
# This CHECK created the worktrees and databases below, so this check removes
# them — that is consistent with AGENTS.md, which makes `git worktree remove`
# the agent-owned cleanup for worktrees the agent itself created. It never
# removes anything it did not create: every artifact carries this run's random
# RUN_ID. Nothing here uses `rm -rf`.
#
# EXPECTED TO FAIL (RED) until scripts/lane-bootstrap.ts exists. It is the
# reward function, not a test of the implementer.
set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORKTREE_BASE="/Volumes/ThunderBolt/_tmp/open-brain/_worktrees"
SCRIPT_REL="scripts/lane-bootstrap.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "REPO_ROOT=$REPO_ROOT is not a git checkout"

RUN_ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

# Branch/worktree names carry RUN_ID so teardown can never touch a real lane.
BR_A="donemeans-lb-${RUN_ID}-a"
BR_B="donemeans-lb-${RUN_ID}-b"
WT_A="${WORKTREE_BASE}/${BR_A}"
WT_B="${WORKTREE_BASE}/${BR_B}"

CREATED_DBS=()
CREATED_WTS=()
CREATED_BRS=()

# --- teardown: only this run's artifacts, all by RUN_ID --------------------
teardown() {
  # Databases first: a live connection from a worktree process would block drop.
  if [ -r "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
    for db in "${CREATED_DBS[@]:-}"; do
      [ -n "$db" ] || continue
      case "$db" in
        *"$RUN_ID"*) dropdb --if-exists --force "$db" >/dev/null 2>&1 ;;
        *) printf 'REFUSING to drop unexpected db name: %s\n' "$db" >&2 ;;
      esac
    done
  fi
  for wt in "${CREATED_WTS[@]:-}"; do
    [ -n "$wt" ] || continue
    case "$wt" in
      *"$RUN_ID"*) git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 ;;
      *) printf 'REFUSING to remove unexpected worktree: %s\n' "$wt" >&2 ;;
    esac
  done
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1
  for br in "${CREATED_BRS[@]:-}"; do
    [ -n "$br" ] || continue
    case "$br" in
      *"$RUN_ID"*) git -C "$REPO_ROOT" branch -D "$br" >/dev/null 2>&1 ;;
    esac
  done
}
trap teardown EXIT

CLAUSE1=FAIL; EV1=""
CLAUSE2=FAIL; EV2=""
CLAUSE3=FAIL; EV3=""
CLAUSE4=FAIL; EV4=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — no --reason refuses, non-zero, naming the rule
# ---------------------------------------------------------------------------
OUT1="$(cd "$REPO_ROOT" && bun "$SCRIPT_REL" --branch "$BR_A" 2>&1)"
EXIT1=$?

if [ "$EXIT1" -eq 0 ]; then
  CLAUSE1=FAIL
  EV1="exit=0 — ran without --reason; the worktrees-need-a-stated-reason rule is not enforced"
elif printf '%s' "$OUT1" | grep -qi 'reason'; then
  CLAUSE1=PASS
  EV1="exit=$EXIT1 non-zero and stderr/stdout names the reason rule"
else
  CLAUSE1=FAIL
  EV1="exit=$EXIT1 non-zero but UNNAMED: output does not mention the reason rule (output head: $(printf '%s' "$OUT1" | head -c 160))"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — happy path: the environment is genuinely good, proven inside it
# ---------------------------------------------------------------------------
OUT2="$(cd "$REPO_ROOT" && bun "$SCRIPT_REL" --branch "$BR_A" --reason "done-means check" 2>&1)"
EXIT2=$?
CREATED_WTS+=("$WT_A"); CREATED_BRS+=("$BR_A")

if [ "$EXIT2" -ne 0 ]; then
  CLAUSE2=FAIL
  EV2="bootstrap exited $EXIT2 (output head: $(printf '%s' "$OUT2" | head -c 200))"
elif [ ! -d "$WT_A" ]; then
  CLAUSE2=FAIL
  EV2="exit=0 but no worktree at $WT_A — reported success without creating the lane"
else
  ENV_OK=FAIL
  [ -f "$WT_A/.env" ] && ENV_OK=PASS
  # The real probe: tsc resolves bun-types only if deps genuinely installed.
  TSC_OUT="$(cd "$WT_A" && bunx tsc --noEmit 2>&1)"
  TSC_EXIT=$?
  if [ "$ENV_OK" = PASS ] && [ "$TSC_EXIT" -eq 0 ]; then
    CLAUSE2=PASS
    EV2="worktree=$WT_A .env present; bunx tsc --noEmit exit=0 (deps incl. bun-types resolve)"
  else
    CLAUSE2=FAIL
    EV2=".env=$ENV_OK tsc_exit=$TSC_EXIT (tsc head: $(printf '%s' "$TSC_OUT" | head -c 200))"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — --fresh-db: url connects, and two runs differ (collision-proof)
# ---------------------------------------------------------------------------
url_from() { printf '%s' "$1" | grep -o 'postgres://[^[:space:]"]*' | tail -1; }
db_from()  { printf '%s' "$1" | sed 's#.*/##; s/?.*//'; }

OUT3="$(cd "$REPO_ROOT" && bun "$SCRIPT_REL" --branch "$BR_B" --reason "done-means check" --fresh-db 2>&1)"
EXIT3=$?
CREATED_WTS+=("$WT_B"); CREATED_BRS+=("$BR_B")
URL_B="$(url_from "$OUT3")"
DB_B="$(db_from "$URL_B")"
[ -n "$DB_B" ] && CREATED_DBS+=("$DB_B")

# Second --fresh-db run on the SAME branch name is what would collide if the
# db name were derived from the branch alone. It must be refused (worktree
# exists) or produce a different db; either way we only compare names when a
# second url is actually printed.
DB_A2=""
if [ "$EXIT3" -eq 0 ] && [ -n "$URL_B" ]; then
  if psql "$URL_B" -At -c 'select 1' >/dev/null 2>&1; then
    BR_C="donemeans-lb-${RUN_ID}-c"
    WT_C="${WORKTREE_BASE}/${BR_C}"
    OUT3B="$(cd "$REPO_ROOT" && bun "$SCRIPT_REL" --branch "$BR_C" --reason "done-means check" --fresh-db 2>&1)"
    CREATED_WTS+=("$WT_C"); CREATED_BRS+=("$BR_C")
    URL_C="$(url_from "$OUT3B")"
    DB_A2="$(db_from "$URL_C")"
    [ -n "$DB_A2" ] && CREATED_DBS+=("$DB_A2")
    if [ -n "$DB_A2" ] && [ "$DB_A2" != "$DB_B" ]; then
      CLAUSE3=PASS
      EV3="psql select 1 OK on run-1 url; db names differ across runs ($DB_B vs $DB_A2)"
    else
      CLAUSE3=FAIL
      EV3="db name not collision-proof: run1=$DB_B run2=${DB_A2:-<none printed>}"
    fi
  else
    CLAUSE3=FAIL
    EV3="printed url does not connect: psql select 1 failed for db=$DB_B"
  fi
else
  CLAUSE3=FAIL
  EV3="--fresh-db exit=$EXIT3, url printed='${URL_B:-<none>}' (head: $(printf '%s' "$OUT3" | head -c 200))"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — teardown printed, not executed
# ---------------------------------------------------------------------------
HAS_WT_LINE=0; HAS_DB_LINE=0
printf '%s' "$OUT3" | grep -q 'git worktree remove' && HAS_WT_LINE=1
printf '%s' "$OUT3" | grep -q 'dropdb' && HAS_DB_LINE=1

if [ "$HAS_WT_LINE" -eq 1 ] && [ "$HAS_DB_LINE" -eq 1 ] && [ -d "$WT_B" ]; then
  CLAUSE4=PASS
  EV4="output carries 'git worktree remove' and 'dropdb'; worktree $WT_B still present after the run (nothing auto-deleted)"
else
  CLAUSE4=FAIL
  EV4="worktree_remove_line=$HAS_WT_LINE dropdb_line=$HAS_DB_LINE worktree_still_exists=$([ -d "$WT_B" ] && echo yes || echo no)"
fi

printf 'CLAUSE 1 (refuses without --reason, names the rule): %s — %s\n' "$CLAUSE1" "$EV1"
printf 'CLAUSE 2 (worktree env genuinely good: .env + tsc): %s — %s\n' "$CLAUSE2" "$EV2"
printf 'CLAUSE 3 (--fresh-db url connects, collision-proof): %s — %s\n' "$CLAUSE3" "$EV3"
printf 'CLAUSE 4 (teardown printed, never executed): %s — %s\n' "$CLAUSE4" "$EV4"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ]; then
  exit 0
fi
exit 1
