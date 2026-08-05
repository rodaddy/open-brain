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

# --- 0. this machine's Development root, RESOLVED ---------------------------
# openbrain-provider resolves the Development lane by asking the FILESYSTEM, and
# the shipped default is the BUILD machine's volume
# (development_scope.py: DEFAULT_DEVELOPMENT_ROOT). On a box whose Development
# tree is somewhere else, that path does not exist, resolve_development_scope()
# answers None for every cwd, and the context-budget gate then composes its
# recovery command from the same wrong root -- so the banner tells the operator
# to cd somewhere that is not there, and the session cannot be unblocked from
# inside itself. Field-proved on the Air, 2026-08-04 (#555).
#
# The package already reads OPENBRAIN_DEVELOPMENT_ROOT per call; nothing ever
# SHIPPED it. Resolving it here, per box, is that missing half. The package is
# unchanged.
#
# RESOLUTION RUNS FIRST, BEFORE ANYTHING IS INSTALLED. It reads the environment
# and the filesystem and writes nothing, but it can `die` -- and a refusal that
# fires after the wheels are installed and the env dir is copied leaves a
# half-installed box behind an error the operator then has to reason about
# twice. Refusing here means the failure mode is "nothing happened yet". The
# WRITE of the resolved value stays in section 2b, after the env file it edits
# actually exists.
#
# Resolution order: an exported value wins (the operator said so), then DEV_ROOT
# (what the fleet scripts already call it), then the two known layouts. Probing
# is last because a guess should never beat an instruction.
log "==> resolving this machine's Development root"
DEV_ROOT_RESOLVED=""
DEV_ROOT_SOURCE=""
if [ -n "${OPENBRAIN_DEVELOPMENT_ROOT:-}" ]; then
  DEV_ROOT_RESOLVED="$OPENBRAIN_DEVELOPMENT_ROOT"
  DEV_ROOT_SOURCE="OPENBRAIN_DEVELOPMENT_ROOT in the environment"
elif [ -n "${DEV_ROOT:-}" ]; then
  DEV_ROOT_RESOLVED="$DEV_ROOT"
  DEV_ROOT_SOURCE="DEV_ROOT in the environment"
else
  for candidate in /Volumes/ThunderBolt/Development "$HOME/Development"; do
    if [ -d "$candidate" ]; then
      DEV_ROOT_RESOLVED="$candidate"
      DEV_ROOT_SOURCE="probed (found on disk)"
      break
    fi
  done
fi

# An explicitly-given root that does not exist is a typo, not a preference, and
# it fails exactly like the defect this guard exists to close. Say so now.
if [ -n "$DEV_ROOT_RESOLVED" ] && [ ! -d "$DEV_ROOT_RESOLVED" ]; then
  die "OPENBRAIN_DEVELOPMENT_ROOT / DEV_ROOT names a path that does not exist:

      $DEV_ROOT_RESOLVED

    The provider resolves the lane by asking the filesystem, so a path that is
    not there behaves exactly like no value at all: every gate wedges. Point it
    at this machine's real Development tree and re-run."
fi

# Refuse rather than warn, matching the loopback guard below: a warning here
# scrolls away under install output and the install then "succeeds" into a box
# that blocks every tool call on first use.
if [ -z "$DEV_ROOT_RESOLVED" ]; then
  if [ "${OPENBRAIN_ALLOW_NO_DEVELOPMENT_ROOT:-}" = "1" ]; then
    log "    [warn] no Development root resolved; continuing because"
    log "           OPENBRAIN_ALLOW_NO_DEVELOPMENT_ROOT=1"
  else
    die "cannot determine this machine's Development root.

    Neither /Volumes/ThunderBolt/Development nor \$HOME/Development exists here,
    and neither OPENBRAIN_DEVELOPMENT_ROOT nor DEV_ROOT was set.

    Without it the provider keeps the build machine's default, every cwd
    resolves to no scope, and the context-budget gate blocks every tool call
    while pointing its own recovery command at a path this box does not have.

    Re-run naming the variable:

      OPENBRAIN_DEVELOPMENT_ROOT=/path/to/Development ./setup-client.sh

    This box genuinely has no Development tree and runs no gated agent work?
    Set OPENBRAIN_ALLOW_NO_DEVELOPMENT_ROOT=1 to skip this check."
  fi
else
  log "    Development root: $DEV_ROOT_RESOLVED [$DEV_ROOT_SOURCE]"
fi

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

# --- 2b. this machine's Development root, WRITTEN ---------------------------
# The value was resolved in section 0, before anything was installed, so a bad
# or missing root has already refused by the time we get here. What is left is
# the write, and it lives here because it edits the env file section 2 just
# placed.
#
# Write it into the INSTALLED env file. The bundle ships the build machine's
# value (or none), so this rewrite is what makes the file correct per box --
# same reason the wrapper's ENV_FILE is rewritten just below.
if [ -n "$DEV_ROOT_RESOLVED" ]; then
  python3 - "$TARGET_ENV_DIR/claudex-observation.env" "$DEV_ROOT_RESOLVED" <<'PY'
import re
import shlex
import sys

path, root = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    text = handle.read()

# Shell-quote the value. The wrapper reads this file with POSIX
# `set -a; . "$ENV_FILE"`, which SPLITS an unquoted right-hand side on IFS: a
# root containing a space becomes a word plus a stray command, the shell says
# "No such file or directory", and the variable lands EMPTY -- which is exactly
# the #555 wedge this line exists to close, delivered silently through its own
# fix while the installer still prints success. Quoting preserves the value
# whole. The other lines in this file are unquoted, which is fine; POSIX `.`
# reads a quoted value just as happily, so only the line we write changes.
quoted_root = shlex.quote(root)

BEGIN = "## >>> openbrain: development root (managed) >>>"
END = "## <<< openbrain: development root (managed) <<<"

block = (
    f"{BEGIN}\n"
    "## Written by setup-client.sh at install time -- the provider's built-in\n"
    "## default is the BUILD machine's volume, and a root that does not exist\n"
    "## resolves every cwd to no scope, which blocks every tool call behind a\n"
    "## recovery command pointing somewhere this box does not have (#555).\n"
    "## Re-run setup-client.sh to update it; this block is rewritten whole.\n"
    "## Shell-quoted: this file is sourced, so a path containing a space would\n"
    "## otherwise split and arrive empty.\n"
    f"OPENBRAIN_DEVELOPMENT_ROOT={quoted_root}\n"
    f"{END}\n"
)

# Rewrite the block WHOLE, between markers. The previous version replaced only
# the assignment LINE, which is idempotent on its own but left the comment lines
# behind -- so every bundle+install cycle appended another seven-line preamble.
# The Air's env file reached THREE stacked blocks that way, one still reading
# "EDIT ME" above the value the installer had just resolved. Delete every marked
# block first (there may be several from before this fix, and `*?` keeps each
# match to its own block rather than swallowing the span between the first BEGIN
# and the last END), then append exactly one.
marked = re.compile(
    rf"^{re.escape(BEGIN)}\n.*?^{re.escape(END)}\n?", re.M | re.S
)
text = marked.sub("", text)

# Sweep the legacy UNMARKED copies this writer and client-bundle.sh emitted
# before markers existed. Each is anchored on its OWN opening comment line and
# eats the "##" run that follows, so it removes blocks this project wrote and
# leaves operator comments alone.
#
# The trailing assignment is OPTIONAL, and that is the whole subtlety: the old
# writer stripped the assignment line as it appended the next block, so in a
# file with N stacked blocks only the LAST one still has a value under it and
# the earlier N-1 are bare comment runs. Requiring the assignment cleaned up
# exactly one block and left the rest -- measured on the Air-shaped fixture,
# which still reported EDIT-ME=1 after a reinstall.
legacy = (
    # setup-client.sh's own historical block (live assignment).
    r"^## This machine's Development root\. Written by setup-client\.sh at install\n"
    r"(?:^##.*\n)*"
    r"(?:^OPENBRAIN_DEVELOPMENT_ROOT=.*\n?)?",
    # client-bundle.sh's staged block (commented assignment).
    r"^## EDIT ME ON THE CLIENT.*\n"
    r"(?:^##.*\n)*"
    r"(?:^#\s*OPENBRAIN_DEVELOPMENT_ROOT=.*\n?)?",
)
for pat in legacy:
    text = re.sub(pat, "", text, flags=re.M)

# Any remaining stray assignment (hand-edited, or a spelling neither block
# above owns) still has to go: two live assignments would disagree silently.
text = re.sub(r"^[#\s]*OPENBRAIN_DEVELOPMENT_ROOT=.*$\n?", "", text, flags=re.M)

text = text.rstrip("\n") + "\n" + block
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
print(f"    OPENBRAIN_DEVELOPMENT_ROOT={quoted_root} written to the installed env file")
PY
fi

# The wrapper starts a CLEAN child (`exec env -i`), so a variable that is not on
# its allowlist never reaches the hook no matter what the env file says. Ensure
# the pass-through is present. OPENBRAIN_DEVELOPMENT_ROOT is a STRING, so it
# takes the plain list spelling; the wrapper's header reserves the conditional
# block for non-string values, where "" and absent differ.
python3 - "$TARGET_ENV_DIR/openbrain-hook-env" <<'PY'
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    text = handle.read()

if "OPENBRAIN_DEVELOPMENT_ROOT=" in text:
    print("    [ok] wrapper already passes OPENBRAIN_DEVELOPMENT_ROOT")
    sys.exit(0)

anchor = '  OPENBRAIN_TOKEN="${OPENBRAIN_TOKEN:-}" \\\n'
if anchor not in text:
    sys.exit(
        "setup-client: could not find the OPENBRAIN_TOKEN line in the wrapper's\n"
        "    env -i list, so OPENBRAIN_DEVELOPMENT_ROOT could not be added. The\n"
        "    wrapper's shape changed; add the pass-through by hand:\n"
        '      OPENBRAIN_DEVELOPMENT_ROOT="${OPENBRAIN_DEVELOPMENT_ROOT:-}" \\'
    )

text = text.replace(
    anchor,
    anchor + '  OPENBRAIN_DEVELOPMENT_ROOT="${OPENBRAIN_DEVELOPMENT_ROOT:-}" \\\n',
    1,
)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
print("    OPENBRAIN_DEVELOPMENT_ROOT pass-through added to the wrapper")
PY

# The wrapper staged into the bundle may carry either the legacy BUILD-machine
# ENV_FILE assignment or a block from a previous install. Normalize both shapes
# into one runtime-derived block so the wrapper and its sibling env file share a
# single location truth on every client.
# --- begin hook env-file path normalization ---
python3 - "$TARGET_ENV_DIR/openbrain-hook-env" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    text = handle.read()

BEGIN = "# >>> openbrain: hook env file (managed) >>>"
END = "# <<< openbrain: hook env file (managed) <<<"
managed = rf"^{re.escape(BEGIN)}\n.*?^{re.escape(END)}\n?"
legacy = r'^ENV_FILE="[^"\n]*"\n?'
recognized = re.compile(rf"(?:{managed}|{legacy})", re.M | re.S)

if recognized.search(text) is None:
    sys.exit(
        "setup-client: wrapper has neither a legacy ENV_FILE assignment nor the\n"
        "    managed hook env-file block. Refusing to guess an insertion point:\n"
        f"    {path}"
    )

block = f'''{BEGIN}
ENV_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || :)"
ENV_FILE_SOURCE="wrapper directory derived from $0"
if [ -z "$ENV_DIR" ]; then
  ENV_DIR="${{HOME}}/.local/share/openbrain-memory/env"
  ENV_FILE_SOURCE="HOME fallback because wrapper directory derivation from $0 yielded nothing"
fi
ENV_FILE="$ENV_DIR/claudex-observation.env"
if [ ! -r "$ENV_FILE" ]; then
  printf '%s\\n' "openbrain-hook-env: env file missing or unreadable: $ENV_FILE (derived from $ENV_FILE_SOURCE)" >&2
  exit 1
fi
{END}
'''

text = recognized.sub("__OPENBRAIN_HOOK_ENV_FILE_BLOCK__", text, count=1)
text = recognized.sub("", text)
text = text.replace("__OPENBRAIN_HOOK_ENV_FILE_BLOCK__", block, 1)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
print("    wrapper env-file path now derives from the wrapper directory")
PY
# --- end hook env-file path normalization ---

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

# The bundle ships the BUILD MACHINE's env file verbatim, and on the Mini that
# file says 127.0.0.1. Copied to a client, a loopback URL points the client at
# ITSELF -- where nothing is listening -- so every later failure reads as "the
# brain is down" instead of "this line was never edited." That is not a
# hypothetical: it is the unedited default of every bundle produced so far.
#
# Refuse rather than warn. A warning here is printed above a wall of install
# output and scrolls away, and the install then "succeeds" into a stack that
# cannot work.
case "$BASE_URL" in
  http://127.0.0.1*|http://localhost*|https://127.0.0.1*|https://localhost*|*'[::1]'*)
    if [ "${OPENBRAIN_ALLOW_LOOPBACK_CLIENT:-}" = "1" ]; then
      log "    [warn] loopback base URL allowed by OPENBRAIN_ALLOW_LOOPBACK_CLIENT=1"
    else
      die "OPENBRAIN_BASE_URL is $BASE_URL — a LOOPBACK address.

    On a client box that is always the unedited build-machine value: the
    bundle ships the Mini's env file as-is, and loopback points this box at
    itself, where no brain is listening.

    Edit this line, then re-run:

      $TARGET_ENV_DIR/claudex-observation.env

    Preferred -- TLS, so it needs no extra variable and works off the LAN:

      OPENBRAIN_BASE_URL=https://ob.rodaddy.live

    Fallback, only if DNS or Caddy is down AND this box is on the LAN. Plain
    http to a non-loopback address is refused by the client unless you ALSO add
    OPENBRAIN_ALLOW_INSECURE_HTTP=1 to that same file -- both lines or neither:

      OPENBRAIN_BASE_URL=http://10.71.1.20:3100
      OPENBRAIN_ALLOW_INSECURE_HTTP=1

    Running this script ON the Mini itself, where loopback is correct? Set
    OPENBRAIN_ALLOW_LOOPBACK_CLIENT=1 to skip this check."
    fi ;;
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

# The CLI reads the namespace from OPENBRAIN_NAMESPACE in the ENVIRONMENT; it
# is not a request field. Assert the export exists BEFORE recalling, because
# without it the recall fails deep inside scope validation with a message about
# a request key -- pointing at the JSON rather than at the missing line in the
# env file. The first client install spent four round trips on that gap.
if rg -q '^[[:space:]]*(export[[:space:]]+)?OPENBRAIN_NAMESPACE=' \
    "$TARGET_ENV_DIR/claudex-observation.env" 2>/dev/null; then
  log "    [ok] OPENBRAIN_NAMESPACE present in the env file"
else
  die "OPENBRAIN_NAMESPACE is missing from
    $TARGET_ENV_DIR/claudex-observation.env

    The provider CLI takes the namespace from the ENVIRONMENT, never from the
    request body, so without this line every recall fails with a message about
    a request key and says nothing about the env file. Add:

      OPENBRAIN_NAMESPACE=rico"
fi

# The prover is the ONLY end-to-end check that the direct stack works, so it
# has to call the CLI the way the CLI is actually called: ONE bounded JSON
# object on stdin, with `operation` inside it and the full five-field scope.
#
# It previously ran `openbrain-memory recall --query ... --limit 1`, an argv
# interface that has never existed. That invocation cannot reach the brain at
# all -- it returns "arguments are not supported" -- so the prover reported
# [FAIL] on every install regardless of whether the install was good, which
# makes it worse than no prover: it is a check whose failure carries no
# information.
log "    recall through the installed openbrain-memory:"
recall_out="$(
  set -a
  . "$TARGET_ENV_DIR/claudex-observation.env"
  set +a
  printf '%s' '{"operation":"recall","query":"client install proof","scope":{"agent":"setup-client","platform":"claude-code","server_id":"client-install","channel_id":"client-install","session_key":"client-install-proof"}}' \
    | openbrain-memory 2>&1 || true
)"
if printf '%s' "$recall_out" | rg -q '"status"[[:space:]]*:[[:space:]]*"direct"' 2>/dev/null; then
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
