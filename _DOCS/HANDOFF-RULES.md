# HANDOFF RULES — open-brain (layer 0.1)

Repo-specific rules every handover in this repo needs. Overrides
HANDOFF-BASE.md; overridden by the handover document. Keep short; add a rule
only when a session actually needed it.

## Execution posture (operator ruling 2026-08-25)

1. **The head orchestrates and does not do the work.** It cuts tasks,
   dispatches, verifies, integrates. Inline work is limited to what
   delegation cannot help: one exact lookup, one deterministic single-file
   edit. A head that spends its turns editing files is off-contract.
2. **Lanes are 10-15 minutes.** A lane that would run 30 minutes was cut
   wrong, not slow. Re-cut until it fits. Expect MANY lanes landed per round;
   a round that produces one lane was under-dispatched.
3. **Batches of 5-6 concurrent, never more.** Larger fan-outs overload the
   machine. One dispatch per worker so each lane is its own visible row.
   Scopes are disjoint and one file has one owner — two lanes never share a
   file; entangled files mean sequenced lanes, not parallel ones.
4. **Failure is a valid outcome WITH RECEIPTS.** A lane that fails but reports
   exactly what it ran, what it saw, and where it stopped is a good outcome.
   The head re-cuts a SMALLER task and sends a new worker carrying what the
   first one learned. Never a bigger one. No receipts = not done.
5. **A scribe runs the whole session.** Records land AS work lands, never
   batched at wrap: every landed change gets its issue comment, every gap
   becomes an issue, every commit reaches the forge, at the moment it happens.
6. **Graph mode always.** Agent produces, script judges, hook enforces.
   Declare the tier by blast radius. Behavior- or security-relevant work is
   RED-first: the check is SEEN failing before the fix makes it pass.
7. **Proper tests, not excessive ones.** Functional input/output tests at the
   real boundary, proven able to fail. No coverage gates, no re-running what
   is already proven, no test-writing as a substitute for the fix.

## Repo facts that trap sessions

8. The application exists TWICE — `src/` (legacy) and `server/` (rewrite) —
   and the halves have diverged. A fix landed in one twin looks fixed and is
   not. Before calling any behavior change done, check whether the file has a
   twin (`server/tools/` vs `src/tools/`) and which one the running service
   loads. `server/main.ts` is the live entrypoint; it imports
   `src/tools/index.ts` as `import type` only.
9. The dependency between the trees is CIRCULAR (`src/index.ts:7,49` import
   from `server/`). Neither side detaches until that edge is cut. Do not plan
   an archive or retirement lane that assumes one-way dependence.
10. Test evidence: `bun run test:isolated`, never bare `bun test`. Postgres
    tests SKIP SILENTLY without `OPENBRAIN_TEST_DATABASE_URL`, and full-suite
    runs against the dogfood database return a different failure count each
    time (#614). A bare `bun test` count is not evidence in a PR, issue, or
    review verdict.
11. `psql` needs no connection arguments here: `set -a; . ./.env; set +a` then
    bare `psql`. There is no `DATABASE_URL`; the app reads `DB_*` and `psql`
    does not. Hand-building a connection fails.
12. `_DOCS/STANDARDS-*.md` are GENERATED and carry a `source-hash`. Never
    hand-edit them. A rule change goes in the Development `_DOCS/` source,
    then `bun _ob/scripts/sync-repo-standards.ts open-brain` refreshes them.
13. core01 was OUT OF SCOPE (operator ruling 2026-08-25 morning) and is back
    IN scope for one purpose only (ruling 2026-08-25 evening, epic #762): the
    service leaves the Mac, to core01 at minimum, likely a k3s Postgres box.
    Until a #762 step executes, core01 still serves the old version, both
    workers return 503, and it is not a blocker for anything else.
14. Every behavior lane carries an executable check in `scripts/done-means/`,
    written RED-first. The checker declares done, never the lane
    (`docs/sop-rlvr-lanes.md`).
15. Workflow dispatch has two gates that fail on shape, not intent. The
    routing gate requires the router snippet from
    `/Users/rico/.claudex/workflows/mixed-model-routing.snippet.js` copied
    BYTE-EXACT, comments included -- a hand-written equivalent is refused. The
    same gate reads string literals for review vocabulary
    (review/verify/SME/gauntlet/antagonist/reconciler) and joins string
    concatenations before scanning, so splitting a word to evade it does not
    work and is a policy violation besides. Word build lanes as what they do:
    "confirm", "check", "prove".
16. Worker lanes cannot reach the forge. They have no `gh` and no network, so
    the head carries every receipt to the issue or PR as scribe. Do not brief
    a lane to comment on an issue.
17. `_githooks/pre-push` runs `bun test` on the WORKING TREE, not the pushed
    tip (#761). A dirty checkout refuses every push, including a clean
    docs-only branch. Push from a clean clone (a cc-* box, or a fresh clone
    under the temp workspace); never `--no-verify` as an agent. To commit
    from a dirty checkout without switching, build the commit with a
    temporary index (`GIT_INDEX_FILE=<scratch> git read-tree <base>`,
    `git add`, `git write-tree`, `git commit-tree`, `git branch -f`).
18. The embedder is a fleet service, not a project host: `embed-gemma-dense`
    on k3s `ai/llama-swap` at `https://llama-swap.rodaddy.live/v1`, admitted
    to clone mode only through `OPEN_BRAIN_EMBEDDING_HOST_ALLOW`. TN01
    `10.71.1.11:8080` and the local MLX unit are dead; point nothing at them.
    The ingress has shown ~1-minute `503 no available server` windows
    (rtech-infra#1110); the clone rides through them.
