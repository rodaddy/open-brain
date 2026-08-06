#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$1"
STAGING_DIR="$2"

SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
SHORT_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
SUBJECT="$(git -C "$REPO_DIR" log -1 --format=%s HEAD)"

tar \
  --exclude "./.git" \
  --exclude "./.github" \
  --exclude "./.forgejo" \
  --exclude "./.planning" \
  --exclude "./.pi" \
  --exclude "./.omc" \
  --exclude "./.DS_Store" \
  --exclude "./.deployed-revision" \
  --exclude "./node_modules" \
  --exclude "./dist" \
  --exclude "./python/.venv" \
  --exclude "./python/dist" \
  --exclude "./python/openbrain-memory/.venv" \
  --exclude "./python/openbrain-memory/dist" \
  --exclude "./.env" \
  --exclude "./.env.*" \
  -C "$REPO_DIR" -cf - . | tar -C "$STAGING_DIR" -xf -

cat > "${STAGING_DIR}/.deployed-revision" <<EOF
sha=${SHA}
short_sha=${SHORT_SHA}
ref=HEAD
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${REPO_DIR}
subject=${SUBJECT}
EOF
