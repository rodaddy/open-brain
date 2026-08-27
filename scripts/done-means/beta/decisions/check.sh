#!/usr/bin/env bash
# Decisions-ledger doctor (graph-mode v1.3-beta).
# Usage: check.sh <decisions.md> [--repo <path>] [--diff-base <ref>] [--section <heading>]
# Exit: 0 pass, 1 a clause failed, 3 harness error.
set -u

LEDGER=""
REPO=""
DIFF_BASE="origin/main"
SECTION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; [ $# -gt 0 ] || { echo "HARNESS ERROR: --repo needs a value"; exit 3; }; REPO="$1" ;;
    --section) shift; [ $# -gt 0 ] || { echo "HARNESS ERROR: --section needs a value"; exit 3; }; SECTION="$1" ;;
    --diff-base) shift; [ $# -gt 0 ] || { echo "HARNESS ERROR: --diff-base needs a value"; exit 3; }; DIFF_BASE="$1" ;;
    -h|--help) echo "usage: check.sh <decisions.md> [--repo <path>] [--diff-base <ref>] [--section <heading>]"; exit 0 ;;
    *) if [ -z "$LEDGER" ]; then LEDGER="$1"; else echo "HARNESS ERROR: unexpected argument $1"; exit 3; fi ;;
  esac
  shift
done

if [ -z "$LEDGER" ]; then
  echo "HARNESS ERROR: no ledger path given"
  exit 3
fi
if [ ! -r "$LEDGER" ]; then
  echo "HARNESS ERROR: ledger unreadable: $LEDGER"
  exit 3
fi

NODE_RESOLVED=""
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN:-}" ]; then
  NODE_RESOLVED="$NODE_BIN"
elif [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  NODE_RESOLVED=/opt/homebrew/opt/node@24/bin/node
elif command -v node >/dev/null 2>&1; then
  NODE_RESOLVED=$(command -v node)
fi
if [ -z "$NODE_RESOLVED" ]; then
  echo "HARNESS ERROR: no node 24 binary found (NODE_BIN, /opt/homebrew/opt/node@24/bin/node, PATH)"
  exit 3
fi

DOCTOR="$(cd "$(dirname "$0")" && pwd)/lib/decisions-doctor.ts"
if [ ! -r "$DOCTOR" ]; then
  echo "HARNESS ERROR: parser missing: $DOCTOR"
  exit 3
fi

# Clause 6 needs git evidence only when some row carries a Retires value.
NEEDS_GIT=0
if awk -F'|' '{ if (NF>=10) { g=$10; gsub(/^[ \t]+|[ \t]+$/,"",g); if (g != "" && g != "Retires" && g !~ /^:?-+:?$/) { found=1 } } } END { exit(found?0:1) }' "$LEDGER"; then
  NEEDS_GIT=1
fi

GIT_OK=0
GIT_JSON="[]"
if [ "$NEEDS_GIT" = "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "HARNESS ERROR: git not available but the ledger has Retires values (clause 6)"
    exit 3
  fi
  if [ -z "$REPO" ]; then
    LEDGER_DIR=$(cd "$(dirname "$LEDGER")" && pwd)
    REPO=$(git -C "$LEDGER_DIR" rev-parse --show-toplevel 2>/dev/null || true)
    if [ -z "$REPO" ]; then
      echo "HARNESS ERROR: ledger is not inside a git repo and no --repo given (clause 6)"
      exit 3
    fi
  fi
  if ! git -C "$REPO" rev-parse --verify --quiet "$DIFF_BASE" >/dev/null 2>&1; then
    echo "HARNESS ERROR: diff base does not resolve in $REPO: $DIFF_BASE"
    exit 3
  fi
  if ! CHANGED=$(git -C "$REPO" diff --name-only "$DIFF_BASE...HEAD" 2>/dev/null); then
    echo "HARNESS ERROR: git diff --name-only $DIFF_BASE...HEAD failed in $REPO"
    exit 3
  fi
  # --untracked-files=all: plain --porcelain collapses an untracked directory
  # to its path, so an exact Retires path inside it would never match.
  DIRTY=$(git -C "$REPO" status --porcelain --untracked-files=all 2>/dev/null | sed 's/^...//' | sed 's/.* -> //')
  GIT_JSON=$(printf '%s\n%s\n' "$CHANGED" "$DIRTY" | awk 'BEGIN{printf "["; n=0} { if ($0=="") next; gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); if (n++) printf ","; printf "\"%s\"", $0 } END{printf "]"}')
  GIT_OK=1
fi

"$NODE_RESOLVED" "$DOCTOR" "$LEDGER" "$GIT_JSON" "$GIT_OK" "$SECTION"
exit $?
