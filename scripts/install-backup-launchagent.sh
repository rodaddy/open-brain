#!/opt/homebrew/bin/bash
# Install the Open Brain scheduled-backup LaunchAgent (issue #677, blocker B4).
#
# Follows scripts/install-qmd-sync-launchagent.sh exactly — same staged-write,
# same metacharacter validation, same plutil lint before anything is
# bootstrapped. That script is the repo's established pattern for this and is
# not being reinvented here; the delta is the backup job's own tokens and a
# render-only mode.
#
# RENDER-ONLY MODE (OPENBRAIN_BACKUP_RENDER_ONLY=1) renders and lints the plist
# and stops before touching launchctl. It exists so the done-means check can
# assert what the INSTALLER produces rather than hand-substituting the tokens
# itself — a hand-rendered plist proves the check's own sed, not this file's.
#
# WHY VALUES ARE VALIDATED: every value below is interpolated into XML. A value
# containing `<` produces a plist that lints clean and means something other
# than what the operator asked for — e.g. an injected <key>RunAtLoad</key> turns
# a nightly job into one that also fires at every login. The validation refuses
# BEFORE anything is written, so a refused run leaves no plist behind.

set -euo pipefail

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SCRIPT="$REPO_ROOT/scripts/backup-scheduled-run.sh"
TEMPLATE="$REPO_ROOT/docs/deploy/com.rico.open-brain-backup.plist.template"

INSTALL_ROOT="${OPENBRAIN_BACKUP_INSTALL_ROOT:-/Volumes/ThunderBolt/open-brain/backup-agent}"
INSTALLED_SCRIPT="$INSTALL_ROOT/backup-scheduled-run.sh"
BACKUP_ROOT="${OPENBRAIN_BACKUP_ROOT:-/Volumes/ThunderBolt/open-brain/backups}"
REPO_DIR_VALUE="${OPENBRAIN_BACKUP_REPO_DIR:-/Volumes/ThunderBolt/open-brain/app}"
ENV_FILE_VALUE="${OPENBRAIN_BACKUP_ENV_FILE:-/Users/rico/.config/open-brain/env}"
LOG_DIR="${OPENBRAIN_BACKUP_LOG_DIR:-/Volumes/ThunderBolt/open-brain/log}"
FALLBACK_LOG_DIR="${OPENBRAIN_BACKUP_FALLBACK_LOG_DIR:-$HOME/Library/Logs/open-brain}"
LAUNCH_AGENTS_DIR="${OPENBRAIN_BACKUP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
RENDER_ONLY="${OPENBRAIN_BACKUP_RENDER_ONLY:-}"

LABEL="com.rico.open-brain-backup"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
STAGED_PLIST="$PLIST.next"
STAGED_SCRIPT="$INSTALLED_SCRIPT.next"
DOMAIN="gui/$(id -u)"

fatal() {
  printf 'FATAL: %s\n' "$1" >&2
  exit 1
}

validate_render_value() {
  local name="$1"
  local value="$2"

  [[ "$value" != *'&'* ]] || fatal "$name contains an unsupported character (&)"
  [[ "$value" != *'|'* ]] || fatal "$name contains an unsupported character (|)"
  [[ "$value" != *'<'* ]] || fatal "$name contains an unsupported character (<)"
  [[ "$value" != *'>'* ]] || fatal "$name contains an unsupported character (>)"
  [[ "$value" != *$'\n'* ]] || fatal "$name contains a newline"
}

[[ -r "$SOURCE_SCRIPT" ]] || fatal "runner script is not readable: $SOURCE_SCRIPT"
[[ -r "$TEMPLATE" ]] || fatal "LaunchAgent template is not readable: $TEMPLATE"

# Validation runs BEFORE any mkdir/install/write, so a hostile value cannot
# leave a partially-installed agent behind.
validate_render_value OPENBRAIN_BACKUP_INSTALL_ROOT "$INSTALL_ROOT"
validate_render_value OPENBRAIN_BACKUP_ROOT "$BACKUP_ROOT"
validate_render_value OPENBRAIN_BACKUP_REPO_DIR "$REPO_DIR_VALUE"
validate_render_value OPENBRAIN_BACKUP_ENV_FILE "$ENV_FILE_VALUE"
validate_render_value OPENBRAIN_BACKUP_LOG_DIR "$LOG_DIR"
validate_render_value OPENBRAIN_BACKUP_FALLBACK_LOG_DIR "$FALLBACK_LOG_DIR"
validate_render_value HOME "$HOME"

mkdir -p "$INSTALL_ROOT" "$LOG_DIR" "$FALLBACK_LOG_DIR" "$LAUNCH_AGENTS_DIR"
/usr/bin/install -m 700 "$SOURCE_SCRIPT" "$STAGED_SCRIPT"
/bin/mv "$STAGED_SCRIPT" "$INSTALLED_SCRIPT"

/usr/bin/sed \
  -e "s|__OPENBRAIN_BACKUP_SCRIPT__|$INSTALLED_SCRIPT|g" \
  -e "s|__OPENBRAIN_BACKUP_WORKING_DIRECTORY__|$INSTALL_ROOT|g" \
  -e "s|__OPENBRAIN_BACKUP_ROOT__|$BACKUP_ROOT|g" \
  -e "s|__OPENBRAIN_BACKUP_REPO_DIR__|$REPO_DIR_VALUE|g" \
  -e "s|__OPENBRAIN_BACKUP_ENV_FILE__|$ENV_FILE_VALUE|g" \
  -e "s|__OPENBRAIN_BACKUP_LOG_DIR__|$LOG_DIR|g" \
  -e "s|__OPENBRAIN_BACKUP_STDOUT__|$FALLBACK_LOG_DIR/open-brain-backup.out.log|g" \
  -e "s|__OPENBRAIN_BACKUP_STDERR__|$FALLBACK_LOG_DIR/open-brain-backup.err.log|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$STAGED_PLIST"
/bin/chmod 600 "$STAGED_PLIST"
/usr/bin/plutil -lint "$STAGED_PLIST"

# Any surviving placeholder means a token was added to the template and never
# given a substitution here. The plist would lint fine and the job would point
# at a literal placeholder path, failing every night in a way nobody reads.
#
# Scoped to <string> VALUES, not the whole file: the template's own explanatory
# comment discusses the placeholder syntax by name, and a whole-file match
# treats that documentation as a defect. (Caught by the done-means check on the
# first green run — the installer refused its own correct output.)
if /usr/bin/grep -q '<string>[^<]*__[A-Z_][A-Z_]*__' "$STAGED_PLIST"; then
  fatal "rendered plist still contains unsubstituted placeholders in a value — a template token has no matching substitution in this installer"
fi

if [[ -n "$RENDER_ONLY" ]]; then
  /bin/mv "$STAGED_PLIST" "$PLIST"
  printf 'RENDER-ONLY: wrote and linted %s\n' "$PLIST"
  printf 'RENDER-ONLY: launchctl was NOT touched; the agent is not scheduled.\n'
  exit 0
fi

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

/bin/mv "$STAGED_PLIST" "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$DOMAIN/$LABEL"
printf 'Installed and bootstrapped %s from %s\n' "$LABEL" "$PLIST"
printf 'Backups will be written under %s at 03:00 daily.\n' "$BACKUP_ROOT"
printf 'Run one NOW to prove the wiring: launchctl kickstart -k %s/%s\n' "$DOMAIN" "$LABEL"
