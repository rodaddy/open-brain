#!/usr/bin/env bash
set -euo pipefail

DAEMON="${MLX_EMBED_DAEMON:-$HOME/bin/mlxembed-daemon}"
LOG_DIR="${MLX_EMBED_RUNTIME_DIR:-$HOME/.mlx-embedding-server/runtime}"
LOG_FILE="$LOG_DIR/mlx-embedding-server.log"
ERR_FILE="$LOG_DIR/mlx-embedding-server.err.log"
LOCK_DIR="${MLX_EMBED_RESTART_LOCK:-$LOG_DIR/open-brain-mlx-embed-restart.lock}"
LOCK_STALE_AFTER_SECONDS="${MLX_EMBED_RESTART_LOCK_STALE_AFTER_SECONDS:-300}"
PORT="${MLX_EMBED_PORT:-8791}"
# The hosted MLX embedding daemon exposes an unauthenticated /health route.
# Override MLX_EMBED_HEALTH_URL for OpenAI-compatible daemons that only expose /v1/models.
HEALTH_URL="${MLX_EMBED_HEALTH_URL:-http://127.0.0.1:$PORT/health}"
HEALTH_RETRIES="${MLX_EMBED_HEALTH_RETRIES:-20}"
HEALTH_SLEEP_SECONDS="${MLX_EMBED_HEALTH_SLEEP_SECONDS:-1}"
RESTART_SETTLE_SECONDS="${MLX_EMBED_RESTART_SETTLE_SECONDS:-2}"
LOCK_SENTINEL="open-brain-mlx-embed-restart"
CURL_BIN="${MLX_EMBED_CURL:-}"

mkdir -p "$LOG_DIR"

if [[ -z "$CURL_BIN" ]]; then
  if command -v curl >/dev/null 2>&1; then
    CURL_BIN="$(command -v curl)"
  elif [[ -x /usr/bin/curl ]]; then
    CURL_BIN="/usr/bin/curl"
  fi
fi

if [[ -z "$CURL_BIN" || ! -x "$CURL_BIN" ]]; then
  echo "mlx embedding restart failed: curl not found or not executable: ${CURL_BIN:-unset}" >> "$ERR_FILE"
  exit 1
fi

remove_lock_dir() {
  local default_lock_dir="$LOG_DIR/open-brain-mlx-embed-restart.lock"
  if [[ -f "$LOCK_DIR/sentinel" ]] && [[ "$(cat "$LOCK_DIR/sentinel" 2>/dev/null || true)" == "$LOCK_SENTINEL" ]]; then
    rm -rf "$LOCK_DIR"
  elif [[ "$LOCK_DIR" == "$default_lock_dir" ]]; then
    echo "mlx embedding restart cleaning partial default lock without sentinel: $LOCK_DIR" >> "$LOG_FILE"
    rm -rf "$LOCK_DIR"
  else
    echo "mlx embedding restart refused lock cleanup without sentinel: $LOCK_DIR" >> "$ERR_FILE"
    return 1
  fi
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$LOCK_SENTINEL" > "$LOCK_DIR/sentinel"
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
  if ! remove_lock_dir; then
    return 1
  fi
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$LOCK_SENTINEL" > "$LOCK_DIR/sentinel"
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    date +%s > "$LOCK_DIR/started_at"
    return 0
  fi

  echo "mlx embedding restart skipped: lock still held after stale cleanup" >> "$LOG_FILE"
  return 1
}

if ! acquire_lock; then
  exit 1
fi
trap 'remove_lock_dir 2>/dev/null || true' EXIT

launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.mlx-embedding-server.plist" >/dev/null 2>&1 || true
pkill -f "qwen_embedding_server.main:app.*--port $PORT" >/dev/null 2>&1 || true
sleep "$RESTART_SETTLE_SECONDS"

if [[ ! -x "$DAEMON" ]]; then
  echo "mlx embedding restart failed: daemon not executable: $DAEMON" >> "$ERR_FILE"
  exit 1
fi

nohup "$DAEMON" >> "$LOG_FILE" 2>> "$ERR_FILE" &
daemon_pid=$!
echo "mlx embedding restart started pid=$daemon_pid" >> "$LOG_FILE"

for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt += 1)); do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    echo "mlx embedding restart failed: daemon exited before health passed pid=$daemon_pid" >> "$ERR_FILE"
    exit 1
  fi

  if [[ -n "$CURL_BIN" ]] && "$CURL_BIN" -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "mlx embedding restart healthy pid=$daemon_pid url=$HEALTH_URL attempt=$attempt" >> "$LOG_FILE"
    exit 0
  fi

  sleep "$HEALTH_SLEEP_SECONDS"
done

echo "mlx embedding restart failed: health check did not pass url=$HEALTH_URL pid=$daemon_pid" >> "$ERR_FILE"
exit 1
