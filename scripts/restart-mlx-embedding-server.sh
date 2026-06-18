#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR="${MLX_EMBED_RESTART_LOCK:-/tmp/open-brain-mlx-embed-restart.lock}"
DAEMON="${MLX_EMBED_DAEMON:-$HOME/bin/mlxembed-daemon}"
LOG_DIR="${MLX_EMBED_RUNTIME_DIR:-$HOME/.mlx-embedding-server/runtime}"
LOG_FILE="$LOG_DIR/mlx-embedding-server.log"
ERR_FILE="$LOG_DIR/mlx-embedding-server.err.log"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

mkdir -p "$LOG_DIR"

launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.mlx-embedding-server.plist" >/dev/null 2>&1 || true
pkill -f "qwen_embedding_server.main:app.*--port 8791" >/dev/null 2>&1 || true
sleep 2

if [[ ! -x "$DAEMON" ]]; then
  echo "mlx embedding restart failed: daemon not executable: $DAEMON" >> "$ERR_FILE"
  exit 1
fi

nohup "$DAEMON" >> "$LOG_FILE" 2>> "$ERR_FILE" &
echo "mlx embedding restart started pid=$!" >> "$LOG_FILE"
