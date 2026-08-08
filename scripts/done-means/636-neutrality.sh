#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
allowlist_file="$repo_root/scripts/done-means/636-neutrality.allowlist"
self_path="scripts/done-means/636-neutrality.sh"
allowlist_path="scripts/done-means/636-neutrality.allowlist"
pattern='10\.71\.[0-9]{1,3}\.[0-9]{1,3}|core01|rodaddy\.live|/Volumes/ThunderBolt'

cd "$repo_root"

if [[ ! -f "$allowlist_file" ]]; then
  printf 'neutrality check failed: missing allowlist %s\n' "$allowlist_path" >&2
  exit 1
fi

mapfile -t allowed_patterns < "$allowlist_file"
violations=()

while IFS= read -r path; do
  [[ "$path" == "$self_path" || "$path" == "$allowlist_path" ]] && continue

  allowed=false
  for allowed_pattern in "${allowed_patterns[@]}"; do
    [[ -z "$allowed_pattern" || "$allowed_pattern" == \#* ]] && continue
    if [[ "$path" == $allowed_pattern ]]; then
      allowed=true
      break
    fi
  done

  if [[ "$allowed" == false ]]; then
    violations+=("$path")
  fi
done < <(git grep -IlE "$pattern" -- . | LC_ALL=C sort)

if (( ${#violations[@]} > 0 )); then
  printf 'neutrality check failed: environment-specific values remain outside the explicit allowlist:\n' >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

printf 'neutrality check passed: no environment-specific values outside the explicit allowlist\n'
