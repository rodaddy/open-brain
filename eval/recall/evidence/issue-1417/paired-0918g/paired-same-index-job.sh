#!/usr/bin/env bash
set -uo pipefail

base=/work/base
current=/work/current
out=/work/out
harness=/mnt/collab/tmp_space/open-brain/release-1425-run-20260914/lexical-and-ab
driver=/work/harness-v2/ab-trace-driver-v2.mjs
reader=/work/harness-v2/trace-evidence-reader.mjs
comparator=/work/harness-v2/compare-base-current.mjs
cache="$harness/input/combined-query-embeddings.json"
backup_dir=/mnt/collab/tmp_space/open-brain/release-1425-run-20260912/delivery-preflight/recovery-proof/input-20260913T011916Z
base_pin=6ecd002aa6ee86a55c44f103d5e4805a1481f7df
current_pin=4eb1810316c68b711df9b6cbeec68c50db73f2ee
fixture_pin=b614dd7d72e54bc7faf1ec97f2a72f5edfe67238825c934704c9930048439a7a
cache_pin=3dead372e3c079f968979908c9bb5434fa68298b1cf75814de30f706a1ae1699
backup_pin=0eed3412ef3b065616908675ea2b25d9363f6091a874679a5e3f13ddf72003c2
driver_pin=cb579ef0afae3a9c5df4cd7659c4a3b36519bf8842bfeb957d43ae4f066ed39a
reader_pin=d01e0faeb1739d53cae95335ca6f0b7ec7f261de7c92b3a306304b63c4bb2ae8
comparator_pin=31e05b39721e2e62b162d051891c5c307dcc4df6046ccad83e12bdfbadda97e7
node_root=/mnt/collab/tmp_space/open-brain/release-1425-run-20260912/recall-red/retry/runtime-scratch/node24
node_bin="$node_root/node-v24.16.0-linux-x64/bin/node"
db_name="ob_1417_paired_$$"
db_role="ob_1417_paired_role_$$"
db_password=
db_created=0
role_created=0
drop_status=not_attempted
role_status=not_attempted

mkdir -p "$out"
cp "$0" "$out/paired-same-index-job.sh"
cp "$driver" "$reader" "$comparator" "$out/"
sha256sum "$out/paired-same-index-job.sh" "$driver" "$reader" "$comparator" > "$out/pre-execution-artifacts.sha256"
exec > >(tee "$out/paired-job.log") 2>&1

unset DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGOPTIONS
admin_env=(env -u DB_HOST -u DB_PORT -u DB_USER -u DB_PASSWORD -u DB_NAME -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE -u PGSERVICE -u PGOPTIONS)
admin_psql() { sudo -n -u postgres -- "${admin_env[@]}" psql -X -v ON_ERROR_STOP=1 "$@"; }
admin_createdb() { sudo -n -u postgres -- "${admin_env[@]}" createdb "$@"; }
admin_dropdb() { sudo -n -u postgres -- "${admin_env[@]}" dropdb "$@"; }
fail() { printf 'HARNESS_ERROR=%s\n' "$*"; return 74; }
hash_file() { sha256sum "$1" | awk '{print $1}'; }

cleanup() {
  local rc=0
  if [ "$db_created" -eq 1 ]; then
    if admin_dropdb --if-exists --force "$db_name" >"$out/paired-dropdb.log" 2>&1; then drop_status=dropped_verified; else drop_status=drop_failed; rc=1; fi
    db_created=0
  fi
  if [ "$role_created" -eq 1 ]; then
    if admin_psql -d postgres -c "DROP ROLE IF EXISTS \"$db_role\"" >"$out/paired-droprole.log" 2>&1; then role_status=dropped_verified; else role_status=drop_failed; rc=1; fi
    role_created=0
  fi
  if [ "$drop_status" = dropped_verified ]; then
    [ -z "$(admin_psql -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$db_name'")" ] || { drop_status=still_present; rc=1; }
  fi
  if [ "$role_status" = dropped_verified ]; then
    [ -z "$(admin_psql -At -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='$db_role'")" ] || { role_status=still_present; rc=1; }
  fi
  printf '{"database":"%s","role":"%s"}\n' "$drop_status" "$role_status" > "$out/paired-teardown.json"
  return "$rc"
}

write_identity() {
  local root=$1 output=$2 head tree tracked_count tracked_sha
  head=$(git -C "$root" rev-parse HEAD) || return 74
  tree=$(git -C "$root" rev-parse 'HEAD^{tree}') || return 74
  tracked_count=$(git -C "$root" ls-files | wc -l)
  tracked_sha=$(git -C "$root" ls-files -s | sha256sum | awk '{print $1}')
  printf '{"head":"%s","tree_oid":"%s","tracked_path_count":%s,"tracked_index_sha256":"%s","worktree_clean":true}\n' "$head" "$tree" "$tracked_count" "$tracked_sha" > "$output"
}

main() {
  local observed base_head current_head base_tree current_tree server_version base_exit current_exit compare_exit
  for cmd in git sha256sum sudo psql createdb dropdb; do command -v "$cmd" >/dev/null || fail "missing command $cmd" || return; done
  [ -x "$node_bin" ] || fail 'Node 24 runtime missing' || return
  export PATH="$node_root/node-v24.16.0-linux-x64/bin:$PATH"
  export npm_config_cache="$harness/npm-cache"
  [ "$(node -p 'process.versions.node.split(`.`)[0]')" = 24 ] || fail 'Node major mismatch' || return

  base_head=$(git -C "$base" rev-parse HEAD) || return 74
  current_head=$(git -C "$current" rev-parse HEAD) || return 74
  [ "$base_head" = "$base_pin" ] || fail 'base HEAD pin mismatch' || return
  [ "$current_head" = "$current_pin" ] || fail 'current HEAD pin mismatch' || return
  [ -z "$(git -C "$base" status --porcelain=v1)" ] || fail 'base source not clean' || return
  [ -z "$(git -C "$current" status --porcelain=v1)" ] || fail 'current source not clean' || return
  write_identity "$base" "$out/base-tracked-tree-identity.json" || return
  write_identity "$current" "$out/current-tracked-tree-identity.json" || return
  base_tree=$(git -C "$base" rev-parse 'HEAD^{tree}') || return 74
  current_tree=$(git -C "$current" rev-parse 'HEAD^{tree}') || return 74

  observed=$(hash_file "$driver"); [ "$observed" = "$driver_pin" ] || fail 'driver pin mismatch' || return
  observed=$(hash_file "$reader"); [ "$observed" = "$reader_pin" ] || fail 'reader pin mismatch' || return
  observed=$(hash_file "$comparator"); [ "$observed" = "$comparator_pin" ] || fail 'comparator pin mismatch' || return
  observed=$(hash_file "$cache"); [ "$observed" = "$cache_pin" ] || fail 'cache pin mismatch' || return
  observed=$(hash_file "$backup_dir/openbrain.dump"); [ "$observed" = "$backup_pin" ] || fail 'backup pin mismatch' || return
  observed=$(hash_file "$base/eval/recall/fixtures.json"); [ "$observed" = "$fixture_pin" ] || fail 'base fixture pin mismatch' || return
  observed=$(hash_file "$current/eval/recall/fixtures.json"); [ "$observed" = "$fixture_pin" ] || fail 'current fixture pin mismatch' || return

  [ "$(sudo -n -u postgres -- "${admin_env[@]}" id -un)" = postgres ] || fail 'postgres identity mismatch' || return
  [ "$(admin_psql -At -F '|' -d postgres -c 'SELECT current_user,current_database()')" = 'postgres|postgres' ] || fail 'postgres peer identity mismatch' || return
  server_version=$(admin_psql -At -d postgres -c 'SHOW server_version') || return 74
  case "$server_version" in 18.*) ;; *) fail 'PostgreSQL major mismatch' || return;; esac
  [ -f /usr/share/postgresql/18/extension/vector.control ] || fail 'pgvector control missing' || return
  [ -f /usr/share/postgresql/18/extension/pg_stat_statements.control ] || fail 'pg_stat_statements control missing' || return

  (cd "$base" && npm ci --ignore-scripts) >"$out/base-npm-ci.log" 2>&1 || fail 'base npm ci failed' || return
  (cd "$current" && npm ci --ignore-scripts) >"$out/current-npm-ci.log" 2>&1 || fail 'current npm ci failed' || return
  [ -z "$(git -C "$base" status --porcelain=v1)" ] || fail 'base npm ci changed source' || return
  [ -z "$(git -C "$current" status --porcelain=v1)" ] || fail 'current npm ci changed source' || return

  db_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
  [ -z "$(admin_psql -At -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='$db_role'")" ] || fail 'role pre-exists' || return
  [ -z "$(admin_psql -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$db_name'")" ] || fail 'database pre-exists' || return
  printf 'CREATE ROLE %s LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '\''%s'\'';\n' "$db_role" "$db_password" | admin_psql -d postgres >"$out/paired-role-create.log" 2>&1 || fail 'role creation failed' || return
  role_created=1
  admin_createdb -E UTF8 -T template0 --owner="$db_role" "$db_name" >"$out/paired-createdb.log" 2>&1 || fail 'database creation failed' || return
  db_created=1
  admin_psql -d "$db_name" -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >"$out/paired-extensions.log" 2>&1 || fail 'extension setup failed' || return

  export DB_NAME="$db_name" DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER="$db_role" DB_PASSWORD="$db_password"
  export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGPASSWORD="$DB_PASSWORD" PGDATABASE="$DB_NAME"
  export EMBEDDING_BASE_URL=https://llm.example.internal/v1 EMBEDDING_MODEL=embed-gemma-dense EMBEDDING_DIMENSIONS=768
  export EMBEDDING_WATCHDOG_RESTART_SCRIPT= OPEN_BRAIN_MAINTENANCE_ENABLED=0 OPENBRAIN_TRACING_ENABLED=0 OPENBRAIN_MCP_AUDIT_ENABLED=0
  PGOPTIONS= node "$current/scripts/restore.ts" --dir "$backup_dir" --target-db "$db_name" >"$out/paired-restore.log" 2>&1 || fail 'restore failed' || return
  [ "$(PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -v ON_ERROR_STOP=1 -c "SELECT current_setting('default_transaction_read_only')")" = on ] || fail 'read-only probe failed' || return

  set +e
  (cd "$base" && PGOPTIONS='-c default_transaction_read_only=on' AB_VARIANT=base AB_SOURCE_PIN="$base_pin" AB_SOURCE_ARCHIVE_SHA="$base_tree" AB_PATCH_SHA= AB_CACHE_SHA="$cache_pin" "$node_bin" "$driver" "$base" "$cache" "$out/base.json") >"$out/base-ab.raw.log" 2>&1
  base_exit=$?
  set +e
  printf '%s\n' "$base_exit" > "$out/base-trace-exit.txt"
  [ "$base_exit" -eq 0 ] || fail "base trace failed exit=$base_exit" || return

  set +e
  (cd "$current" && PGOPTIONS='-c default_transaction_read_only=on' AB_VARIANT=current AB_SOURCE_PIN="$current_pin" AB_SOURCE_ARCHIVE_SHA="$current_tree" AB_PATCH_SHA= AB_CACHE_SHA="$cache_pin" "$node_bin" "$driver" "$current" "$cache" "$out/current.json") >"$out/current-ab.raw.log" 2>&1
  current_exit=$?
  set +e
  printf '%s\n' "$current_exit" > "$out/current-trace-exit.txt"
  [ "$current_exit" -eq 0 ] || fail "current trace failed exit=$current_exit" || return

  "$node_bin" --input-type=module - "$comparator" "$out/base.json" "$out/current.json" "$out/paired-pins.json" "$out/paired-comparison.json" "$base_pin" "$base_tree" "$current_pin" "$current_tree" "$fixture_pin" "$cache_pin" "$backup_pin" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [modulePath,basePath,currentPath,pinsPath,outputPath,baseHead,baseTree,currentHead,currentTree,fixture,cache,backup]=process.argv.slice(2);
const hash=(path)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const pins={fixture,cache,backup,base:{source:baseHead,archive:baseTree,file:hash(basePath),backup_sha256:backup},current:{source:currentHead,archive:currentTree,file:hash(currentPath),backup_sha256:backup}};
writeFileSync(pinsPath,JSON.stringify(pins,null,2)+'\n');
const {compare}=await import(`file://${modulePath}`);
const result=compare(JSON.parse(readFileSync(basePath,'utf8')),JSON.parse(readFileSync(currentPath,'utf8')),pins);
writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
console.log(`PAIRED_${result.status} cases=${result.cases.length}`);
process.exit(result.status==='PASS'?0:1);
NODE
  compare_exit=$?
  printf '%s\n' "$compare_exit" > "$out/paired-comparison-exit.txt"
  [ "$compare_exit" -eq 0 ] || fail 'paired comparison RED' || return
}

set +e
main
main_exit=$?
cleanup
cleanup_exit=$?
set -e
printf '{"schema":"openbrain.recall_paired_execution.v1","execution_status":"%s","comparison_status":"%s","main_exit":%s,"cleanup_exit":%s}\n' "$([ "$main_exit" -eq 0 ] && [ "$cleanup_exit" -eq 0 ] && printf PASS || printf FAIL)" "$([ -f "$out/paired-comparison.json" ] && "$node_bin" -e 'const x=require(process.argv[1]);process.stdout.write(x.status)' "$out/paired-comparison.json" || printf NOT_RUN)" "$main_exit" "$cleanup_exit" > "$out/paired-summary.json"
sha256sum "$out/paired-same-index-job.sh" "$out/ab-trace-driver-v2.mjs" "$out/trace-evidence-reader.mjs" "$out/compare-base-current.mjs" "$out/base-tracked-tree-identity.json" "$out/current-tracked-tree-identity.json" "$out/paired-teardown.json" "$out/paired-summary.json" > "$out/final-artifacts.sha256"
[ "$main_exit" -eq 0 ] && [ "$cleanup_exit" -eq 0 ]
