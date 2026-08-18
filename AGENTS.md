<!-- STANDARDS-SYNC-BANNER (delete this block when done) -->
> ## ⚠️ NEW/UPDATED STANDARDS — READ BEFORE WRITING CODE
>
> Development standards were synced into this repo. Read the ones relevant to
> your change **before** writing code. They override habit and older repo prose.
>
>   - `_DOCS/STANDARDS-core.md`
>   - `_DOCS/STANDARDS-observability.md`
>   - `_DOCS/STANDARDS-testing.md`
>   - `_DOCS/STANDARDS-git.md`
>   - `_DOCS/STANDARDS-repo-search.md`
>   - `_DOCS/STANDARDS-typescript.md`
>   - `_DOCS/STANDARDS-python.md`
>   - `_DOCS/STANDARDS-ci-security.md`
>
> Highlights that are commonly gotten wrong — read these even if you read
> nothing else:
>
> - **NEVER `/tmp`, `$TMPDIR`, or `mktemp -d`. HARD RULE.** `/tmp` is process-
>   and sandbox-local: a runner, a Codex sandbox, and the host each see a
>   *different* one, so anything written there is invisible to everyone else and
>   vanishes without notice. Use `{temp_workspace}/open-brain/_scratch/`. This gets
>   broken by reflex — a one-line `> /tmp/foo.txt` inside an otherwise correct
>   task — so treat any `/tmp` path in a command you are about to run as a bug,
>   the same way you would treat `rm -rf`.
> - **Commit in the repo that owns the files, and commit before you stop.** The
>   git boundary is the responsibility boundary: you are responsible for this
>   repo's git state and nothing else. If a task takes you into another repo, the
>   work lands *there*, on that repo's branch, with its own message — never
>   version repo A's artifact inside repo B, because it escapes A's history
>   entirely. Uncommitted work is the expensive failure: dirty files carry no
>   author and no reason, so they sit outside the audit trail that makes every
>   other mistake cheap to undo. See `_DOCS/STANDARDS-git.md`.
> - **Do not hand-roll solved problems.** Prefer an existing repo helper → a
>   well-known maintained library → the standard library → custom code. An empty
>   dependency list on a new repo is NOT a reason to write your own logger, HTTP
>   client, retry, config loader, or validator.
> - **No coverage gates.** Coverage percentages and line/branch targets are not
>   acceptance criteria. Write functional input/output tests at the function,
>   class, or public boundary, and prove a new test can fail before trusting it.
> - **You are in this repo, so you own it — search it before asking.** Asking
>   the user how their own software works is a failure, not diligence. One
>   command does all of it, from any repo:
>   `aqmd "question"` (this repo, with the shared `_DOCS`/`_ob` policy
>   appended) · `aqmd up` (refresh after you write files) ·
>   `aqmd -r <repo> "question"` (one named repo, without leaving this one;
>   repeatable as `-r a -r b` or `-r a,b` for several, one labelled block
>   each) · `aqmd internal "question"` (the shared policy only) ·
>   `aqmd research "question"` (prior art only). Never `cd` to another repo
>   to search it and `cd` back. Know the exact word instead of the idea →
>   `sqlite3 .qmd/index.sqlite` is faster and needs nothing installed. Details
>   and the missing-index fix are in `_DOCS/STANDARDS-repo-search.md`.
>
> Refresh these copies with:
> `/Volumes/ThunderBolt/Development/_ob/bin/sync-repo-standards open-brain`
>
> **When this repo is up to standard, close this work item by running:**
> `/Volumes/ThunderBolt/Development/_ob/bin/sync-repo-standards --ack open-brain`
>
> That removes this block and leaves the one-line marker below it in place. Do
> not hand-delete it: dropping the marker makes this banner return on the next
> sync, and deleting past the end marker eats the top of this file. The marker
> is what stops the banner coming back; a later rule change raises a new one.
<!-- /STANDARDS-SYNC-BANNER -->
<!-- standards-acknowledged: 0f777779a478 -->

# Open Brain

MCP server providing a unified semantic brain over PostgreSQL + pgvector. TypeScript (Bun), with a Python client package at `python/openbrain-memory/`.


> Repo LAWs and workflow expectations are documented here and apply to every
> runtime. `CLAUDE.md` is a thin router that points here and carries only
> Claude-specific deltas; this file wins unless a rule there is stricter.


## Standards (in this repo)

The Development standards that apply here are copied into `_DOCS/` so you do not
have to leave the repo to read them. Read the ones relevant to your change
before writing code:

- `_DOCS/STANDARDS-core.md` — workspace hygiene, quality bar, minimal correct
  change, secrets. **Includes the temp-workspace rules: never `/tmp`,
  `$TMPDIR`, or `mktemp -d`; use `{temp_workspace}/open-brain/_scratch/`.**
- `_DOCS/STANDARDS-observability.md` — the shared log envelope, required on
  every emitter.
- `_DOCS/STANDARDS-typescript.md`, `_DOCS/STANDARDS-python.md` — per-stack rules.
- `_DOCS/STANDARDS-git.md`, `_DOCS/STANDARDS-ci-security.md`.

These are **generated** from `/Volumes/ThunderBolt/Development/_DOCS/` and carry
a `source-hash`. Never hand-edit them — a rule change goes in the source
document, then `bun _ob/scripts/sync-repo-standards.ts open-brain` refreshes the
copies. Run that same command when asked to bring this repo up to standards; it
also creates the temp-workspace buckets.

Repo-specific rules below this line override the copies when stricter.

## Stack

- **Runtime:** Bun 1.3.13
- **Database:** PostgreSQL 18 + pgvector (halfvec 768)
- **Embeddings:** Any OpenAI-compatible endpoint via `EMBEDDING_BASE_URL` (prod: local MLX server on 127.0.0.1:8791, `embeddinggemma-300m-8bit`). Hosted prod sets `EMBEDDING_WATCHDOG_RESTART_SCRIPT` so repeated provider failures bounce the local MLX embedding daemon.
- **Auth:** Per-consumer Bearer tokens (admin, agent, discord, ob-admin, promoter, readonly)
- **Deploy:** core01 Mac Mini via launchd `com.rico.open-brain` (10.71.1.21:3100). Source lives in `/Volumes/ThunderBolt/Development/open-brain`; the running app lives in `/Volumes/ThunderBolt/open-brain/app`; qmd runtime/index lives in `/Volumes/ThunderBolt/qmd`.
- **core01 runs multiple workers; this machine runs one.** `10.71.1.21:3100` is a front over `open-brain-worker-1` (3101) and `open-brain-worker-2` (3102) — confirmed 2026-07-30 from the `workers` array in `/health`, which the single-process local service does not emit. Session caps are **per worker** (`DEFAULT_MAX_SESSIONS = 100`, `src/transport.ts`), so core01 has ~200 slots and load balancing while local has 100 and neither. **Do not size capacity or concurrency against the local service and assume it transfers.** `curl -s http://10.71.1.21:3100/health` answers this in under a second; guessing at it produced a wrong conclusion once already.
- **Hosts — there are exactly two.** This machine while developing, and core01 when the dev work is done. No other database or service host belongs to this project. Retired LXC hosts may still answer on the network and still hold old Open Brain data; that does not make them valid. Do not point config, docs, canaries, or tooling at one, and do not treat a successful connection as evidence a host is in scope.
- **Retired hosts are out of scope, not worthless.** Earlier Open Brain attempts left databases that still hold real thinking — design specs, SOPs, and decisions that predate the current epics and were never carried forward as reasoning. Leave them alone: do not connect, query, migrate, or drop anything. They are not this repo's data, and reading them is not part of any task here. If a question genuinely needs that history, it is an explicit, operator-approved archaeology task with its own scope — never a side quest inside other work. The default is: this project does not touch them.
- **Prior-art clones live at `/Volumes/ThunderBolt/open-brain-local/research/`** — `gbrain`, `cognee`, `cognee-integrations`, `graphiti`, `honcho`, `mem0`, as real git clones. Read prior art from **source, not marketing**; that is what made the existing borrow-list usable. Findings belong in `docs/prior-art/`, not in a scratch directory. Anything borrowed — code *or* idea — gets attribution: see `docs/prior-art/ATTRIBUTION.md`.
- **Search that prior art with the `research` qmd index — do not grep six trees.** All six clones are indexed as one named index, so a single query crosses all of them, which is the whole point: the useful prior-art question is comparative ("how does each of these model X?"), and that is exactly what six separate searches answer badly.

  ```bash
  aqmd research "how are temporal relationships modeled"   # all six clones
  aqmd in graphiti "how are edges deduplicated"            # one clone
  aqmd all "question"        # this fleet AND the clones, in one query
  ```

  `aqmd` resolves the index for you and refuses to run unscoped. The explicit
  form still works and is what `aqmd` calls underneath:

  ```bash
  qmd query "how are temporal relationships modeled" --index research
  qmd query "..." --index research -c graphiti    # one project only
  qmd search "SearchConfig" --index research       # BM25, ~0.1s
  qmd get "#df268b"                                # open a hit by docid
  ```

  Use `--index research`, never `INDEX_PATH`: that swaps only the database and
  silently inherits the global collection list, mixing our own fleet code into
  prior-art results. `-c <project>` narrows to one clone.

  **The clones stay pristine.** The index lives in `~/.cache/qmd/research.sqlite`,
  not in the checkouts — nothing is written into them, so `git pull` stays clean
  and upstream diffs stay honest. Never run `qmd init` or `qmd collection add`
  inside one.

  Rebuild after pulling new upstream commits, or if the index is missing
  (it is a cache, so it is expendable and rebuildable):

  ```bash
  /Volumes/ThunderBolt/Development/_ob/bin/qmd-reference-index
  ```

  Rebuilding re-embeds and is GPU-bound — minutes, not seconds. Only do it when
  the sources have actually moved. Process notes: `_DOCS/QMD_INDEXES.md`.

## Commands

```bash
bun install --frozen-lockfile   # install deps
bunx tsc --noEmit               # typecheck
bun run migrate                 # run migrations
bun run test:isolated           # run tests — the trustworthy default (#614)
bun test                        # quick single-file iteration only; see below
```

### `bun run test:isolated` — the default way to run the suite

`bun run test:isolated` (`scripts/test-isolated.ts`) creates a uniquely-named
database, migrates it, points `OPENBRAIN_TEST_DATABASE_URL` at it, runs
`bun test` with whatever arguments you pass, prints the database name, and drops
the database on the way out — including on SIGINT/SIGTERM. If the drop itself
fails it prints the orphan's name and the exact `dropdb` line rather than
leaking quietly.

```bash
bun run test:isolated                              # whole suite
bun run test:isolated src/maintenance-queue.pg.test.ts   # one file
```

It invents no new mechanism: creation is CI's `createdb -E UTF8 -T template0`
(`.github/workflows/ci.yml:68`, by way of `scripts/lane-bootstrap.ts
--fresh-db`), migrations run through the existing `bun run migrate` path, and
`bun test` itself is unchanged.

**A full `bun test` run against the dogfood database is NOT evidence.** It
returns a different failure count each time on unmodified code — 49 → 43 → 40
across consecutive runs (#614, 2026-08-06; same class as #498) — while the same
tree against a fresh database is clean. Shared mutable state is the contaminant,
not the tests (#613 documents one concrete leakage mechanism). Bare `bun test`
remains fine for quick single-file iteration; do not cite its full-suite counts
in a PR, an issue, or a review verdict.

### Querying the dogfood database

`.env` carries the standard libpq vars (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`)
alongside the app's `DB_*` ones, so **`psql` needs no connection arguments**:

```bash
set -a; . ./.env; set +a
psql -At -c "select count(*) from ob_session_events;"
```

Do NOT hand-build a connection. There is no `DATABASE_URL` in this repo, the app
reads `DB_*` and `psql` does not, and bare `psql` defaults to a `rico` database
that does not exist. Deriving it by hand cost five failed calls every time,
repeatedly, until the libpq vars were added on 2026-07-29.

The dogfood database is `open_brain_local_20260724` on `127.0.0.1` — the real one
for this machine while in dev/dogfood mode. Note that `bun test` Postgres tests
SKIP SILENTLY without `OPENBRAIN_TEST_DATABASE_URL`, so a green run may have
tested nothing. `bun run test:isolated` sets that variable for you, which is the
other reason to prefer it.

## Codex Durable Memory

Codex memory protocol and rollout guidance lives in
`docs/memory-contract.md`. Read it before changing session lifecycle tools,
`brain_answer`, eval fixtures, or AGENTS/skill directives that force Open Brain
as Codex durable memory.

## Downstream Rollout Gate

Open Brain is a live dependency of mcp2cli, generated agent skills, and Hermes
agents. Before closing an issue or reporting a PR complete, read
`docs/downstream-rollout.md` and classify whether downstream rollout applies.
For MCP tool/schema/protocol/client-facing changes, "verified" means the
applicable rtech-mcps, mcp2cli, rtech-hermes Python runtime/plugin, and live
Hermes agent canary steps are complete or explicitly marked not applicable.

## Critical Self-Review Pre-PR Gate

Before opening or marking a non-trivial PR ready, the author or controller MUST
run a critical self-review and include a concise receipt in the PR body or a PR
comment. This is a separate author-side gate and does not replace fresh-context
review swarms, CI, or fix-verification.

Required receipt:

```text
Critical self-review:
- Highest-risk behavior:
- Assumptions that could be wrong:
- Missing/weak tests:
- Security/permission risk:
- Migration/deploy risk:
- Downstream client/runtime risk:
- Rollback/cleanup concern:
- Fixes made before PR:
- Known residual risk:
```

If the self-review finds a material issue, fix it before requesting review or
mark it as deferred only with explicit Rico approval. Do not use empty
"all good" language; name the risks checked and the evidence behind them.

## Python Package

```bash
cd python/openbrain-memory
uv sync
uv run mypy src/openbrain_memory
uv run ruff check src tests
uv run pytest -q
```

## Operating Mode: RLVR Lanes (repo default)

Adopted by operator decision 2026-08-08 (ledger item 12, `docs/issue-graph.md`)
and codified in `docs/sop-rlvr-lanes.md` — READ IT before dispatching or
accepting implementation work in this repo. The short form: work dispatches
from the computed frontier (`bun scripts/issue-graph.ts`) to worker lanes
briefed from `docs/lane-contract.md`; every lane carries an executable
done-means check written red-first; the checker declares done, never the lane;
the controller re-runs the check before merge; every lane report is harvested
into the lane contract's Tightenings (mandatory merge-pass step); decisions are
reviewed WITH the operator and recorded in the ledger. INLINE work remains
correct for conversation, exact lookups, and tiny deterministic changes.
**No variations** (operator, 2026-08-08): the process is used all the time as
the default standard; a deviation is flagged for a ruling, never taken
silently, and a broken process step fails HARD and gets fixed through the
decisions loop — never worked around. Where compliance needs forcing, the
step gets a hook (last-ditch tier, per the controller contract's enforcement
migration).

## Coding Standards

- Do not code on `main`; branch first and keep unrelated local files out of commits.
- Treat namespace isolation as a security boundary. Any ID-based read or mutation must include an auth-derived namespace predicate unless the token-sourced role is intentionally global.
- Use `shared-kb` for shared Open Brain knowledge. Promotion and scan flows
  must accept and test `target_namespace` where relevant, with legacy `collab`
  treated only as an internal migration source.
- Keep SQL parameterized. Table names may be interpolated only after Zod enum validation or another explicit allowlist.
- Put auth, namespace, and permission checks on the server side. Client-side convenience checks are not security controls.
- For every security/isolation bug fix, add a regression test that fails on the old behavior and proves the exact predicate, header binding, or call shape.
- Preserve DreamEngine dry-run behavior by default. No archive, promote, demote, or tier mutation should run from dream planning unless the caller explicitly opts into a mutating wrapper.
- Python client behavior must be covered by fake transport tests for headers, session lifecycle, error redaction, and wrapper call shapes. Live canaries stay env-gated.
- Python package source must pass `uv run mypy src/openbrain_memory` and `uv run ruff check src tests` with zero errors, matching the quality bar used by `/Volumes/ThunderBolt/Development/king-capital/king-signals`.
- Keep fixes scoped to the issue. Avoid broad refactors unless they are required to close the bug safely.
- **Nothing is adjusted silently** (operator ruling, 2026-08-08). Any script, tool, or lane that transforms its input to satisfy a constraint — shortens a name to fit a bound, substitutes a default, skips a step as N/A, coerces a value — announces the adjustment in its normal output: original → adjusted, and why. Provably-safe and cosmetic adjustments are not exempt; the transcript must let the reader map what was asked for to what exists. SME entry: `docs/sme/entries/2026-08-08-nothing-is-adjusted-silently-tools-announce-every-self-made-decision.md`.
- When a review or post-merge issue exposes a missed pattern, update `docs/sme/` so the next swarm checks for it.
- For contract-changing MCP, transport, Python client, or agent-facing changes,
  follow `docs/downstream-rollout.md`; do not treat local tests or hosted
  Open Brain smokes alone as the full definition of done.

## Review Swarms and SME Knowledge

`docs/sme/` contains a review-swarm knowledge base seeded from PRs #72-#76 and post-merge issues #77-#82. Each file maps to a reviewer lane:

| Lane | SME File |
|------|----------|
| Correctness | `docs/sme/correctness.md` |
| Adversarial | `docs/sme/adversarial.md` |
| Quality | `docs/sme/quality.md` |
| Security | `docs/sme/security.md` |
| Backend/Domain | `docs/sme/domain-backend.md` |
| Gotcha Agent | `docs/sme/gotcha-agent.md` |

**Before spawning a review swarm**, read and inject the matching SME file into each reviewer's prompt. The gotcha-agent lane is **mandatory** for any PR touching `python/openbrain-memory/`.

**After each swarm cycle**, update the SME knowledge base. The lane files are
GENERATED — write one file per finding in `docs/sme/entries/` and run
`bun scripts/build-sme-indexes.ts`. Never edit a lane file directly; the next
build overwrites it. Format and `order` rules: `docs/sme/README.md`.
- Promote new MEDIUM+ findings as new entry files with `lane:` set to the matching lane, carrying provenance (issue/PR, severity, status).
- Mark resolved patterns as `Status: superseded` -- don't delete, the history matters.
- If the swarm missed something that surfaces post-merge, add an entry with `lane: gotcha-agent` so the next cycle catches it.

**Periodic validation:** The KB can go stale. Run a validation pass occasionally -- an agent reads each SME file, checks whether the findings still apply against current code (grep for the functions/patterns named, check if issues are closed, verify the code paths still exist), and either confirms, updates, or marks entries superseded. Stale findings waste reviewer attention and erode trust in the KB. A good trigger is after a significant refactor, a batch of issue closures, or if it's been more than a few weeks since the last check.

The KB grows with every review. Each swarm starts smarter than the last. See `docs/sme/README.md` for capture rules and PR comment format.
