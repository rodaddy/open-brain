# server/ quality baseline — measured, not remembered

Status: WRITTEN 2026-08-26. Numbers below are measured, each with the command
that produced it. Re-measure with those commands; do not re-derive by hand and
do not re-run the survey from scratch in a new session. That is what this file
exists to stop.

## Why this file exists

The survey behind these numbers was run twice, in two sessions, because the
first run lived only in conversation and a compact ate it. Measuring is cheap;
measuring the same thing three times because nobody wrote it down is not.

## Scope decision (operator, 2026-08-26)

Embedding and inference are SETTLED — inference on k3s llama-swap, localhost
fallbacks removed by PR #766. The database exists on k3s CNPG at
10.71.20.167, empty. Neither is the work.

The work is: get `server/` into a proper TypeScript application shape. Then
containerize. `src/` dies at the end of that, not at the start.

## The shape server/ already has

`server/` is NOT unstructured. It carries the layering already:

    server/application/   server/auth/       server/capture/
    server/config/        server/contracts/  server/db/
    server/domain/        server/logging/    server/maintenance/
    server/observability/ server/realtime/   server/security/
    server/tools/         server/transport/

99 non-test TypeScript files, 36 test files, 17,565 non-test CODE lines
(comments and blanks stripped).

    fd -e ts . server/ | rg -v '\.test\.ts$' | wc -l

This matters because the instinct after "the code is garbage" is to invent a
new layout. The layout is not the defect. What lives inside it is.

## Defect 1 — five files over the 500-line ceiling

CODE lines, comments and blanks excluded, sorted:

    982  server/observability/langfuse-tracing.ts
    837  server/tools/search-engine.ts
    729  server/tools/agent-context-pack.ts
    692  server/realtime/recovery-wal.ts
    581  server/tools/entities.ts

Next largest is 420 (`server/tools/source-registry.ts`), comfortably under.
So this is five specific files, not a pervasive condition.

Command (per file):

    sed -e 's://.*::' -e '/^\s*$/d' "$f" | rg -v '^\s*(\*|/\*)' | wc -l

## Defect 2 — config is a validator nothing consumes

`server/config.ts` (253 code lines) parses and validates: `parseServerConfig`
runs `environmentSchema.safeParse()` and returns `{ok, config}` or structured
issues. Pure function, no side effects. That is the schema half of Python's
`config.py` and it is good.

What is MISSING is the other half. Operator, 2026-08-26: "does config.ts fire
up all of the logging and full configurations and everything and then pass
those down to the rest of the application? Because if not, then it's not the
same, just the same idea and the weaker one at that."

It does not. There is no composition root. Nothing constructs the logger, the
pool, or the embedder client FROM the parsed config and hands them down, so
11 files in `server/` read `process.env` directly instead of receiving config:

    server/main.ts                        6
    server/tools/shared-namespace.ts      3
    server/config.ts                      3   <- legitimate, this is the door
    server/tools/search-engine.ts         2
    server/tools/fts-config.ts            2
    server/tools/search-all.ts            1
    server/tools/realtime-stores.ts       1
    server/tools/operator-doctor.ts       1
    server/observability/langfuse-tracing.ts  1
    server/config/nats.ts                 1
    server/application/nats.ts            1

    rg -c 'process\.env' server/ --type ts | rg -v '\.test\.ts:'

Eight files are the real bypass (excluding config.ts itself and main.ts, which
is where env legitimately enters). This is smaller than the 16 quoted from
memory in an earlier session — that number spanned src/ AND server/.

`server/config/` (a DIFFERENT thing from `server/config.ts`) holds only
`maintenance.ts` and `nats.ts` — subsystem config, not the keystone.

## Defect 3 — server/ still depends on src/

50 import sites in non-test `server/` code reach into `src/`, across 28
distinct modules. The two that dominate:

    7  src/types.ts
    7  src/shared-namespace.ts

Then a long tail at 2 and 1: tools/index, source-registry, sharing,
promotion-service, operator-doctor, nats-runtime, maintenance-queue,
embedding, contract, background-tracing, and 18 more at one site each.

    rg -oN "from ['\"][^'\"]*src/[^'\"]+" server/ --type ts \
      | rg -v '\.test\.ts:' | rg -o "src/[^'\"]+" | sort | uniq -c | sort -rn

This is the list that has to go to zero before `src/` can be retired. It is a
finite, enumerable list — 28 modules — not an unbounded refactor.

## Defect 4 — logging is not a single logger

`server/logging/` exists: `logger.ts`, `context.ts` (AsyncLocalStorage),
`crash-handlers.ts`, `sanitize.ts`. Operator assessment, 2026-08-25: "I don't
even think the logger is using what the standards say and it should just be a
single logger and it should travel the entire application using decorators for
all of the functions and classes."

UNVERIFIED as of this file: whether `server/logging/logger.ts` conforms to
`_DOCS/STANDARDS-observability.md`, and whether a decorator path exists. That
check has not been run. Do not assume either way.

## Repo-wide numbers (src/ + server/ together)

From the earlier survey. Kept because they sized the enforcement decision:

    8.79%   code duplication (jscpd)
    715     production lint violations at the exemplar's 50-line ceiling
    529     production lint violations at the agreed 100-line ceiling
    3112    lint violations in test files
    7       separate retry implementations

## The ceiling decision (operator, 2026-08-25)

Function ceiling is 100 CODE lines, comments and docstrings excluded — NOT the
exemplar's 50. Measured basis: of 333 functions over 50 code lines, the median
is 89, p75 146, p90 213, max 528. A 50-line ceiling mostly flags near-misses,
which is the signature of a limit tight enough to be ignored. 100 flags 147
functions that nobody defends.

Divergence from Python (50) is deliberate and must stay recorded in
`_DOCS/STANDARDS-typescript.md` or be resolved by moving Python too.

Also agreed: complexity 10, max-depth 3, max-params 4, max-lines 500,
no-explicit-any, no unused vars, `catch {}` banned. And: "remove any of the
fucking safeguard bullshit things that allow you to olay actually following
the rules" — so test exemptions come OUT of the lint config.

## Open questions, not yet answered

1. Do tests get the full rules including the 100-line ceiling? That makes
   3,112 test violations blocking. Recommendation on record: yes, because the
   exemption is what allowed a 364-line test function in
   `src/tools/__tests__/append-session-event.test.ts`.
2. Python 50 vs TypeScript 100: move Python, or document the divergence.

## Where the artifacts are

- `.oxlintrc.json` — committed as `2a89cf2` on `chore/oxlint-enforcement` in
  the clean clone at `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/clone-20260825`.
- `_githooks/pre-commit:221` — the config-guarded staged-content oxlint step
  exists only on `sprint/standards-fmt` (`b2d4252`, on hold, unpushed).
  `origin/main`'s hook has no oxlint step; a probe with `any` and
  `console.log` committed clean against it. L1 lands hook step and config
  together (see the ladder).
- PRs #765, #766, #767, #768 merged 2026-08-26; `origin/main` is `96978a8`,
  deployed to the local clone.
