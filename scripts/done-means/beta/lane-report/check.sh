#!/usr/bin/env bash
# Validate a Development five-field lane report.
# Schema: _DOCS/controller-contract.md "## Lane report schema".
# Exit grammar: 0 pass, 1 the report under test failed, 3 harness error.
set -u

here=$(cd "$(dirname "$0")" && pwd)
lib="$here/lib/lane-report.ts"

if [ ! -f "$lib" ]; then
  echo "HARNESS: missing $lib" >&2
  exit 3
fi

node_bin=""
if [ -n "${NODE_BIN:-}" ]; then
  node_bin="$NODE_BIN"
elif [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  node_bin=/opt/homebrew/opt/node@24/bin/node
elif command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
fi

if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "HARNESS: no usable node 24 binary (NODE_BIN, /opt/homebrew/opt/node@24/bin/node, PATH)" >&2
  exit 3
fi

if [ "$#" -lt 1 ]; then
  echo "HARNESS: usage: check.sh <report-file>" >&2
  exit 3
fi

report="$1"

if [ ! -f "$report" ] || [ ! -r "$report" ]; then
  echo "HARNESS: cannot read report file: $report" >&2
  exit 3
fi

if [ ! -s "$report" ]; then
  echo "HARNESS: report file is zero bytes: $report" >&2
  exit 3
fi

"$node_bin" "$lib" "$report"
exit $?
