#!/usr/bin/env bash
# DONE-MEANS check for the operator ruling of 2026-08-09 — "the mirrors are not
# mirrors. They are artifacts ... when completed, we should show that they are
# completed. And so when we do an AQMD search, they're known to be completed,
# and they explain the direction we went in and why we went in them."
#
#   bash scripts/done-means/issue-resolution-artifacts.sh
#
# ---------------------------------------------------------------------------
# WHAT THE EXISTING DESIGN SAYS, AND WHAT THE DELTA IS
# ---------------------------------------------------------------------------
# `scripts/sync-issues.ts` is NOT being replaced, and no parallel artifact
# system is being introduced. Its header (lines 1-29) already states the whole
# premise this ruling extends: issue bodies live on the forge, nothing in the
# working tree can search them, and "COMMENTS ARE THE POINT, NOT THE BODY"
# because the comments carry the corrections that reshaped the issue. One
# generated file per issue, overwritten every sync, never hand-edited. All of
# that stays exactly as it is.
#
# THE GAP the ruling names: for a CLOSED issue, `render()` emits `State: CLOSED`
# and a `Closed:` timestamp and stops. The RESOLUTION — which direction was
# taken and why — lives in the closing PR: its body (which in this repo carries
# the done-means evidence and the critical self-review), its merge commit, and
# its merge time. The artifact never captured any of it. So a completed node
# reads as CLOSED with no account of how, which is precisely the state the
# ruling says is wrong: an aqmd search finds the question and not the answer.
#
# The delta is therefore ONE new rendered section, `## Resolution`, on closed
# issues only, sourced from the issue timeline.
#
# ---------------------------------------------------------------------------
# WHY THE TIMELINE, AND NOT `closedByPullRequestsReferences`
# ---------------------------------------------------------------------------
# MEASURED, 2026-08-09, not assumed. The obvious field is empty here:
#
#   gh api graphql -f query='query{repository(owner:"Rodaddy",name:"open-brain"){
#     issue(number:681){ closedByPullRequestsReferences(first:10,
#       includeClosedPrs:true){ nodes{ number } } } }}'
#   => {"nodes":[]}
#
# ...even though PR #687 demonstrably closed #681. The reason is this repo's
# flow: lanes squash-merge into `wip/2026-08-07`, not into the default branch,
# so GitHub's auto-close linkage never registers and that connection stays
# empty. A generator built on it would render an empty Resolution for the exact
# issues that have one, which is worse than no section — it would assert
# absence.
#
# The timeline carries it. Over the 25 most recently closed issues, measured:
#
#   closer = PullRequest : 20/25   direct link
#   closer = Commit      :  2/25   correlate the SHA against cross-referenced
#                                  PR merge commits (#681 -> 31589d1 -> #687)
#   closer = null        :  3/25   closed by hand; no PR exists to find
#
# 22 of 25 resolve to a PR by closer-or-SHA-correlation. The remaining 3 are a
# real shape, not a failure, and clause (c) pins their behaviour.
#
# CROSS-REFERENCES ARE NOISY AND ARE NOT A PR LIST. #659 is cross-referenced by
# PRs 660, 663, 688 and 689; only #660 closed it. Cross-references are used
# SOLELY to resolve a closer COMMIT SHA to the PR whose mergeCommit equals it.
# Rendering them as "possibly related PRs" would put four candidate directions
# on an issue that took one, and a reader cannot tell which — an artifact that
# makes the answer ambiguous fails the ruling as surely as an absent one.
#
# ---------------------------------------------------------------------------
# WHERE THIS CHECK STANDS TO SEE THE DEFECT, AND WHAT IT CANNOT SEE
# ---------------------------------------------------------------------------
# The renderer is the SHIPPED function, imported from `scripts/sync-issues.ts`.
# What is substituted is the NETWORK: timeline payloads come from
# `scripts/done-means/fixtures/issue-resolution-timelines.json`, recorded
# verbatim from the live API on 2026-08-09. Two of the three shapes are real
# recorded issues (#681 commit-closer, #636 null-closer); the third
# (direct-PR-closer) is synthetic and labelled `_synthetic` in the fixture.
#
# PR bodies are stored in the fixture IN FULL — 9,627 characters for #687 —
# because the body IS the direction-and-why payload under test. A shortened
# fixture copy could not prove the artifact carries the reasoning.
#
# ITS LIMITATION, STATED (the round-22 Tightening). A recorded fixture cannot
# see a change in GitHub's live timeline schema. Clause (e) exists for exactly
# that: it runs the REAL query against the REAL API for #681 and asserts the
# recorded shape still matches what GitHub returns today. If GitHub moves, (e)
# goes red and names the drift instead of the fixture quietly going stale. (e)
# needs network and `gh` auth; it SKIPS LOUDLY without them and says so in the
# result line, and a skip is never counted as a pass.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) A CLOSED issue whose closer is a COMMIT renders a `## Resolution`
#       section naming the closing PR, its merge SHA, its merged-at, and its
#       BODY. This is the #681/#687/31589d1 case — the one the obvious API
#       field cannot see. The check reads the expected PR number, SHA and a
#       body phrase FROM THE FIXTURE, never from a literal here, so re-recording
#       the fixture moves both sides together and cannot leave a stale literal
#       passing.
#
#   (b) A CLOSED issue whose closer is a PULL REQUEST renders the same section.
#       The common shape; without it the feature would work only for the rare
#       one.
#
#   (c) A CLOSED issue with NO closing PR RENDERS AND DOES NOT CRASH. It states
#       what the timeline actually has — close actor and state reason — and it
#       must NOT name a PR. Both halves in one clause (the round-18 rule): a
#       renderer that emitted nothing would satisfy "names no PR", and a
#       renderer that crashed would satisfy nothing. #636 is the real instance.
#
#   (d) CONTROL — an OPEN issue renders NO Resolution section. A check that only
#       ever finds the section proves the string was added, not that it is
#       conditioned on closure. This is the clause that proves discrimination.
#
#   (e) THE FIXTURE STILL MATCHES LIVE GITHUB (network; skips loudly). Proves
#       the recorded shape is current rather than an archaeological artifact.
#
#   (f) THE GENERATED HEADER SURVIVES. The file's own rule — these files are
#       generated and overwritten, hand edits are lost — must still be stated in
#       every rendered artifact, including ones carrying a Resolution.
#
# ---------------------------------------------------------------------------
# WHAT THIS SCRIPT TOUCHES, AND WHAT IT REFUSES TO
# ---------------------------------------------------------------------------
# It writes nothing into the repository. It creates no database, needs no
# credentials beyond `gh` auth for clause (e), talks to no deployment, and
# touches neither the dogfood database nor core01. It contains no `rm` of any
# kind. Scratch output goes under the temp workspace. It resolves the driver and
# the renderer from its OWN tree (BASH_SOURCE-derived root), so it structurally
# cannot measure a different checkout than the one it ships in (round 23).
#
# ---------------------------------------------------------------------------
# EXPECTED TO FAIL BEFORE THE CHANGE
# ---------------------------------------------------------------------------
# On the pre-change generator `render()` takes no timeline, emits no
# `## Resolution`, and does not even export itself for a driver to call.
# Clauses (a), (b) and (c) fail. RED transcript is in the PR body.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

DRIVER="${REPO_ROOT}/scripts/done-means/issue-resolution-artifacts.driver.ts"
FIXTURE="${REPO_ROOT}/scripts/done-means/fixtures/issue-resolution-timelines.json"

FAILURES=0
SKIPS=0
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
skip() { printf 'SKIP  %s\n' "$*"; SKIPS=$((SKIPS + 1)); }

printf '=== done-means (operator ruling 2026-08-09): does a completed issue artifact carry its resolution — the direction taken and why? ===\n\n'

for required in "${DRIVER}" "${FIXTURE}"; do
  if [[ ! -f "${required}" ]]; then
    fail "missing required component: ${required}"
    printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
    exit 1
  fi
done

SCRATCH_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/issue-resolution-artifacts"
mkdir -p "${SCRATCH_DIR}"
OUT="${SCRATCH_DIR}/render-$$.json"
info "receipt: ${OUT}"

set +e
LOG="$(DONE_MEANS_RESOLUTION_OUT="${OUT}" bun "${DRIVER}" 2>&1)"
DRIVER_EXIT=$?
set -e
printf '%s\n' "${LOG}" | tail -25
if [[ ${DRIVER_EXIT} -ne 0 ]]; then
  fail "driver exited ${DRIVER_EXIT} — clause results below may be unreadable"
fi

read_json() {
  # $1 = key. Prints MISSING (never the empty string) when absent, so an absence
  # is visible in the transcript and every later clause stays reachable under
  # `set -u` (the round-24 sentinel lesson from #671's first RED run).
  local value
  value="$(bun -e 'const f=Bun.file(process.argv[2]);if(!(await f.exists())){console.log("MISSING");process.exit(0)}let r;try{r=await f.json()}catch{console.log("MISSING");process.exit(0)}const v=r[process.argv[3]];console.log(v===undefined||v===null?"MISSING":(Array.isArray(v)?JSON.stringify(v):String(v)))' \
    x "${OUT}" "$1" 2>/dev/null)"
  printf '%s' "${value:-MISSING}"
}

is_true() { [[ "$1" == "true" ]]; }

# ---------------------------------------------------------------------------
# (a) commit-closer — the #681 -> 31589d1 -> #687 case
# ---------------------------------------------------------------------------
printf '\n--- (a) a commit-closed issue names the closing PR, its SHA, its merged-at, and its body ---\n'

A_RENDERED="$(read_json commit_closer_rendered)"
if is_true "${A_RENDERED}"; then
  pass "(a) the shipped renderer ran on the commit-closer shape and produced output"
else
  fail "(a) the renderer produced no output for the commit-closer shape (rendered=${A_RENDERED}); every assertion below would be vacuous"
fi

A_SECTION="$(read_json commit_closer_has_resolution)"
if is_true "${A_SECTION}"; then
  pass "(a) the artifact carries a '## Resolution' section"
else
  fail "(a) no '## Resolution' section — a completed node still reads as CLOSED with no account of how"
fi

# Expectations come from the FIXTURE via the driver, never a literal here.
A_EXPECT_PR="$(read_json commit_closer_expected_pr)"
A_EXPECT_SHA="$(read_json commit_closer_expected_sha)"
A_EXPECT_PHRASE="$(read_json commit_closer_expected_body_phrase)"

if [[ "${A_EXPECT_PR}" =~ ^[0-9]+$ && "${A_EXPECT_SHA}" =~ ^[0-9a-f]{40}$ && -n "${A_EXPECT_PHRASE}" && "${A_EXPECT_PHRASE}" != "MISSING" ]]; then
  pass "(a) the driver derived specific expectations from the fixture (PR #${A_EXPECT_PR}, sha ${A_EXPECT_SHA:0:7}) — not hardcoded in this script"
else
  fail "(a) the driver's expectations are absent or malformed (pr=${A_EXPECT_PR} sha=${A_EXPECT_SHA} phrase=${A_EXPECT_PHRASE}); assertions against them would prove nothing"
fi

# PROVE THE EXPECTATION BEFORE TRUSTING IT. The first draft of the driver built
# its phrase by filtering long words and joining them, fabricating a string that
# appears nowhere in the body — so the body clause went red against a CORRECT
# renderer and read exactly like a renderer defect. An expectation that is not
# present in the source measures the driver's arithmetic, not the artifact.
if is_true "$(read_json commit_closer_phrase_is_in_source)"; then
  pass "(a) the derived phrase is genuinely a contiguous run of the source PR body — the next clause measures the renderer, not the driver"
else
  fail "(a) the derived phrase is NOT in the source PR body; the body assertion below would be measuring the driver's own derivation"
fi

for field in pr_number sha merged_at body; do
  key="commit_closer_names_${field}"
  if is_true "$(read_json "${key}")"; then
    pass "(a) the Resolution names the closing PR's ${field}"
  else
    fail "(a) the Resolution does NOT name the closing PR's ${field}"
  fi
done

# The body is the direction-and-why payload. Naming the PR without carrying its
# reasoning would satisfy "a link exists" while failing the ruling outright.
A_BODY_CHARS="$(read_json commit_closer_body_chars_rendered)"
A_BODY_SOURCE_CHARS="$(read_json commit_closer_body_chars_source)"
if [[ "${A_BODY_CHARS}" =~ ^[0-9]+$ && "${A_BODY_SOURCE_CHARS}" =~ ^[0-9]+$ ]] \
   && (( A_BODY_CHARS >= A_BODY_SOURCE_CHARS )); then
  pass "(a) the PR body reaches the artifact WHOLE (${A_BODY_CHARS} of ${A_BODY_SOURCE_CHARS} source chars) — the reasoning is not shortened away"
else
  fail "(a) the PR body did not reach the artifact intact (rendered=${A_BODY_CHARS} source=${A_BODY_SOURCE_CHARS}); a partial body is a partial answer"
fi

# ---------------------------------------------------------------------------
# (b) direct PR closer — the common shape
# ---------------------------------------------------------------------------
printf '\n--- (b) a PR-closed issue renders the same section ---\n'
if is_true "$(read_json pr_closer_has_resolution)" && is_true "$(read_json pr_closer_names_pr_number)"; then
  pass "(b) the direct-PR-closer shape renders a Resolution naming its PR — the 20-of-25 case is covered"
else
  fail "(b) the direct-PR-closer shape did not render a Resolution naming its PR"
fi

# ---------------------------------------------------------------------------
# (c) closed with NO PR — renders, states what the timeline has, names no PR
# ---------------------------------------------------------------------------
printf '\n--- (c) a closed-without-PR issue renders what the timeline has and does not crash ---\n'
C_RENDERED="$(read_json no_pr_rendered)"
C_THREW="$(read_json no_pr_threw)"
if is_true "${C_RENDERED}" && [[ "${C_THREW}" == "false" ]]; then
  pass "(c) the renderer completed without throwing on a null closer"
else
  fail "(c) the renderer failed on a null closer (rendered=${C_RENDERED} threw=${C_THREW}) — the sync would break on 3 of every 25 closed issues"
fi

# Both halves in ONE clause: it must SAY something, and it must not invent a PR.
C_STATES="$(read_json no_pr_states_close_facts)"
C_NAMES_PR="$(read_json no_pr_names_a_pr)"
if is_true "${C_STATES}" && [[ "${C_NAMES_PR}" == "false" ]]; then
  pass "(c) it states the close actor and state reason AND names no PR — honest about having no PR rather than silent or speculative"
else
  fail "(c) states_close_facts=${C_STATES} names_a_pr=${C_NAMES_PR} — either it said nothing, or it attributed a PR that did not close it"
fi

# ---------------------------------------------------------------------------
# (d) CONTROL — an OPEN issue gets no Resolution section
# ---------------------------------------------------------------------------
printf '\n--- (d) control: an OPEN issue renders NO Resolution ---\n'
D_HAS="$(read_json open_issue_has_resolution)"
D_RENDERED="$(read_json open_issue_rendered)"
if is_true "${D_RENDERED}" && [[ "${D_HAS}" == "false" ]]; then
  pass "(d) the open issue rendered normally and carries no Resolution — the section is conditioned on closure, not merely present in the template"
else
  fail "(d) rendered=${D_RENDERED} has_resolution=${D_HAS} — an open issue must not claim a resolution"
fi

# ---------------------------------------------------------------------------
# (f) the GENERATED header survives on a Resolution-carrying artifact
# ---------------------------------------------------------------------------
printf '\n--- (f) the generated-file header survives ---\n'
if is_true "$(read_json commit_closer_has_generated_header)"; then
  pass "(f) the 'GENERATED ... do not edit' header is still present on an artifact carrying a Resolution"
else
  fail "(f) the GENERATED header is missing — the file's own no-hand-edit rule would be unstated on exactly the files most worth editing by hand"
fi

# ---------------------------------------------------------------------------
# (e) the fixture still matches live GitHub (network; skips LOUDLY)
# ---------------------------------------------------------------------------
printf '\n--- (e) the recorded fixture still matches what GitHub returns today ---\n'
if ! command -v gh >/dev/null 2>&1; then
  skip "(e) gh is not installed — the fixture's currency is UNPROVEN this run, not proven"
elif ! gh auth status >/dev/null 2>&1; then
  skip "(e) gh is not authenticated — the fixture's currency is UNPROVEN this run, not proven"
else
  LIVE_JSON="$(gh api graphql -f query='
    query($owner:String!,$repo:String!,$number:Int!) {
      repository(owner:$owner,name:$repo) {
        issue(number:$number) {
          number stateReason
          timelineItems(last:40, itemTypes:[CLOSED_EVENT,CROSS_REFERENCED_EVENT]) {
            nodes { __typename
              ... on ClosedEvent { closer { __typename ... on PullRequest { number } ... on Commit { oid } } }
              ... on CrossReferencedEvent { source { __typename ... on PullRequest { number mergeCommit{oid} } } } } } } } }' \
    -F owner=Rodaddy -F repo=open-brain -F number="$(read_json commit_closer_issue_number)" 2>&1)"
  if [[ $? -ne 0 ]]; then
    skip "(e) the live query failed (network or auth); the fixture's currency is UNPROVEN this run"
    printf '      %s\n' "$(printf '%s' "${LIVE_JSON}" | head -3)"
  else
    LIVE_MATCH="$(printf '%s' "${LIVE_JSON}" | bun -e '
      const live = await Bun.readableStreamToJSON(Bun.stdin.stream());
      const fx = await Bun.file(process.argv[2]).json();
      const want = fx.commit_closer;
      const got = live?.data?.repository?.issue;
      if (!got) { console.log("no-issue"); process.exit(0); }
      const closerOf = (n) => n.timeline ? n.timeline.find(x=>x.__typename==="ClosedEvent")?.closer
                                         : n.timelineItems.nodes.find(x=>x.__typename==="ClosedEvent")?.closer;
      const w = closerOf(want), g = closerOf(got);
      if (!w || !g) { console.log("no-closer"); process.exit(0); }
      if (w.__typename !== g.__typename) { console.log(`closer-type:${w.__typename}!=${g.__typename}`); process.exit(0); }
      if ((w.oid ?? w.number) !== (g.oid ?? g.number)) { console.log("closer-value-drift"); process.exit(0); }
      console.log("match");' x "${FIXTURE}" 2>&1)"
    if [[ "${LIVE_MATCH}" == "match" ]]; then
      pass "(e) live GitHub still returns the recorded closer shape for #$(read_json commit_closer_issue_number) — the fixture is current, not archaeology"
    else
      fail "(e) the fixture no longer matches live GitHub: ${LIVE_MATCH} — re-record it and re-check the correlation logic"
    fi
  fi
fi

printf '\n'
if [[ ${SKIPS} -gt 0 ]]; then
  printf 'NOTE  %d clause(s) SKIPPED — skipped is not passed; what they cover is unproven this run.\n' "${SKIPS}"
fi
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== RESULT: PASS — completed issue artifacts carry the closing PR, its merge SHA and its full body; a closed-without-PR issue renders honestly; open issues claim nothing ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
