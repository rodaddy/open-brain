# server/ hardening ladder — L1 through L6

**Status: L1 MERGED, L2 MERGED, L3 MERGED (#863, #865, #867, #869), L4 MET — 2026-08-27.** Ordering
approved by the operator. L1, both halves of L2, and L3 are on `origin/main`, and L4
is already met on `origin/main` as a side effect of the #780 lint sweep. L5 and
L6 are not started.

## What this file is, and what it is NOT

This is the EXECUTION SEQUENCE. The analysis, the target architecture, and the
dependency direction already exist in `_plans/463-server-rewrite-charter.md`
and are not restated here. Read that first; this file says what order to do it
in and what proves each rung done.

Measured numbers live in `_plans/server-quality-baseline.md`. Operator rulings
live verbatim in `_plans/server-rewrite-decisions.md`. Three files, three jobs.

## Supersession — read this before citing the charter's sequencing

The charter states the cutover is "sequenced after the Python applications
named by map issue #443 and issue #463" (`463-server-rewrite-charter.md:9`).

**That gate is superseded** by the operator, 2026-08-25/26. Inference moved to
k3s llama-swap, the localhost fallbacks are removed (PR #766), and the k3s CNPG
database exists at `10.71.20.167`. The operator's position: "the only thing we
really have to do is fix the code and then once that's fixed and fully verified
and tested then we bottle this up into Docker mode and ship it off to the K3S."
Dreaming work is explicitly later.

So `server/` hardening is the ACTIVE lane, not parallel-safe preparation for a
later gate. Everything else in the charter still stands as authority.

## Why this order

Each rung is a precondition for the next, not a preference:

- L2 constructs the logger, so L3 cannot come first.
- L4 splits files; doing it before L2/L3 means splitting them again when their
  config and logging change.
- L5 removes the `src/` imports, which is what lets `src/` be retired at all.
- L6 cannot start while the app still imports a tree that will not be in the
  image.

L1 is first because it is the only rung that stops the problem GROWING while
the other five are in progress.

**Superseded in part, 2026-08-26 (issue #780).** L1 armed the gate, and the
existing lint debt then blocked L2's own commits, so the operator ruled the
debt is paid one file at a time rather than rung by rung: the files blocking L2
go first, and for `server/tools/search-engine.ts` and
`server/observability/langfuse-tracing.ts` that means their L4 split is pulled
FORWARD into their lint lane rather than waiting for L4. The dependency
direction above still holds; what changed is that L4's work on those two files
arrives early because `max-lines` is one of their findings.

---

## L1 — Arm enforcement

**Deliverable.** `.oxlintrc.json` on `main`, pre-commit refusing staged content
that violates it.

**Status: MERGED 2026-08-26.** PR #771 (`c73a7f7`) landed both halves together,
which is what the rung required: `.oxlintrc.json` and the config-guarded
staged-content oxlint step in `_githooks/pre-commit`, plus the repo-local
`oxlint` dependency the hook invokes. The hook reads the INDEX copy of the
config, so an unstaged edit cannot decide how strictly staged content is
judged. Proven RED first by
`scripts/done-means/750-precommit-lint-gate-fires.sh`: a deliberately
violating file is REFUSED by the oxlint step by name, which is the bar this
rung set — not "the hook ran".

**Why it was first and cheap.** The hook step lints STAGED CONTENT and is
config-guarded, so landing it alongside the config was a wiring job, not new
hook code. The `sprint/standards-fmt` variant of `.oxlintrc.json` (rule values
copied from what the live code already did, plus test exemptions) was
superseded by the strict config that shipped in #771.

Staged-content scope is what makes this affordable: the 529 production and 3112
test violations are NOT a debt owed before the next commit. They are paid
per-file as work naturally touches them, and nothing new can enter.

**Rules and the numbers behind them** are in the baseline file. The one that
was argued: function ceiling 100 code lines, comments excluded, not the
exemplar's 50.

**Done means.** A deliberately-violating file staged and committed is REFUSED by
the oxlint step by name. RED first: prove it fails before trusting that it
passes. Not "the hook ran" — the hook must reject.

**Open, owed to the operator.** Whether tests carry the full rules including the
100-line ceiling. Recommendation on record: yes. The exemption is what allowed a
364-line test function in `src/tools/__tests__/append-session-event.test.ts`.

---

## L2 — Composition root

**Deliverable.** `server/main.ts` parses config once, fails hard on invalid,
constructs logger + pool + embedder client from the validated result, and hands
them down. `process.env` appears in `server/config.ts` and nowhere else in
`server/`.

**Status: L2a MERGED, L2b MERGED — 2026-08-26.** The rung splits into a schema
half and a rewiring half, and both have now landed: #825 moved the remaining
`server/` readers onto injected config and armed `node/no-process-env`, proven
by `scripts/done-means/750-l2a-config-covers-every-env-read.sh` and
`scripts/done-means/750-l2b2-lint-refuses-process-env.sh`.

L2a is merged as PR #778 (`49ecfbe`): every env var name read anywhere in
non-test `server/` code — 23 of them — is now declared in the validated schema,
with the fields the composition root does not yet inject living in
`server/config/env-groups.ts` and spread into `environmentSchema`. The parsers
there deliberately MIRROR their existing readers rather than tidying them,
because tightening a fallback into a hard rejection would turn a currently
booting deployment into a startup failure — a behavior change smuggled in under
a typing change. Proven by
`scripts/done-means/750-l2a-config-covers-every-env-read.sh`, which reads the
schema literal only (not the whole file) so a name mentioned in a comment
cannot satisfy it, and which fails if the scan collects fewer than 15 names so
a broken scan cannot pass as a clean repo.

L2a is the SCHEMA half only. Declaring the field is what makes rewiring a
consumer mechanical instead of behavioral; the rewiring is L2b/L2c, and until
then both the schema field and the original `process.env` reader exist on
purpose. That is why the baseline's process.env count went UP, not down, when
L2a landed.

L2b-1a — injecting the first four tool-layer env values from validated config —
is open as DRAFT PR #779, blocked by the lint gate L1 armed: the files it must
touch carry pre-existing violations, so the gate refuses the commit.

**The lint-debt ruling (operator, issue #780, 2026-08-26), verbatim:**

> Pay the debt one file at a time, each file brought fully to standard and
> passing before the next, lane after lane, until the whole app passes the
> standards. Order: the files blocking L2 first (server/main.ts,
> search-brain.ts, search-all.ts, search-engine.ts, langfuse-tracing.ts), then
> every remaining server/ file with findings. Each lane: one file,
> behavior-preserving, existing tests unmodified and green, done-means =
> oxlint --deny-warnings on that file exits 0 (RED on main).

142 findings across non-test `server/`, measured at `49ecfbe`; #780 carries the
per-file checklist. Two of the five blocking files —
`server/tools/search-engine.ts` (9 findings) and
`server/observability/langfuse-tracing.ts` (8) — include `max-lines` among
theirs, so **their L4 split is pulled forward into their lint lane**. They are
split once, here, rather than lint-fixed now and split again at L4.

**The defect, stated exactly.** `server/config.ts` (303 code lines as of
`49ecfbe`; 253 before L2a) is the schema half and it is good: `parseServerConfig` runs
`environmentSchema.safeParse()` and returns `{ok, config}` or structured issues.
Pure, no side effects.

What is missing is the other half. The operator, 2026-08-26: "does config.ts
fire up all of the logging and full configurations and everything and then pass
those down to the rest of the application? Because if not, then it's not the
same, just the same idea and the weaker one at that."

It does not. Nothing constructs the logger, pool, or embedder FROM it. So the
validator sits beside an application that never asks it, which is exactly why
files bypass it — nothing is downstream.

**Scope, measured at `49ecfbe`.** 12 non-test files in `server/` CONTAIN the
string `process.env` (was 11 before L2a). Three are not bypasses:
`server/config.ts` is the door, `server/main.ts` is where env enters the
process, and `server/config/env-groups.ts` names it only in comments. Eight are
real bypasses, unchanged by L2a because L2a typed them rather than rewiring
them:

    server/tools/shared-namespace.ts      3
    server/tools/search-engine.ts         2
    server/tools/fts-config.ts            2
    server/tools/search-all.ts            1
    server/tools/realtime-stores.ts       1
    server/tools/operator-doctor.ts       1
    server/observability/langfuse-tracing.ts  1
    server/config/nats.ts                 1
    server/application/nats.ts            1

**Enforcement.** Add `no-process-env` to `.oxlintrc.json` with an override
allowing it ONLY in `server/config.ts` and `server/main.ts`. That makes the rung
self-defending: once at zero it cannot regress.

**Done means.** `rg -c 'process\.env' server/ --type ts | rg -v '\.test\.ts:'`
returns only the door and the composition root as CODE readers, AND the lint
rule refuses a new one. `server/config/env-groups.ts` will still appear in that
command's output because it names the string in prose; `no-process-env` is what
distinguishes a reader from a mention, which is why the rule — not the grep —
is the real gate.

**Charter authority.** `server/config/` owns all env parsing and startup
validation; `server/application/` owns composition, startup and shutdown order
(charter §3). This rung implements that row.

---

## L3 — One logger, threaded

**Deliverable.** A single logger constructed in the composition root, carried
through the application, with decorators on functions and classes, and stack
traces on failure.

**Operator, 2026-08-25:** "it should just be a single logger and it should
travel the entire application using decorators for all of the functions and
classes... the decorator for logging should give stack traces so we can figure
it out."

**Depends on L2** because the logger is constructed FROM validated config. Doing
it first means building it against `process.env` and rebuilding it after.

**What exists.** `server/logging/` has `logger.ts`, `context.ts`
(AsyncLocalStorage), `crash-handlers.ts`, `sanitize.ts`.

**UNVERIFIED, must be checked before designing the delta.** Whether
`server/logging/logger.ts` conforms to `_DOCS/STANDARDS-observability.md`, and
whether any decorator path exists today. Do not assume either way. That check is
the first task of this rung, not an assumption inside it.

**Related and NOT lint-enforceable.** The operator also requires hard failure:
a function "should be wrapped properly around try something continue that
doesn't allow it to pass through safely it should fail hard if it fails."

`no-empty` with `allowEmptyCatch:false` catches `catch {}`. It does NOT catch
`catch (e) { logger.warn("failed") }`, which swallows just as completely while
looking responsible. That needs a shared error-handling helper, and it belongs
in this rung because the stack-trace requirement is the same requirement.

**Done means.** Domain modules do not import the logger directly; they receive
it. A thrown error inside a decorated function produces a log line carrying the
stack and the correlation id.

---

## L4 — Break the five oversize files

**Deliverable.** No non-test file in `server/` over 500 code lines.

**Status: MET 2026-08-26 as a side effect of #780.** The lint sweep split every
one of the five, not just the two that were pulled forward, so this rung's
deliverable is already true on `origin/main`. Code lines on `origin/main`,
blanks and comments stripped:

    461  server/observability/langfuse-tracing.ts
    478  server/tools/search-engine.ts
    330  server/tools/agent-context-pack.ts
    487  server/realtime/recovery-wal.ts
    361  server/tools/entities.ts

`./node_modules/.bin/oxlint --deny-warnings --ignore-pattern '**/*.test.ts'
server` exits 0 with `max-lines` at 500 armed (`.oxlintrc.json`), so no
non-test file in `server/` is over the mark. The two pulled-forward splits are
`ca349ad` (PR #795, `search-engine.ts`) and `5666c67` (PR #796,
`langfuse-tracing.ts`).

**Scope is exactly five files.** Code lines, comments and blanks stripped:

    982  server/observability/langfuse-tracing.ts
    837  server/tools/search-engine.ts
    729  server/tools/agent-context-pack.ts
    692  server/realtime/recovery-wal.ts
    581  server/tools/entities.ts

The sixth largest is 420 (`server/tools/source-registry.ts`), comfortably under.
This is five specific files, not a pervasive condition — worth stating because
"the code is too big" invites a rewrite when the answer is five splits.

**Two of the five are pulled FORWARD (issue #780).**
`server/observability/langfuse-tracing.ts` and `server/tools/search-engine.ts`
carry `max-lines` among their lint findings and both block L2, so their split
happens inside their per-file lint lane rather than waiting here. By the time
this rung runs, expect its scope to be the remaining three.

**Depends on L2 and L3** for the three that remain, so each is split once,
against its final config and logging shape, rather than split and then
re-touched. The two pulled forward accept that cost knowingly: they are split
against a config and logging shape that L2b/L3 may still move, because the
alternative is L2 staying blocked.

**Split along the charter's boundaries, not by line count.** Tool adapters
become thin: validate, authorize, call domain or repository, map response
(charter §3). A file over the ceiling is usually a tool file that also owns
schema, permission checks, SQL, and response construction. The split follows
those seams.

**Done means.** `max-lines` passes for every non-test file in `server/`, and no
behavior changed — the existing tests for those five files pass unmodified.

---

## L5 — Cut server/ free of src/

**Deliverable.** Zero imports from `src/` in non-test `server/` code.

**Scope, measured.** 50 import sites across 28 distinct modules. The two that
dominate:

    7  src/types.ts
    7  src/shared-namespace.ts

Then 2 sites each: tools/index, source-registry, sharing, promotion-service,
operator-doctor, nats-runtime, maintenance-queue, embedding, contract,
background-tracing. Then 18 modules at one site each.

Re-measure with:

    rg -oN "from ['\"][^'\"]*src/[^'\"]+" server/ --type ts \
      | rg -v '\.test\.ts:' | rg -o "src/[^'\"]+" | sort | uniq -c | sort -rn

**This is where the real work hides.** The other rungs are mechanical. Here each
of the 28 modules needs a decision: does it MOVE to `server/` under the
charter's boundaries, MERGE into an existing `server/` module, or DIE because
`server/` already has its replacement.

The operator was explicit that this is not a delete: "it's not a straight kill
source and switch to server. We have to reconfigure and rejigger a bunch of shit
that's shared between the two and then we move it all over from source to server
and then we rejigger it."

**Required artifact before any move.** A reconciliation table, one row per
module: `src/` path, the `server/` counterpart if one exists, whether they have
drifted, and the disposition. Files sharing a name across the two trees are the
dangerous ones — same name, drifted content, and picking the wrong one is a
silent behavior change.

**Done means.** The rg command above returns nothing, and `bun run
test:isolated` is green.

---

## L6 — Retire src/, containerize, ship

**Deliverable.** A Docker image running `server/main.ts`, deployed to k3s,
serving against the CNPG database at `10.71.20.167`. `src/` deleted.

**Operator:** "eventually, once we're done with the development work on this
here locally, we are going to create a Docker image of Open Brain which will
also live on the K3S cluster, and none of this will live locally here."

**Preconditions.** L5 at zero. The entrypoint flipped from `src/index.ts` to
`server/main.ts` in `package.json` — the charter notes no startup command
references `server/` today (`463-server-rewrite-charter.md:9`).

**Read before writing any manifest.** `STANDARDS-kubernetes.md` is not yet
synced into this repo. Sync it first; it governs GitOps and forbids side doors.

**Downstream gate applies here and not before.** Open Brain is a live dependency
of mcp2cli, generated agent skills, and Hermes agents. A host change is
client-facing: `docs/downstream-rollout.md` is mandatory, and "verified" means
the rtech-mcps, mcp2cli, Hermes runtime, and live canary steps are complete or
explicitly N/A.

**Data.** The corpus (178,282 vectors) has to move to the k3s database with a
verified restore receipt. The check that makes a restore safe is embedding model
and dimension EQUAL between source and target — verify that, not just row
counts.

**Done means.** The k3s service answers `/health` with embedding connected true,
the Mac's local clone is no longer required by anything, and `src/` is gone.

---

## Parallel, not on the ladder — RESOLVED 2026-08-26

Both items are closed. Kept so the next reader does not re-open them.

**The open PRs are merged.** #767 → `5ebf407`, #766 → `64af1d6`, #768 →
`0692b63`, #765 → `96978a8`. `origin/main` was at `96978a8` and RUNNING on the
local clone (`/health`: embedding true, db true) when this was written. It has
since moved to `49ecfbe` via #771 and #778; those two are MERGED, not verified
running.

**Open Brain capture works again.** The cause was not the SessionStart prose.
From #678 (2026-08-09) `src/contract.ts` advertised `agent_context_pack` v2 in
`capabilities` and v3 in `tool_contracts`; the Python client requires both at 3
(`client.py:78`) and returned `status: lost` for every capture. Fixed in #768
(hash `b9157706` → `4580a681`, 9 repo files + 3 in Development), with a drift
assertion in `src/contract.test.ts` that derives both version blocks from
source. The client takes JSON on stdin (`{"operation":"capture",...}`); there
is no `--event` flag. First captures that landed: events `bea4e90c` and
`d892a1ea`, read back from `ob_session_events`. Install the Python tools from a
clone at `origin/main`: `uv tool install --from <checkout>` reads the working
tree, and the dev checkout sits on a stale branch.
