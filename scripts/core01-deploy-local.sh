#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_DIR="${RUNTIME_DIR:-/Volumes/ThunderBolt/open-brain/app}"
ENV_FILE="${ENV_FILE:-/Users/rico/.config/open-brain/env}"
SERVICE_LABEL="${SERVICE_LABEL:-system/com.rico.open-brain}"
QMD_PATH_VALUE="${QMD_PATH_VALUE:-/Volumes/ThunderBolt/qmd/open-brain-qmd.ts}"
BUN_BIN="${BUN_BIN:-}"
STAGING_DIR="${STAGING_DIR:-${RUNTIME_DIR}.next}"
PREVIOUS_DIR="${PREVIOUS_DIR:-${RUNTIME_DIR}.previous}"

if [[ -z "$BUN_BIN" ]]; then
  if [[ -x "/Users/rico/Library/Application Support/reflex/bun/bin/bun" ]]; then
    BUN_BIN="/Users/rico/Library/Application Support/reflex/bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    echo "FATAL: bun not found" >&2
    exit 1
  fi
fi

if [[ ! -d "/Volumes/ThunderBolt" ]]; then
  echo "FATAL: /Volumes/ThunderBolt is not mounted" >&2
  exit 1
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "FATAL: env file missing: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

tar \
  --exclude "./.git" \
  --exclude "./.github" \
  --exclude "./.planning" \
  --exclude "./.pi" \
  --exclude "./.omc" \
  --exclude "./.DS_Store" \
  --exclude "./node_modules" \
  --exclude "./dist" \
  --exclude "./python/openbrain-memory/.venv" \
  --exclude "./python/openbrain-memory/dist" \
  --exclude "./.env" \
  --exclude "./.env.*" \
  -C "$REPO_DIR" -cf - . | tar -C "$STAGING_DIR" -xf -

"$BUN_BIN" install --cwd "$STAGING_DIR" --frozen-lockfile

if [[ -x "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh" ]]; then
  "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh"
fi

if grep -q "^QMD_PATH=" "$ENV_FILE"; then
  perl -pi -e "s#^QMD_PATH=.*#QMD_PATH=$QMD_PATH_VALUE#" "$ENV_FILE"
else
  printf '\nQMD_PATH=%s\n' "$QMD_PATH_VALUE" >> "$ENV_FILE"
fi

cd "$STAGING_DIR"
"$BUN_BIN" run migrate

rm -rf "$PREVIOUS_DIR"
if [[ -d "$RUNTIME_DIR" ]]; then
  mv "$RUNTIME_DIR" "$PREVIOUS_DIR"
fi
mv "$STAGING_DIR" "$RUNTIME_DIR"

sudo launchctl kickstart -k "$SERVICE_LABEL"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 http://127.0.0.1:3100/health >/dev/null 2>&1; then
    echo "Open Brain health check passed"
    "$BUN_BIN" test src/tools/__tests__/search-all.test.ts
    rm -rf "$PREVIOUS_DIR"
    exit 0
  fi
  sleep 2
done

if [[ -d "$PREVIOUS_DIR" ]]; then
  rm -rf "$RUNTIME_DIR"
  mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
  sudo launchctl kickstart -k "$SERVICE_LABEL"
fi

echo "FATAL: Open Brain health check failed after restart" >&2
exit 1
