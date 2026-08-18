#!/usr/bin/env bash
# Stage a COMMITTED revision of this repo into a staging directory for the
# core01 deploy.
#
# Until 2026-08-09 this tarred $REPO_DIR — the WORKING TREE — so any dirty file
# on the runner shipped to production. The ref gate in the calling script
# (verify_deploy_ref) does not cover that: it asserts a git-HISTORY property
# (HEAD is an ancestor of origin/main) and is silent on what is actually on
# disk, and it is a no-op entirely outside CI, which is every operator-run
# deploy. Issue #675 (cutover-blocker B5).
#
# `git archive` reads git OBJECT STORAGE, so the working tree is structurally
# invisible rather than merely excluded — the same property that made the local
# clone's staging trustworthy (scripts/local-clone-deploy.sh:16-21, proven
# 2026-07-30). The long --exclude list this replaces was a denylist, and a
# denylist only omits what somebody remembered to name; git archive omits
# everything that is not committed, by construction. Gitignored files (.env and
# friends) do not exist as git objects and therefore cannot travel; the runtime
# gets its configuration from ENV_FILE.
#
# Uncommitted work is REPORTED, never silently dropped. It is correct that it
# does not ship — that is the entire point — but an operator who edited a file
# and expected it to deploy has to be told, not left to discover it later
# (AGENTS.md "nothing is adjusted silently", 2026-08-08).
#
# Usage:
#   scripts/core01-package-runtime.sh <repo-dir> <staging-dir> [ref]
#
# `ref` defaults to HEAD. It is resolved to a concrete commit BEFORE anything
# is written, so an unknown ref fails here rather than halfway through a swap.
set -euo pipefail

REPO_DIR="$1"
STAGING_DIR="$2"
REF="${3:-HEAD}"

log() { printf '%s core01-package-runtime: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

SHA="$(git -C "$REPO_DIR" rev-parse --verify "${REF}^{commit}" 2>/dev/null)" || {
  echo "FATAL: not a commit: ${REF}" >&2
  exit 1
}
SHORT_SHA="$(git -C "$REPO_DIR" rev-parse --short "$SHA")"
SUBJECT="$(git -C "$REPO_DIR" log -1 --format=%s "$SHA")"

# Announce uncommitted paths. `git status --porcelain` covers staged, unstaged,
# and untracked work — all three are equally invisible to `git archive`, and an
# operator who added a new file is exactly as surprised as one who edited an
# existing one.
DIRTY_COUNT="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${DIRTY_COUNT:-0}" -gt 0 ]]; then
  log "NOTE: ${DIRTY_COUNT} uncommitted path(s) in ${REPO_DIR}; they are NOT deployed"
  git -C "$REPO_DIR" status --porcelain 2>/dev/null | sed 's/^/    /' || true
fi

log "exporting ${SHORT_SHA} (${REF}) to ${STAGING_DIR} — ${SUBJECT}"
git -C "$REPO_DIR" archive "$SHA" | tar -x -C "$STAGING_DIR"

# Stamp the deployed revision so the runtime can be identified without guessing
# from file mtimes, and — since #675 — so the deploy's revision proof has
# something on disk to compare the shipped sha against. Plain key=value, not
# JSON: the commit subject is arbitrary text and hand-escaping it into JSON
# from shell is a bug waiting to happen.
cat > "${STAGING_DIR}/.deployed-revision" <<EOF
sha=${SHA}
short_sha=${SHORT_SHA}
ref=${REF}
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${REPO_DIR}
subject=${SUBJECT}
EOF
