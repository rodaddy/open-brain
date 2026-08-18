#!/opt/homebrew/bin/bash
# Open Brain scheduled backup runner (issue #677, cutover blocker B4).
#
# This is the program launchd invokes. It is deliberately thin: every decision
# that matters already lives in the tested CLIs (scripts/backup.ts,
# scripts/backup-verify.ts). What this adds is the three things a scheduled
# invocation needs and a CLI does not:
#
#   1. a per-run dated destination under the backups root, so runs do not
#      collide and a set is identifiable by name;
#   2. env loading, because launchd starts a job with almost no environment —
#      a job that inherits nothing is the classic reason a scheduled task works
#      by hand and fails at 03:00;
#   3. VERIFICATION of what it just wrote, because an unverified backup is a
#      belief, not a backup. #677 exists because a backup nobody looked at
#      turned out to be 16 days and 15 migrations stale.
#
# It never removes anything. Retention is operator-run per
# docs/backup-restore.md:19, and a scheduled job that deletes backup sets is a
# larger risk than the disk it protects against.
#
# The deploy-overlap guard is NOT here: it lives inside scripts/backup.ts, so
# it protects every caller rather than only this one. A backup that fires
# during a deploy exits 4 and writes nothing.
#
# Exit codes: 0 backup written and verified; non-zero otherwise (4 = refused
# because a deploy is in flight, which is a correct skip, not a fault — the
# next scheduled run takes a clean dump).

set -uo pipefail

REPO_DIR="${OPENBRAIN_BACKUP_REPO_DIR:-/Volumes/ThunderBolt/open-brain/app}"
BACKUP_ROOT="${OPENBRAIN_BACKUP_ROOT:-/Volumes/ThunderBolt/open-brain/backups}"
ENV_FILE="${OPENBRAIN_BACKUP_ENV_FILE:-/Users/rico/.config/open-brain/env}"
BUN_BIN="${BUN_BIN:-}"

log() {
  printf '%s openbrain-backup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

fatal() {
  log "FATAL: $1"
  exit 1
}

[[ -d "$REPO_DIR" ]] || fatal "repo dir does not exist: $REPO_DIR"
[[ -r "$ENV_FILE" ]] || fatal "env file is not readable: $ENV_FILE"

# launchd gives a job a near-empty environment, so bun is resolved explicitly
# rather than trusted to be on PATH. Same resolution order the deploy uses.
if [[ -z "$BUN_BIN" ]]; then
  if [[ -x "/Users/rico/Library/Application Support/reflex/bun/bin/bun" ]]; then
    BUN_BIN="/Users/rico/Library/Application Support/reflex/bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    fatal "bun not found (launchd jobs inherit almost no PATH; set BUN_BIN)"
  fi
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# DB_NAME selects WHICH BRAIN gets backed up. #676 records that it silently
# defaults to open_brain; a scheduled job that quietly backs up the wrong
# database would look healthy forever. Required here, loudly (ledger 28:
# identity config is never silently defaulted).
[[ -n "${DB_NAME:-}" ]] || fatal "DB_NAME is not set in $ENV_FILE — refusing to guess which database to back up"
[[ -n "${DB_HOST:-}" ]] || fatal "DB_HOST is not set in $ENV_FILE"
[[ -n "${DB_USER:-}" ]] || fatal "DB_USER is not set in $ENV_FILE"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SET_DIR="$BACKUP_ROOT/$DB_NAME-$STAMP"

if ! mkdir -p "$BACKUP_ROOT"; then
  fatal "could not create the backups root: $BACKUP_ROOT"
fi

log "starting backup of $DB_NAME on $DB_HOST -> $SET_DIR"

cd "$REPO_DIR" || fatal "could not enter repo dir: $REPO_DIR"

"$BUN_BIN" run "$REPO_DIR/scripts/backup.ts" --out "$SET_DIR"
backup_rc=$?

if [[ "$backup_rc" -eq 4 ]]; then
  log "SKIPPED: a deploy is in progress; no backup written. The next scheduled run takes a clean dump."
  exit 4
fi

if [[ "$backup_rc" -ne 0 ]]; then
  fatal "backup failed with exit $backup_rc (no verified set written)"
fi

log "backup written; verifying the set that was just created"

# Verify the SET WE JUST WROTE, not the root. Verifying the root would pass on
# the strength of some OTHER, older set while today's was corrupt — the exact
# shape of misreading that let #677 sit undetected for 16 days.
"$BUN_BIN" run "$REPO_DIR/scripts/backup-verify.ts" --dir "$SET_DIR"
verify_rc=$?

if [[ "$verify_rc" -ne 0 ]]; then
  fatal "backup at $SET_DIR FAILED verification (exit $verify_rc) — treat this set as unusable"
fi

# Staleness check across the whole root. This is the alert #677 asked for: it
# answers "is there a CURRENT restorable backup", which is a different question
# from "did tonight's run succeed" — a job that has been failing silently for a
# week passes the first and fails this.
"$BUN_BIN" run "$REPO_DIR/scripts/backup-verify.ts" --dir "$BACKUP_ROOT" --max-age-hours 26
stale_rc=$?

if [[ "$stale_rc" -eq 3 ]]; then
  log "ALERT: the newest VALID backup in $BACKUP_ROOT is older than 26h despite tonight's run succeeding — investigate"
  exit 3
fi

if [[ "$stale_rc" -ne 0 ]]; then
  fatal "root-level verification failed with exit $stale_rc"
fi

log "OK: backup written and verified at $SET_DIR"
exit 0
