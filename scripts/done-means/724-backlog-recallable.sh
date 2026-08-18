#!/usr/bin/env bash
# DONE-MEANS check for issue #724 item 1 — "rows captured 2026-08-14..2026-08-17
# are stored but never embedded/indexed after the nats-worker outage; the
# 2026-08-17 write-recall heal covered NEW writes only, leaving the backlog
# unreachable."
#
#   bash scripts/done-means/724-backlog-recallable.sh
#
# ---------------------------------------------------------------------------
# WHAT THE PREMISE ACTUALLY LOOKS LIKE ON THE LIVE DOGFOOD DB (observed
# 2026-08-17 while authoring this gate — RUNNING, not inferred)
# ---------------------------------------------------------------------------
# The lane brief said the backlog was in session EVENTS. Measured, it is not:
#
#   ob_session_events, 2026-08-14..2026-08-17, namespace rico:
#       55 rows, 55 embedded, 0 NULL embeddings, embedded_at == created_at
#       (max lag -0.0008s => embedding is synchronous on the write path).
#
# The backlog that DOES exist in the window is in ob_session_lanes:
#
#   ob_session_lanes, same window, topic non-empty (the registry's own
#   eligibility filter, src/embedding-targets.ts:baseFilterSql):
#       2 rows, 0 embedded.
#   All-time eligible-but-unembedded lanes: 549.
#   ob_entities (archived_at IS NULL): 429 rows, 12 with NULL embedding.
#
# So this gate does NOT assert the brief's original shape. It asserts the
# invariant the brief was REACHING FOR, over every embedding-bearing table the
# repo itself declares, and it lets the numbers say which table is short. If a
# future outage moves the gap into events, clause 1 catches it there too,
# because clause 1 is driven by the registry rather than by one hand-picked
# table.
#
# TRUTH LABEL for anyone reading a run of this: a clause-1 FAIL is a CONFIRMED
# observation of unembedded rows, not a claim about the CAUSE. Whether the
# nats-worker outage produced them is unverified by this gate.
#
# ---------------------------------------------------------------------------
# Schema citations — every column below was read from source and confirmed
# against the live stored schema with `\d`, not invented.
# ---------------------------------------------------------------------------
#   src/embedding-targets.ts:EMBEDDING_TARGETS   — the single registry of every
#       embedding-bearing table. This gate reads it at runtime instead of
#       holding a second copy, for the same reason #433 exists: two
#       hand-maintained copies of one table list is the defect class itself.
#   src/embedding-targets.ts (ob_session_events entry) — `namespaceVia`
#       { table: ob_session_lanes, localKey: lane_id, remoteKey: id,
#         namespaceColumn: namespace }. ob_session_events carries NO namespace
#       column of its own; isolation is only through that FK.
#   src/embedding-targets.ts (ob_session_lanes entry) — `baseFilterSql`
#       "topic IS NOT NULL AND btrim(topic) <> ''". Lanes with an empty topic
#       have no text to embed and are NOT a backlog; counting them would report
#       thousands of phantom rows (7,634 in the window) and make the gate lie.
#   src/embedding-targets.ts (ob_entities entry) — `baseFilterSql`
#       "archived_at IS NULL"; provenance has NO content_hash/embedded_at/
#       embedding_model, so only missing-embedding detection is truthful there.
#   Columns `embedding halfvec(768)`, `embedded_at timestamptz`,
#       `embedding_model text`, `content_hash text`, `created_at timestamptz`
#       on ob_session_events — src/db/migrations/013_session_events.sql,
#       confirmed live via `\d ob_session_events` 2026-08-17.
#   src/tools/search-brain.ts:109 readableSearchTables(role) — the one function
#       brain_answer and search_brain both call to decide what recall may read.
#   src/tools/search-brain.ts:1586 executeSearch(...) — the real retrieval
#       entry point; this gate drives it in-process from THIS checkout so an
#       uncommitted fix can go red-then-green. Probing the deployed service
#       would measure the installed revision instead and could never move.
#   src/embedding.ts:618 generateEmbedding(...) — the real provider call, used
#       for the semantic arm so a vector-side failure cannot hide behind
#       lexical hits.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 — NO UNEMBEDDED BACKLOG IN THE WINDOW. For every table in
#   EMBEDDING_TARGETS, and for every namespace, there must be no row created in
#   2026-08-14..2026-08-17 that is eligible to be embedded and has a NULL
#   embedding. Eligibility is the registry's own baseFilterSql, never a
#   predicate invented here.
#
# Clause 2 — RECALL REACHES THE WINDOW. The real executeSearch path must return
#   at least one row whose created_at falls inside the window, for a query drawn
#   from known Aug-15 content. Run in BOTH keyword and semantic mode: keyword
#   proves the lexical arm, semantic proves the vector arm actually has usable
#   embeddings for window rows. An embedding backlog is invisible to keyword
#   search, so keyword alone would pass over exactly the defect under test.
#
# Clause 3 — CONTROL. A KNOWN-GOOD pre-2026-08-14 row must also be recallable
#   through the same path. This is what stops a dead service, an empty table
#   list, a broken embed provider, or a namespace typo from faking a clause-2
#   pass by returning nothing everywhere. If the control cannot be recalled,
#   the whole run is a HARNESS ERROR (exit 3), not a FAIL: the instrument is
#   broken, so it has no opinion about the window.
#
# ---------------------------------------------------------------------------
# Exit grammar
# ---------------------------------------------------------------------------
#   0  every clause PASS
#   1  a clause genuinely FAILED (real defect observed)
#   3  HARNESS ERROR — the gate could not form an opinion. Includes: DB
#      unreachable, psql/bun missing, a probe that raised, a query that
#      examined ZERO candidate rows (0 rows examined is NOT a pass), and a
#      failed control clause.
#
# Output is content-free apart from short previews of already-public window
# text: statuses, counts, table names. No tokens, no full memory bodies.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WINDOW_START="2026-08-14"
WINDOW_END="2026-08-18"   # exclusive; covers through 2026-08-17 23:59:59

fail_hard() {
  printf '\nHARNESS-ERROR: %s\n' "$1" >&2
  printf 'RESULT: HARNESS ERROR (exit 3) — the gate formed no opinion about the backlog.\n' >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the registry read and the recall probes)"
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"

# --- database access --------------------------------------------------------
# .env carries the libpq vars, so bare psql needs no connection arguments.
# See AGENTS.md "Querying the dogfood database". A clone made from the primary
# checkout does NOT carry .env (it is gitignored), so fall back to the primary
# checkout's copy rather than hand-building a connection string.
ENV_FILE="$REPO_ROOT/.env"
if [ ! -r "$ENV_FILE" ]; then
  ENV_FILE="/Volumes/ThunderBolt/Development/open-brain/.env"
fi
[ -r "$ENV_FILE" ] || fail_hard "no readable .env at $REPO_ROOT/.env or the primary checkout; cannot reach the dogfood database"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
psql -At -c 'select 1' >/dev/null 2>&1 || fail_hard "cannot reach the dogfood database (DB unreachable => exit 3, never a pass)"

PROBE_DB_URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# ===========================================================================
# Clause 1 — no unembedded backlog in the window, across the WHOLE registry
# ===========================================================================
# The table list, its eligibility filter, and its namespace wiring all come out
# of src/embedding-targets.ts at runtime. Emitting one line per target as
# "table<TAB>baseFilterSql<TAB>namespaceExpr" keeps the SQL construction here
# while the SCHEMA FACTS stay owned by the registry.
REGISTRY_TSV="$(cd "$REPO_ROOT" && bun -e '
import { EMBEDDING_TARGETS } from "./src/embedding-targets.ts";
for (const t of Object.values(EMBEDDING_TARGETS)) {
  // Namespace is either a column on the table itself, or reached through the
  // declared FK to a parent that owns it (ob_session_events -> ob_session_lanes).
  let nsExpr = "'"'"'(none)'"'"'";
  let joinSql = "";
  if (t.namespaceColumn) {
    nsExpr = `x.${t.namespaceColumn}`;
  } else if (t.namespaceVia) {
    const v = t.namespaceVia;
    nsExpr = `p.${v.namespaceColumn}`;
    joinSql = `join ${v.table} p on p.${v.remoteKey} = x.${v.localKey}`;
  }
  console.log([t.table, t.baseFilterSql ?? "true", nsExpr, joinSql].join("\t"));
}' 2>/dev/null)"

[ -n "$REGISTRY_TSV" ] || fail_hard "could not read EMBEDDING_TARGETS from src/embedding-targets.ts; the gate refuses to fall back to a hand-written table list (that duplication IS the #433 defect class)"

CLAUSE1=PASS
CLAUSE1_DETAIL=""
TOTAL_EXAMINED=0
BACKLOG_TOTAL=0

while IFS=$'\t' read -r TBL BASEFILTER NSEXPR JOINSQL; do
  [ -n "$TBL" ] || continue

  # Candidates = rows of this table created inside the window that the registry
  # itself considers embeddable. Examined count is reported so "0 backlog" can
  # be distinguished from "0 rows looked at" — the latter is empty-because-wrong
  # and must never read as a pass.
  ROW="$(psql -At -F'|' -c "
    select
      count(*),
      count(*) filter (where x.embedding is null),
      coalesce(string_agg(distinct ${NSEXPR}, ',') filter (where x.embedding is null), '')
    from ${TBL} x
    ${JOINSQL}
    where x.created_at >= '${WINDOW_START}'
      and x.created_at <  '${WINDOW_END}'
      and (${BASEFILTER});
  " 2>&1)"

  case "$ROW" in
    *ERROR*|*error:*) fail_hard "clause 1 query failed for table ${TBL}: ${ROW}" ;;
  esac

  EXAMINED="$(printf '%s' "$ROW" | cut -d'|' -f1 | tr -d '[:space:]')"
  MISSING="$(printf '%s' "$ROW" | cut -d'|' -f2 | tr -d '[:space:]')"
  NSLIST="$(printf '%s' "$ROW" | cut -d'|' -f3)"

  printf '%s' "${EXAMINED:-}" | rg -q '^[0-9]+$' || fail_hard "clause 1 returned no parseable count for ${TBL}: '${ROW}'"

  TOTAL_EXAMINED=$((TOTAL_EXAMINED + EXAMINED))
  BACKLOG_TOTAL=$((BACKLOG_TOTAL + MISSING))

  if [ "$MISSING" -gt 0 ]; then
    CLAUSE1=FAIL
    CLAUSE1_DETAIL="${CLAUSE1_DETAIL}
    ${TBL}: ${MISSING} of ${EXAMINED} eligible window rows have NULL embedding (namespaces: ${NSLIST:-?})"
  else
    CLAUSE1_DETAIL="${CLAUSE1_DETAIL}
    ${TBL}: 0 of ${EXAMINED} eligible window rows unembedded — clean"
  fi
done <<< "$REGISTRY_TSV"

# ZERO ROWS EXAMINED IS NOT A PASS. If the whole registry turned up no candidate
# rows in the window, either the window is wrong, the filters are wrong, or the
# gate is pointed at the wrong database. Any of those means no opinion.
if [ "$TOTAL_EXAMINED" -eq 0 ]; then
  fail_hard "clause 1 examined ZERO candidate rows across every embedding target in ${WINDOW_START}..${WINDOW_END}. Empty-because-wrong is not a pass; check the window, the registry filters, and PGDATABASE=${PGDATABASE}"
fi

# ===========================================================================
# Clauses 2 and 3 — recall probes through the REAL retrieval path
# ===========================================================================
# Both probes run against the same executeSearch entry point brain_answer uses,
# in BOTH keyword and semantic mode. `admin` is the most permissive role there
# is: if content is invisible to admin it is invisible to everyone, and the
# result cannot be waved off as a permissions artifact.
#
# The probe is written into the repo-scoped scratch bucket rather than the
# checkout, so it never dirties `git status` and needs no delete to clean up
# (agents never run forced or recursive deletes — Development AGENTS.md).
PROBE_DIR="${OPENBRAIN_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/done-means-724"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

cat > "$PROBE" <<PROBE_TS
const REPO_ROOT = "${REPO_ROOT}";
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'
import { Pool } from "pg";

const { executeSearch, readableSearchTables } = await import(
  `${REPO_ROOT}/src/tools/search-brain.ts`
);
const { generateEmbedding } = await import(`${REPO_ROOT}/src/embedding.ts`);

const [dbUrl, namespace, query, loIso, hiIso] = process.argv.slice(2);
const lo = new Date(loIso).getTime();
const hi = new Date(hiIso).getTime();
const pool = new Pool({ connectionString: dbUrl });

// THE REAL SELECTION, not a copy. readableSearchTables is the single function
// brain_answer and search_brain both call; re-deriving the list here would let
// the gate pass while the product stayed blind.
const tables = readableSearchTables("admin");

function inRange(rows: any[]): number {
  return rows.filter((r: any) => {
    const t = new Date(r.created_at ?? 0).getTime();
    return Number.isFinite(t) && t >= lo && t < hi;
  }).length;
}

async function run(mode: string): Promise<number> {
  // Semantic mode uses the REAL provider so a dead embedding endpoint or a
  // missing row-side embedding surfaces as a miss instead of being masked by
  // the lexical arm.
  const embedFn = mode === "semantic" ? generateEmbedding : async () => null;
  const rows: any[] = await executeSearch(
    { pool, embedFn } as any,
    tables as any,
    query,
    25,
    mode,
    undefined,
    0,
    namespace,
  );
  return inRange(rows);
}

try {
  const kw = await run("keyword");
  const sem = await run("semantic");
  console.log(`OK ${kw} ${sem}`);
} catch (err) {
  console.log(`ERR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
PROBE_TS

# --- pick the namespace and the probe subjects from live data ----------------
# The namespace is DISCOVERED, not hardcoded: the gate asks which namespace
# actually owns window events, so it cannot silently probe an empty one.
NAMESPACE="$(psql -At -c "
  select l.namespace
  from ob_session_events e
  join ob_session_lanes l on l.id = e.lane_id
  where e.created_at >= '${WINDOW_START}' and e.created_at < '${WINDOW_END}'
  group by 1 order by count(*) desc limit 1;" 2>/dev/null | tr -d '[:space:]')"
[ -n "$NAMESPACE" ] || fail_hard "no namespace has session events in ${WINDOW_START}..${WINDOW_END}; with nothing captured in the window there is nothing to prove recallable (exit 3, not a pass)"

# Clause 2 subject: known Aug-15-window content. Drawn from the DB so the query
# is guaranteed to correspond to a row that really exists — a hardcoded phrase
# that had drifted would fail the clause for the wrong reason.
# Same distinctiveness rules as the control below: exclude the shared
# checkpoint/probe boilerplate and cut on a word boundary, so the probe asks
# about THIS row rather than about a phrase thousands of rows share.
WINDOW_QUERY="$(psql -At -c "
  select regexp_replace(left(e.content, 70), '\s+\S*\$', '')
  from ob_session_events e
  join ob_session_lanes l on l.id = e.lane_id
  where l.namespace = '${NAMESPACE}'
    and e.created_at >= '2026-08-15' and e.created_at < '2026-08-16'
    and length(e.content) > 80
    and e.content !~* '^(recorded codex turn checkpoint|probe:|liveness probe|test\$)'
  order by length(e.content) desc limit 1;" 2>/dev/null)"
[ -n "$WINDOW_QUERY" ] || fail_hard "no Aug-15 session event long enough to form a recall probe in namespace ${NAMESPACE}; cannot evaluate clause 2 (exit 3)"

# Clause 3 subject: a KNOWN-GOOD pre-window row that is already embedded. Being
# embedded is the point — this is the control for "the retrieval path works at
# all", so it must be a row nothing about the outage could have touched.
#
# The subject must be DISTINCTIVE, not merely recent. Observed 2026-08-17 while
# authoring: taking `left(content,60)` of the newest pre-window event yielded
# "Recorded codex turn checkpoint for Development. 3. Self-host" — boilerplate
# shared by thousands of rows, truncated mid-word. Every one of the top-25
# keyword hits was a DIFFERENT checkpoint carrying the same prefix, so the
# control failed while the retrieval path was working perfectly. A control that
# can fail for its own reasons is worse than no control: it converts every run
# into a harness error and hides the clause it was meant to protect.
#
# So: pick the pre-window row whose content is LEAST like the common
# boilerplate, and cut on a word boundary so no token is truncated. Rows whose
# content starts with the known checkpoint/probe boilerplate are excluded
# outright.
CONTROL_QUERY="$(psql -At -c "
  select regexp_replace(left(e.content, 70), '\s+\S*\$', '')
  from ob_session_events e
  join ob_session_lanes l on l.id = e.lane_id
  where l.namespace = '${NAMESPACE}'
    and e.created_at < '${WINDOW_START}'
    and e.embedding is not null
    and length(e.content) > 80
    and e.content !~* '^(recorded codex turn checkpoint|probe:|liveness probe|test\$)'
  order by e.created_at desc limit 1;" 2>/dev/null)"
[ -n "$CONTROL_QUERY" ] || fail_hard "no embedded pre-${WINDOW_START} session event available as a control in namespace ${NAMESPACE}; without a control a clause-2 pass could not be trusted (exit 3)"

CONTROL_DAY="$(psql -At -c "
  select max(e.created_at)::date
  from ob_session_events e
  join ob_session_lanes l on l.id = e.lane_id
  where l.namespace = '${NAMESPACE}' and e.created_at < '${WINDOW_START}'
    and e.embedding is not null;" 2>/dev/null | tr -d '[:space:]')"

probe() {
  cd "$REPO_ROOT" && bun "$PROBE" "$PROBE_DB_URL" "$NAMESPACE" "$1" "$2" "$3" 2>/dev/null | rg '^(OK|ERR)' | tail -1
}

# TIMEZONE: the window boundaries MUST be resolved the same way on both sides
# of this gate, or the two halves disagree about which rows are "in the window".
#
# Observed 2026-08-17 while authoring: the SQL above compares `created_at`
# against bare dates, which Postgres resolves in the session TimeZone (local,
# America/New_York), while the probe parsed the boundary as UTC. The control row
# sat at 2026-08-14T02:55:40Z — Aug 13 21:55 LOCAL. SQL correctly called it
# pre-window; the probe called it in-window; the control reported 0 hits and the
# whole run went to exit 3 while nothing was actually broken. A five-hour offset
# silently inverted the classification of every evening row in the window.
#
# So the boundaries handed to the probe are computed BY POSTGRES, in the same
# session zone the clause-1 queries used, and emitted as absolute instants.
WINDOW_LO_ISO="$(psql -At -c "select to_char(timestamptz '${WINDOW_START} 00:00:00' at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');" 2>/dev/null | tr -d '[:space:]')"
WINDOW_HI_ISO="$(psql -At -c "select to_char(timestamptz '${WINDOW_END} 00:00:00' at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');" 2>/dev/null | tr -d '[:space:]')"
[ -n "$WINDOW_LO_ISO" ] && [ -n "$WINDOW_HI_ISO" ] || fail_hard "could not resolve the window boundaries through Postgres; without a single shared definition of the window the clauses cannot be compared"

WINDOW_OUT="$(probe "$WINDOW_QUERY" "$WINDOW_LO_ISO" "$WINDOW_HI_ISO")"
# Control range: everything before the window, using the SAME resolved lower
# boundary. Epoch lower bound so any pre-window hit counts.
CONTROL_OUT="$(probe "$CONTROL_QUERY" "1970-01-01T00:00:00Z" "$WINDOW_LO_ISO")"

case "$WINDOW_OUT" in ERR*) fail_hard "clause 2 probe raised before returning rows: ${WINDOW_OUT#ERR }" ;; esac
case "$CONTROL_OUT" in ERR*) fail_hard "clause 3 control probe raised: ${CONTROL_OUT#ERR }" ;; esac
[ -n "$WINDOW_OUT" ] || fail_hard "clause 2 probe produced no parseable output"
[ -n "$CONTROL_OUT" ] || fail_hard "clause 3 probe produced no parseable output"

W_KW="$(printf '%s' "$WINDOW_OUT" | awk '{print $2}')"
W_SEM="$(printf '%s' "$WINDOW_OUT" | awk '{print $3}')"
C_KW="$(printf '%s' "$CONTROL_OUT" | awk '{print $2}')"
C_SEM="$(printf '%s' "$CONTROL_OUT" | awk '{print $3}')"

# --- clause 3 first: it decides whether the instrument has any authority -----
CLAUSE3=FAIL
CLAUSE3_EVIDENCE=""
if [ "${C_KW:-0}" -ge 1 ] && [ "${C_SEM:-0}" -ge 1 ]; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="known-good pre-${WINDOW_START} row (namespace ${NAMESPACE}, newest embedded ${CONTROL_DAY:-?}) recalled through the real path: keyword=${C_KW} semantic=${C_SEM} in-range hits. The retrieval path is live, so a clause-2 miss means the WINDOW is unreachable, not the service."
else
  CLAUSE3_EVIDENCE="CONTROL FAILED: a pre-window row that IS embedded did not come back (keyword=${C_KW:-?} semantic=${C_SEM:-?}). The retrieval path itself is not answering, so this run has NO opinion about the window backlog."
fi

CLAUSE2=FAIL
CLAUSE2_EVIDENCE=""
if [ "${W_KW:-0}" -ge 1 ] && [ "${W_SEM:-0}" -ge 1 ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="window content is reachable in BOTH arms: keyword=${W_KW} semantic=${W_SEM} rows dated inside ${WINDOW_START}..${WINDOW_END}"
elif [ "${W_KW:-0}" -ge 1 ]; then
  CLAUSE2_EVIDENCE="LEXICAL ONLY: keyword returned ${W_KW} window row(s) but semantic returned ${W_SEM:-0}. Keyword search reads stored text and is blind to a missing embedding, so this is the exact signature of an unembedded backlog — the rows are STORED but not INDEXED."
else
  CLAUSE2_EVIDENCE="UNREACHABLE: the real recall path returned 0 rows dated inside the window in either arm (keyword=${W_KW:-0} semantic=${W_SEM:-0}), while the control proves the path answers for older rows."
fi

# ===========================================================================
# Report
# ===========================================================================
printf '\n=== DONE-MEANS #724 item 1 (Aug 14-17 backlog is embedded AND recallable) ===\n'
printf 'window          : %s .. %s (exclusive)\n' "$WINDOW_START" "$WINDOW_END"
printf 'namespace probed: %s (discovered, not hardcoded)\n' "$NAMESPACE"
printf 'rows examined   : %s eligible window rows across the whole EMBEDDING_TARGETS registry\n' "$TOTAL_EXAMINED"
printf 'unembedded total: %s\n' "$BACKLOG_TOTAL"

printf '\nCLAUSE 1 no unembedded backlog in window : %s%s\n' "$CLAUSE1" "$CLAUSE1_DETAIL"
printf '\nCLAUSE 2 recall reaches the window       : %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf '\nCLAUSE 3 control (pre-window recallable) : %s\n  %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"

# A broken control means the instrument is broken. Report exit 3, never 0 or 1:
# with the retrieval path silent, both a "pass" and a "fail" on clause 2 would
# be unearned.
if [ "$CLAUSE3" != "PASS" ]; then
  printf '\nRESULT: HARNESS ERROR (exit 3) — the control clause failed, so this run has no authority to judge the window.\n'
  exit 3
fi

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ]; then
  printf '\nRESULT: PASS — every eligible row captured in the window carries an embedding, and window content returns from the real recall path in both the lexical and the vector arm.\n'
  exit 0
fi

printf '\nRESULT: FAIL — the window backlog is not closed. Numbers above name the table(s) and the arm that is short.\n'
exit 1
