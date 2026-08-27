#!/usr/bin/env bash
# brief-pack: assemble a bounded lane brief from a task, the lane contract,
# a done-means check, and optional decisions/loop-policy inputs.
#
# Ranked inclusion, explicit exclusion list, fail-closed budget: over budget it
# REFUSES (exit 1) and writes nothing rather than truncating a section.
#
# Exit grammar (see scripts/done-means/README.md):
#   0  under budget, brief printed
#   1  OVER BUDGET (report on stderr, no --out file written)
#   3  harness error - missing/unreadable input, no node, no "## Tightenings"
set -u

here=$(cd "$(dirname "$0")" && pwd)

node_bin=""
if [ -n "${NODE_BIN:-}" ]; then
  node_bin="$NODE_BIN"
elif [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  node_bin=/opt/homebrew/opt/node@24/bin/node
elif command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
fi
if [ -z "$node_bin" ]; then
  echo "HARNESS ERROR: no node 24 binary (NODE_BIN, /opt/homebrew/opt/node@24/bin/node, PATH)" >&2
  exit 3
fi

exec "$node_bin" "$here/lib/brief-pack.ts" "$@"
