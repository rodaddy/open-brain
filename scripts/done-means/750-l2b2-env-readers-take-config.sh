#!/usr/bin/env bash
# DONE-MEANS check for lane L2b-2 of the server/ hardening ladder
# (`_plans/server-hardening-ladder.md`, rung L2 "Composition root", issue #825).
#
#   bash scripts/done-means/750-l2b2-env-readers-take-config.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# The rewrite charter (`_plans/463-server-rewrite-charter.md:108,119`) puts ALL
# env parsing behind `server/config/` and forbids domain code from importing
# `process.env`. L2a (#778) delivered the SCHEMA half — every one of these reads
# is typed and parsed into a `ServerConfig` group — and L2b-1
# (`scripts/done-means/750-l2b1-tool-readers-take-config.sh`) closed the first
# four readers. This lane closes the REMAINDER, including the two that L2b-1
# explicitly deferred behind the lint-debt ruling.
#
# The state it ends is the doubled one: a validated group AND the original
# scattered reader both exist, and only the reader is consulted. Nothing fails
# while that lasts; `config.search.embeddingTimeoutMs` can be correct, tested,
# and reported in `/health` while `server/tools/search-engine.ts` reads
# `process.env` and answers something else. The two drift, and the config
# becomes a record of an intention rather than the value in force.
#
# ABSENCE ALONE IS NOT THE BAR. A reader that stopped reading `process.env` and
# whose caller never started passing the value is not wired — it runs on its
# `?? default` forever, and an absence-only check goes green on exactly that
# state. So clause 4 asserts ARRIVAL: each value must be handed down from the
# ONE validated parse, at the call site that reaches the reader.
#
# ---------------------------------------------------------------------------
# The four readers, and what "wired" means for each
# ---------------------------------------------------------------------------
# Measured on origin/main a80484b:
#
#   server/tools/search-engine.ts:124-125
#     `searchEmbeddingTimeoutMs()` reads OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS
#     then SEARCH_EMBEDDING_TIMEOUT_MS. `server/config/env-groups.ts:289`
#     already parses both into `SearchConfigGroup.embeddingTimeoutMs`, exposed
#     as `config.search` (`server/config.ts:236,359`).
#
#   server/tools/shared-namespace.ts:37,45,52
#     `sharedNamespaceConfig()` re-derives five values from the environment on
#     every call. `server/config/env-groups.ts:333` (`sharedNamespaceGroup`)
#     already parses the identical name list into the identical shape, exposed
#     as `config.sharedNamespaceNames` (`server/config.ts:245,363`).
#
#   server/tools/search-all.ts:124
#     `resolveQmdPath(env = process.env)` already TAKES an env parameter and
#     defaults it to `process.env`. A default parameter is the doubled state in
#     miniature: it looks injected and behaves like a direct read for every
#     caller that omits the argument. The default goes away, callers pass.
#
#   server/observability/trace-config.ts:33
#     `readMcpTracingConfig(env = process.env)` has the same shape. Its only
#     non-test callers are `server/observability/langfuse-tracing.ts:402,506`,
#     both of which call it with no argument.
#
# ---------------------------------------------------------------------------
# WHY CLAUSE 3 EXISTS — the vacuous-pass problem
# ---------------------------------------------------------------------------
# The natural check is "rg finds no `process.env` in these files", and that
# assertion passes for two very different reasons: because the reads are gone,
# or because the scan examined nothing. A renamed file, a typo in a path, an
# `rg` that is not on PATH, a bad `--glob` — every one produces a silent clean
# sweep and an exit 0 that means nothing. So the check proves the scanner can
# still see a hit somewhere it MUST see one.
#
# Four clauses, and all four must pass:
#
# CLAUSE 1 — ALL FOUR TARGET FILES EXIST.
#   Each path is `test -f`'d individually and named in the output. A renamed or
#   deleted file makes clause 2 vacuous, so it fails loudly here instead.
#
# CLAUSE 2 — NONE OF THEM READS `process.env`.
#   `rg -n 'process\.env' <four files>` must produce no output. Any match is
#   printed, so a failure names the file and line instead of just refusing.
#
# CLAUSE 3 — THE SCANNER IS PROVEN TO MATCH.
#   `rg -c 'process\.env' server/config.ts` must be > 0. That file is the
#   composition root's own env reader: the one file in `server/` that MUST read
#   the environment, because it is the boundary the charter puts the parsing
#   behind. If the same pattern, tool, and invocation find nothing THERE, the
#   clean result in clause 2 is a broken scan, not a clean tree. Deliberately
#   pointed at a file this lane does not touch and no future lane should empty.
#
# CLAUSE 4 — THE VALUES ARRIVE AT THEIR CALL SITES.
#   Four anchored fixed-string patterns, each matching EXACTLY once: 0 means
#   unwired, >1 means two composition paths that can disagree, which is the
#   doubled state this rung exists to end. Each pattern names the field
#   spelling that already exists in `ServerConfig`, so a rewiring lane adds the
#   call-site line and nothing else. See the ARRIVALS list below for the
#   per-pattern contract.
#
# CLAUSE 5 IS DELIBERATELY ABSENT.
#   L2b-1 carries a fifth clause that RUNS `server/tools/dependency-arrival.test.ts`
#   and asserts observable behavior at the far end. That clause is only writable
#   because the test file name was decided before the check was. No arrival-test
#   file name is decided for L2b-2, and inventing one here would assert against
#   a path no lane has agreed to create — a clause that can only ever fail is
#   not a gate, it is a typo waiting to be edited out.
#
#   Arrival for this rung is therefore proven by clause 4 PLUS the rewiring
#   lanes' own tests: each of the four rewirings is a signature change, so its
#   own lane must ship a test that passes a value in and observes it come out,
#   and that test is reviewed with the change that needs it. If a later lane
#   does settle on one exercising test file for all four, growing this script a
#   clause 5 in the L2b-1 shape is the right follow-up.
#
# Exit 0 only when all four clauses pass. Exit 3 is a harness error (missing
# tool / wrong repo root), which is NOT a fail of the thing under test.
#
# NO ARGUMENTS. Every input comes from the tree at $REPO_ROOT. A check that
# takes a path can be pointed at a tree where it passes, which makes its green
# a statement about the caller rather than about the repo.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

# The four readers this lane rewires. Listed literally rather than globbed: a
# glob that stops matching is exactly the vacuous pass clause 3 guards against,
# and naming them makes a rename fail loudly in clause 1.
TARGETS="server/tools/search-engine.ts
server/tools/shared-namespace.ts
server/tools/search-all.ts
server/observability/trace-config.ts"

# The positive control: the composition root's OWN env reader, which must keep
# reading `process.env` for the boundary to exist at all.
CONTROL="server/config.ts"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — every target file is present.
# ---------------------------------------------------------------------------
MISSING=""
N_TARGETS=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  N_TARGETS=$((N_TARGETS + 1))
  [ -f "$REPO_ROOT/$t" ] || MISSING="${MISSING}${t} "
done <<EOF
$TARGETS
EOF

if [ "$N_TARGETS" -ne 4 ]; then
  CLAUSE1_EVIDENCE="expected 4 target paths, the list yielded $N_TARGETS — the check itself is miswritten"
elif [ -n "$MISSING" ]; then
  CLAUSE1_EVIDENCE="target file(s) NOT found: ${MISSING}— a scan over missing files passes vacuously"
else
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="all 4 target files present under $REPO_ROOT"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — none of the four reads process.env.
# ---------------------------------------------------------------------------
if [ "$CLAUSE1" != PASS ]; then
  CLAUSE2_EVIDENCE="skipped — target files are not all present, so any result is vacuous"
else
  # Build the argument list from the same literal set clause 1 verified.
  set --
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    set -- "$@" "$REPO_ROOT/$t"
  done <<EOF
$TARGETS
EOF

  HITS="$(cd "$REPO_ROOT" && rg -n 'process\.env' "$@" 2>/dev/null)"
  RG_STATUS=$?
  # rg exits 1 for "no matches" (the pass) and 2 for a real error. A 2 is a
  # harness problem, not a clean tree, and must not be read as success.
  if [ "$RG_STATUS" -ge 2 ]; then
    fail_hard "rg failed with status $RG_STATUS scanning the four target files"
  fi

  if [ -n "$HITS" ]; then
    CLAUSE2_EVIDENCE="$(printf '%s\n' "$HITS" | wc -l | tr -d ' ') process.env read(s) remain:"
    CLAUSE2_HITS="$HITS"
  else
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="no process.env read in any of the 4 files — each value now arrives from validated config"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — positive control: the scanner still finds a known hit.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$CONTROL" ]; then
  CLAUSE3_EVIDENCE="positive control $CONTROL does not exist — cannot prove the scan matches anything"
else
  CONTROL_COUNT="$(cd "$REPO_ROOT" && rg -c 'process\.env' "$CONTROL" 2>/dev/null)"
  CONTROL_COUNT="${CONTROL_COUNT:-0}"
  if [ "$CONTROL_COUNT" -gt 0 ]; then
    CLAUSE3=PASS
    CLAUSE3_EVIDENCE="$CONTROL still contains $CONTROL_COUNT process.env line(s) — the pattern, tool, and invocation are proven to match"
  else
    CLAUSE3_EVIDENCE="$CONTROL contains ZERO process.env lines — either the composition root stopped reading the environment, or this scan is broken and clause 2's clean result is meaningless"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — the values ARRIVE at their call sites.
# ---------------------------------------------------------------------------
# Each entry is `<file>|<fixed-string pattern>`. `rg -F` so the pattern is read
# literally, and the count must be exactly 1: 0 is unwired, >1 is two
# composition paths. Every `config.` spelling below already exists on
# origin/main a80484b, so a rewiring lane adds the call-site line and does not
# have to invent a config field first:
#
#   (a) server/main.ts  `searchEmbeddingTimeoutMs: config.search.embeddingTimeoutMs`
#       TO SATISFY: add a `searchEmbeddingTimeoutMs?: number` field to
#       `MemoryToolDependencies` (server/tools/types.ts), have
#       `searchEmbeddingTimeoutMs()` in search-engine.ts take it as a parameter
#       instead of reading the env, and write this line into the dependencies
#       literal in server/main.ts (alongside `ftsCorpusConfig:` at :184).
#       `config.search.embeddingTimeoutMs` is server/config/env-groups.ts:227,
#       exposed as `ServerConfig.search` at server/config.ts:236,359.
#
#   (b) server/main.ts  `sharedNamespaceNames: config.sharedNamespaceNames`
#       TO SATISFY: add a `sharedNamespaceNames?: SharedNamespaceGroup` field to
#       `MemoryToolDependencies`, have `sharedNamespaceConfig()` take the group
#       rather than re-deriving it, and write this line into the dependencies
#       literal in server/main.ts. NOTE the spelling: the brief proposed
#       `sharedNamespaceEnv: config.sharedNamespace`, and `config.sharedNamespace`
#       is NOT that value — server/config.ts:235 declares it as the literal type
#       `"shared-kb"`, the canonical NAME only. The parsed five-field group is
#       `config.sharedNamespaceNames` (server/config.ts:245,363, built by
#       `sharedNamespaceGroup` at server/config/env-groups.ts:333), whose shape
#       already matches `SharedNamespaceConfig` field for field. Asserting the
#       proposed spelling would have gated on a value that cannot carry the
#       legacy names, the fallback flag, or the minimum result count.
#
#   (c) server/main.ts  `qmdPath: config.qmd.path`
#       AMENDED by the rewiring lane (#825, L2b-2). The pattern was
#       `searchAllEnv:`, written on the assumption that no validated field held
#       this value and that main.ts would therefore have to hand down a raw env
#       slice. That assumption was wrong: `server/config/env-groups.ts:188,304`
#       already parses QMD_PATH through `blankAsAbsent` into `QmdConfigGroup`,
#       exposed as `config.qmd` (`server/config.ts:238,361`), and
#       `server/config.test.ts:657` already proves input by input that
#       `config.qmd.path` answers exactly what `resolveQmdPath` answers.
#       Passing an env record beside an equivalent validated field would have
#       created the very second composition path the exact-1 rule exists to
#       catch, so the arrival asserts the validated field instead.
#       TO SATISFY: drop the `= process.env` default from `resolveQmdPath`
#       (server/tools/search-all.ts:124) and write this line into the
#       dependencies literal in server/main.ts. `MemoryToolDependencies.qmdPath`
#       (server/tools/types.ts:25) already exists, so no new field is needed.
#       What the lane may NOT do is leave the parameter defaulted, or leave a
#       `?? resolveQmdPath()` fallback at the consumer, because either one reads
#       as injected and behaves as a direct read.
#
#   (d) server/observability/langfuse-tracing.ts  `readMcpTracingConfig(config.`
#       TO SATISFY: drop the `= process.env` default from `readMcpTracingConfig`
#       (server/observability/trace-config.ts:33) and pass the validated group at
#       its only two non-test call sites (langfuse-tracing.ts:402,506, both
#       currently `readMcpTracingConfig()` with no argument).
#       `ServerConfig.tracing` is server/config.ts:246,367, built by
#       `tracingGroup` at server/config/env-groups.ts:359. The count of exactly 1
#       is deliberate even though there are two call sites: the two must resolve
#       through ONE shared `deps.config ?? …` expression rather than each
#       building its own, which is the same "two composition paths" defect the
#       exact-1 rule catches everywhere else in this file.
ARRIVALS="server/main.ts|searchEmbeddingTimeoutMs: config.search.embeddingTimeoutMs
server/main.ts|sharedNamespaceNames: config.sharedNamespaceNames
server/main.ts|qmdPath: config.qmd.path
server/observability/langfuse-tracing.ts|readMcpTracingConfig(config."

ARRIVAL_BAD=""
ARRIVAL_OK=0
N_ARRIVALS=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  N_ARRIVALS=$((N_ARRIVALS + 1))
  a_file="${entry%%|*}"
  a_pat="${entry#*|}"
  if [ ! -f "$REPO_ROOT/$a_file" ]; then
    ARRIVAL_BAD="${ARRIVAL_BAD}
    MISSING FILE $a_file (for: $a_pat)"
    continue
  fi
  a_count="$(cd "$REPO_ROOT" && rg -cF -- "$a_pat" "$a_file" 2>/dev/null)"
  a_count="${a_count:-0}"
  if [ "$a_count" -eq 1 ]; then
    ARRIVAL_OK=$((ARRIVAL_OK + 1))
  else
    ARRIVAL_BAD="${ARRIVAL_BAD}
    $a_file: found $a_count, expected 1 — \"$a_pat\""
  fi
done <<EOF
$ARRIVALS
EOF

if [ "$N_ARRIVALS" -ne 4 ]; then
  CLAUSE4_EVIDENCE="expected 4 arrival assertions, the list yielded $N_ARRIVALS — the check itself is miswritten"
elif [ -n "$ARRIVAL_BAD" ]; then
  CLAUSE4_EVIDENCE="$ARRIVAL_OK/4 values arrive; the rest are not wired:${ARRIVAL_BAD}"
else
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="all 4 values are passed exactly once from validated config"
fi

printf 'CLAUSE 1 (all 4 target files exist):                    %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (no process.env in any of the 4):              %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
if [ "$CLAUSE2" != PASS ] && [ -n "${CLAUSE2_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE2_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 3 (scanner proven to match in %s):   %s — %s\n' "$CONTROL" "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf 'CLAUSE 4 (values arrive from validated config):         %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ]; then
  exit 0
fi
exit 1
