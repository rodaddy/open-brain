#!/usr/bin/env zsh
emulate -L zsh
set -euo pipefail

mode="${1:-artifact-only}"
script_dir="${0:A:h}"
repo_root="${script_dir:h}"
plan="${script_dir}/plan-3f-gbrain-sprint.html"
asset_dir="${script_dir}/plan-3f-gbrain-sprint"
site_plan="/Volumes/collab/sites/open-brain/plans/plan-3f-gbrain-sprint.html"
site_asset_dir="/Volumes/collab/sites/open-brain/plans/plan-3f-gbrain-sprint"

failures=0

pass() {
  print "PASS $1"
}

fail() {
  print "FAIL $1"
  failures=$((failures + 1))
}

check() {
  local label="$1"
  shift
  if "$@"; then
    pass "$label"
  else
    fail "$label"
  fi
}

check_absent() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  if grep -q "$pattern" "$file"; then
    fail "$label"
  else
    pass "$label"
  fi
}

cd "$repo_root"

check "repo plan html exists" test -f "$plan"
check "hero image exists" test -f "${asset_dir}/hero.png"
check "favicon source exists" test -f "${asset_dir}/favicon.png"
check "favicon 64 exists" test -f "${asset_dir}/favicon-64.png"
check "apple touch icon exists" test -f "${asset_dir}/apple-touch-icon.png"
check "favicon is baked in as data uri" grep -q "data:image/png;base64," "$plan"
check "hero is referenced from plan" grep -q 'src="plan-3f-gbrain-sprint/hero.png"' "$plan"
check "finished site html exists" test -f "$site_plan"
check "finished hero exists" test -f "${site_asset_dir}/hero.png"
check "finished favicon source exists" test -f "${site_asset_dir}/favicon.png"
check "finished favicon 64 exists" test -f "${site_asset_dir}/favicon-64.png"
check "finished apple touch icon exists" test -f "${site_asset_dir}/apple-touch-icon.png"
check "finished site html matches repo source" cmp -s "$plan" "$site_plan"
check "finished hero matches repo source" cmp -s "${asset_dir}/hero.png" "${site_asset_dir}/hero.png"
check "finished favicon source matches repo source" cmp -s "${asset_dir}/favicon.png" "${site_asset_dir}/favicon.png"
check "finished favicon 64 matches repo source" cmp -s "${asset_dir}/favicon-64.png" "${site_asset_dir}/favicon-64.png"
check "finished apple touch icon matches repo source" cmp -s "${asset_dir}/apple-touch-icon.png" "${site_asset_dir}/apple-touch-icon.png"
check_absent "no unexpanded template tokens in html" "{{" "$plan"
check_absent "no favicon placeholder remains" "__FAVICON_DATA_URI__" "$plan"

if [[ "$mode" == "--artifact-only" || "$mode" == "artifact-only" ]]; then
  if (( failures > 0 )); then
    print "Artifact verification failed with ${failures} failure(s)."
    exit 1
  fi
  print "Artifact verification passed."
  exit 0
fi

check "#223 remains open" zsh -c 'test "$(gh issue view 223 --repo rodaddy/open-brain --json state --jq .state)" = "OPEN"'
check "#265 remains open while sprint runs" zsh -c 'test "$(gh issue view 265 --repo rodaddy/open-brain --json state --jq .state)" = "OPEN"'
check "#266 relational retrieval eval tests pass" bun test src/tools/__tests__/search-brain-relational-retrieval.test.ts
check "#267 graph arm tests pass" bun test tests/search-brain-graph-arm.test.ts
check "#269 audit log tests pass" bun test tests/tool-audit-log.test.ts
check "#270 doctor status tests pass" bun test tests/doctor-status.test.ts
check "#268 answer/search evidence tests pass" bun test tests/brain-answer-graph-evidence.test.ts tests/search-all-graph-evidence.test.ts
check "#271 context pack hot memory tests pass" bun test tests/agent-context-pack-hot-memory.test.ts tests/agent-context-pack-scope.test.ts
check "typescript compiles" bunx tsc --noEmit
check "full bun suite passes" bun test

if (( failures > 0 )); then
  print "Full sprint verification failed with ${failures} failure(s)."
  exit 1
fi

print "Full sprint verification passed."
