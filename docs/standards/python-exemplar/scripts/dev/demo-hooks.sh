#!/opt/homebrew/bin/bash
# demo-hooks.sh -- prove each hook actually REJECTS the thing it claims to.
#
# A hook that has never been observed failing is not enforcement, it is a file.
# This script injects one violation per check and asserts the hook exits
# non-zero. It also asserts a clean commit SUCCEEDS -- a hook that rejects
# everything is equally useless and much harder to notice.
#
# Runs entirely in the temp workspace: clones this tree there, `git init`s the
# clone, installs the hooks into it. Nothing is written under Development and no
# commit is made in a real repo.

set -uo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"

# DEMO_WORK_ROOT lets CI point this at the runner's temp dir. The default is the
# configured temp workspace on Rico's Mac; /tmp is deliberately NOT used, since
# it is sandbox-local and the artifact would be invisible to whoever is
# debugging a failure.
work_root="${DEMO_WORK_ROOT:-/path/to/open-brain/_tmp/python-exemplar/_validation-runs}"
work="$work_root/hooks-$stamp"

pass=0
fail=0

ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
head_() { printf '\n== %s ==\n' "$1"; }

cleanup() {
  # Leaves the run dir on failure so the output can be inspected; removes it on
  # success. `git worktree` is not involved, this is a plain clone.
  if [[ $fail -eq 0 && -d "$work" ]]; then
    rm -rf "$work"
  else
    printf '\nRun directory kept for inspection:\n  %s\n' "$work"
  fi
}
trap cleanup EXIT

printf 'demo-hooks: proving the hooks in %s\n' "$src/_githooks"
printf 'scratch:    %s\n' "$work"

mkdir -p "$work"
# Copy the tree WITHOUT any .git, so `git init` below owns the result.
(cd "$src" && tar --exclude='.git' --exclude='.venv' --exclude='__pycache__' \
                  --exclude='.mypy_cache' --exclude='.ruff_cache' -cf - .) \
  | (cd "$work" && tar -xf -)

cd "$work" || exit 1

# Install the toolchain BEFORE any commit. The hooks call `uv run --no-sync` so
# that a commit never silently installs packages; that means the environment has
# to exist first. Without this the hooks fail with "Failed to spawn: ruff" and
# every violation test passes for the wrong reason -- blocked, but by a missing
# tool rather than by the check under test.
printf '\n[setup] uv sync --dev (once, so the hooks have their tools)\n'
if ! uv sync --dev >/dev/null 2>&1; then
  printf '  FAILED: uv sync could not build the environment.\n'
  exit 1
fi
printf '  toolchain ready\n'

git init -q
git config user.email "demo@example.invalid"
git config user.name  "Hook Demo"
git config commit.gpgsign false
# Rico's real global core.hooksPath (~/.config/git/hooks, the Gitleaks gate)
# applies to every repo including this scratch clone, and the installer
# correctly refuses to install underneath it. `--unset` does NOT help: it clears
# the repo-local key, and with none set the global still wins. Setting an empty
# repo-local value is what actually overrides it, and it is scoped to this
# throwaway clone.
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
# protected-branch guard that refuses any commit to main -- it fired here and
# blocked the clean-commit cases, which then read as "the hook is over-broad"
# when the hook had never run at all. A demo that cannot tell WHICH gate
# rejected it is not proving anything.
git checkout -qb feat/hook-demo
ok "switched to feat/hook-demo (main is protected by the global hooks)"

# --------------------------------------------------------------------------
# Helper: stage a file, attempt a commit, assert the hook's verdict.
#   assert_blocked <label> <path> <content>
#   assert_passes  <label> <path> <content>
# --------------------------------------------------------------------------
# Captured so an assertion can prove WHICH gate rejected the commit. Any hook
# on the machine can make `git commit` exit non-zero; only output containing our
# own marker proves that OUR hook is what ran.
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
# name the specific check. Otherwise an unrelated global hook (Rico's
# protected-branch guard did exactly this) makes every test read as a pass.
assert_blocked() {
  local label="$1" path="$2" content="$3" marker="${4:-\[pre-commit\]}"
  if attempt "$path" "$content" "test: $label"; then
    bad "$label -- hook ALLOWED it (should have blocked)"
  elif ! grep -qE "$marker" <<< "$last_output"; then
    bad "$label -- blocked, but NOT by this hook (no '$marker' in output)"
    printf '        rejected by: %s\n' "$(head -1 <<< "$last_output")"
  else
    ok "$label -- blocked by pre-commit"
  fi
}

head_ "pre-commit: each check rejects its violation"

assert_blocked "relative import" "src/exemplar/_demo_rel.py" \
'"""Demo module."""

from .config import Settings

__all__ = ["Settings"]
'

assert_blocked "naive datetime" "src/exemplar/_demo_naive.py" \
'"""Demo module."""

from datetime import datetime


def stamp() -> str:
    """Return a timestamp."""
    return datetime.now().isoformat()
'

assert_blocked "nested blocks past the limit" "src/exemplar/_demo_nested.py" \
'"""Demo module."""


def deep(a: int, b: int, c: int, d: int) -> int:
    """Nest deeper than PLR1702 allows."""
    if a:
        if b:
            if c:
                if d:
                    return 1
    return 0
'

assert_blocked "bare except that swallows" "src/exemplar/_demo_swallow.py" \
'"""Demo module."""


def risky() -> None:
    """Swallow every error."""
    try:
        raise ValueError("x")
    except Exception:
        pass
'

assert_blocked "type error under mypy --strict" "src/exemplar/_demo_types.py" \
'"""Demo module."""


def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


result: str = add(1, 2)
'

head_ "pre-commit: a clean file is ALLOWED"
# Guards against the opposite failure: a hook that rejects everything.
if attempt "src/exemplar/_demo_clean.py" \
'"""A module that satisfies every rule."""

from exemplar.utils.datetime_helpers import utc_now


def stamp() -> str:
    """Return an aware UTC timestamp."""
    return utc_now().isoformat()
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
  printf '"""Demo."""\n\nVALUE = 1\n' > "src/exemplar/_demo_msg.py"
  git add "src/exemplar/_demo_msg.py" >/dev/null 2>&1
  last_output="$(git commit -m "$message" 2>&1)"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    git reset -q --soft HEAD~1        # undo it; keep testing from one baseline
  fi
  git reset -q HEAD -- "src/exemplar/_demo_msg.py" >/dev/null 2>&1 || true
  git checkout -q -- "src/exemplar/_demo_msg.py" 2>/dev/null || true
  [[ -f "src/exemplar/_demo_msg.py" ]] && mv "src/exemplar/_demo_msg.py" "src/exemplar/_demo_msg.py.attempted" 2>/dev/null

  if [[ "$want" == block ]]; then
    if [[ $rc -eq 0 ]]; then
      bad "$label -- ALLOWED (should block)"
    elif ! grep -q '\[commit-msg\]' <<< "$last_output"; then
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
git config core.hooksPath /tmp/some-other-hooks
if ./_githooks/install.sh >/dev/null 2>&1; then
  bad "installed anyway despite core.hooksPath (the silent-no-op trap)"
else
  ok "refused to install into a shadowed .git/hooks"
fi
git config --unset core.hooksPath

printf '\n== summary ==\n'
printf '  %d passed, %d failed\n\n' "$pass" "$fail"

if [[ $fail -ne 0 ]]; then
  printf 'THE HOOKS ARE NOT PROVEN. Do not describe them as enforcement.\n\n'
  exit 1
fi

printf 'Every check was observed rejecting its violation, and a clean commit\n'
printf 'was observed passing. The hooks are RUNNING, not merely written.\n\n'
exit 0
