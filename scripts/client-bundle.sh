#!/opt/homebrew/bin/bash
# client-bundle.sh — build the offline install bundle that puts the Open Brain
# direct client stack onto a machine that CANNOT reach GitHub.
#
# RUN THIS ON THE MINI (192.0.2.20). It reads this machine's live, working
# installation and freezes it into a directory the client can copy from.
#
# Why this exists: the clients (the Air, and every other family-A box) have no
# route to the private GitHub repo, so `uv tool install git+ssh://...` is not
# available to them. There is no published index either — python/openbrain-memory
# records that its `fleet-nats` dependency is not on PyPI. Wheels built here and
# staged on the ThunderBolt volume are the paved road, and this script is what
# makes that road reproducible instead of a thing somebody re-derives at 2am.
#
# WHAT IT STAGES — the four artifacts, plus the installer that applies them:
#
#   1. wheels/          three wheels: openbrain, openbrain-memory,
#                       openbrain-provider, built with `uv build` from the
#                       CURRENT WORKING TREE of this checkout.
#   2. env/             a copy of ~/.local/share/openbrain-memory/env/, which is
#                       the env file AND the openbrain-hook-env wrapper.
#   3. settings-hooks.json  the openbrain-* hook entries lifted out of
#                       ~/.claude/settings.json, hook events only, so the client
#                       installer can MERGE them instead of clobbering a
#                       settings file that has unrelated content in it.
#   4. setup-client.sh  the installer that runs on the client.
#      README.md        what this bundle is and the commit it came from.
#
# THE ENV DIR CARRIES A LIVE TOKEN. That is why the bundle home is on the
# ThunderBolt volume next to the running app and NOT in this repo, and why
# nothing here ever writes into the repo. Do not commit a bundle. Do not copy
# one anywhere a token should not go.
#
# NO RECURSIVE DELETES. Each run stages into a FRESH timestamped directory and
# then flips the `current` symlink. Stale bundles stay on disk until an operator
# removes them by hand — a superseded bundle costs disk, a wrong `rm -rf` costs
# the volume.
#
# Usage:
#   scripts/client-bundle.sh                 # stage into the default home
#   BUNDLE_HOME=/some/path scripts/client-bundle.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_HOME="${BUNDLE_HOME:-$HOME/.local/share/openbrain/air-bundle}"
SOURCE_ENV_DIR="${SOURCE_ENV_DIR:-$HOME/.local/share/openbrain-memory/env}"
SOURCE_SETTINGS="${SOURCE_SETTINGS:-$HOME/.claude/settings.json}"

PACKAGES=(openbrain openbrain-memory openbrain-provider)

log() { printf '%s\n' "$*" >&2; }
die() { printf 'client-bundle: %s\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
# Fail before staging anything, so a half-built bundle never becomes `current`.

command -v uv >/dev/null 2>&1 || die "uv not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"

[ -d "$SOURCE_ENV_DIR" ] || die "env dir not found: $SOURCE_ENV_DIR"
[ -f "$SOURCE_ENV_DIR/claudex-observation.env" ] || \
  die "env file missing: $SOURCE_ENV_DIR/claudex-observation.env"
[ -f "$SOURCE_ENV_DIR/openbrain-hook-env" ] || \
  die "hook wrapper missing: $SOURCE_ENV_DIR/openbrain-hook-env"
[ -f "$SOURCE_SETTINGS" ] || die "settings.json not found: $SOURCE_SETTINGS"

for pkg in "${PACKAGES[@]}"; do
  [ -f "$REPO_DIR/python/$pkg/pyproject.toml" ] || \
    die "missing package source: python/$pkg/pyproject.toml"
done

BUILT_FROM_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
BUILT_FROM_REF="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
if [ "$BUILT_FROM_REF" = "HEAD" ]; then
  # Detached (building from a PR head is normal here) — name the branches that
  # contain the commit, so the README says something more useful than "HEAD".
  BUILT_FROM_REF="detached; contained in: $(
    git -C "$REPO_DIR" branch -r --contains HEAD --format='%(refname:short)' 2>/dev/null |
      paste -sd', ' - || echo 'unknown'
  )"
fi
if [ -n "$(git -C "$REPO_DIR" status --porcelain -- python/)" ]; then
  BUILT_FROM_DIRTY="yes — python/ had uncommitted edits at build time"
else
  BUILT_FROM_DIRTY="no"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$BUNDLE_HOME/$STAMP"

log "==> staging into $STAGE"
mkdir -p "$STAGE/wheels" "$STAGE/env"

# --- 1. wheels -------------------------------------------------------------
# `uv build --wheel` writes into the package's own dist/, so each build is
# directed at the bundle instead to keep the checkout clean.

for pkg in "${PACKAGES[@]}"; do
  log "==> building wheel: $pkg"
  uv build --wheel \
    --project "$REPO_DIR/python/$pkg" \
    --out-dir "$STAGE/wheels" >&2
done

for pkg in "${PACKAGES[@]}"; do
  # Wheel filenames normalise '-' to '_'. ('openbrain' has no hyphen, so its
  # glob stays 'openbrain-*' and does not match the two underscored siblings.)
  normalised="${pkg//-/_}"
  compgen -G "$STAGE/wheels/${normalised}-*.whl" >/dev/null || \
    die "no wheel produced for $pkg (expected ${normalised}-*.whl)"
done

# `uv build` drops a '*' .gitignore into its out-dir to keep dist/ out of git.
# The bundle is not a git tree, so the file means nothing here except confusion
# for whoever opens the directory next.
# (`if`, not `[ ] && mv` — under `set -e` a false test as the last command of a
# list is itself a nonzero exit.)
if [ -f "$STAGE/wheels/.gitignore" ]; then
  mv "$STAGE/wheels/.gitignore" "$STAGE/wheels/.gitignore.uv-artifact"
fi

# --- 2. env dir ------------------------------------------------------------
# Mode is preserved deliberately: the env file is 0600 because it holds the
# token, and the wrapper is 0755 because settings.json execs it.

log "==> copying env dir"
cp -p "$SOURCE_ENV_DIR/claudex-observation.env" "$STAGE/env/"
cp -p "$SOURCE_ENV_DIR/openbrain-hook-env" "$STAGE/env/"
chmod 600 "$STAGE/env/claudex-observation.env"
chmod 755 "$STAGE/env/openbrain-hook-env"

# setup-client.sh normalizes the wrapper's ENV_FILE block on every install, so
# the bundle deliberately does not carry a second copy of that rewrite logic.

# --- 2b. Development root, staged -------------------------------------------
# The staged env dir is a copy of THIS machine's live installation, and this
# machine is the one box where the provider's built-in default happens to be
# right -- so a bundle built here carries no evidence that the value is
# machine-specific at all. On any client it is wrong, every cwd resolves to no
# scope, and the context-budget gate blocks every tool call (#555).
#
# setup-client.sh resolves and overwrites this per box. What is staged here is
# the BUILD machine's value plus a loud note, so the file is self-describing if
# anyone reads or hand-installs it, and the allowlist entry, without which the
# value cannot reach the hook child at all.

log "==> staging the Development root marker"
# The build machine's own root, by the same order setup-client.sh uses.
BUILD_DEV_ROOT="${OPENBRAIN_DEVELOPMENT_ROOT:-${DEV_ROOT:-}}"
if [ -z "$BUILD_DEV_ROOT" ]; then
  for candidate in "$HOME/Development"; do
    if [ -d "$candidate" ]; then
      BUILD_DEV_ROOT="$candidate"
      break
    fi
  done
fi
[ -n "$BUILD_DEV_ROOT" ] || \
  die "set OPENBRAIN_DEVELOPMENT_ROOT (or DEV_ROOT) to the build machine's Development root"

python3 - "$STAGE/env/claudex-observation.env" "$BUILD_DEV_ROOT" <<'PY'
import re
import shlex
import sys

path, build_root = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    text = handle.read()

# Shell-quote it for the same reason setup-client.sh does: this file is read
# with POSIX `set -a; . "$ENV_FILE"`, so an unquoted path containing a space
# splits on IFS and the variable arrives empty. The staged line is commented,
# but it is the line an operator uncomments when hand-installing -- staging it
# unquoted hands them the #555 wedge with the fix's own example.
quoted_build_root = shlex.quote(build_root)

BEGIN = "## >>> openbrain: development root (managed) >>>"
END = "## <<< openbrain: development root (managed) <<<"

# Stage the BUILD machine's value COMMENTED. Live, it would look authoritative
# on a client where it is wrong; commented with the note, it reads as the
# example it actually is. setup-client.sh writes the live line per box, which is
# why this no longer says "EDIT ME": on the paved road nobody edits it, and the
# instruction outlived its own fix -- it was still sitting above the resolved
# value on a box the installer had already configured correctly.
block = (
    f"{BEGIN}\n"
    "## The BUILD machine's Development root, staged as an EXAMPLE ONLY.\n"
    "## setup-client.sh resolves and rewrites this per box at install time; you\n"
    "## only touch it when hand-installing without that script.\n"
    "## The provider resolves the lane by asking the filesystem, so on a box\n"
    "## where this path does not exist EVERY cwd resolves to no scope and EVERY\n"
    "## tool call is blocked behind a recovery command naming a directory that\n"
    "## box does not have (#555).\n"
    "## The value is shell-quoted: this file is sourced, so a path containing a\n"
    "## space would otherwise split and arrive empty. Keep the quoting if you\n"
    "## do edit it by hand.\n"
    f"# OPENBRAIN_DEVELOPMENT_ROOT={quoted_build_root}\n"
    f"{END}\n"
)

# Rewrite the block WHOLE, between markers -- same reason as setup-client.sh.
# A bundle is staged FROM this machine's live installed env file, so without
# this the staged copy carries every block the installer ever wrote, ships them
# to the client, and the next rebuild stacks another pair.
marked = re.compile(
    rf"^{re.escape(BEGIN)}\n.*?^{re.escape(END)}\n?", re.M | re.S
)
text = marked.sub("", text)

# Sweep the legacy UNMARKED copies emitted before markers existed, anchored on
# their own first comment lines so operator-written comments are untouched. The
# trailing assignment is OPTIONAL: the old writer stripped it while appending
# the next block, so in a file with N stacked blocks only the last one still
# carries a value and the rest are bare comment runs.
legacy = (
    r"^## This machine's Development root\. Written by setup-client\.sh at install\n"
    r"(?:^##.*\n)*"
    r"(?:^OPENBRAIN_DEVELOPMENT_ROOT=.*\n?)?",
    r"^## EDIT ME ON THE CLIENT.*\n"
    r"(?:^##.*\n)*"
    r"(?:^#\s*OPENBRAIN_DEVELOPMENT_ROOT=.*\n?)?",
)
for pat in legacy:
    text = re.sub(pat, "", text, flags=re.M)

text = re.sub(r"^[#\s]*OPENBRAIN_DEVELOPMENT_ROOT=.*$\n?", "", text, flags=re.M)
text = text.rstrip("\n") + "\n" + block
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
print("    staged OPENBRAIN_DEVELOPMENT_ROOT marker (commented)", file=sys.stderr)
PY

# The wrapper starts a clean child with `exec env -i`, so a variable missing
# from its list never reaches the hook regardless of the env file. Stage the
# pass-through here too, so a bundle is correct even if the build machine's own
# wrapper predates this fix. String variable -> plain list spelling; the
# conditional block above it is for non-string values only.
python3 - "$STAGE/env/openbrain-hook-env" <<'PY'
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    text = handle.read()

if "OPENBRAIN_DEVELOPMENT_ROOT=" in text:
    print("    [ok] staged wrapper already passes it", file=sys.stderr)
    sys.exit(0)

anchor = '  OPENBRAIN_TOKEN="${OPENBRAIN_TOKEN:-}" \\\n'
if anchor not in text:
    sys.exit(
        "client-bundle: the staged wrapper has no OPENBRAIN_TOKEN line in its\n"
        "    env -i list, so the OPENBRAIN_DEVELOPMENT_ROOT pass-through could\n"
        "    not be added. Fix the source wrapper before bundling."
    )

text = text.replace(
    anchor,
    anchor + '  OPENBRAIN_DEVELOPMENT_ROOT="${OPENBRAIN_DEVELOPMENT_ROOT:-}" \\\n',
    1,
)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
print("    added OPENBRAIN_DEVELOPMENT_ROOT pass-through to the staged wrapper",
      file=sys.stderr)
PY

# --- 3. hook entries -------------------------------------------------------
# Extract ONLY hook entries whose command mentions openbrain. Everything else in
# settings.json is this machine's business and must not travel.

log "==> extracting openbrain hook entries"
python3 - "$SOURCE_SETTINGS" "$STAGE/settings-hooks.json" <<'PY'
import json
import sys

source, dest = sys.argv[1], sys.argv[2]
with open(source, encoding="utf-8") as handle:
    settings = json.load(handle)

extracted = {}
for event, matchers in (settings.get("hooks") or {}).items():
    kept_matchers = []
    for matcher in matchers:
        kept = [
            hook
            for hook in matcher.get("hooks", [])
            if "openbrain" in str(hook.get("command", ""))
        ]
        if kept:
            entry = {k: v for k, v in matcher.items() if k != "hooks"}
            entry["hooks"] = kept
            kept_matchers.append(entry)
    if kept_matchers:
        extracted[event] = kept_matchers

if not extracted:
    sys.exit("client-bundle: no openbrain hook entries found in " + source)

with open(dest, "w", encoding="utf-8") as handle:
    json.dump({"hooks": extracted}, handle, indent=2)
    handle.write("\n")

total = sum(len(h["hooks"]) for ms in extracted.values() for h in ms)
print(f"    {total} hook entries across {len(extracted)} events", file=sys.stderr)
PY

# --- 4. installer + README -------------------------------------------------

log "==> writing setup-client.sh"
cp -p "$REPO_DIR/scripts/setup-client.sh" "$STAGE/setup-client.sh"
chmod 755 "$STAGE/setup-client.sh"

BASE_URL="$(python3 - "$STAGE/env/claudex-observation.env" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if line.startswith("OPENBRAIN_BASE_URL="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"

log "==> writing README.md"
cat > "$STAGE/README.md" <<EOF
# Open Brain client bundle — $STAMP

Everything a client machine needs to run the Open Brain **direct** stack
(hooks + recall) without reaching GitHub or a package index.

## Provenance

| | |
|---|---|
| Built on | \`$(hostname -s)\` at $(date '+%Y-%m-%d %H:%M:%S %Z') |
| Built from commit | \`$BUILT_FROM_COMMIT\` |
| Branch/ref at build | \`$BUILT_FROM_REF\` |
| \`python/\` dirty at build | $BUILT_FROM_DIRTY |
| Base URL in the staged env | \`$BASE_URL\` |

The wheels are built from that commit's \`python/\` tree. The env dir and the
hook wrapper are a copy of the **live, working** installation on the build
machine, so this bundle reproduces a configuration that was actually running
rather than one assembled from documentation.

## Contents

| Path | What it is |
|---|---|
| \`wheels/\` | \`openbrain\`, \`openbrain-memory\`, \`openbrain-provider\` wheels |
| \`env/claudex-observation.env\` | base URL, token, namespace, observation keys |
| \`env/openbrain-hook-env\` | the wrapper every hook command runs through |
| \`settings-hooks.json\` | the \`openbrain-*\` hook entries, for merging |
| \`setup-client.sh\` | the installer — run this on the CLIENT |

## Install

Copy this directory to the client, then:

\`\`\`bash
./setup-client.sh
\`\`\`

It installs the three wheels, places the env dir, merges the hook entries into
\`~/.claude/settings.json\` without clobbering it, and then proves the install
(health, then a real recall). Restart the agent harness afterwards so the new
\`SessionStart\` hooks load.

## SECURITY

\`env/claudex-observation.env\` contains a **live bearer token**. This bundle is
not in git and must never be committed, attached to an issue or PR, or copied
anywhere a token should not go.

## Full procedure and rationale

\`docs/client-install-runbook.md\` in the open-brain repo.
EOF

# --- publish ---------------------------------------------------------------
# Symlink flip, not a delete. `ln -sfn` replaces the link atomically enough for
# this purpose and never touches the directory the old link pointed at.

ln -sfn "$STAMP" "$BUNDLE_HOME/current"

log ""
log "==> bundle staged: $STAGE"
log "==> current -> $(readlink "$BUNDLE_HOME/current")"
log "==> built from commit: $BUILT_FROM_COMMIT ($BUILT_FROM_REF)"
log ""
log "Older bundles are left in place on purpose. Remove them by hand if disk"
log "matters; this script never deletes."
