#!/usr/bin/env bash
# demo-hooks.sh -- prove each hook actually REJECTS the thing it claims to.
#
# A hook that has never been observed failing is not enforcement, it is a file.
# This script injects one violation per check and asserts the hook exits
# non-zero. It also asserts a clean commit SUCCEEDS -- a hook that rejects
# everything is equally useless and much harder to notice.
#
# Runs entirely in the temp workspace: copies this tree there, `git init`s the
# copy, installs the hooks into it. Nothing is written under Development and no
# commit is made in a real repo.

set -uo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"

# DEMO_WORK_ROOT lets CI point this at the runner's temp dir. The default is the
# configured temp workspace on Rico's Mac; /tmp is deliberately NOT used, since
# it is sandbox-local and the artifact would be invisible to whoever is
# debugging a failure.
work_root="${DEMO_WORK_ROOT:-/path/to/open-brain/_tmp/typescript-exemplar/_validation-runs}"
work="$work_root/hooks-$stamp"

pass=0
fail=0

ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
head_() { printf '\n== %s ==\n' "$1"; }

cleanup() {
  # ARCHIVE, never delete. The agent policy in AGENTS.md forbids recursive or
  # forced removal anywhere, for any reason -- including a directory this script
  # created itself. Moving costs one rename and leaves the evidence recoverable;
  # the archive is the operator's to empty.
  if [[ $fail -eq 0 && -d "$work" ]]; then
    archive="$work_root/../_archive"
    mkdir -p "$archive"
    mv "$work" "$archive/hooks-$stamp" 2>/dev/null \
      && printf '\nRun archived to:\n  %s/hooks-%s\n' "$archive" "$stamp"
  else
    printf '\nRun directory kept for inspection:\n  %s\n' "$work"
  fi
}
trap cleanup EXIT

printf 'demo-hooks: proving the hooks in %s\n' "$src/_githooks"
printf 'scratch:    %s\n' "$work"

mkdir -p "$work"
# Copy the tree WITHOUT any .git, so `git init` below owns the result, and
# without node_modules (npm install below rebuilds it; copying 100MB of symlinks
# is slower than reinstalling).
(cd "$src" && tar --exclude='.git' --exclude='node_modules' --exclude='data' \
                  --exclude='dist' -cf - .) \
  | (cd "$work" && tar -xf -)

cd "$work" || exit 1

# Install the toolchain BEFORE any commit. The hooks call npx, which resolves
# from node_modules; without it npx either fails or silently downloads a
# different version, and every violation test then passes for the wrong reason
# -- blocked, but by a missing tool rather than by the check under test. The
# Python twin hit exactly this ("Failed to spawn: ruff") on its first run.
printf '\n[setup] npm install (once, so the hooks have their tools)\n'
if ! npm install --silent >/dev/null 2>&1; then
  printf '  FAILED: npm install could not build node_modules.\n'
  exit 1
fi
printf '  toolchain ready\n'

git init -q
git config user.email "demo@example.invalid"
git config user.name  "Hook Demo"
git config commit.gpgsign false
# Rico's real global core.hooksPath (~/.config/git/hooks, the Gitleaks gate)
# applies to every repo including this scratch copy, and the installer correctly
# refuses to install underneath it. `--unset` does NOT help: it clears the
# repo-local key, and with none set the global still wins. Setting an explicit
# repo-local value is what actually overrides it, scoped to this throwaway copy.
git config core.hooksPath "$work/.git/hooks"

head_ "install"
if ./_githooks/install.sh >/dev/null 2>&1; then
  ok "install.sh installed the hooks"
else
  bad "install.sh failed -- everything below is meaningless"
  exit 1
fi

# A baseline commit so later commits have a parent and diffs are meaningful.
git add -A >/dev/null 2>&1
if git commit -qm "chore: baseline for hook demo" --no-verify >/dev/null 2>&1; then
  ok "baseline commit created (--no-verify, intentionally)"
else
  bad "could not create a baseline commit"
  exit 1
fi

# Move OFF main before testing. Rico's machine-wide hooks include a
# protected-branch guard that refuses any commit to main -- it fired in the
# Python twin and blocked the clean-commit cases, which then read as "the hook
# is over-broad" when the hook had never run at all. A demo that cannot tell
# WHICH gate rejected it is not proving anything.
git checkout -qb feat/hook-demo
ok "switched to feat/hook-demo (main is protected by the global hooks)"

# --------------------------------------------------------------------------
# Helper: stage a file, attempt a commit, assert the hook's verdict.
# --------------------------------------------------------------------------
# Captured so an assertion can prove WHICH gate rejected the commit. Any hook on
# the machine can make `git commit` exit non-zero; only output containing our own
# marker proves that OUR hook is what ran.
last_output=""

attempt() {
  local path="$1" content="$2" msg="$3"
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
  git add "$path" >/dev/null 2>&1
  last_output="$(git commit -m "$msg" 2>&1)"
  local rc=$?
  git reset -q HEAD -- "$path" >/dev/null 2>&1 || true
  git checkout -q -- "$path" 2>/dev/null || true
  [[ -f "$path" ]] && mv "$path" "$path.attempted" 2>/dev/null
  return $rc
}

# Blocked is not enough: it must be blocked BY THIS HOOK, and the message must
# name the specific check. Otherwise an unrelated global hook (the
# protected-branch guard did exactly this) makes every test read as a pass.
assert_blocked() {
  local label="$1" path="$2" content="$3" marker="${4:-\[pre-commit\]}"
  if attempt "$path" "$content" "test: $label"; then
    bad "$label -- hook ALLOWED it (should have blocked)"
  elif ! rg -q "$marker" <<< "$last_output"; then
    bad "$label -- blocked, but NOT by this hook (no '$marker' in output)"
    printf '        rejected by: %s\n' "$(head -1 <<< "$last_output")"
  else
    ok "$label -- blocked by pre-commit"
  fi
}

head_ "pre-commit: each check rejects its violation"

assert_blocked "naive Date" "src/exemplar/_demo_naive.ts" \
'/** Demo module. */
export function stamp(): string {
  return new Date().toISOString();
}
'

assert_blocked "nesting past max-depth" "src/exemplar/_demo_nested.ts" \
'/** Demo module. */
export function deep(a: boolean, b: boolean, c: boolean, d: boolean): number {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          return 1;
        }
      }
    }
  }
  return 0;
}
'

assert_blocked "empty catch that swallows" "src/exemplar/_demo_swallow.ts" \
'/** Demo module. */
export function risky(raw: string): void {
  try {
    JSON.parse(raw);
  } catch {}
}
'

assert_blocked "any-typed catch" "src/exemplar/_demo_anycatch.ts" \
'/** Demo module. */
export function handle(raw: string): string {
  try {
    JSON.parse(raw);
    return "ok";
  } catch (error: any) {
    return error.message;
  }
}
'

assert_blocked "console.log outside the logger" "src/exemplar/_demo_console.ts" \
'/** Demo module. */
export function announce(): void {
  console.log("hello");
}
'

assert_blocked "bare TODO with no issue" "src/exemplar/_demo_todo.ts" \
'/** Demo module. */
// TODO fix this later
export const VALUE = 1;
'

assert_blocked "type error under tsc" "src/exemplar/_demo_types.ts" \
'/** Demo module. */
export function add(a: number, b: number): number {
  return a + b;
}

export const result: string = add(1, 2);
'

head_ "pre-commit: a clean file is ALLOWED"
# Guards against the opposite failure: a hook that rejects everything.
if attempt "src/exemplar/_demo_clean.ts" \
'/** A module that satisfies every rule. */
import { iso, utcNow } from "./utils/datetime.ts";

/**
 * Return an aware UTC timestamp.
 *
 * @returns ISO-8601 in UTC.
 */
export function stamp(): string {
  return iso(utcNow());
}
' "test: add a clean demonstration module"; then
  ok "clean file -- allowed"
  git reset -q --soft HEAD~1    # keep the baseline stable for later cases
else
  bad "clean file -- BLOCKED (hook is over-broad)"
  printf '        rejected by: %s\n' "$(head -1 <<< "$last_output")"
  printf '        full output:\n'
  sed 's/^/          /' <<< "$last_output" | head -20
fi

head_ "commit-msg: format is enforced"

msg_case() {
  local label="$1" message="$2" want="$3"   # want = block | pass
  # A valid module, so pre-commit passes and commit-msg is what decides.
  printf '/** Demo. */\nexport const VALUE = 1;\n' > "src/exemplar/_demo_msg.ts"
  git add "src/exemplar/_demo_msg.ts" >/dev/null 2>&1
  last_output="$(git commit -m "$message" 2>&1)"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    git reset -q --soft HEAD~1        # undo it; keep testing from one baseline
  fi
  git reset -q HEAD -- "src/exemplar/_demo_msg.ts" >/dev/null 2>&1 || true
  git checkout -q -- "src/exemplar/_demo_msg.ts" 2>/dev/null || true
  [[ -f "src/exemplar/_demo_msg.ts" ]] && mv "src/exemplar/_demo_msg.ts" "src/exemplar/_demo_msg.ts.attempted" 2>/dev/null

  if [[ "$want" == block ]]; then
    if [[ $rc -eq 0 ]]; then
      bad "$label -- ALLOWED (should block)"
    elif ! rg -q '\[commit-msg\]' <<< "$last_output"; then
      bad "$label -- blocked, but NOT by commit-msg"
      printf '        rejected by: %s\n' "$(head -1 <<< "$last_output")"
    else
      ok "$label -- blocked by commit-msg"
    fi
  else
    if [[ $rc -eq 0 ]]; then
      ok "$label -- allowed"
    else
      bad "$label -- BLOCKED (should pass)"
      printf '        rejected by: %s\n' "$(head -1 <<< "$last_output")"
    fi
  fi
}

msg_case "no type prefix"        "updated some things"                      block
msg_case "past tense"            "feat(demo): added a thing"                block
msg_case "trailing period"       "feat(demo): add a thing."                 block
msg_case "unknown type"          "banana(demo): add a thing"                block
msg_case "conventional subject"  "feat(demo): add a demonstration value"    pass

head_ "install.sh refuses when core.hooksPath would shadow it"
git config core.hooksPath "$work/.some-other-hooks"
if ./_githooks/install.sh >/dev/null 2>&1; then
  bad "installed anyway despite core.hooksPath (the silent-no-op trap)"
else
  ok "refused to install into a shadowed .git/hooks"
fi
git config core.hooksPath "$work/.git/hooks"

printf '\n== summary ==\n'
printf '  %d passed, %d failed\n\n' "$pass" "$fail"

if [[ $fail -ne 0 ]]; then
  printf 'THE HOOKS ARE NOT PROVEN. Do not describe them as enforcement.\n\n'
  exit 1
fi

printf 'Every check was observed rejecting its violation, and a clean commit\n'
printf 'was observed passing. The hooks are RUNNING, not merely written.\n\n'
exit 0
