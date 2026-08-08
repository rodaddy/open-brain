#!/usr/bin/env bash
# DONE-MEANS check for issue #433, DEFECT 1 ONLY — the acceptance gate, not the fix.
#
#   bash scripts/done-means/433-recall-sees-session-events.sh
#
# Defect 1, verbatim from the issue thread: `brain_answer` structurally cannot
# see `ob_session_events`. Its table list (`ALL_TABLES`, src/tools/
# table-constants.ts) names only thoughts/decisions/relationships/projects/
# sessions, so asking "what happened in the last day" answers from months-old
# thoughts while the session-event corpus — 11,136 rows on the dogfood DB as of
# 2026-08-07, 80 of them from the last 24h — is invisible to recall.
#
# SCOPE. This gate covers recall VISIBILITY only. Defect 2 of the same issue
# ("nothing promotes events into durable tables" — no producer calls
# classifyLaneEvent -> tierLaneEvent -> graduateLaneEvent) is explicitly NOT
# gated here and is not closed by this check passing. Visibility and promotion
# are independent: this asks whether the retrieval path CAN reach the corpus,
# not whether anything copies it elsewhere.
#
# EXPECTED TO FAIL until #433 defect 1 is fixed. It is the reward function, not
# a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Why this drives executeSearch in-process rather than the running service
# ---------------------------------------------------------------------------
# A live service is listening on OPENBRAIN_BASE_URL, but it serves the DEPLOYED
# revision, not this working tree. Probing it would measure whatever is already
# installed, so the check could never go red-then-green on an uncommitted fix —
# it would report the same answer before and after. This script therefore
# imports `executeSearch` from THIS checkout via `bun`, with a real `pg` Pool
# against the dogfood database. That is the same entry point `brain_answer`
# calls (src/tools/brain-answer.ts imports executeSearch from ./search-brain.ts),
# so the retrieval path under test is the real one.
#
# The source list comes from `readableSearchTables(role)` — the one exported
# function brain_answer and search_brain both call — rather than being
# re-derived here. That matters: #433 defect 1 IS a divergence between two
# hand-maintained copies of that list, so a gate holding a third copy could
# pass while the product stayed broken. The probe asks for the `admin` role,
# the most permissive there is; if the marker is invisible to admin it is
# invisible to everyone, and the failure cannot be dismissed as a permissions
# artifact.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 — VISIBILITY. A session event seeded seconds ago, carrying a unique
#   marker token, surfaces from the real search path when queried by that
#   marker. FAIL if the retrieval path returns no row bearing the marker.
#
# Clause 2 — NAMESPACE ISOLATION. The same query, run under a DIFFERENT
#   namespace filter, must NOT return the marker. `ob_session_events` has no
#   namespace column (verified against information_schema on the dogfood DB
#   2026-08-07 — see the seeding SQL below); namespace is reachable only by
#   joining ob_session_lanes on lane_id. A recall path that adds the corpus
#   without carrying the auth-derived namespace predicate through that join
#   leaks every agent's session history into every other namespace. Clause 2 is
#   a security gate: it fails CLOSED, so if clause 1 cannot be satisfied at all
#   the leak question is reported as untested rather than silently passed.
#
# Both clauses run against ONE seeded row so they cannot disagree about what
# "the marker" means.
#
# Output is content-free apart from the random run marker: statuses and counts
# only. No tokens, no memory bodies.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the retrieval probe)"

# --- database access (seed + proof + teardown) ------------------------------
# .env carries the libpq vars, so bare psql needs no connection arguments.
# See AGENTS.md "Querying the dogfood database".
[ -r "$REPO_ROOT/.env" ] || fail_hard "no .env at $REPO_ROOT/.env; cannot reach the dogfood database"
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
psql -At -c 'select 1' >/dev/null 2>&1 || fail_hard "cannot reach the dogfood database; seeding, row proof, and teardown are all impossible, so a PASS could not be trusted"

# The probe needs a connection string; the app reads DB_* and psql reads PG*,
# but `pg.Pool` reads neither implicitly in the shape we want. Build it from the
# libpq vars already exported above rather than inventing a second source.
PROBE_DB_URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MARKER="rlvr433${RUN_ID}"

# ISOLATION IS BY THROWAWAY LANE. Two namespaces unique to this run give
# clause 2 a real cross-namespace pair to test with. Neither can collide with
# real data, and teardown cannot touch anything else.
OWNER_NS="done-means-433-own-${RUN_ID}"
OTHER_NS="done-means-433-other-${RUN_ID}"
SESSION_KEY="done-means-433-${RUN_ID}"

teardown() {
  psql -At -c "delete from ob_session_events where lane_id in (select id from ob_session_lanes where session_key like 'done-means-433-${RUN_ID}%');" >/dev/null 2>&1
  psql -At -c "delete from ob_session_lanes where session_key like 'done-means-433-${RUN_ID}%';" >/dev/null 2>&1
}
trap teardown EXIT

# --- seed -------------------------------------------------------------------
# The event is seeded directly rather than through the capture CLI on purpose:
# this gate is about whether RECALL can see the corpus, so the write path must
# not be able to fail the check for its own reasons (#598 covers that path).
#
# `embedding` is left NULL deliberately. The probe runs in keyword mode, so the
# lexical arm is what must find the row; a seeded embedding would let a vector
# hit mask a lexical arm that was never wired up.
SEED_SQL=$(cat <<SQL
insert into ob_session_lanes (session_key, namespace, created_by)
values ('${SESSION_KEY}-owner', '${OWNER_NS}', 'done-means-433');
insert into ob_session_events (lane_id, event_type, content, importance, created_by)
select id, 'fact', '${MARKER} session event seeded by the done-means gate for issue 433', 'hot', 'done-means-433'
from ob_session_lanes where session_key = '${SESSION_KEY}-owner';
SQL
)
psql -At -v ON_ERROR_STOP=1 -c "$SEED_SQL" >/dev/null 2>&1 || fail_hard "could not seed the throwaway lane/event"

SEEDED="$(psql -At -c "select count(*) from ob_session_events e join ob_session_lanes l on l.id = e.lane_id where l.namespace = '${OWNER_NS}' and e.content like '%${MARKER}%';" 2>/dev/null | tr -d '[:space:]')"
[ "${SEEDED:-0}" = "1" ] || fail_hard "seed did not land exactly one event (got '${SEEDED:-0}'); the gate cannot distinguish a retrieval miss from a missing row"

# --- probe ------------------------------------------------------------------
# Runs the REAL executeSearch from this checkout, with the REAL table list
# brain_answer would compute, once per namespace. Prints two integers: the count
# of returned rows carrying the marker under the owning namespace, and the count
# carrying it under the unrelated one.
#
# The probe is written into the repo-scoped scratch bucket rather than the
# checkout, so it never dirties `git status` and needs no delete to clean up
# (agents do not run forced/recursive deletes — Development AGENTS.md). It is
# imported by absolute path, so bun still resolves this checkout's modules.
PROBE_DIR="${OPENBRAIN_SCRATCH:-$HOME/.cache/open-brain/open-brain/_scratch}/done-means-433"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

cat > "$PROBE" <<PROBE_TS
import { Pool } from "pg";
import {
  executeSearch,
  readableSearchTables,
} from "${REPO_ROOT}/src/tools/search-brain.ts";
import {
  executeSearch as executeSearchServer,
  readableSearchSources,
} from "${REPO_ROOT}/server/tools/search-engine.ts";
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'

const [dbUrl, marker, ownerNs, otherNs] = process.argv.slice(2);
const pool = new Pool({ connectionString: dbUrl });

// THE REAL SELECTION, not a copy of it. `readableSearchTables` is the single
// function brain_answer and search_brain both call to decide what recall can
// read. Re-implementing that choice here would let the gate pass while the
// product stayed broken -- which is precisely the class of defect #433 is:
// two hand-maintained copies of one list that silently disagreed.
//
// `admin` is the most permissive role there is. If the marker is invisible to
// admin, it is invisible to everyone, and the failure cannot be waved off as a
// permissions artifact.
const accessibleTables = readableSearchTables("admin");
const accessibleSources = readableSearchSources("admin");

// Keyword mode: the lexical arm must find the marker on its own. The mock embed
// returns null so no vector arm can mask a missing lexical path.
const embedFn = async () => null;
const deps = { pool, embedFn } as any;

function countMarker(rows: any[]): number {
  return rows.filter((r: any) =>
    String(r.content_preview ?? "").includes(marker),
  ).length;
}

// BOTH SERVING TREES ARE PROBED, because both are live. `server/main.ts` is the
// local-clone serving entrypoint and `src/index.ts` still serves deployment_host via
// deploy/open-brain.service and scripts/run-two-worker.ts -- the repo states
// this itself at src/index.ts:52-60 and src/tools/agent-context-pack.ts:215.
// Fixing one tree and reporting the defect closed would leave a live path
// still blind to the corpus, so a PASS requires the marker to surface from
// EACH tree and to leak from NEITHER.
async function hitsSrc(namespace: string): Promise<number> {
  return countMarker(
    await executeSearch(
      deps,
      accessibleTables as any,
      marker,
      25,
      "keyword",
      undefined,
      0,
      namespace,
    ),
  );
}

async function hitsServer(namespace: string): Promise<number> {
  return countMarker(
    await executeSearchServer(
      deps,
      accessibleSources as any,
      marker,
      25,
      "keyword",
      undefined,
      0,
      namespace,
    ),
  );
}

try {
  const ownSrc = await hitsSrc(ownerNs);
  const otherSrc = await hitsSrc(otherNs);
  const ownServer = await hitsServer(ownerNs);
  const otherServer = await hitsServer(otherNs);
  // Each side reports the WEAKEST result across the two trees: visibility is
  // the minimum (a tree that cannot see it fails the clause) and leakage is the
  // maximum (a leak in either tree is a leak).
  console.log(
    `${Math.min(ownSrc, ownServer)} ${Math.max(otherSrc, otherServer)} src=${ownSrc}/${otherSrc} server=${ownServer}/${otherServer}`,
  );
} catch (err) {
  console.log(`ERR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
PROBE_TS

PROBE_OUT="$(cd "$REPO_ROOT" && bun "$PROBE" "$PROBE_DB_URL" "$MARKER" "$OWNER_NS" "$OTHER_NS" 2>&1 | tail -1)"

OWN_HITS="$(printf '%s' "$PROBE_OUT" | awk '{print $1}')"
OTHER_HITS="$(printf '%s' "$PROBE_OUT" | awk '{print $2}')"
# Per-tree detail (src=own/other server=own/other) so a failure names WHICH
# serving tree is blind or leaking, rather than only that one of them is.
PER_TREE="$(printf '%s' "$PROBE_OUT" | awk '{print $3, $4}')"

SEARCHED_TABLES="$(cd "$REPO_ROOT" && bun -e 'import{readableSearchTables}from"./src/tools/search-brain.ts";console.log(readableSearchTables("admin").join(","))' 2>/dev/null)"

CLAUSE1=FAIL
CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL
CLAUSE2_EVIDENCE=""

if [ "$OWN_HITS" = "ERR" ]; then
  CLAUSE1_EVIDENCE="retrieval path raised before returning rows: ${PROBE_OUT#ERR }"
  CLAUSE2_EVIDENCE="not assessed: clause 1 never produced a result, so a non-leak cannot be distinguished from a path that returns nothing at all"
elif ! printf '%s' "$OWN_HITS" | grep -Eq '^[0-9]+$'; then
  fail_hard "probe emitted no parseable result: '$PROBE_OUT'"
else
  # Clause 1 — visibility.
  if [ "$OWN_HITS" -ge 1 ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="seeded session event surfaced from the real executeSearch path: ${OWN_HITS} marker-bearing row(s) under namespace ${OWNER_NS}; searched tables [${SEARCHED_TABLES}]"
  else
    CLAUSE1_EVIDENCE="INVISIBLE: the row exists (seeded=1, confirmed in ob_session_events) but the real recall path returned 0 rows carrying the marker. Searched tables were [${SEARCHED_TABLES}] — the session-event corpus is not among them."
  fi

  # Clause 2 — namespace isolation. Fails closed when clause 1 failed.
  if [ "$CLAUSE1" != "PASS" ]; then
    CLAUSE2_EVIDENCE="not assessed: with the corpus invisible to recall, a zero cross-namespace count proves only that nothing is searched — not that the namespace predicate works. Re-run once clause 1 passes."
  elif [ "$OTHER_HITS" = "0" ]; then
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="no leak: the same marker query under unrelated namespace ${OTHER_NS} returned 0 marker-bearing rows while the owning namespace returned ${OWN_HITS}"
  else
    CLAUSE2_EVIDENCE="NAMESPACE LEAK: ${OTHER_HITS} marker-bearing row(s) visible from namespace ${OTHER_NS}, which owns none of them. The lane join is not carrying the auth-derived namespace predicate."
  fi
fi

printf '\n=== DONE-MEANS #433 (defect 1: recall visibility) ===\n'
printf 'run marker      : %s\n' "$MARKER"
printf 'seeded events   : %s (namespace %s)\n' "$SEEDED" "$OWNER_NS"
printf 'probe result    : own=%s other=%s (worst across trees)\n' "${OWN_HITS:-?}" "${OTHER_HITS:-?}"
printf 'per serving tree: %s\n' "${PER_TREE:-n/a}"
printf '\nCLAUSE 1 visibility         : %s\n  %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '\nCLAUSE 2 namespace isolation: %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ]; then
  printf '\nRESULT: PASS — defect 1 (recall visibility) satisfied. Defect 2 (promotion) is NOT covered by this gate and #433 does not close on this alone.\n'
  exit 0
fi

printf '\nRESULT: FAIL\n'
exit 1
