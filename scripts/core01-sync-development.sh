#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-/Volumes/ThunderBolt/Development}"
TARGET_DIR="${TARGET_DIR:-10.71.1.21:/Volumes/ThunderBolt/Development}"
TARGET_PATH="${TARGET_PATH:-/Volumes/ThunderBolt/Development}"
QMD_BIN="${QMD_BIN:-/Volumes/ThunderBolt/qmd/bin/qmd}"
QMD_MASK="${QMD_MASK:-**/*.{ts,tsx,js,jsx,md,json,yaml,yml,sql,sh,py,toml}}"
CLEAN_EXCLUDED="${CLEAN_EXCLUDED:-1}"

EXCLUDED_DIR_NAMES=(
  node_modules
  .venv
  venv
  __pycache__
  .pytest_cache
  .mypy_cache
  dist
  .next
  target
  _quarantine
  _tmp
  .reports
)

RSYNC_EXCLUDES=(
  --exclude ".DS_Store"
)

for name in "${EXCLUDED_DIR_NAMES[@]}"; do
  RSYNC_EXCLUDES+=(--exclude "$name/")
done

if [[ "$SOURCE_DIR" == "$TARGET_DIR" ]]; then
  echo "FATAL: SOURCE_DIR and TARGET_DIR are identical; set TARGET_DIR to the core01 mirror target" >&2
  exit 1
fi

rsync -rltz --delete --no-perms --no-owner --no-group --omit-dir-times --stats --human-readable \
  "${RSYNC_EXCLUDES[@]}" \
  "$SOURCE_DIR"/ "$TARGET_DIR"/

target_host=""
target_root="$TARGET_DIR"
if [[ "$TARGET_DIR" == *:* ]]; then
  target_host="${TARGET_DIR%%:*}"
  target_root="${TARGET_DIR#*:}"
fi

cleanup_excluded_dirs() {
  local root="$1"
  find "$root" -type d -name .git -prune -o -type d \( \
    -name node_modules -o \
    -name .venv -o \
    -name venv -o \
    -name __pycache__ -o \
    -name .pytest_cache -o \
    -name .mypy_cache -o \
    -name dist -o \
    -name .next -o \
    -name target -o \
    -name _quarantine -o \
    -name _tmp -o \
    -name .reports \
  \) -prune -print -exec sudo rm -rf {} +
}

if [[ "$CLEAN_EXCLUDED" == "1" ]]; then
  if [[ -n "$target_host" ]]; then
    ssh "$target_host" "$(declare -f cleanup_excluded_dirs); cleanup_excluded_dirs '$target_root'"
  else
    cleanup_excluded_dirs "$target_root"
  fi
fi

run_qmd_ingest() {
  if [[ ! -x "$QMD_BIN" ]]; then
    echo "WARN: qmd not found at $QMD_BIN; skipping qmd update/embed" >&2
    exit 0
  fi

  ensure_collection() {
    local name="$1"
    local path="$2"

    if [[ ! -d "$path" ]]; then
      echo "WARN: qmd collection path missing, skipping $name: $path" >&2
      return
    fi

    if "$QMD_BIN" collection list | grep -q "^$name ("; then
      return
    fi

    "$QMD_BIN" collection add "$path" --name "$name" --mask "$QMD_MASK"
  }

  ensure_collection "rtech-infra" "$TARGET_PATH/rtech-infra"
  ensure_collection "rtech-consulting" "$TARGET_PATH/rtech-consulting"
  ensure_collection "rtech-hermes" "$TARGET_PATH/ai-agents/platforms/rtech-hermes"

  while IFS= read -r repo_path; do
    repo_rel="${repo_path#"$TARGET_PATH"/}"
    collection_name="${repo_rel//\//-}"
    ensure_collection "$collection_name" "$repo_path"
  done < <(find "$TARGET_PATH/king-capital" -maxdepth 2 -type d -name .git -prune -print | while IFS= read -r git_dir; do dirname "$git_dir"; done | sort)

  "$QMD_BIN" update
  "$QMD_BIN" embed
}

if [[ -n "$target_host" ]]; then
  {
    declare -f run_qmd_ingest
    echo "run_qmd_ingest"
  } | ssh "$target_host" "QMD_BIN='$QMD_BIN' TARGET_PATH='$TARGET_PATH' QMD_MASK='$QMD_MASK' /opt/homebrew/bin/bash -s"
else
  run_qmd_ingest
fi
