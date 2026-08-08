#!/opt/homebrew/bin/bash
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SCRIPT="$REPO_ROOT/scripts/qmd-sync.sh"
TEMPLATE="$REPO_ROOT/docs/deploy/com.rico.qmd-sync.plist.template"
INSTALL_ROOT="${QMD_SYNC_INSTALL_ROOT:-$HOME/.local/share/open-brain/qmd-sync}"
INSTALLED_SCRIPT="$INSTALL_ROOT/qmd-sync.sh"
LOG_DIR="${QMD_SYNC_LOG_DIR:-$HOME/.local/state/open-brain/log}"
FALLBACK_LOG_DIR="${QMD_SYNC_FALLBACK_LOG_DIR:-$HOME/Library/Logs/open-brain-local}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS_DIR/com.rico.qmd-sync.plist"
STAGED_PLIST="$PLIST.next"
STAGED_SCRIPT="$INSTALLED_SCRIPT.next"
LABEL="com.rico.qmd-sync"
DOMAIN="gui/$(id -u)"

fatal() {
  printf 'FATAL: %s\n' "$1" >&2
  exit 1
}

validate_render_value() {
  local name="$1"
  local value="$2"

  [[ "$value" != *'&'* ]] || fatal "$name contains an unsupported character"
  [[ "$value" != *'|'* ]] || fatal "$name contains an unsupported character"
  [[ "$value" != *'<'* ]] || fatal "$name contains an unsupported character"
  [[ "$value" != *'>'* ]] || fatal "$name contains an unsupported character"
  [[ "$value" != *$'\n'* ]] || fatal "$name contains a newline"
}

[[ -x "$SOURCE_SCRIPT" ]] || fatal "source script is not executable: $SOURCE_SCRIPT"
[[ -r "$TEMPLATE" ]] || fatal "LaunchAgent template is not readable: $TEMPLATE"
validate_render_value QMD_SYNC_INSTALL_ROOT "$INSTALL_ROOT"
validate_render_value QMD_SYNC_LOG_DIR "$LOG_DIR"
validate_render_value QMD_SYNC_FALLBACK_LOG_DIR "$FALLBACK_LOG_DIR"
validate_render_value HOME "$HOME"

mkdir -p "$INSTALL_ROOT" "$LOG_DIR" "$FALLBACK_LOG_DIR" "$LAUNCH_AGENTS_DIR"
/usr/bin/install -m 700 "$SOURCE_SCRIPT" "$STAGED_SCRIPT"
/bin/mv "$STAGED_SCRIPT" "$INSTALLED_SCRIPT"

/usr/bin/sed \
  -e "s|__QMD_SYNC_SCRIPT__|$INSTALLED_SCRIPT|g" \
  -e "s|__QMD_SYNC_WORKING_DIRECTORY__|$INSTALL_ROOT|g" \
  -e "s|__QMD_SYNC_LOG_DIR__|$LOG_DIR|g" \
  -e "s|__QMD_SYNC_STDOUT__|$FALLBACK_LOG_DIR/qmd-sync.out.log|g" \
  -e "s|__QMD_SYNC_STDERR__|$FALLBACK_LOG_DIR/qmd-sync.err.log|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$STAGED_PLIST"
/bin/chmod 600 "$STAGED_PLIST"
/usr/bin/plutil -lint "$STAGED_PLIST"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

/bin/mv "$STAGED_PLIST" "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$DOMAIN/$LABEL"
printf 'Installed and bootstrapped %s from %s\n' "$LABEL" "$PLIST"
