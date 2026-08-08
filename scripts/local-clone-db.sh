#!/opt/homebrew/bin/bash
# Clone the live dogfood database into a disposable playground database.
#
# Point-in-time snapshot, by design. The live service keeps ingesting, so the
# two diverge from the moment the clone is taken. Re-pull when you want current
# data; NEVER merge playground data back into live.
#
# SEPARATE DATABASE, NOT A SEPARATE SCHEMA. The repo's own migration test says
# why (src/db/migrations/028_maintenance_jobs_lease_expired_compat.test.ts:83):
#
#   "A dedicated Client (not a Pool) so the schema-scoping search_path set once
#    at connect time holds for every query in this file. A Pool hands out
#    arbitrary connections, which would let a query leak back to public."
#
# The server runs on a pg.Pool (src/db/pool.ts:19) and sets no search_path, so a
# schema-scoped playground would silently write into `public` -- the live
# dogfood data -- the moment the pool opened a second connection. A separate
# database makes that impossible rather than merely unlikely.
#
# Schemas INSIDE the playground database are fine and are the right tool for
# parallel isolated test runs: that is Client-based test code, which is exactly
# the context the migration test proves is safe.
#
# Usage:
#   scripts/local-clone-db.sh                    # clone live -> open_brain_play
#   scripts/local-clone-db.sh <target>           # clone live -> <target>
#   scripts/local-clone-db.sh --drop <target>    # drop a playground database
#   scripts/local-clone-db.sh --list             # list playground databases
#
# Environment (read from the repo .env if present, else the shell):
#   PGHOST PGPORT PGUSER   libpq connection coordinates
#   OPENBRAIN_LIVE_DB      source database (default open_brain_local_20260724)
#   OPENBRAIN_PLAY_DB      default target  (default open_brain_play)
set -euo pipefail

REPO_DIR="${OPENBRAIN_REPO_DIR:-$HOME/Development/open-brain}"
LIVE_DB="${OPENBRAIN_LIVE_DB:-open_brain_local_20260724}"
# The open_brain_local_ prefix is REQUIRED, not stylistic: the runtime's
# fail-closed guard (src/local-clone-mode.ts:154) refuses to start local clone
# mode without it. A name that only satisfies the disposable-name rule below
# produces a database that clones fine and then cannot be served.
DEFAULT_PLAY_DB="${OPENBRAIN_PLAY_DB:-open_brain_local_play}"

log() { printf '%s local-clone-db: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
fatal() { printf 'FATAL: %s\n' "$1" >&2; exit 1; }

# The repo .env carries the standard libpq vars, so psql needs no connection
# arguments. Deriving a connection by hand cost five failed calls every time
# until those were added on 2026-07-29 (AGENTS.md).
if [[ -r "${REPO_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_DIR}/.env"
  set +a
fi

# A playground database name must be recognisable as disposable. This is the
# guard that stops `--drop` from ever being pointed at the live database by a
# typo or a stale shell variable.
assert_disposable() {
  local name="$1"
  case "$name" in
    *play*|*scratch*|*test*) ;;
    *) fatal "refusing to operate on '${name}': a playground database name must contain 'play', 'scratch', or 'test'" ;;
  esac
  [[ "$name" != "$LIVE_DB" ]] || fatal "refusing to operate on the live database '${LIVE_DB}'"
}

# Checked BEFORE the clone, not after: the runtime guard only rejects a bad
# name at startup, which would be a 3-minute dump/restore followed by a server
# that refuses to boot.
assert_servable() {
  local name="$1"
  [[ "$name" == open_brain_local_* ]] || fatal \
    "refusing to create '${name}': src/local-clone-mode.ts requires DB_NAME to start with open_brain_local_, so this database could be cloned but never served"
}

db_exists() {
  [[ "$(psql -At -d postgres -c "select 1 from pg_database where datname = '$1'")" == "1" ]]
}

if [[ "${1:-}" == "--list" ]]; then
  psql -d postgres -c \
    "select datname, pg_size_pretty(pg_database_size(datname)) as size
       from pg_database
      where datname like '%play%' or datname like '%scratch%'
      order by datname;"
  exit 0
fi

if [[ "${1:-}" == "--drop" ]]; then
  TARGET="${2:-}"
  [[ -n "$TARGET" ]] || fatal "--drop requires a database name"
  assert_disposable "$TARGET"
  db_exists "$TARGET" || fatal "no such database: ${TARGET}"
  log "dropping ${TARGET}"
  dropdb --if-exists --force "$TARGET"
  log "dropped ${TARGET}"
  exit 0
fi

TARGET="${1:-$DEFAULT_PLAY_DB}"
assert_disposable "$TARGET"
assert_servable "$TARGET"

db_exists "$LIVE_DB" || fatal "source database not found: ${LIVE_DB}"

live_size="$(psql -At -d postgres -c "select pg_size_pretty(pg_database_size('${LIVE_DB}'))")"
log "source ${LIVE_DB} (${live_size}) -> target ${TARGET}"

if db_exists "$TARGET"; then
  log "target exists; dropping it first"
  dropdb --if-exists --force "$TARGET"
fi

# pg_dump/pg_restore rather than CREATE DATABASE ... TEMPLATE: TEMPLATE requires
# ZERO active connections to the source, and the live service holds a pool open.
# Dump/restore works while live stays up, which is the whole point of having a
# playground.
#
# Custom format (-Fc) so pg_restore can run in parallel.
#
# Ownership and ACLs are PRESERVED, not stripped. Measured 2026-07-30: live
# carries MIXED ownership -- 23 public tables owned by open_brain_local_clone
# and 10 by rico. Restoring with --no-owner flattened all 33 to the invoking
# user, and migrations then failed with "permission denied for table
# _migrations" because the service connects as the clone role. A playground
# whose permissions differ from live is not a playground; it fails in ways live
# never would, and passes things live would reject.
#
# This works without --no-owner because both roles already exist locally. On a
# host where they do not, the restore would need them created first -- which is
# the correct failure, not a reason to strip ownership.
DUMP_DIR="${TMPDIR_OVERRIDE:-$HOME/.local/state/open-brain/_scratch}"
mkdir -p "$DUMP_DIR"
DUMP_FILE="${DUMP_DIR}/${TARGET}-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Own the clone with the SAME role that owns the source. Measured 2026-07-30:
# a database created by `rico` and handed to the clone role's connection failed
# migrations with "permission denied for schema public". Live's public schema
# is granted `pg_database_owner=UC`, so schema rights follow database ownership
# -- matching the owner is the fix, and it needs no explicit GRANT statements
# that could drift from live.
SOURCE_OWNER="$(psql -At -d postgres -c "select pg_get_userbyid(datdba) from pg_database where datname = '${LIVE_DB}'")"
[[ -n "$SOURCE_OWNER" ]] || fatal "could not determine the owner of ${LIVE_DB}"

log "creating ${TARGET} owned by ${SOURCE_OWNER}"
createdb -E UTF8 -T template0 -O "$SOURCE_OWNER" "$TARGET"

# pgvector must exist before the restore replays halfvec columns.
psql -q -d "$TARGET" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;"

log "dumping ${LIVE_DB} (live service stays up)"
pg_dump -Fc -d "$LIVE_DB" -f "$DUMP_FILE"
log "dump written: $(du -h "$DUMP_FILE" | cut -f1)"

log "restoring into ${TARGET}"
# The vector extension already exists, so its CREATE EXTENSION in the dump is a
# duplicate; --exit-on-error would abort on it. Errors are reported and counted
# instead, then asserted against below.
restore_log="${DUMP_FILE}.restore.log"
if ! pg_restore -j 4 -d "$TARGET" "$DUMP_FILE" 2>"$restore_log"; then
  error_count="$(grep -c '^pg_restore: error' "$restore_log" || true)"
  log "pg_restore reported ${error_count} error line(s); see ${restore_log}"
fi

# Prove the clone actually carries data. A restore that silently produced an
# empty database would otherwise look like success.
live_turns="$(psql -At -d "$LIVE_DB" -c "select count(*) from ob_raw_turns" 2>/dev/null || echo "n/a")"
play_turns="$(psql -At -d "$TARGET" -c "select count(*) from ob_raw_turns" 2>/dev/null || echo "n/a")"
play_tables="$(psql -At -d "$TARGET" -c "select count(*) from information_schema.tables where table_schema='public'")"

log "verification: ${play_tables} tables; ob_raw_turns live=${live_turns} play=${play_turns}"

if [[ "$play_tables" -lt 1 ]]; then
  fatal "clone verification failed: ${TARGET} has no tables"
fi

# Ownership has to match live, or the service connects and cannot write. This
# failed twice on 2026-07-30 before the flags above were right, and BOTH times
# the row counts above looked perfect -- a clone can be complete and still be
# unusable, so counting rows alone is not verification.
live_owners="$(psql -At -d "$LIVE_DB" -c "select tableowner || ':' || count(*) from pg_tables where schemaname='public' group by tableowner order by tableowner" | paste -sd, -)"
play_owners="$(psql -At -d "$TARGET" -c "select tableowner || ':' || count(*) from pg_tables where schemaname='public' group by tableowner order by tableowner" | paste -sd, -)"

if [[ "$live_owners" != "$play_owners" ]]; then
  fatal "clone verification failed: table ownership differs.
  live: ${live_owners}
  play: ${play_owners}
A clone whose ownership differs from live fails in ways live never would."
fi

log "verification: ownership matches live (${play_owners})"

rm -f "$DUMP_FILE"
log "clone complete: ${TARGET} (dump removed; restore log at ${restore_log})"
log "point-in-time snapshot -- live keeps ingesting, so these diverge from now"
