#!/usr/bin/env bash
# setup-client.sh — install the Open Brain direct client stack from a bundle.
#
# RUN THIS ON THE CLIENT (the Air, or any other box that cannot reach GitHub),
# from inside a bundle directory produced by scripts/client-bundle.sh.
#
# This file lives in the repo so it is versioned and reviewable; client-bundle.sh
# copies it into each bundle so the client gets it without a checkout.
#
# It is /usr/bin/env bash, not the Homebrew absolute path the Mini's scripts use,
# because the client may not have Homebrew at that path — the bundle has to run
# on a machine we have not standardised.
#
# WHAT IT DOES, and why each step is not optional:
#
#   1. Installs three wheels with `uv tool install --force`. All three: the hook
#      commands in settings.json come from all of `openbrain` (capture/session),
#      `openbrain-provider` (the gates), and `openbrain-memory` (recall).
#   2. Copies the env dir to ~/.local/share/openbrain-memory/. The wrapper reads
#      an ABSOLUTE path, so the location is load-bearing, not a preference.
#   3. chmod +x on the wrapper — settings.json execs it, and a copy that lost its
#      mode bit turns every hook into a silent no-op.
#   4. MERGES hook entries into ~/.claude/settings.json. Merge, never clobber:
#      that file holds permissions, model choice, and other hooks that are not
#      ours to overwrite.
#   5. Proves it: /health, then a real recall through the installed client.
#
# ORDER MATTERS — the wrapper and the installed package are a MATCHED PAIR. The
# wrapper passes OPENBRAIN_* variables through; the Python config REJECTS any
# OPENBRAIN_* it does not declare, and the hook entrypoints SWALLOW that
# rejection into a clean exit 0. A wrapper newer than its package is therefore a
# silent, green-looking, zero-capture install. This script installs the wheels
# BEFORE placing the wrapper for exactly that reason.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SHARE="${TARGET_SHARE:-$HOME/.local/share/openbrain-memory}"
TARGET_ENV_DIR="$TARGET_SHARE/env"
SETTINGS="${SETTINGS:-$HOME/.claude/settings.json}"

log() { printf '%s\n' "$*"; }
die() { printf 'setup-client: %s\n' "$*" >&2; exit 1; }

command -v uv >/dev/null 2>&1 || die "uv not on PATH — install uv first (https://astral.sh/uv)"
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"

[ -d "$BUNDLE_DIR/wheels" ] || die "bundle incomplete: no wheels/ next to this script"
[ -f "$BUNDLE_DIR/env/claudex-observation.env" ] || die "bundle incomplete: env/claudex-observation.env missing"
[ -f "$BUNDLE_DIR/env/openbrain-hook-env" ] || die "bundle incomplete: env/openbrain-hook-env missing"
[ -f "$BUNDLE_DIR/settings-hooks.json" ] || die "bundle incomplete: settings-hooks.json missing"

# --- 1. wheels -------------------------------------------------------------
# --find-links points at the bundle's own wheels/, mirroring the
# OPENBRAIN_MEMORY_FIND_LINKS convention the Mini already uses
# (~/.local/share/openbrain-memory/wheels). Same idea, client side: resolve from
# a local wheelhouse, never from an index.

log "==> installing wheels from $BUNDLE_DIR/wheels"
for pkg in openbrain openbrain-memory openbrain-provider; do
  normalised="${pkg//-/_}"
  wheel="$(ls -1 "$BUNDLE_DIR"/wheels/${normalised}-*.whl 2>/dev/null | head -1 || true)"
  [ -n "$wheel" ] || die "no wheel for $pkg in $BUNDLE_DIR/wheels"
  log "    $pkg <- $(basename "$wheel")"
  uv tool install --force --find-links "$BUNDLE_DIR/wheels" "$wheel"
done

# --- 2/3. env dir + wrapper ------------------------------------------------

log "==> placing env dir at $TARGET_ENV_DIR"
mkdir -p "$TARGET_ENV_DIR"
if [ -f "$TARGET_ENV_DIR/claudex-observation.env" ]; then
  backup="$TARGET_ENV_DIR/claudex-observation.env.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET_ENV_DIR/claudex-observation.env" "$backup"
  log "    existing env file backed up to $(basename "$backup")"
fi
cp "$BUNDLE_DIR/env/claudex-observation.env" "$TARGET_ENV_DIR/"
cp "$BUNDLE_DIR/env/openbrain-hook-env" "$TARGET_ENV_DIR/"
chmod 600 "$TARGET_ENV_DIR/claudex-observation.env"
chmod +x "$TARGET_ENV_DIR/openbrain-hook-env"

# The wrapper hardcodes ENV_FILE as an absolute path from the BUILD machine. If
# this client's $HOME differs, that path is wrong and every hook silently fails
# to find its env — so rewrite it to this machine's actual location.
BUILD_ENV_PATH="$(python3 - "$TARGET_ENV_DIR/openbrain-hook-env" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r'^ENV_FILE="([^"]+)"', text, re.M)
print(match.group(1) if match else "")
PY
)"
WANT_ENV_PATH="$TARGET_ENV_DIR/claudex-observation.env"
if [ -n "$BUILD_ENV_PATH" ] && [ "$BUILD_ENV_PATH" != "$WANT_ENV_PATH" ]; then
  log "    rewriting wrapper ENV_FILE: $BUILD_ENV_PATH -> $WANT_ENV_PATH"
  python3 - "$TARGET_ENV_DIR/openbrain-hook-env" "$WANT_ENV_PATH" <<'PY'
import re
import sys
path, want = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
text = re.sub(r'^ENV_FILE="[^"]+"', f'ENV_FILE="{want}"', text, count=1, flags=re.M)
open(path, "w", encoding="utf-8").write(text)
PY
fi

# The hook COMMANDS in settings-hooks.json also carry the build machine's
# absolute wrapper path; retarget them the same way during the merge below.

# --- 4. merge hook entries -------------------------------------------------

log "==> merging openbrain hook entries into $SETTINGS"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
cp -p "$SETTINGS" "$SETTINGS.bak-openbrain-$(date +%Y%m%d-%H%M%S)"

python3 - "$SETTINGS" "$BUNDLE_DIR/settings-hooks.json" "$TARGET_ENV_DIR/openbrain-hook-env" <<'PY'
import json
import re
import sys

settings_path, hooks_path, wrapper_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(settings_path, encoding="utf-8") as handle:
    settings = json.load(handle)
with open(hooks_path, encoding="utf-8") as handle:
    incoming = json.load(handle)["hooks"]


def retarget(command: str) -> str:
    """Point the command at THIS machine's wrapper, keeping the arguments."""
    return re.sub(r"\S*openbrain-hook-env", wrapper_path, command)


hooks = settings.setdefault("hooks", {})
added = replaced = 0

for event, matchers in incoming.items():
    existing = hooks.setdefault(event, [])
    # Drop any openbrain entries already present, so re-running is idempotent
    # and an upgrade replaces rather than duplicates. Non-openbrain hooks in the
    # same matcher are preserved untouched.
    for matcher in existing:
        kept = [h for h in matcher.get("hooks", []) if "openbrain" not in str(h.get("command", ""))]
        replaced += len(matcher.get("hooks", [])) - len(kept)
        matcher["hooks"] = kept
    existing[:] = [m for m in existing if m.get("hooks")]

    for matcher in matchers:
        entry = dict(matcher)
        entry["hooks"] = [
            {**h, "command": retarget(str(h.get("command", "")))} for h in matcher["hooks"]
        ]
        added += len(entry["hooks"])
        # Fold into an existing matcher with the same selector when there is one,
        # so we do not fragment the file into near-duplicate matcher blocks.
        same = next(
            (m for m in existing if m.get("matcher") == entry.get("matcher")),
            None,
        )
        if same is None:
            existing.append(entry)
        else:
            same["hooks"].extend(entry["hooks"])

with open(settings_path, "w", encoding="utf-8") as handle:
    json.dump(settings, handle, indent=2)
    handle.write("\n")

print(f"    {added} openbrain hook entries written ({replaced} stale ones replaced)")
PY

# --- 5. proof --------------------------------------------------------------
# An install is not done because commands exist. It is done when the brain
# answers and a recall comes back through the DIRECT stack.

log ""
log "==> proving the install"

BASE_URL="$(python3 - "$TARGET_ENV_DIR/claudex-observation.env" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if line.startswith("OPENBRAIN_BASE_URL="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"
[ -n "$BASE_URL" ] || die "OPENBRAIN_BASE_URL not found in the env file"
log "    base URL: $BASE_URL"

case "$BASE_URL" in
  */mcp|*/mcp/)
    die "OPENBRAIN_BASE_URL ends in /mcp — the direct stack needs a BARE
    scheme://host:port with no path. A /mcp URL is the retired MCP lane." ;;
esac

health_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/health" || echo 000)"
if [ "$health_code" = "200" ]; then
  log "    [ok] /health -> 200"
else
  log "    [FAIL] /health -> $health_code"
  log "           The brain is unreachable from this box. Check: is the service"
  log "           up on the Mini, is the URL right, and if it is plain http on a"
  log "           LAN address, is OPENBRAIN_ALLOW_INSECURE_HTTP=1 set?"
fi

log "    recall through the installed openbrain-memory:"
recall_out="$(sh "$TARGET_ENV_DIR/openbrain-hook-env" openbrain-memory recall \
  --query "open brain client install" --limit 1 2>&1 || true)"
if printf '%s' "$recall_out" | rg -q '"status"\s*:\s*"direct"' 2>/dev/null; then
  log "    [ok] recall returned status=direct"
else
  log "    [FAIL] recall did not return status=direct"
  log "           First 400 chars of the response:"
  printf '%s\n' "$recall_out" | head -c 400 | sed 's/^/           /'
fi

# --- 6. stale MCP registration reminder ------------------------------------

log ""
log "==> CHECK FOR A STALE MCP REGISTRATION"
log "    The direct stack NEVER uses a /mcp URL. If any error you see later"
log "    mentions a URL ending in /mcp, a retired MCP-lane registration is still"
log "    configured on this box and is answering instead of the direct client."
log ""
log "      claude mcp list"
log "      claude mcp remove <name>     # for any open-brain entry it shows"
log ""
if command -v claude >/dev/null 2>&1; then
  log "    Current registrations:"
  claude mcp list 2>&1 | sed 's/^/      /' || true
else
  log "    (claude CLI not on PATH — check by hand)"
fi

log ""
log "==> done. RESTART the agent harness so the new SessionStart hooks load."
log "    Then confirm a fresh session emits CANON PACK with non-zero counts."
