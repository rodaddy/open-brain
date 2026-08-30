#!/usr/bin/env bash
# DONE-MEANS check for issue #744, DEFECT D1 ONLY — the acceptance gate, not the fix.
#
#   bash scripts/done-means/744-recall-serves-durable.sh
#
# D1, verbatim from the issue: `recall` returns `ok` with zero items while
# serving only the non-durable working set. A success receipt that examined no
# durable memory is the exit-0 no-op.
#
# THE MECHANISM this gate holds the line on. The section toggles in
# agent-context-pack read one optional field with two OPPOSITE defaults:
#
#   server/tools/agent-context-pack.ts:132  absent requested_sections => working_set INCLUDED
#     const includeWorkingSet =
#       !args.requested_sections || args.requested_sections.includes("working_set");
#
#   server/tools/agent-context-pack.ts:139  absent requested_sections => durable_memory EXCLUDED
#     const includeDurableMemorySection =
#       args.requested_sections?.includes("durable_memory") === true;
#
# The Python client never sets the key (runtime.py:245-257
# context_pack_arguments; runtime.py:794 adds it only when non-None), so EVERY
# bare recall takes the working-set-only branch and reports success. Measured
# 2026-08-25 against the local service with the installed client:
#
#   bare recall  -> sections_receipt {"requested":null,"requested_not_served":[],
#                                     "served":["working_set"]}, citations 0
#   with the section asked for explicitly -> served [working_set,durable_memory],
#                                            citations 10
#
# So the corpus is reachable and the query works. The DEFAULT is the defect, and
# `requested_not_served: []` means the envelope carries no signal that durable
# memory was never consulted.
#
# SCOPE. This gate covers the SECTION DEFAULT only — whether a caller who asks
# for nothing in particular gets durable memory consulted. It does NOT cover:
#   - #433 defect 1 (ob_session_events absent from ALL_TABLES) — gated by
#     scripts/done-means/433-recall-sees-session-events.sh
#   - #433 defect 2 (nothing promotes lane events) — ungated
#   - #742 (client contract mismatch at get_contract) — ungated
# Those are independent. This check passing does not close #744, and it will
# still pass while recall remains unable to see a single session event.
#
# EXPECTED TO FAIL until the default at agent-context-pack.ts:139 is fixed. It
# is the reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Why this drives BOTH trees in-process rather than the running service
# ---------------------------------------------------------------------------
# A live service is listening, but it serves the DEPLOYED revision, not this
# working tree — so probing it would report the same answer before and after an
# uncommitted fix and could never go red-then-green. This script therefore
# imports the tool builder from THIS checkout via `bun`.
#
# Both trees are probed because both are live: `server/tools/` is the local
# clone's serving entrypoint (server/main.ts per scripts/local-clone.ts), and
# `src/tools/` still serves through `bun start`, deploy/open-brain.service, and
# scripts/run-two-worker.ts. At L5 `src/tools/agent-context-pack.ts` became a
# thin adapter that re-exports the server twin, so the two probes now exercise
# the same implementation through the two entrypoints that callers actually
# reach. That is still worth probing separately: the adapter is the live src
# path, and a broken re-export would break it while the twin stayed green. A
# PASS requires BOTH entrypoints to consult durable memory on a bare request.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 — DEFAULT CONSULTS DURABLE MEMORY. A recall carrying NO
#   requested_sections must report `durable_memory` among its served sections.
#   FAIL if served is working_set-only.
#
# Clause 2 — NO SILENT OMISSION. If a section is genuinely withheld, the
#   envelope must say so: `requested_not_served` must be non-empty, OR the
#   section must be served. An `ok` receipt with an empty served-set AND an
#   empty not-served list is the exit-0 no-op D1 names, and fails this clause
#   regardless of clause 1. This is what stops a "fix" that simply relabels the
#   omission as intentional.
#
# Output is content-free: section names, counts, and statuses only. No memory
# bodies, no tokens.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the section-default probe)"

# .env carries the libpq vars, so bare psql needs no connection arguments.
# See AGENTS.md "Querying the dogfood database".
[ -r "$REPO_ROOT/.env" ] || fail_hard "no .env at $REPO_ROOT/.env; cannot reach the dogfood database"
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
psql -At -c 'select 1' >/dev/null 2>&1 || fail_hard "cannot reach the dogfood database; the probe needs a real pool, so a PASS could not be trusted"

# A durable corpus must actually exist, or "no citations" would be ambiguous
# between a skipped query and an empty table. This gate is about the SECTION
# BEING CONSULTED, but an empty corpus would make any downstream reading of the
# result meaningless, so refuse to run rather than report a hollow PASS.
DURABLE_ROWS="$(psql -At -c "select count(*) from thoughts" 2>/dev/null | tr -d '[:space:]')"
printf '%s' "${DURABLE_ROWS:-0}" | grep -Eq '^[0-9]+$' || fail_hard "could not count durable rows"
[ "${DURABLE_ROWS:-0}" -gt 0 ] || fail_hard "thoughts is empty; a skipped durable query and an empty corpus would be indistinguishable"

PROBE_DB_URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"

# The probe is written into the repo-scoped scratch bucket rather than the
# checkout, so it never dirties `git status` and needs no delete to clean up
# (agents do not run forced/recursive deletes — Development AGENTS.md).
PROBE_DIR="${OPENBRAIN_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/done-means-744"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

cat > "$PROBE" <<PROBE_TS
import { Pool } from "pg";
import { buildAgentContextPackPayload as buildSrc } from "${REPO_ROOT}/src/tools/agent-context-pack.ts";
import { buildAgentContextPackPayload as buildServer } from "${REPO_ROOT}/server/tools/agent-context-pack.ts";
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'

const [dbUrl] = process.argv.slice(2);
const pool = new Pool({ connectionString: dbUrl });

// THE BARE REQUEST — exactly the shape the Python client sends. No
// requested_sections key at all, which is the whole point: this gate asks what
// a caller who specifies nothing receives. Adding the key here would test the
// opt-in path, which already works and is not the defect.
const bareArgs: Record<string, unknown> = {
  agent: "done-means-744",
  platform: "done-means",
  server_id: "local",
  channel_id: "gate",
  session_key: `done-means-744-${process.pid}`,
  query: "durable memory recall section default",
};

// `admin` is the most permissive role there is. If durable memory is skipped
// for admin, it is skipped for everyone, and the failure cannot be waved off as
// a permissions artifact.
const auth = { clientId: "done-means-744", role: "admin", namespace: "rico" };
const embedFn = async () => null;
// The server tree reaches for a logger on its durable-memory path. A silent
// no-op logger keeps the probe content-free while letting the real code run;
// omitting it made the tree throw and read as a product failure (it was not).
const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as any;
const deps = { pool, embedFn, auth, logger: noopLogger } as any;

function readServed(result: any): { served: string[]; notServed: string[] } {
  // The builders return { payload, isError }; the receipt lives on the payload.
  const pack = result?.payload ?? result;
  const receipt = pack?.sections_receipt ?? {};
  return {
    served: Array.isArray(receipt.served) ? receipt.served : [],
    notServed: Array.isArray(receipt.requested_not_served)
      ? receipt.requested_not_served
      : [],
  };
}

async function probe(
  build: (args: any, auth: any, deps: any) => Promise<any>,
  label: string,
): Promise<string> {
  try {
    const result = await build({ ...bareArgs }, auth, deps);
    const { served, notServed } = readServed(result);
    return `${label}|${served.join(",") || "-"}|${notServed.join(",") || "-"}`;
  } catch (err) {
    return `${label}|ERR|${err instanceof Error ? err.message : String(err)}`;
  }
}

try {
  console.log(await probe(buildSrc as any, "src"));
  console.log(await probe(buildServer as any, "server"));
} finally {
  await pool.end();
}
PROBE_TS

PROBE_OUT="$(cd "$REPO_ROOT" && bun "$PROBE" "$PROBE_DB_URL" 2>&1)"

SRC_LINE="$(printf '%s\n' "$PROBE_OUT" | grep '^src|' | tail -1)"
SERVER_LINE="$(printf '%s\n' "$PROBE_OUT" | grep '^server|' | tail -1)"

[ -n "$SRC_LINE" ] && [ -n "$SERVER_LINE" ] \
  || fail_hard "probe emitted no parseable result for one or both trees; raw output: ${PROBE_OUT}"

SRC_SERVED="$(printf '%s' "$SRC_LINE" | cut -d'|' -f2)"
SRC_NOTSERVED="$(printf '%s' "$SRC_LINE" | cut -d'|' -f3)"
SERVER_SERVED="$(printf '%s' "$SERVER_LINE" | cut -d'|' -f2)"
SERVER_NOTSERVED="$(printf '%s' "$SERVER_LINE" | cut -d'|' -f3)"

has_durable() {
  printf '%s' "$1" | tr ',' '\n' | grep -qx 'durable_memory'
}

CLAUSE1=FAIL
CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL
CLAUSE2_EVIDENCE=""

if [ "$SRC_SERVED" = "ERR" ] || [ "$SERVER_SERVED" = "ERR" ]; then
  CLAUSE1_EVIDENCE="context-pack build raised before returning a receipt: src=[${SRC_NOTSERVED}] server=[${SERVER_NOTSERVED}]"
  CLAUSE2_EVIDENCE="not assessed: no receipt was produced, so a silent omission cannot be distinguished from a crash"
else
  # Clause 1 — the default consults durable memory, in BOTH live trees.
  if has_durable "$SRC_SERVED" && has_durable "$SERVER_SERVED"; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="a bare recall (no requested_sections) served durable_memory in both trees: src=[${SRC_SERVED}] server=[${SERVER_SERVED}]"
  else
    BLIND=""
    has_durable "$SRC_SERVED"    || BLIND="src"
    has_durable "$SERVER_SERVED" || BLIND="${BLIND:+$BLIND and }server"
    CLAUSE1_EVIDENCE="SKIPPED: a bare recall did not consult durable memory in the ${BLIND} tree. src served [${SRC_SERVED}], server served [${SERVER_SERVED}]. The deciding branch is the asymmetric default in server/tools/agent-context-pack.ts, which src/tools/agent-context-pack.ts now re-exports as an L5 adapter: working_set treats an absent requested_sections as INCLUDED, durable_memory treats it as EXCLUDED."
  fi

  # Clause 2 — no silent omission. Evaluated independently of clause 1: a fix
  # that keeps the omission but starts declaring it would satisfy this clause
  # and still fail clause 1, and a fix that serves the section satisfies both.
  # What must never pass is the current state — omitted AND undeclared.
  SILENT=""
  has_durable "$SRC_SERVED"    || [ "$SRC_NOTSERVED"    != "-" ] || SILENT="src"
  has_durable "$SERVER_SERVED" || [ "$SERVER_NOTSERVED" != "-" ] || SILENT="${SILENT:+$SILENT and }server"
  if [ -z "$SILENT" ]; then
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="every unserved section is declared: src not_served [${SRC_NOTSERVED}], server not_served [${SERVER_NOTSERVED}]"
  else
    CLAUSE2_EVIDENCE="SILENT OMISSION: the ${SILENT} tree withheld durable_memory and reported requested_not_served empty. The receipt is truthful and useless — nothing was requested, so nothing was withheld, so the caller gets an ok envelope with no signal that the durable corpus was never consulted."
  fi
fi

printf '\n=== DONE-MEANS #744 (D1: recall serves durable memory by default) ===\n'
printf 'durable corpus  : %s rows in thoughts\n' "${DURABLE_ROWS}"
printf 'src tree        : served=[%s] not_served=[%s]\n' "${SRC_SERVED}" "${SRC_NOTSERVED}"
printf 'server tree     : served=[%s] not_served=[%s]\n' "${SERVER_SERVED}" "${SERVER_NOTSERVED}"
printf '\nCLAUSE 1 default consults durable: %s\n  %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '\nCLAUSE 2 no silent omission      : %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ]; then
  printf '\nRESULT: PASS — D1 satisfied. #433 (session events unreachable, promotion frozen) and #742 (client contract) are NOT covered by this gate and #744 does not close on this alone.\n'
  exit 0
fi

printf '\nRESULT: FAIL\n'
exit 1
