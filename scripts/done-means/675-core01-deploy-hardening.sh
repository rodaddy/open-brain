#!/usr/bin/env bash
# DONE-MEANS check for issue #675 (cutover-blocker B5) — "core01 deploy has no
# revision proof, no feature signal, tars the working tree, unversioned plist".
#
#   bash scripts/done-means/675-core01-deploy-hardening.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------
# scripts/core01-deploy-local.sh's ONLY post-restart assertion is
# wait_for_health() (10x2s = 20s poll of the :3100 aggregate FRONT). That is
# the exact 2026-08-02 failure the local clone was hardened against and which
# scripts/local-clone-deploy.sh:22-27 says outright core01 still lacks:
#
#   a new process throws on config and dies -> launchd holds it down for
#   ThrottleInterval (30s, LONGER than the 20s poll) -> `curl /health` is
#   answered by the process that never stopped -> the deploy exits 0.
#
# And scripts/core01-package-runtime.sh:11-28 tars $REPO_DIR — the WORKING
# TREE — so a dirty file on the runner ships to production. The ref gate
# (verify_deploy_ref) only asserts a git-history property (HEAD is an ancestor
# of origin/main) and is a no-op outside CI, so it is silent on the working
# tree in every operator-run deploy.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (round 12 / round 23)
# ---------------------------------------------------------------------------
# The subject under test is a set of SCRIPTS plus a plist template, so "which
# copy executes" is the whole question. REPO_ROOT is resolved from THIS FILE'S
# own location (BASH_SOURCE), and every asserted artifact is read from that
# root. Running this file from the lane worktree tests the lane worktree's
# scripts; running it from the primary checkout tests that one. It structurally
# cannot reach across trees.
#
# ---------------------------------------------------------------------------
# WHAT THE SIMULATION IS, AND WHAT IT IS NOT
# ---------------------------------------------------------------------------
# core01 (10.71.1.21) is NEVER contacted — not by this check, not by anything
# in this lane (hard rule; two-host rule in AGENTS.md). The deploy is simulated
# entirely locally:
#
#   * a throwaway git repo under _scratch/ is the "repo",
#   * a directory under _scratch/ is the "runtime",
#   * a fake `launchctl` on PATH is the "service manager". It starts, or
#     deliberately fails to start, a trivial bun HTTP listener that serves
#     /health out of the runtime directory. That listener is what `lsof` sees.
#   * ports come from the repo-standard 7100-7199 development range.
#
# So the revision proof runs against REAL processes, REAL sockets, and a REAL
# lsof — only the supervisor and the app are stand-ins. That is the highest
# fidelity available without a second machine, and the two failure modes the
# proof exists to catch (new process dies; old process still answers) are
# reproduced literally rather than mocked.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) COMMIT, NOT WORKING TREE. A dirty edit in the repo's working tree must
#       NOT appear in the staged runtime. Pre-fix this fails: `tar -C $REPO_DIR`
#       copies whatever is on disk. This is asserted on file CONTENT, not on
#       the presence of a `git archive` string in the source — a source grep
#       would pass for a script that mentions git archive and still tars.
#
#   (b) DIRTY TREE IS ANNOUNCED. Not shipping the dirty file is correct; doing
#       it silently is the adjusted-silently defect (AGENTS.md, 2026-08-08).
#       The run must SAY the working tree was dirty and that those paths are
#       not deployed. Asserted on the deploy's own announce marker, never on
#       incidental prose (round 23: an announce-assertion anchored on prose the
#       failure mode also emits can go green off the subject's own error text).
#
#   (c) REVISION PROOF FIRES ON A DEAD NEW PROCESS — the 2026-08-02 shape.
#       The service is made to fail to start while the PREVIOUS process keeps
#       holding the port and answering /health. The deploy must FAIL (non-zero)
#       and must name the revision proof as the reason. THIS IS THE RED THAT
#       MATTERS: pre-fix the deploy exits 0 here, because /health is green.
#
#   (d) REVISION PROOF FIRES WHEN THE OLD PROCESS NEVER LET GO. Same port,
#       same pid, still healthy, nothing restarted. Distinct from (c): in (c)
#       nothing new ever bound; here the pid is unchanged, which is the
#       assertion `pid != previous_pid` owns. Split deliberately — one clause
#       covering both passes for the wrong reason if only one branch works.
#
#   (e) CONTROL — A GOOD DEPLOY STILL PASSES. A new process really binds the
#       port, out of the runtime dir, stamped with the shipped sha. The deploy
#       must exit 0 and log the revision proof PASS. Without this clause a
#       deploy hardened into always-fail would satisfy (c) and (d). This clause
#       PASSES PRE-FIX (round 13: a control that passes pre-fix is the signal
#       the check discriminates rather than failing everywhere).
#
#   (f) FEATURE SIGNAL, NOT JUST REVISION (round 18). A revision proof is not a
#       feature-live proof: the #659 clone redeploy passed its revision proof
#       at the right SHA while the merged feature stayed dark. The deploy must
#       assert a NAMED feature key is live in the served /health body, and must
#       FAIL when that key is absent even though the revision proof passes and
#       /health returns 200. Both directions asserted here: absent -> non-zero
#       + the feature named in the failure; present -> exit 0.
#
#   (g) EACH WORKER PORT IS CHECKED DIRECTLY. core01 runs two workers behind
#       the :3100 front, and `wait_for_health` on the front reads green while a
#       worker is dead (the front aggregates). A dead individual worker port
#       must fail the deploy and the failure must name that port.
#
#   (h) THE PLIST IS IN THE REPO AND SHIPS THE RULED ENTRYPOINT. B2, plus the
#       B1 operator ruling (issue #674 comment, 2026-08-09): core01 cuts over
#       to server/main.ts. Asserted: a com.rico.open-brain plist template
#       exists under docs/deploy/ (the NATS-worker precedent), it names
#       server/main.ts, it carries an explicit ThrottleInterval (the proof's
#       poll window has to outlast it, so an unversioned value is exactly what
#       B3 could not reason about), and src/ is NOT deleted from the tree —
#       the ruling keeps it as rollback.
#
#   (i) THE OPERATOR ENV FILE IS BACKED UP BEFORE IT IS REWRITTEN (SHOULD-FIX
#       5). The in-place `perl -pi` on the file holding every AUTH_TOKEN_* is
#       unbacked-up; a mid-write failure truncates it and .previous covers only
#       the runtime. Asserted: after a run that rewrites QMD_PATH, a backup
#       exists containing the ORIGINAL contents, and the rewrite is announced.
#
# Exit 0 only if every clause passes.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="675-$(date -u +%Y%m%dT%H%M%SZ)-$$"
SCRATCH="${REPO_ROOT}/_scratch/675-core01-deploy-hardening/${RUN_ID}"
DEPLOY_SCRIPT="${REPO_ROOT}/scripts/core01-deploy-local.sh"
PACKAGE_SCRIPT="${REPO_ROOT}/scripts/core01-package-runtime.sh"
PLIST_TEMPLATE="${REPO_ROOT}/docs/deploy/com.rico.open-brain.plist.template"

# Development-range ports (AGENTS.md: 7100-7199 for local dev servers).
FRONT_PORT="${OB675_FRONT_PORT:-7171}"
WORKER1_PORT="${OB675_WORKER1_PORT:-7172}"
WORKER2_PORT="${OB675_WORKER2_PORT:-7173}"

BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"

PASS=0
FAIL=0

pass() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
info() { printf '        %s\n' "$1"; }
clause() { printf '\n[%s] %s\n' "$1" "$2"; }

if [[ -z "$BUN_BIN" ]]; then
  echo "FATAL: bun not found; this check drives the real deploy script" >&2
  exit 2
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "FATAL: lsof not found; the revision proof is built on it" >&2
  exit 2
fi

mkdir -p "$SCRATCH"

# ---------------------------------------------------------------------------
# Fixture: a throwaway git repo standing in for the deploy source.
# ---------------------------------------------------------------------------
# Isolated git env so the operator's global config, hooks, and templates cannot
# reach in. Mirrors scripts/core01-deploy-local.integration.test.ts.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="${SCRATCH}/gitconfig"
: > "$GIT_CONFIG_GLOBAL"

FIXTURE_REPO="${SCRATCH}/repo"
RUNTIME_DIR="${SCRATCH}/runtime"
FAKE_BIN="${SCRATCH}/bin"
SERVICE_STATE="${SCRATCH}/service-state"
mkdir -p "$FIXTURE_REPO" "$FAKE_BIN" "$SERVICE_STATE"

git -C "$FIXTURE_REPO" init --quiet -b main
git -C "$FIXTURE_REPO" config user.name "done-means 675"
git -C "$FIXTURE_REPO" config user.email "done-means-675@example.invalid"

mkdir -p "$FIXTURE_REPO/scripts" "$FIXTURE_REPO/src" "$FIXTURE_REPO/server" \
  "$FIXTURE_REPO/src/tools/__tests__"

# The deploy runs a post-health smoke test at this exact path
# (scripts/core01-deploy-local.sh: `bun test src/tools/__tests__/search-all.test.ts`).
# The fixture carries a trivial file THERE rather than the check inventing an
# env escape hatch in the shipped script: the smoke step is part of the deploy
# contract, and a check that switches it off is testing a deploy nobody runs.
cat > "$FIXTURE_REPO/src/tools/__tests__/search-all.test.ts" <<'SMOKE'
import { expect, test } from "bun:test";
// Fixture stand-in for the real post-health smoke test. Its only job is to
// exist at the path the deploy invokes and to pass.
test("fixture smoke", () => {
  expect(true).toBe(true);
});
SMOKE

# The fixture "app". It is what the fake launchctl starts, and it is what
# `lsof` will see holding the port. It serves /health out of the runtime dir it
# is started in, so the revision proof's cwd assertion has something real to
# read, and it publishes a feature block whose presence is switchable.
cat > "$FIXTURE_REPO/server/main.ts" <<'APP'
// Fixture stand-in for the real server/main.ts. Serves /health only.
const port = parseInt(process.env.PORT ?? "0", 10);
const featureLive = process.env.OB675_FEATURE_LIVE !== "0";
const body: Record<string, unknown> = { status: "healthy", port };
if (featureLive) {
  body.capture_health = { status: "ok", observed_at: new Date().toISOString() };
}
Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json(body);
    return new Response("not found", { status: 404 });
  },
});
console.log(`fixture app listening on :${port}`);
APP

# src/ exists so clause (h) can assert the B1 ruling kept it as rollback.
printf '// fixture legacy entrypoint (rollback tree)\n' > "$FIXTURE_REPO/src/index.ts"

cp "$PACKAGE_SCRIPT" "$FIXTURE_REPO/scripts/core01-package-runtime.sh"
chmod +x "$FIXTURE_REPO/scripts/core01-package-runtime.sh"
# scripts/deploy-lock.ts arrived on main with #677/#690 (backup/deploy overlap
# guard) after this check was written, and core01-deploy-local.sh now holds that
# lock for the whole deploy, resolving it as "$REPO_DIR/scripts/deploy-lock.ts".
# Without it in the fixture repo every clause failed identically at "could not
# acquire the openbrain-deploy lock ... Module not found" — including the (e)
# CONTROL clause whose entire job is to prove a good deploy still passes.
#
# Stubbed rather than copied, deliberately and announced: the real lock takes a
# Postgres advisory lock (`createPool` from src/db/pool.ts), and this fixture is
# hermetic by design — no database, no network, no core01. Copying the shipped
# file only moved the failure from "Module not found" to "Cannot find module
# '../src/db/pool.ts'". Whether the advisory lock genuinely serialises backup
# against deploy is #677/#690's own done-means check to prove, not this one's;
# what THIS check needs from the lock is only its observable contract with the
# deploy script, which is the two lines below: print READY on --hold, then hold
# until killed (scripts/deploy-lock.ts:185-188). The deploy waits for `^READY$`
# and kills the child on EXIT, so a stub that honours those two facts exercises
# the same code path in core01-deploy-local.sh that production takes.
cat > "$FIXTURE_REPO/scripts/deploy-lock.ts" <<'LOCK'
// FIXTURE STUB — not the shipped scripts/deploy-lock.ts.
// Mirrors only the observable contract core01-deploy-local.sh depends on:
// `--hold` prints READY and then holds until the parent kills it. The real
// implementation takes a Postgres advisory lock; this fixture has no database
// on purpose, and #677/#690 owns proving the lock itself works.
if (import.meta.main) {
  console.log("READY");
  await new Promise<void>(() => {});
}
LOCK
# The deploy runs `bun install --frozen-lockfile` in staging; a package.json
# with no dependencies and a matching lockfile keeps that step honest and fast.
cat > "$FIXTURE_REPO/package.json" <<'PKG'
{ "name": "ob675-fixture", "private": true, "scripts": { "migrate": "true" } }
PKG

git -C "$FIXTURE_REPO" add -A
git -C "$FIXTURE_REPO" commit --quiet -m "fixture: committed revision"
COMMIT_SHA="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
COMMIT_SHORT="$(git -C "$FIXTURE_REPO" rev-parse --short HEAD)"

# THE DIRTY FILE. Committed content says COMMITTED; the working tree says
# DIRTY. Clause (a) reads the staged runtime and must find the committed one.
printf 'DIRTY_WORKING_TREE_MARKER_675\n' > "$FIXTURE_REPO/dirty-marker.txt"
printf '// UNCOMMITTED_EDIT_675\n' >> "$FIXTURE_REPO/src/index.ts"

# ---------------------------------------------------------------------------
# The fake service manager.
# ---------------------------------------------------------------------------
# `launchctl kickstart -k gui/<uid>/<label>` is what the deploy calls. This
# stand-in reads OB675_SERVICE_MODE to decide what happens:
#
#   start      — start the fixture app on each worker port + the front port,
#                out of the RUNTIME dir (the post-swap tree).
#   dead       — do nothing at all. Whatever was already listening keeps
#                listening. This is the 2026-08-02 shape (clause c).
#   noop       — same as dead, used by clause (d) where a pre-existing process
#                is deliberately left holding the port.
#   worker-down— start the front and worker 1 only; worker 2 never comes up,
#                while the front still answers 200 (clause g).
#
# OB675_FEATURE_LIVE=0 starts the app with its feature block absent (clause f).
cat > "${FAKE_BIN}/launchctl" <<LAUNCHCTL
#!/usr/bin/env bash
set -uo pipefail
MODE="\${OB675_SERVICE_MODE:-start}"
STATE="${SERVICE_STATE}"
RUNTIME="${RUNTIME_DIR}"
BUN="${BUN_BIN}"
FRONT="${FRONT_PORT}"
W1="${WORKER1_PORT}"
W2="${WORKER2_PORT}"

if [[ "\${1:-}" != "kickstart" ]]; then
  exit 0
fi

start_one() {
  local port="\$1" feature="\$2"
  ( cd "\$RUNTIME" && PORT="\$port" OB675_FEATURE_LIVE="\$feature" \\
      "\$BUN" run server/main.ts >>"\${STATE}/app-\${port}.log" 2>&1 &
    echo \$! > "\${STATE}/pid-\${port}" )
}

case "\$MODE" in
  start)
    start_one "\$W1" "\${OB675_FEATURE_LIVE:-1}"
    start_one "\$W2" "\${OB675_FEATURE_LIVE:-1}"
    start_one "\$FRONT" "\${OB675_FEATURE_LIVE:-1}"
    ;;
  worker-down)
    start_one "\$W1" "\${OB675_FEATURE_LIVE:-1}"
    start_one "\$FRONT" "\${OB675_FEATURE_LIVE:-1}"
    ;;
  dead|noop)
    : # the new process never starts; whatever holds the port keeps holding it
    ;;
esac
exit 0
LAUNCHCTL
chmod +x "${FAKE_BIN}/launchctl"

# ---------------------------------------------------------------------------
# Process bookkeeping. Every listener this check starts is recorded so teardown
# can stop exactly those and nothing else.
# ---------------------------------------------------------------------------
STARTED_PIDS=()

listening_pid_on() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

start_standin_listener() {
  # A listener standing in for the PREVIOUS (pre-deploy) process. Started out
  # of a directory that is NOT the runtime, and stamped with a DIFFERENT
  # revision, so it is the old process in every dimension the proof reads.
  local port="$1" dir="$2"
  mkdir -p "$dir"
  cp "$FIXTURE_REPO/server/main.ts" "${dir}/main.ts" 2>/dev/null || true
  ( cd "$dir" && PORT="$port" "$BUN_BIN" run main.ts >>"${SERVICE_STATE}/standin-${port}.log" 2>&1 &
    echo $! > "${SERVICE_STATE}/standin-pid-${port}" )
  sleep 1
  local pid
  pid="$(cat "${SERVICE_STATE}/standin-pid-${port}" 2>/dev/null || true)"
  [[ -n "$pid" ]] && STARTED_PIDS+=("$pid")
  # The bun wrapper may fork; record the actual listener too.
  local lpid
  lpid="$(listening_pid_on "$port")"
  [[ -n "$lpid" ]] && STARTED_PIDS+=("$lpid")
}

collect_started_pids() {
  local port pid
  for port in "$FRONT_PORT" "$WORKER1_PORT" "$WORKER2_PORT"; do
    pid="$(listening_pid_on "$port")"
    [[ -n "$pid" ]] && STARTED_PIDS+=("$pid")
    if [[ -r "${SERVICE_STATE}/pid-${port}" ]]; then
      pid="$(cat "${SERVICE_STATE}/pid-${port}")"
      [[ -n "$pid" ]] && STARTED_PIDS+=("$pid")
    fi
  done
}

stop_all_listeners() {
  collect_started_pids
  local pid
  for pid in "${STARTED_PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
  done
  # Anything still bound to one of OUR three ports, by port — never by name.
  local port
  for port in "$FRONT_PORT" "$WORKER1_PORT" "$WORKER2_PORT"; do
    pid="$(listening_pid_on "$port")"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  sleep 1
}

require_ports_free() {
  local port pid busy=0
  for port in "$FRONT_PORT" "$WORKER1_PORT" "$WORKER2_PORT"; do
    pid="$(listening_pid_on "$port")"
    if [[ -n "$pid" ]]; then
      echo "FATAL: port ${port} is already in use by pid ${pid}; pick other OB675_*_PORT values" >&2
      busy=1
    fi
  done
  [[ "$busy" -eq 0 ]] || exit 2
}

reset_runtime() {
  # No rm, ever (AGENTS.md, unconditional). Retire by moving aside.
  local retired="${SCRATCH}/retired/$(date -u +%s)-$RANDOM"
  mkdir -p "${SCRATCH}/retired"
  for d in "$RUNTIME_DIR" "${RUNTIME_DIR}.next" "${RUNTIME_DIR}.previous"; do
    [[ -e "$d" ]] && mv "$d" "${retired}-$(basename "$d")" 2>/dev/null || true
  done
}

# Run the real deploy script against the fixture. Returns its exit code in
# DEPLOY_EXIT and its combined output in DEPLOY_OUT (via a file — piping
# through tee masks the exit code, round 19).
DEPLOY_EXIT=0
DEPLOY_OUT=""
run_deploy() {
  local label="$1"; shift
  local logfile="${SCRATCH}/deploy-${label}.log"
  local envfile="${SCRATCH}/env-${label}"

  cat > "$envfile" <<ENVEOF
PORT=${FRONT_PORT}
DB_NAME=ob675_fixture_not_used
QMD_PATH=/fixture/old/qmd/path.ts
AUTH_TOKEN_ADMIN=fixture-only-not-a-real-token-675
ENVEOF
  LAST_ENV_FILE="$envfile"

  PATH="${FAKE_BIN}:${PATH}" \
  REPO_DIR="$FIXTURE_REPO" \
  RUNTIME_DIR="$RUNTIME_DIR" \
  ENV_FILE="$envfile" \
  SERVICE_LABEL="gui/$(id -u)/com.rico.open-brain-ob675-fixture" \
  NATS_WORKER_LABEL="gui/$(id -u)/com.rico.open-brain-ob675-fixture-nats" \
  BUN_BIN="$BUN_BIN" \
  QMD_PATH_VALUE="/fixture/new/qmd/path.ts" \
  OPEN_BRAIN_PUBLIC_PORT="$FRONT_PORT" \
  OPEN_BRAIN_WORKER_PORTS="${WORKER1_PORT},${WORKER2_PORT}" \
  OPENBRAIN_DEPLOY_HEALTH_FEATURE_KEY="capture_health" \
  "$@" \
    bash "$DEPLOY_SCRIPT" >"$logfile" 2>&1
  DEPLOY_EXIT=$?
  DEPLOY_OUT="$(cat "$logfile")"
  return 0
}

require_ports_free
trap 'stop_all_listeners' EXIT

echo "================================================================"
echo "DONE-MEANS 675 — core01 deploy hardening"
echo "  repo root:  ${REPO_ROOT}"
echo "  scratch:    ${SCRATCH}"
echo "  fixture sha:${COMMIT_SHORT}"
echo "  ports:      front ${FRONT_PORT}, workers ${WORKER1_PORT}/${WORKER2_PORT}"
echo "  core01:     NOT CONTACTED (two-host rule); this is a local simulation"
echo "================================================================"

# ===========================================================================
# (a) + (b) + (e) + (i): the HAPPY-PATH deploy.
# ===========================================================================
reset_runtime
OB675_SERVICE_MODE=start run_deploy "happy" env OB675_SERVICE_MODE=start
collect_started_pids

clause a "COMMIT, NOT WORKING TREE — the dirty file must not reach the runtime"
if [[ -e "${RUNTIME_DIR}/dirty-marker.txt" ]]; then
  fail "dirty-marker.txt IS present in ${RUNTIME_DIR} — the working tree shipped"
elif [[ ! -d "$RUNTIME_DIR" ]]; then
  fail "no runtime directory at ${RUNTIME_DIR}; deploy exit ${DEPLOY_EXIT}"
  info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -5 | tr '\n' ' ')"
else
  if grep -q "UNCOMMITTED_EDIT_675" "${RUNTIME_DIR}/src/index.ts" 2>/dev/null; then
    fail "src/index.ts in the runtime carries the UNCOMMITTED edit"
  else
    pass "runtime holds the committed revision only (no dirty marker, no uncommitted edit)"
  fi
fi

clause b "DIRTY TREE IS ANNOUNCED — not shipping it silently"
# Anchored on the deploy's OWN marker, not on incidental prose (round 23).
if printf '%s' "$DEPLOY_OUT" | grep -q "NOT deployed"; then
  if printf '%s' "$DEPLOY_OUT" | grep -qi "uncommitted"; then
    pass "the run announces uncommitted paths are NOT deployed"
  else
    fail "'NOT deployed' appears but nothing names uncommitted work"
  fi
else
  fail "the run never announces the dirty working tree"
fi

clause e "CONTROL — a good deploy still passes (must PASS pre-fix too)"
if [[ "$DEPLOY_EXIT" -eq 0 ]]; then
  pass "happy-path deploy exited 0"
else
  fail "happy-path deploy exited ${DEPLOY_EXIT} — the check would prove nothing"
  info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -8 | tr '\n' ' ')"
fi

clause i "OPERATOR ENV FILE BACKED UP BEFORE THE IN-PLACE REWRITE (SHOULD-FIX 5)"
ENV_BACKUP_FOUND=""
for candidate in "${LAST_ENV_FILE}".bak-* "${LAST_ENV_FILE}".backup-*; do
  [[ -e "$candidate" ]] || continue
  ENV_BACKUP_FOUND="$candidate"
  break
done
if [[ -z "$ENV_BACKUP_FOUND" ]]; then
  fail "no backup of the operator env file was written before the QMD_PATH rewrite"
elif ! grep -q "^QMD_PATH=/fixture/old/qmd/path.ts$" "$ENV_BACKUP_FOUND"; then
  fail "backup exists (${ENV_BACKUP_FOUND}) but does not hold the ORIGINAL contents"
elif ! printf '%s' "$DEPLOY_OUT" | grep -qi "backed up"; then
  fail "the env-file backup happened but was not announced (nothing-silent)"
else
  pass "env file backed up with original contents, and the backup is announced"
fi

# ===========================================================================
# (f) FEATURE SIGNAL — revision right, feature dark.
# ===========================================================================
stop_all_listeners
reset_runtime
OB675_SERVICE_MODE=start run_deploy "feature-dark" env OB675_SERVICE_MODE=start OB675_FEATURE_LIVE=0
collect_started_pids

clause f "FEATURE SIGNAL — a revision proof is not a feature-live proof (round 18)"
if [[ "$DEPLOY_EXIT" -eq 0 ]]; then
  fail "deploy exited 0 with the feature key absent from /health — revision-only proof"
elif printf '%s' "$DEPLOY_OUT" | grep -q "capture_health"; then
  pass "deploy FAILED (exit ${DEPLOY_EXIT}) and named the missing feature key"
else
  fail "deploy failed (exit ${DEPLOY_EXIT}) but never named the feature key it wanted"
  info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -8 | tr '\n' ' ')"
fi

# ===========================================================================
# (c) THE 2026-08-02 SHAPE — new process dies, old one answers /health.
# ===========================================================================
stop_all_listeners
reset_runtime
# A previous-generation listener on every port, serving from a NON-runtime dir.
start_standin_listener "$FRONT_PORT"   "${SCRATCH}/old-runtime"
start_standin_listener "$WORKER1_PORT" "${SCRATCH}/old-runtime"
start_standin_listener "$WORKER2_PORT" "${SCRATCH}/old-runtime"
PRE_FRONT_PID="$(listening_pid_on "$FRONT_PORT")"

# Sanity: the old process really is answering, or this clause proves nothing.
if ! curl -fsS --max-time 5 "http://127.0.0.1:${FRONT_PORT}/health" >/dev/null 2>&1; then
  fail "(c) SETUP: the stand-in old process is not answering /health — clause cannot discriminate"
else
  OB675_SERVICE_MODE=dead run_deploy "dead-new-process" env OB675_SERVICE_MODE=dead

  clause c "REVISION PROOF vs a DEAD new process while /health stays green"
  info "pre-deploy listener on :${FRONT_PORT} = pid ${PRE_FRONT_PID:-<none>} (never restarted)"
  if [[ "$DEPLOY_EXIT" -eq 0 ]]; then
    fail "deploy exited 0 — this is the 2026-08-02 false success, unchanged"
  elif printf '%s' "$DEPLOY_OUT" | grep -qi "revision proof"; then
    pass "deploy FAILED (exit ${DEPLOY_EXIT}) and named the revision proof"
  else
    fail "deploy failed (exit ${DEPLOY_EXIT}) but not via the revision proof"
    info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -8 | tr '\n' ' ')"
  fi

  # =========================================================================
  # (d) OLD PROCESS NEVER LET GO — same pid still holding the port.
  # =========================================================================
  clause d "REVISION PROOF vs an UNCHANGED pid still holding the port"
  POST_FRONT_PID="$(listening_pid_on "$FRONT_PORT")"
  if [[ -z "$POST_FRONT_PID" ]]; then
    fail "(d) SETUP: nothing is listening after the run; the unchanged-pid case was not exercised"
  elif [[ "$POST_FRONT_PID" != "$PRE_FRONT_PID" ]]; then
    fail "(d) SETUP: listener pid changed (${PRE_FRONT_PID} -> ${POST_FRONT_PID}); not the unchanged-pid case"
  elif printf '%s' "$DEPLOY_OUT" | grep -qiE "still (held|serving)|never took over|pid .* unchanged|PRE-DEPLOY process"; then
    pass "the unchanged pid ${POST_FRONT_PID} was detected and named as the failure cause"
  else
    fail "pid ${POST_FRONT_PID} was unchanged but the failure does not name it"
    info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -8 | tr '\n' ' ')"
  fi
fi

# ===========================================================================
# (g) PER-WORKER PORT — the front reads green over a dead worker.
# ===========================================================================
stop_all_listeners
reset_runtime
OB675_SERVICE_MODE=worker-down run_deploy "worker-down" env OB675_SERVICE_MODE=worker-down
collect_started_pids

clause g "EACH WORKER PORT CHECKED DIRECTLY — a dead worker behind a green front"
FRONT_OK=1
curl -fsS --max-time 5 "http://127.0.0.1:${FRONT_PORT}/health" >/dev/null 2>&1 || FRONT_OK=0
W2_PID="$(listening_pid_on "$WORKER2_PORT")"
if [[ "$FRONT_OK" -ne 1 ]]; then
  fail "(g) SETUP: the front is not answering, so this is not the front-green case"
elif [[ -n "$W2_PID" ]]; then
  fail "(g) SETUP: worker port ${WORKER2_PORT} is up (pid ${W2_PID}); the dead-worker case was not created"
elif [[ "$DEPLOY_EXIT" -eq 0 ]]; then
  fail "deploy exited 0 with worker port ${WORKER2_PORT} dead behind a healthy front"
elif printf '%s' "$DEPLOY_OUT" | grep -q "${WORKER2_PORT}"; then
  pass "deploy FAILED (exit ${DEPLOY_EXIT}) and named the dead worker port ${WORKER2_PORT}"
else
  fail "deploy failed (exit ${DEPLOY_EXIT}) but never named worker port ${WORKER2_PORT}"
  info "deploy tail: $(printf '%s' "$DEPLOY_OUT" | tail -8 | tr '\n' ' ')"
fi

stop_all_listeners

# ===========================================================================
# (h) THE PLIST IS VERSIONED AND SHIPS THE RULED ENTRYPOINT.
# ===========================================================================
clause h "PLIST IN THE REPO, server/main.ts entrypoint (B1 ruling), explicit ThrottleInterval"
if [[ ! -r "$PLIST_TEMPLATE" ]]; then
  fail "no plist template at docs/deploy/com.rico.open-brain.plist.template"
else
  plist_ok=1
  if ! grep -q "com.rico.open-brain" "$PLIST_TEMPLATE"; then
    fail "plist does not carry the com.rico.open-brain label"; plist_ok=0
  fi
  if ! grep -q "server/main.ts" "$PLIST_TEMPLATE"; then
    fail "plist does not ship server/main.ts (B1 ruling, issue #674 comment)"; plist_ok=0
  fi
  if ! grep -q "ThrottleInterval" "$PLIST_TEMPLATE"; then
    fail "plist carries no explicit ThrottleInterval — the value the revision proof's poll must outlast"; plist_ok=0
  fi
  if ! plutil -lint "$PLIST_TEMPLATE" >/dev/null 2>&1; then
    fail "plist template does not parse (plutil -lint)"; plist_ok=0
  fi
  if [[ ! -f "${REPO_ROOT}/src/index.ts" ]]; then
    fail "src/index.ts is gone — the B1 ruling keeps src/ as rollback"; plist_ok=0
  fi
  [[ "$plist_ok" -eq 1 ]] && pass "plist template versioned, parses, ships server/main.ts, names ThrottleInterval; src/ retained"
fi

# ===========================================================================
echo
echo "================================================================"
echo "  PASS: ${PASS}   FAIL: ${FAIL}"
echo "  scratch retained at: ${SCRATCH}"
echo "================================================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
