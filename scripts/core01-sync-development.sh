#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-/Volumes/ThunderBolt/Development}"
TARGET_DIR="${TARGET_DIR:-/Volumes/ThunderBolt/Development}"
QMD_BIN="${QMD_BIN:-/Volumes/ThunderBolt/qmd/bin/qmd}"

if [[ "$SOURCE_DIR" == "$TARGET_DIR" ]]; then
  echo "FATAL: SOURCE_DIR and TARGET_DIR are identical; run this on the sync source or set TARGET_DIR explicitly" >&2
  exit 1
fi

rsync -a --delete \
  --exclude ".DS_Store" \
  --exclude "node_modules/" \
  --exclude ".venv/" \
  --exclude "venv/" \
  --exclude "__pycache__/" \
  --exclude ".pytest_cache/" \
  --exclude ".mypy_cache/" \
  --exclude "dist/" \
  --exclude ".next/" \
  --exclude "target/" \
  --exclude "logs/" \
  --exclude "_quarantine/" \
  --exclude "_tmp/" \
  --exclude ".reports/" \
  "$SOURCE_DIR"/ "$TARGET_DIR"/

if [[ -x "$QMD_BIN" ]]; then
  "$QMD_BIN" update
  "$QMD_BIN" embed
fi
