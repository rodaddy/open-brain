# core01 cutover pre-flight — protocol test findings

Status: WRITTEN 2026-08-09. Product of a full top-to-bottom pre-cutover
protocol test (operator: "let's do a full on protocol test from top to
bottom inside out... I don't want to cut over to core01 and then find out
that we forgot this and the other thing"). Six read-only specialist audits
over the distinct pre-cutover surfaces, each returning findings classified
by cutover-blocker severity, plus a live re-run of the #578 E2E gate at the
head that would cut over (`f673299`).

**Headline: the E2E gate being green did NOT mean cutover-ready.** The gate
tests the running dogfood clone; every blocker below is about the *gap*
between that clone and core01, or about a surface the gate was never scoped
to see (backup, drift receipts, spool quarantine, the `tool` role). The
protocol test was the right call — we were one "cut over" away from moving
to core01 with a serving tree missing its capture instrumentation, a health
check blind to a dead role, a backstop silently dropping turns, and no
current backup.

Two findings are confirmed **RUNNING** by the controller's own hand this
session (live DB + disk), not merely reported by a subagent: the spool
quarantine drop (#680) and the `tool`-role liveness blind spot (#681).

## What is SOUND (proven, negative results matter)

- **Migrations** — idempotent, ordered, transactional, advisory-locked
  (`server/db/migrations.ts`), re-runnable; verified against the simulated
  core01 applied history (031→046 forward, no throw). NOT a blocker.
- **Watermark durability** — send-before-advance, re-raise-on-failure,
  unreadable-transcript skips advance. A process crash loses nothing.
- **Turn-capture ordering** — the watermark model covers a server-down
  capture (turn re-sent, not lost). The steady-state path is solid.
- **Namespace/delegation security** (tonight's #654/#657/#662/#666) —
  server role-gates the header, refusal is live-proven, defaults OFF are
  safe both client/server directions.
- **The test suite via `bun run test:isolated`** — 3761/35/0, load-bearing
  paths mutation-proven (auth predicate, #563 burst bound, delegation,
  spool). Trustworthy evidence — via that path only.
- **Repo-specific gates** — merge-gate, pr-body-gate, design-lookup-gate,
  contract-parity CI, PR-body CI all reject their crafted violations.
- **The #578 E2E gate itself** — re-ran green at `f673299`, 6/6 clauses,
  zero residue confirmed by outside query, control discriminates.

## CUTOVER-BLOCKERS (7)

| # | Issue | One line | Confirmed by controller |
|---|---|---|---|
| B1 | #674 | core01 runs `src/index.ts`; capture-health chain lives only in `server/main.ts` — absent from the production tree | yes (rg + entrypoint read) |
| B2 | #680 | spool quarantine = permanent silent drop; 15 turns + ~44 lifecycle events gone, `count=0` in DB, `spool_pending` reads 0 | **yes (DB query + disk)** |
| B3 | #681 | liveness observer blind to `tool` role — dead 8 days, 14,006 rows frozen, `/health` green | **yes (live DB + /health)** |
| B4 | #677 | no scheduled backup on core01; only backup 16 days / 15 migrations old; disk loss = catastrophic | yes (disk + docs) |
| B5 | #675 | core01 deploy: no revision proof, no feature signal, tars working tree, unversioned plist | yes (script read) |
| B6 | #678 | `schema_hash` drift receipt blind (mirror lags Zod); no client walks bounded-recall continuation | source-read |
| B7 | #679 | Development-wide safety gates fail OPEN in open-brain (`_ob/bin/ob-gate` unresolved) — **dev-safety, not core01-service** | yes (file inspection) |

## NOTES / SHOULD-FIX

- #676 — `DB_NAME` silently defaults to `open_brain` (identity config with a
  fallback; ledger 28/31). Selects which brain; verify explicitly at cutover.
- #682 — capture lower-severity cluster: typo'd health namespace green
  forever; empty `OBSERVATION_ENABLED` disables silently; chunked delivery
  vs 5s Stop deadline; latch stuck-degraded; unhealed lanes still accruing
  (2,777, premise behind the "stays lazy" ruling is stale); no Postgres test
  drives the observer gatherer SQL.
- #683 — test/CI: #563 bound's only catchers are Postgres-gated; anti-skip
  guard covers 16 of 51 live suites (2 unguarded are namespace-isolation);
  #665 mechanism corrected (runner concurrency, not shared DB).

## Ordered pre-flight (the batten-the-hatches list)

Do 1–7 before touching core01; 8–12 are the cutover run itself.

1. **B1 (#674):** operator decision — cut core01 to `server/main.ts`, or
   port the capture-health composition into `src/index.ts`. Architecture
   call, not a lane's. Blocks everything capture-health on core01.
2. **B2 (#680):** make quarantine loud — surface `quarantined_count` in
   `/health` + observer; decide the abandon-after-5 policy for durable
   memory; done-means: forced 5 failures → still pending OR fault raised,
   never a silent sidecar. Manually replay the existing sidecar or accept
   the loss, explicitly.
3. **B3 (#681):** seed `EXPECTED_ROLES` from the ingest enum; done-means: a
   dead `tool` role → `stale=true silent_roles=[tool]`. Investigate why
   `tool` capture stopped 2026-08-01 (may share cause with B2).
4. **B4 (#677):** schedule `backup.ts` on core01 (launchd); run ONE restore
   end-to-end at current schema; ensure the job can't overlap a deploy.
5. **B5 (#675):** port the revision proof + feature-signal assertion into
   the core01 deploy; version the plist; `git archive` the commit (not the
   working tree); check each worker port directly.
6. **B6 (#678):** reconcile `contract-schemas.ts` with the live Zod schema,
   bump version + hash, re-pin the client; survey mcp2cli/Hermes for
   budgetless broad recall callers.
7. **B7 (#679):** register the Development-wide safety gates so they resolve
   for open-brain; done-means: a destructive-delete and a fast-tool call are
   REFUSED in this repo.
8. Deploy to core01 (once B1/B4/B5 land).
9. Re-run the #578 E2E gate against core01 (it takes a base URL).
10. Re-run `563-bounded-recall.sh` against hosted core01.
11. Feature-signal proofs on core01: capture block live, all config keys in
    the child env, each worker on the new revision.
12. Downstream: rtech-mcps/mcp2cli/Hermes canary per `docs/downstream-rollout.md`.

## Provenance caveat

The enforcement audit's raw report contained injected instruction-shaped
text (harness-neutralized). Every claim marked "confirmed by controller"
was independently verified this session; unconfirmed subagent claims (e.g.
merge-gate bypass via `gh api`) are labeled as such in their issues and are
NOT treated as established.
