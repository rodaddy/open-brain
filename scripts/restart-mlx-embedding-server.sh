#!/usr/bin/env bash
set -euo pipefail

DAEMON="${MLX_EMBED_DAEMON:-$HOME/bin/mlxembed-daemon}"
LOG_DIR="${MLX_EMBED_RUNTIME_DIR:-$HOME/.mlx-embedding-server/runtime}"
LOG_FILE="$LOG_DIR/mlx-embedding-server.log"
ERR_FILE="$LOG_DIR/mlx-embedding-server.err.log"
LOCK_DIR="${MLX_EMBED_RESTART_LOCK:-$LOG_DIR/open-brain-mlx-embed-restart.lock}"
LOCK_STALE_AFTER_SECONDS="${MLX_EMBED_RESTART_LOCK_STALE_AFTER_SECONDS:-300}"

mkdir -p "$LOG_DIR"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    date +%s > "$LOCK_DIR/started_at"
    return 0
  fi

  local lock_pid lock_started now lock_age
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  lock_started="$(cat "$LOCK_DIR/started_at" 2>/dev/null || true)"
  now="$(date +%s)"

  if [[ "$lock_started" =~ ^[0-9]+$ ]]; then
    lock_age=$((now - lock_started))
  else
    lock_age=$((LOCK_STALE_AFTER_SECONDS + 1))
  fi

  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null && (( lock_age < LOCK_STALE_AFTER_SECONDS )); then
    echo "mlx embedding restart skipped: restart already running pid=$lock_pid age=${lock_age}s" >> "$LOG_FILE"
    return 1
  fi

  echo "mlx embedding restart removing stale lock pid=${lock_pid:-unknown} age=${lock_age}s" >> "$LOG_FILE"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    date +%s > "$LOCK_DIR/started_at"
    return 0
  fi

  echo "mlx embedding restart skipped: lock still held after stale cleanup" >> "$LOG_FILE"
  return 1
}

if ! acquire_lock; then
  exit 0
fi
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.mlx-embedding-server.plist" >/dev/null 2>&1 || true
pkill -f "qwen_embedding_server.main:app.*--port 8791" >/dev/null 2>&1 || true
sleep 2

if [[ ! -x "$DAEMON" ]]; then
  echo "mlx embedding restart failed: daemon not executable: $DAEMON" >> "$ERR_FILE"
  exit 1
fi

nohup "$DAEMON" >> "$LOG_FILE" 2>> "$ERR_FILE" &
echo "mlx embedding restart started pid=$!" >> "$LOG_FILE"
