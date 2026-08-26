#!/usr/bin/env bash
# DONE-MEANS check for #750 lane L2a (_plans/server-hardening-ladder.md, rung
# L2 "Composition root").
#
#   bash scripts/done-means/750-l2a-config-covers-every-env-read.sh
#
# ---------------------------------------------------------------------------
# What this asserts
# ---------------------------------------------------------------------------
# `_plans/463-server-rewrite-charter.md:108` gives `server/config/` ownership of
# ALL env parsing and startup validation, and `:119` states that domain code
# must not import `process.env`. The charter is a claim about the SCHEMA's
# coverage, not about who happens to read the variable today: a consumer cannot
# be rewired onto injected config (L2b/L2c) until the field it needs exists in
# the validated schema.
#
# So the invariant this file gates is one-directional and checkable now:
#
#   every env var name read anywhere in non-test `server/` code is declared as
#   a key of `environmentSchema` in `server/config.ts`.
#
# It deliberately does NOT assert the converse (that nothing reads
# `process.env`) — that is the `no-process-env` lint rule L2c installs. Until
# then a name can be both schema-declared and still read directly, which is
# exactly the intermediate state L2a produces on purpose.
#
# ---------------------------------------------------------------------------
# Why main.ts's names are listed literally
# ---------------------------------------------------------------------------
# `server/config.ts` is excluded because it IS the schema — every name in it
# would match itself and the check would pass vacuously. `server/main.ts` is
# excluded from the SCAN because it is the composition root and is allowed to
# read the environment, but its five departures (inventory section B) are the
# ones L2b removes, so they are named here explicitly rather than skipped. A
# name added to main.ts later is caught by the inventory refresh, not by this
# file; that is a known and accepted limit of listing them.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CONFIG=server/config.ts
[[ -f $CONFIG ]] || { echo "FAIL: $CONFIG not found"; exit 1; }

# The schema literal only: from `const environmentSchema` to its `.catchall(`
# terminator. Scanning the whole file would let a name mentioned in a comment,
# in `OPTIONAL_SECRET_KEYS`, or in `buildConfig` satisfy the check without the
# field existing — the exact false green this is here to avoid.
schema_block="$(awk '/^const environmentSchema = z$/{on=1} on{print} on&&/^  \.catchall\(/{exit}' "$CONFIG")"
if [[ -z $schema_block ]]; then
  echo "FAIL: could not locate the environmentSchema literal in $CONFIG"
  exit 1
fi

# Explicit `KEY:` declarations inside that literal. A key must be DECLARED, not
# merely mentioned, so the colon is part of the pattern.
declared="$(printf '%s\n' "$schema_block" | rg -o '^\s{4}([A-Z][A-Z0-9_]+):' -r '$1' | sort -u)"

# The literal may compose a group module with `...extendedEnvironmentFields`,
# which keeps `server/config.ts` inside the 100-code-line-per-function lint
# limit. A spread is a real declaration, so it is FOLLOWED — but only into the
# named sibling module, and only into that module's own object literal. Trusting
# an arbitrary spread would let a name be "declared" by anything the file
# happens to mention, which is the vacuous pass this check exists to prevent.
# NOT named `GROUPS`: that is a bash builtin holding the user's group IDs,
# and assigning it silently yields the numeric group list instead.
GROUPS_FILE=server/config/env-groups.ts
if printf '%s\n' "$schema_block" | rg -q '^\s*\.\.\.extendedEnvironmentFields,$'; then
  [[ -f $GROUPS_FILE ]] || { echo "FAIL: schema spreads extendedEnvironmentFields but $GROUPS_FILE is missing"; exit 1; }
  group_block="$(awk '/^export const extendedEnvironmentFields = \{$/{on=1} on{print} on&&/^\} as const;$/{exit}' "$GROUPS_FILE")"
  [[ -n $group_block ]] || { echo "FAIL: could not locate extendedEnvironmentFields in $GROUPS_FILE"; exit 1; }
  group_declared="$(printf '%s\n' "$group_block" | rg -o '^\s{2}([A-Z][A-Z0-9_]+):' -r '$1' | sort -u)"
  declared="$(printf '%s\n%s\n' "$declared" "$group_declared" | rg -v '^$' | sort -u)"
fi

# Section A: every name read in non-test `server/` code, config.ts and main.ts
# excluded per the header.
scanned="$(rg -oN 'process\.env\.([A-Z0-9_]+)' -r '$1' server --type ts \
  | rg -v '^server/config\.ts:' \
  | rg -v '^server/main\.ts:' \
  | rg -v 'test\.ts:' \
  | sed 's/^.*://' \
  | sort -u)"

# The same scan misses names reached through an exported constant rather than a
# literal member expression (`env[CAPTURE_HEALTH_NAMESPACE_ENV]`), and misses
# names read via an injected `env` parameter whose only production argument is
# `process.env`, and misses `server/tools/shared-namespace.ts`'s `envString`
# family, which indexes `process.env[name]` with a name passed in as data. All
# three are real reads and all are in inventory section A/B, so they are
# enumerated. NATS is absent from this list on purpose: `server/config/nats.ts`
# already parses `OPENBRAIN_TRANSPORT` and every `OPENBRAIN_NATS_*` from the
# environment object the schema's `.catchall` passes it, so those names reach
# `parseNatsConfig` through validated config and are not direct reads.
indirect="SHARED_NAMESPACE_CANONICAL
OPENBRAIN_SHARED_NAMESPACE
SHARED_NAMESPACE_PHYSICAL
SHARED_NAMESPACE_LEGACY
OPENBRAIN_LEGACY_SHARED_NAMESPACE
OPENBRAIN_LEGACY_SHARED_FALLBACK
OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS
OPENBRAIN_CAPTURE_HEALTH_NAMESPACE
OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES
OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS
OPENBRAIN_TRACING_ENDPOINT
OPENBRAIN_TRACING_PUBLIC_KEY
OPENBRAIN_TRACING_SECRET_KEY
OPENBRAIN_TRACING_ENABLED
OPENBRAIN_TRACING_MASKING_ENABLED
QMD_PATH
OPENBRAIN_FTS_CONFIG"

# Section B: main.ts's own direct reads, per the inventory.
main_names="OPENBRAIN_RECOVERY_WAL_PATH
ALLOWED_ORIGINS
PORT
OPEN_BRAIN_BIND_HOST"

required="$(printf '%s\n%s\n%s\n' "$scanned" "$indirect" "$main_names" | rg -v '^$' | sort -u)"

count=0
missing=()
while IFS= read -r name; do
  [[ -n $name ]] || continue
  count=$((count + 1))
  if ! printf '%s\n' "$declared" | rg -q "^${name}$"; then
    missing+=("$name")
  fi
done <<< "$required"

# A scan that found nothing is a broken scan, not a clean repo. `rg` returning
# no matches would otherwise make this exit 0 while examining zero names.
if (( count < 15 )); then
  echo "FAIL: only $count env names collected — the scan is broken, not the repo"
  exit 1
fi

if (( ${#missing[@]} > 0 )); then
  echo "FAIL: $count env names read in server/; ${#missing[@]} are not declared in environmentSchema:"
  printf '  %s\n' "${missing[@]}"
  exit 1
fi

echo "PASS: all $count env names read in server/ are declared in environmentSchema ($CONFIG)"
