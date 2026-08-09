#!/usr/bin/env bash
# DONE-MEANS check for issue #677 — cutover blocker B4: "no scheduled backup on
# core01; only backup is 16 days / 15 migrations old; disk loss = catastrophic".
#
#   bash scripts/done-means/677-scheduled-backup.sh
#
# ---------------------------------------------------------------------------
# WHAT ALREADY EXISTS, AND WHAT THE DELTA IS
# ---------------------------------------------------------------------------
# The backup SUBSTRATE is real and good, and none of it is being replaced:
# scripts/backup.ts (pg_dump -Fc inside an exported REPEATABLE READ snapshot),
# scripts/backup-verify.ts (integrity + runtime compatibility, --max-age-hours
# staleness), scripts/restore.ts (fail-closed restore with post-restore row /
# archived / namespace / migration validation), and a live CI drill
# (scripts/__tests__/backup-restore-live.test.ts under OPENBRAIN_BACKUP_DRILL=1).
#
# What does not exist is any INVOCATION. #677 measured it:
#   - docs/backup-restore.md:149-156 — launchd/cron wiring is "deliberately left
#     to the operator runbook and NOT shipped in this repo".
#   - `rg -n -i backup deploy/` -> 0 hits; `fd -e plist` -> 0 schedulers.
#   - The only backup set on disk is dated 2026-07-24 at migration head 031;
#     the repo head is 046. Stated RPO 24h, observed RPO 16 days and unbounded.
#
# So the delta is three things, and this check is shaped as one clause each
# plus controls:
#   1. a SCHEDULE (launchd plist template + installer), which is the thing whose
#      absence is the blocker;
#   2. ONE restore proven END TO END at the CURRENT schema — not the 07-24 set,
#      not only the CI drill's ephemeral image — asserted by a row-count and
#      schema-hash comparison between source and restored database;
#   3. an OVERLAP GUARD, because docs/backup-restore.md:200 records that a dump
#      taken mid-migration captures a half-applied schema that "verify cannot
#      detect from the outside" — an undetectably corrupt backup is worse than a
#      missing one, so scheduling WITHOUT this clause would make the blocker
#      subtler rather than smaller.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (round 12 / round 23)
# ---------------------------------------------------------------------------
# Every subject here is a file that SHIPS in this repo, so "which copy executes"
# is the whole question. REPO_ROOT is derived from THIS FILE's own location
# (BASH_SOURCE), and every path below hangs off it. Running this check from a
# lane worktree tests that worktree's files; running it from the primary
# checkout tests the primary checkout's. It structurally cannot reach across
# trees.
#
# ---------------------------------------------------------------------------
# WHICH DATABASE RUNS
# ---------------------------------------------------------------------------
# Clause (c) creates its OWN two databases, both carrying this run's RUN_ID, and
# drops only names containing that RUN_ID. It never reads, writes, or names the
# dogfood database (open_brain_local_20260724) and it never reads DB_NAME from
# the ambient env for its source. A restore proof run against a database other
# work is mutating would be unfalsifiable — row counts would move underneath it.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) THE SCHEDULE EXISTS AND IS A VALID, PERIODIC LAUNCHD JOB. A plist
#       TEMPLATE ships in docs/deploy/, `plutil -lint` accepts the RENDERED
#       output (not the template — the template contains __PLACEHOLDER__ tokens
#       and linting it would prove only that placeholders are legal strings),
#       the rendered job carries a StartCalendarInterval, and its
#       ProgramArguments point at the installed backup runner. RED pre-fix: no
#       backup plist template exists at all.
#
#       Load-bearing detail: the check RENDERS via the shipped installer with a
#       fake install root, rather than hand-substituting the tokens itself.
#       Round 25's rule — "when a gate has no clause-level seam, EXTRACT from
#       the real file, never retype it" — applies to rendering too: a
#       hand-rendered plist proves the check's own sed, not the installer's.
#
#   (b) THE INSTALLER REFUSES A HOSTILE RENDER VALUE. The qmd-sync installer
#       precedent (scripts/install-qmd-sync-launchagent.sh) validates every
#       interpolated value against XML metacharacters, because a value
#       containing `<` silently produces a plist that means something other than
#       what the operator asked for. A value containing `<` must be REFUSED with
#       a non-zero exit, and — the half that distinguishes a guard from an
#       exception (round 16) — NO plist may be left behind by the refused run.
#       Control: the same installer with a clean value SUCCEEDS, so the clause
#       cannot pass by refusing everything.
#
#   (c) ONE FULL RESTORE, END TO END, AT THE CURRENT SCHEMA. This is the
#       issue's own "run ONE restore end-to-end before cutover" and it is the
#       heart of the check. The clause:
#         1. creates a SOURCE database at the repo's migration head and SEEDS it
#            with rows in the tables the manifest counts (an empty database
#            would make every count comparison trivially equal — 0 == 0 is the
#            vacuous green round 25 warns about);
#         2. runs the REAL scripts/backup.ts against it;
#         3. runs the REAL scripts/restore.ts into a SECOND, empty database;
#         4. compares SOURCE and RESTORED directly, from OUTSIDE both scripts:
#            per-table row counts must match exactly for every table in
#            COUNT_TABLE_ALLOWLIST, and the schema hash — computed by this check
#            from information_schema over both databases, not read from either
#            script's receipt — must be identical.
#       Comparing from outside is the point. restore.ts performs its own
#       post-restore validation, and a receipt saying "ok" is the thing under
#       test, never the proof (round 16: "a teardown that reports success is not
#       evidence of removal", same shape). If restore.ts's internal comparison
#       were subtly wrong, reading its receipt would launder the defect.
#       RED pre-fix: nothing here depends on new code, so this clause is
#       EXPECTED TO PASS PRE-FIX — it is the CONTROL that proves the substrate
#       works, and it is what converts "restore is drilled in CI" into "restore
#       ran at head 046 on this machine, on this date". Its value is the receipt
#       it writes, not a red-to-green transition. Stated openly so nobody reads
#       its pre-fix PASS as a broken check.
#
#   (d) THE OVERLAP GUARD REFUSES A BACKUP WHILE A DEPLOY HOLDS THE LOCK.
#       With the deploy lock HELD by a separate live connection, scripts/backup.ts
#       must exit NON-ZERO and must NOT write a backup set. RED pre-fix: no lock
#       exists, so the backup completes happily mid-deploy and writes a set.
#       Two halves, deliberately in ONE clause each (round 17: a two-audience
#       claim split into two clauses passes for the wrong reason):
#         (d1) refusal happens AND no dump file is left behind;
#         (d2) the refusal message NAMES the deploy as the cause, because a
#              refusal that does not tell the operator what to reconcile is a
#              dead end (round 15's dead-end-error class).
#
#   (e) CONTROL — THE GUARD DOES NOT REFUSE A NORMAL BACKUP. With NO lock held,
#       the same backup command against the same database SUCCEEDS. Without
#       this, a guard that refuses unconditionally — the trivially "safe"
#       implementation — would satisfy (d) completely while disabling backups
#       altogether, which is the blocker restated, not fixed.
#
#   (f) CONTROL — THE DEPLOY SIDE ACTUALLY TAKES THE LOCK. A guard is only
#       mutual exclusion if BOTH sides participate. scripts/core01-deploy-local.sh
#       must acquire the lock before it mutates anything, and the check asserts
#       the acquisition happens BEFORE the migrate/staging steps in the script's
#       own order — a lock taken after `bun run migrate` protects nothing, and
#       reads identically in a diff.
#
#   (g) THE CORE01 INSTALL STEP IS WRITTEN, NOT EXECUTED. This lane is forbidden
#       from contacting core01, so the deliverable for the host half is a
#       runbook section. The check asserts docs/backup-restore.md carries a
#       cutover-runbook section naming the installer and the plist, AND that the
#       previously-recorded "deliberately left to the operator runbook and NOT
#       shipped in this repo" claim is gone — a doc that both ships wiring and
#       says it ships none is how the next reader concludes wrong.
#
# ---------------------------------------------------------------------------
# TEARDOWN
# ---------------------------------------------------------------------------
# Databases created here are dropped by exact name, and only names containing
# this run's RUN_ID. Files are written under a RUN_ID directory in _scratch/
# (gitignored, repo-relative per round "no absolute machine paths"), and are
# left in place — no `rm` in any spelling, ever (lane contract rule 7). The
# path is printed so it can be archived or read.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

RUN_ID="dm677$(date +%Y%m%d%H%M%S)$$"
SCRATCH="$REPO_ROOT/_scratch/677-scheduled-backup/$RUN_ID"
mkdir -p "$SCRATCH"

PLIST_TEMPLATE="$REPO_ROOT/docs/deploy/com.rico.open-brain-backup.plist.template"
INSTALLER="$REPO_ROOT/scripts/install-backup-launchagent.sh"
DEPLOY_SCRIPT="$REPO_ROOT/scripts/core01-deploy-local.sh"
BACKUP_DOC="$REPO_ROOT/docs/backup-restore.md"

PASS=0
FAIL=0

pass() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '        %s\n' "$1"; }

printf '=== DONE-MEANS #677 — scheduled backup, proven restore, overlap guard ===\n'
printf 'repo:    %s\n' "$REPO_ROOT"
printf 'run id:  %s\n' "$RUN_ID"
printf 'scratch: %s\n' "$SCRATCH"

# ---------------------------------------------------------------------------
# Environment resolution. The check needs a Postgres it may create databases
# in. It reads the LANE database URL, never the dogfood database, and refuses
# loudly rather than falling through to a misleading failure (round 15: name
# where the credential comes from, refuse when absent).
# ---------------------------------------------------------------------------
PGH="${DB_HOST:-127.0.0.1}"
PGP="${DB_PORT:-5432}"
PGU="${DB_USER:-$(id -un)}"

if [[ -n "${OPENBRAIN_TEST_DATABASE_URL:-}" ]]; then
  # postgres://user@host:port/dbname
  _url="${OPENBRAIN_TEST_DATABASE_URL#*://}"
  _userhost="${_url%%/*}"
  PGU="${_userhost%%@*}"
  _hostport="${_userhost#*@}"
  PGH="${_hostport%%:*}"
  PGP="${_hostport#*:}"
  [[ "$PGP" == "$PGH" ]] && PGP=5432
fi

note "postgres: $PGU@$PGH:$PGP (source: ${OPENBRAIN_TEST_DATABASE_URL:+OPENBRAIN_TEST_DATABASE_URL}${OPENBRAIN_TEST_DATABASE_URL:-DB_* env})"

SRC_DB="dm677_src_$RUN_ID"
DST_DB="dm677_dst_$RUN_ID"

psqlq() { psql -X -At -h "$PGH" -p "$PGP" -U "$PGU" -d "$1" -c "$2"; }

if ! psql -X -At -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -c 'select 1' >/dev/null 2>&1; then
  printf '\nFATAL: cannot reach postgres at %s@%s:%s — this check creates its own\n' "$PGU" "$PGH" "$PGP"
  printf 'databases and cannot run without one. Run it from a lane bootstrapped\n'
  printf 'with --fresh-db, or set OPENBRAIN_TEST_DATABASE_URL.\n'
  exit 1
fi

teardown() {
  printf '\n--- teardown ---\n'
  for db in "$SRC_DB" "$DST_DB"; do
    # Prefix + RUN_ID guard: this loop can only ever name a database this run
    # created. A teardown that can name anything else is not teardown.
    if [[ "$db" != dm677_*"$RUN_ID" ]]; then
      printf '  REFUSED to drop %s (does not carry this run id)\n' "$db"
      continue
    fi
    # A lingering connection (the lock-holding session of clause (d), or a
    # backup pool that has not finished closing) makes dropdb fail. Observed on
    # the first run: the source database survived teardown and had to be
    # dropped by hand. Terminate this database's own backends first — scoped by
    # datname to the run-id-guarded name above, so it can only ever disconnect
    # sessions attached to a database this run created.
    psql -X -At -h "$PGH" -p "$PGP" -U "$PGU" -d postgres \
      -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" \
      >/dev/null 2>&1 || true
    if dropdb -h "$PGH" -p "$PGP" -U "$PGU" --if-exists "$db" 2>/dev/null; then
      printf '  dropped %s\n' "$db"
    else
      printf '  COULD NOT DROP %s — drop it by hand: dropdb %s\n' "$db" "$db"
    fi
  done
  printf '  scratch left in place (no rm, ever): %s\n' "$SCRATCH"
}
trap teardown EXIT

# ===========================================================================
printf '\n--- (a) launchd plist template exists, renders, and is a valid periodic job ---\n'
# ===========================================================================
RENDER_ROOT="$SCRATCH/render"
RENDERED_PLIST="$RENDER_ROOT/agents/com.rico.open-brain-backup.plist"

if [[ ! -r "$PLIST_TEMPLATE" ]]; then
  fail "(a) no backup plist template at docs/deploy/com.rico.open-brain-backup.plist.template"
elif [[ ! -x "$INSTALLER" ]]; then
  fail "(a) no executable installer at scripts/install-backup-launchagent.sh"
else
  mkdir -p "$RENDER_ROOT"
  # Render THROUGH THE SHIPPED INSTALLER (round 25: extract from the real file,
  # never retype), in a mode that writes the plist without bootstrapping it.
  if OPENBRAIN_BACKUP_INSTALL_ROOT="$RENDER_ROOT/install" \
     OPENBRAIN_BACKUP_LOG_DIR="$RENDER_ROOT/log" \
     OPENBRAIN_BACKUP_LAUNCH_AGENTS_DIR="$RENDER_ROOT/agents" \
     OPENBRAIN_BACKUP_RENDER_ONLY=1 \
     "$INSTALLER" > "$SCRATCH/installer-render.log" 2>&1; then
    note "installer render-only run exited 0"
  else
    note "installer render-only run exited non-zero (see installer-render.log)"
  fi

  if [[ ! -f "$RENDERED_PLIST" ]]; then
    fail "(a) installer did not produce a rendered plist at $RENDERED_PLIST"
  elif ! plutil -lint "$RENDERED_PLIST" >/dev/null 2>&1; then
    fail "(a) rendered plist is not a valid property list (plutil -lint refused)"
  else
    # Read structure with plutil, not by grepping XML: a grep for the KEY name
    # passes on a commented-out or wrongly-nested key.
    interval_type="$(plutil -type StartCalendarInterval -o - "$RENDERED_PLIST" 2>/dev/null || true)"
    prog0="$(plutil -extract ProgramArguments.0 raw -o - "$RENDERED_PLIST" 2>/dev/null || true)"
    label="$(plutil -extract Label raw -o - "$RENDERED_PLIST" 2>/dev/null || true)"
    if [[ -z "$interval_type" ]]; then
      fail "(a) rendered plist has no StartCalendarInterval — a job with no schedule is not a schedule"
    elif [[ -z "$prog0" ]]; then
      fail "(a) rendered plist has no ProgramArguments.0"
    elif [[ ! -f "$prog0" && ! -x "$prog0" ]]; then
      fail "(a) ProgramArguments.0 does not point at an installed runner: $prog0"
    elif [[ -z "$label" ]]; then
      fail "(a) rendered plist has no Label"
    else
      pass "(a) rendered plist is valid, periodic (StartCalendarInterval), label=$label"
      note "runner: $prog0"
      # No placeholder tokens may survive rendering in a VALUE — an
      # unsubstituted placeholder is a plist that lints fine and does nothing.
      # Scoped to <string> values, not the whole file: the template documents
      # its own placeholder syntax in a comment, and a whole-file match reads
      # that documentation as a defect. (Self-caught: the first green run
      # failed here on the template's own explanatory comment, and the
      # installer contained the identical over-broad guard — one mistake made
      # twice, in the checker and in the subject.)
      if rg -q '<string>[^<]*__[A-Z_]+__' "$RENDERED_PLIST"; then
        fail "(a) rendered plist still contains unsubstituted placeholders in a value"
      else
        pass "(a) no unsubstituted placeholders survive rendering into values"
      fi
    fi
  fi
fi

# ===========================================================================
printf '\n--- (b) installer refuses a hostile render value, and leaves nothing behind ---\n'
# ===========================================================================
HOSTILE_ROOT="$SCRATCH/hostile"
HOSTILE_AGENTS="$HOSTILE_ROOT/agents"
if [[ ! -x "$INSTALLER" ]]; then
  fail "(b) no installer to test"
else
  mkdir -p "$HOSTILE_AGENTS"
  set +e
  OPENBRAIN_BACKUP_INSTALL_ROOT="$HOSTILE_ROOT/install</key><key>RunAtLoad" \
  OPENBRAIN_BACKUP_LOG_DIR="$HOSTILE_ROOT/log" \
  OPENBRAIN_BACKUP_LAUNCH_AGENTS_DIR="$HOSTILE_AGENTS" \
  OPENBRAIN_BACKUP_RENDER_ONLY=1 \
    "$INSTALLER" > "$SCRATCH/installer-hostile.log" 2>&1
  hostile_rc=$?
  set -e
  leftover="$(fd -t f . "$HOSTILE_AGENTS" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$hostile_rc" -eq 0 ]]; then
    fail "(b) installer ACCEPTED a value containing XML metacharacters (exit 0)"
  elif [[ "$leftover" != "0" ]]; then
    fail "(b) installer refused (exit $hostile_rc) but left $leftover file(s) behind — refused before mutating is the claim"
  else
    pass "(b) installer refused the hostile value (exit $hostile_rc) and wrote no plist"
  fi
fi

# ===========================================================================
printf '\n--- (c) ONE full restore end-to-end at the current schema ---\n'
# ===========================================================================
# CONTROL CLAUSE, expected to PASS pre-fix. See the header. Its output is the
# receipt the issue asks for, not a red-to-green transition.
BACKUP_SET="$SCRATCH/backup-set"
restore_ok=1

if ! createdb -h "$PGH" -p "$PGP" -U "$PGU" -E UTF8 -T template0 "$SRC_DB" 2>"$SCRATCH/createdb-src.err"; then
  fail "(c) could not create source database $SRC_DB"
  restore_ok=0
elif ! createdb -h "$PGH" -p "$PGP" -U "$PGU" -E UTF8 -T template0 "$DST_DB" 2>"$SCRATCH/createdb-dst.err"; then
  fail "(c) could not create target database $DST_DB"
  restore_ok=0
else
  note "source=$SRC_DB target=$DST_DB"

  # 1. Migrate the SOURCE to the repo head. This is what makes the proof
  #    "at the current schema" rather than a replay of the 07-24 set.
  if ! DB_HOST="$PGH" DB_PORT="$PGP" DB_USER="$PGU" DB_NAME="$SRC_DB" \
       bun run "$REPO_ROOT/scripts/migrate.ts" > "$SCRATCH/migrate-src.log" 2>&1; then
    fail "(c) migrations failed against the source database"
    restore_ok=0
  else
    head_file="$(ls "$REPO_ROOT/src/db/migrations"/*.sql 2>/dev/null | sort | tail -1 | xargs -n1 basename)"
    applied="$(psqlq "$SRC_DB" "select count(*) from _migrations")"
    note "source migrated: $applied migrations applied, repo head file ${head_file:-<UNRESOLVED>}"
    if [[ -z "$head_file" ]]; then
      fail "(c) could not resolve the repo migration head file — 'at the current schema' is unproven if the head is unknown"
      restore_ok=0
    fi

    # 2. SEED. Empty tables make every count comparison vacuous (0 == 0).
    #    Rows go into namespace-carrying tables so the namespace inventory and
    #    archived-count validations have something to compare too. Column names
    #    are the REAL ones (thoughts has no thought_type; the lanes table is
    #    ob_session_lanes) — verified against information_schema, not recalled.
    #    NO FALLBACK: a seed that quietly degrades to a weaker shape is the
    #    adjusted-silently failure, and it would hide exactly the schema drift
    #    this clause exists to detect. A failed seed FAILS the clause.
    if ! psqlq "$SRC_DB" "
      insert into thoughts (namespace, content, created_by)
        select 'dm677-$RUN_ID', 'done-means seeded row ' || g, 'done-means-677'
        from generate_series(1, 7) g;
      insert into thoughts (namespace, content, created_by, archived_at)
        select 'dm677-$RUN_ID', 'done-means archived row ' || g, 'done-means-677', now()
        from generate_series(1, 3) g;
      insert into ob_session_lanes (namespace, session_key, created_by)
        select 'dm677-$RUN_ID', 'dm677-session-' || g, 'done-means-677'
        from generate_series(1, 2) g;
    " > "$SCRATCH/seed.log" 2>&1; then
      fail "(c) seeding FAILED — see $SCRATCH/seed.log (no silent fallback: a degraded seed hides schema drift)"
      note "$(tail -3 "$SCRATCH/seed.log" 2>/dev/null)"
      restore_ok=0
    fi
    seeded="$(psqlq "$SRC_DB" "select count(*) from thoughts where namespace = 'dm677-$RUN_ID'")"
    if [[ "${seeded:-0}" -lt 1 ]]; then
      fail "(c) seeding produced ZERO rows — a count comparison over empty tables proves nothing"
      restore_ok=0
    else
      note "seeded $seeded rows in namespace dm677-$RUN_ID"

      # 3. REAL backup.
      if ! DB_HOST="$PGH" DB_PORT="$PGP" DB_USER="$PGU" DB_NAME="$SRC_DB" \
           bun run "$REPO_ROOT/scripts/backup.ts" --out "$BACKUP_SET" \
           > "$SCRATCH/backup-receipt.json" 2>"$SCRATCH/backup.err"; then
        fail "(c) scripts/backup.ts failed against the source database"
        note "$(tail -3 "$SCRATCH/backup.err" 2>/dev/null)"
        restore_ok=0
      elif [[ ! -f "$BACKUP_SET/openbrain.dump" ]]; then
        fail "(c) backup reported success but wrote no dump file"
        restore_ok=0
      else
        dump_bytes="$(wc -c < "$BACKUP_SET/openbrain.dump" | tr -d ' ')"
        note "backup set written: $dump_bytes bytes"

        # 4. REAL restore into the empty target.
        if ! DB_HOST="$PGH" DB_PORT="$PGP" DB_USER="$PGU" \
             bun run "$REPO_ROOT/scripts/restore.ts" --dir "$BACKUP_SET" --target-db "$DST_DB" \
             > "$SCRATCH/restore-receipt.json" 2>"$SCRATCH/restore.err"; then
          fail "(c) scripts/restore.ts failed restoring into $DST_DB"
          note "$(tail -5 "$SCRATCH/restore.err" 2>/dev/null)"
          restore_ok=0
        else
          note "restore completed; comparing source and restored FROM OUTSIDE both scripts"

          # 5a. ROW COUNTS, table by table, computed by THIS check against both
          #     databases. Not read from either receipt.
          count_sql="select table_name from information_schema.tables
                     where table_schema = 'public' and table_type = 'BASE TABLE'
                     order by table_name"
          mismatches=0
          tables_compared=0
          while IFS= read -r tbl; do
            [[ -z "$tbl" ]] && continue
            a="$(psqlq "$SRC_DB" "select count(*) from \"$tbl\"" 2>/dev/null)"
            b="$(psqlq "$DST_DB" "select count(*) from \"$tbl\"" 2>/dev/null)"
            if [[ -z "$a" || -z "$b" ]]; then
              printf '        UNREADABLE %s (src=%s dst=%s)\n' "$tbl" "${a:-<none>}" "${b:-<none>}"
              mismatches=$((mismatches + 1))
              continue
            fi
            tables_compared=$((tables_compared + 1))
            if [[ "$a" != "$b" ]]; then
              printf '        MISMATCH %s: src=%s restored=%s\n' "$tbl" "$a" "$b"
              mismatches=$((mismatches + 1))
            fi
          done < <(psqlq "$SRC_DB" "$count_sql")

          if [[ "$tables_compared" -lt 10 ]]; then
            fail "(c) only $tables_compared tables compared — too few to be a schema-wide comparison"
            restore_ok=0
          elif [[ "$mismatches" -ne 0 ]]; then
            fail "(c) row counts differ on $mismatches table(s) across $tables_compared compared"
            restore_ok=0
          else
            pass "(c) row counts IDENTICAL across all $tables_compared tables"
          fi

          # 5b. SCHEMA HASH, computed here over information_schema, so the
          #     comparison does not depend on either script's own notion of it.
          schema_sql="select md5(string_agg(sig, E'\n' order by sig)) from (
              select table_name || '.' || column_name || ':' || data_type || ':' ||
                     is_nullable || ':' || coalesce(character_maximum_length::text,'-') as sig
              from information_schema.columns
              where table_schema = 'public'
            ) s"
          ha="$(psqlq "$SRC_DB" "$schema_sql")"
          hb="$(psqlq "$DST_DB" "$schema_sql")"
          if [[ -z "$ha" || -z "$hb" ]]; then
            fail "(c) schema hash unreadable (src=${ha:-<none>} dst=${hb:-<none>}) — unread is not equal"
            restore_ok=0
          elif [[ "$ha" != "$hb" ]]; then
            fail "(c) schema hash MISMATCH: src=$ha restored=$hb"
            restore_ok=0
          else
            pass "(c) schema hash IDENTICAL: $ha"
          fi

          # 5c. Prove the comparison DISCRIMINATES. Two databases that always
          #     hash equal would pass 5b whatever happened. One extra column in
          #     the target must change the hash.
          psqlq "$DST_DB" "create table dm677_probe_$RUN_ID (id int)" >/dev/null 2>&1
          hb2="$(psqlq "$DST_DB" "$schema_sql")"
          psqlq "$DST_DB" "drop table dm677_probe_$RUN_ID" >/dev/null 2>&1
          if [[ -n "$hb2" && "$hb2" != "$hb" ]]; then
            pass "(c) CONTROL: schema hash changes under a deliberate schema mutation (discriminates)"
          else
            fail "(c) CONTROL: schema hash did NOT change under a deliberate mutation — the comparison proves nothing"
            restore_ok=0
          fi

          if [[ "$restore_ok" -eq 1 ]]; then
            note "RESTORE PROOF COMPLETE at repo head — receipt: $SCRATCH/restore-receipt.json"
          fi
        fi
      fi
    fi
  fi
fi

# ===========================================================================
printf '\n--- (d) overlap guard: backup REFUSES while a deploy holds the lock ---\n'
# ===========================================================================
GUARD_SET="$SCRATCH/backup-set-during-deploy"
if [[ ! -f "$BACKUP_SET/openbrain.dump" && "$restore_ok" -ne 1 ]]; then
  note "clause (c) did not establish a usable database; (d) runs against the source anyway"
fi

# Hold the deploy lock from a SEPARATE live connection, exactly as a running
# deploy would. The lock is a session-scoped Postgres advisory lock, so holding
# it requires an open session that STAYS open: a psql child that takes the lock
# and then sleeps inside the same session. `pg_sleep` keeps the session alive
# server-side without this script having to keep a pipe open (an earlier fifo
# version of this deadlocked on open-for-write with no reader attached — a
# check that hangs is a check that reports nothing).
LOCK_SQL="select pg_advisory_lock(hashtext(current_database() || ':openbrain-deploy')); select pg_sleep(120);"
psql -X -At -h "$PGH" -p "$PGP" -U "$PGU" -d "$SRC_DB" -c "$LOCK_SQL" \
  > "$SCRATCH/lockhold.log" 2>&1 &
LOCK_PID=$!

if true; then
  # Wait for the lock to actually be visible in pg_locks before proceeding —
  # a race here would let the backup run unlocked and bank a false RED. The
  # lock is identified by its own key, not by "any advisory lock": another
  # session's unrelated advisory lock would otherwise satisfy the precondition.
  # Scoped to THIS RUN'S database (pg_locks is cluster-wide — see the release
  # note below). An advisory lock held against an unrelated database would
  # otherwise satisfy this precondition, and clause (d1) would then be testing
  # a backup that faced no lock at all: a false RED banked as a real one.
  lock_visible=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    held="$(psqlq "$SRC_DB" "select count(*) from pg_locks l
                             join pg_stat_activity a on a.pid = l.pid
                             where l.locktype='advisory' and l.granted
                               and a.datname = '$SRC_DB'" 2>/dev/null)"
    if [[ "${held:-0}" -ge 1 ]]; then lock_visible=1; break; fi
  done

  if [[ "$lock_visible" -ne 1 ]]; then
    fail "(d) PRECONDITION: could not observe the deploy advisory lock as held — (d) would be a false RED"
  else
    note "deploy advisory lock is HELD by pid $LOCK_PID (observed in pg_locks)"
    set +e
    DB_HOST="$PGH" DB_PORT="$PGP" DB_USER="$PGU" DB_NAME="$SRC_DB" \
      bun run "$REPO_ROOT/scripts/backup.ts" --out "$GUARD_SET" \
      > "$SCRATCH/backup-during-deploy.out" 2>"$SCRATCH/backup-during-deploy.err"
    guard_rc=$?
    set -e
    guard_out="$(cat "$SCRATCH/backup-during-deploy.out" "$SCRATCH/backup-during-deploy.err" 2>/dev/null)"

    if [[ "$guard_rc" -eq 0 ]]; then
      fail "(d1) backup SUCCEEDED (exit 0) while a deploy held the lock — mid-migration dumps are exactly what this guard exists to prevent"
    elif [[ -f "$GUARD_SET/openbrain.dump" ]]; then
      fail "(d1) backup exited $guard_rc but LEFT A DUMP behind — a refusal that writes a half-backup is not a refusal"
    else
      pass "(d1) backup refused (exit $guard_rc) and wrote no dump while the deploy lock was held"
    fi

    # (d2) The message must name the CAUSE. Assert what it SAYS (round 19),
    # not merely that some text exists.
    #
    # SELF-CAUGHT FALSE GREEN (round 9/17/25 family, new spelling): the first
    # version of this clause was a bare `rg -qi 'deploy'` over the command's
    # combined output, and it PASSED on the pre-fix tree where no guard existed
    # and no refusal happened — because the successful backup's own receipt
    # embeds "backup_dir":".../backup-set-during-deploy", and the word "deploy"
    # is in the PATH THIS CHECK CHOSE. The clause was reading its own fixture.
    # Two repairs, both required:
    #   1. the clause is GATED on the refusal having actually occurred — there
    #      is no message to judge when the command succeeded;
    #   2. it reads STDERR only (the refusal channel) and requires the deploy
    #      word to appear in a sentence, not in a path token.
    if [[ "$guard_rc" -eq 0 ]]; then
      fail "(d2) NOT ASSERTABLE: the backup did not refuse, so there is no refusal message to judge (not a pass)"
    else
      guard_err="$(cat "$SCRATCH/backup-during-deploy.err" 2>/dev/null)"
      if printf '%s' "$guard_err" | rg -qi 'deploy (is |in |lock|running|in progress)|during a deploy|deploy holds'; then
        pass "(d2) the refusal names the deploy as the cause"
      else
        fail "(d2) the refusal does not name a deploy in prose — a refusal that does not say what to reconcile is a dead end"
        note "observed stderr: $(printf '%s' "$guard_err" | tail -2)"
      fi
    fi
  fi

  # Release: end the lock-holding session. Killing the psql child closes its
  # connection, which is what releases a session-scoped advisory lock.
  #
  # KILLING psql DOES NOT RELEASE THE LOCK. Measured here, twice: the client
  # process dies immediately and `pg_locks` still reports the advisory lock
  # held, because the BACKEND is inside `pg_sleep()` and does not notice the
  # client is gone until that query returns. The lock belongs to the backend
  # session, not to the psql process.
  #
  # This cost a full false failure of clause (e) — an unlocked backup refused
  # with exit 4 and the check reported "a guard that blocks normal backups",
  # which reads exactly like a real implementation defect. It was the check's
  # own leftover lock. Release SERVER-SIDE with pg_terminate_backend, scoped by
  # application_name to the lock-holder this run started, then WAIT for the
  # lock to be observably gone and fail loudly rather than let (e) inherit it.
  kill "$LOCK_PID" 2>/dev/null || true
  psqlq "$SRC_DB" "select pg_terminate_backend(pid) from pg_stat_activity
                   where datname = '$SRC_DB' and pid <> pg_backend_pid()
                     and query like '%openbrain-deploy%'" >/dev/null 2>&1 || true
  wait "$LOCK_PID" 2>/dev/null || true
  # pg_locks is CLUSTER-WIDE. Scope the reading to THIS RUN'S database by
  # joining pg_stat_activity on datname — an unrelated advisory lock held
  # against some other database on the same server otherwise reads as "still
  # held" forever and fails this clause for a reason that has nothing to do
  # with the subject. (Self-caught: a leftover debug database on this machine
  # did exactly that, and the failure was indistinguishable at a glance from a
  # real unreleased lock.)
  lock_gone=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    still="$(psqlq "$SRC_DB" "select count(*) from pg_locks l
                              join pg_stat_activity a on a.pid = l.pid
                              where l.locktype='advisory' and l.granted
                                and a.datname = '$SRC_DB'" 2>/dev/null)"
    if [[ "${still:-1}" == "0" ]]; then lock_gone=1; break; fi
    sleep 0.5
  done
  if [[ "$lock_gone" -eq 1 ]]; then
    note "deploy lock released (observed gone from pg_locks)"
  else
    fail "(d) the deploy lock was still held after the holder was killed — clause (e) below would inherit a false failure"
  fi
fi

# ===========================================================================
printf '\n--- (e) CONTROL: with NO lock held, the same backup SUCCEEDS ---\n'
# ===========================================================================
CONTROL_SET="$SCRATCH/backup-set-no-lock"
set +e
DB_HOST="$PGH" DB_PORT="$PGP" DB_USER="$PGU" DB_NAME="$SRC_DB" \
  bun run "$REPO_ROOT/scripts/backup.ts" --out "$CONTROL_SET" \
  > "$SCRATCH/backup-control.out" 2>"$SCRATCH/backup-control.err"
control_rc=$?
set -e
if [[ "$control_rc" -eq 0 && -f "$CONTROL_SET/openbrain.dump" ]]; then
  pass "(e) CONTROL: unlocked backup succeeded — the guard does not refuse everything"
else
  fail "(e) CONTROL: unlocked backup FAILED (exit $control_rc) — a guard that blocks normal backups is the blocker restated"
  note "$(tail -3 "$SCRATCH/backup-control.err" 2>/dev/null)"
fi

# ===========================================================================
printf '\n--- (f) CONTROL: the DEPLOY side takes the lock, before it mutates ---\n'
# ===========================================================================
if [[ ! -r "$DEPLOY_SCRIPT" ]]; then
  fail "(f) deploy script not readable: $DEPLOY_SCRIPT"
else
  # Sentinel reads: `rg` exits non-zero on no-match, and an EMPTY variable in a
  # numeric test aborts the whole script under `set -u` — which is how the
  # first run of this clause printed NOTHING AT ALL rather than a verdict
  # (round 21/24 lesson, hit here in its own spelling). `|| true` keeps the
  # pipeline alive and every value is defaulted before any arithmetic.
  # ANCHOR ON THE COMMANDS, NOT ON PROSE. The first version of this clause
  # matched `openbrain-deploy` and `run migrate` anywhere in the file, and both
  # patterns hit the deploy script's own explanatory COMMENTS — which sit
  # ABOVE the real commands, so the clause reported the lock as taken after
  # migrate when it is taken before. Round 23's rule: anchor an assertion on a
  # marker the subject OWNS, never on prose that also contains the words. Here
  # the owned markers are the actual invocations, with comment lines excluded.
  ncl() { rg -n -v '^\s*#' "$DEPLOY_SCRIPT" 2>/dev/null; }
  lock_line="$(rg -n 'deploy-lock\.ts' "$DEPLOY_SCRIPT" 2>/dev/null | rg -v '^\s*[0-9]+:\s*#' | head -1 | cut -d: -f1 || true)"
  migrate_line="$(rg -n '^\s*"\$BUN_BIN" run migrate' "$DEPLOY_SCRIPT" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  stage_line="$(rg -n '^\s*"\$REPO_DIR/scripts/core01-package-runtime\.sh"' "$DEPLOY_SCRIPT" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  lock_line="${lock_line:-0}"
  migrate_line="${migrate_line:-0}"
  stage_line="${stage_line:-0}"
  if [[ "$lock_line" == "0" ]]; then
    fail "(f) the deploy script never references the deploy lock — a one-sided guard is not mutual exclusion"
  elif [[ "$migrate_line" == "0" || "$stage_line" == "0" ]]; then
    fail "(f) could not locate the deploy's migrate/staging steps to order against (migrate=$migrate_line stage=$stage_line)"
  elif [[ "$lock_line" -ge "$migrate_line" || "$lock_line" -ge "$stage_line" ]]; then
    fail "(f) the lock is taken at line $lock_line, AT OR AFTER staging ($stage_line) / migrate ($migrate_line) — a lock taken after the mutation protects nothing"
  else
    pass "(f) deploy acquires the lock at line $lock_line, before staging ($stage_line) and migrate ($migrate_line)"
  fi
fi

# ===========================================================================
printf '\n--- (g) the core01 install step is WRITTEN into the runbook, not executed ---\n'
# ===========================================================================
if [[ ! -r "$BACKUP_DOC" ]]; then
  fail "(g) docs/backup-restore.md not readable"
else
  if rg -q 'NOT shipped in this repo' "$BACKUP_DOC"; then
    fail "(g) docs/backup-restore.md still claims the scheduling wiring is NOT shipped — a doc that ships wiring and denies it misleads the next reader"
  else
    pass "(g) the stale 'NOT shipped in this repo' scheduling claim is gone"
  fi
  if rg -q 'install-backup-launchagent\.sh' "$BACKUP_DOC" \
     && rg -q 'com\.rico\.open-brain-backup' "$BACKUP_DOC"; then
    pass "(g) the runbook names the installer and the launchd label for the core01 step"
  else
    fail "(g) the runbook does not name both scripts/install-backup-launchagent.sh and the com.rico.open-brain-backup label"
  fi
fi

# ===========================================================================
printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'DONE-MEANS #677: FAIL\n'
  exit 1
fi
printf 'DONE-MEANS #677: PASS\n'
exit 0
