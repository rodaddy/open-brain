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
>
> **Also outstanding in this repo** (reported by the sync, never auto-fixed):
>   - no _githooks/ (tracked hooks, core.hooksPath)
>   - has .githooks/ -- hidden folder, migrate to _githooks/
>
> Refresh these copies with:
> `bun /Volumes/ThunderBolt/Development/_ob/scripts/sync-repo-standards.ts open-brain`
>
> **When this repo is up to standard, close this work item by running:**
> `bun /Volumes/ThunderBolt/Development/_ob/scripts/sync-repo-standards.ts --ack open-brain`
>
> That removes this block and leaves the one-line marker below it in place. Do
> not hand-delete it: dropping the marker makes this banner return on the next
> sync, and deleting past the end marker eats the top of this file. The marker
> is what stops the banner coming back; a later rule change raises a new one.
<!-- /STANDARDS-SYNC-BANNER -->
<!-- standards-acknowledged: 44f96e3f7d04 -->

# Open Brain

MCP server providing a unified semantic brain over PostgreSQL + pgvector. TypeScript (Bun), with a Python client package at `python/openbrain-memory/`.


> Repo LAWs and workflow expectations are documented here for Codex and exposed to Claude through the `CLAUDE.md -> AGENTS.md` symlink.


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
- **Hosts:** There are exactly two. This machine while developing, and core01 when the dev work is done. No other database or service host is valid for Open Brain — do not reintroduce retired LXC addresses.
- **Local dogfood clone:** If you see `OB ✗ gate unavailable`, or nothing is listening on `127.0.0.1:3100`, the local clone is just not running. Read the restart section at the top of `docs/local-clone-dogfood.md` and run `bun run scripts/local-clone.ts --verify && bun run scripts/local-clone.ts --start` after sourcing `/Volumes/ThunderBolt/open-brain-local/local-clone.env`. The config and all six auth tokens already exist in that file — do not write a new `.env` or generate tokens, and do not use the repo `.env` for the clone.

## Commands

```bash
bun install --frozen-lockfile   # install deps
bunx tsc --noEmit               # typecheck
bun run migrate                 # run migrations
bun test                        # run tests
```

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

**After each swarm cycle**, update the SME files:
- Promote new MEDIUM+ findings into the matching lane file with provenance (issue/PR, severity, status).
- Mark resolved patterns as `Status: superseded` -- don't delete, the history matters.
- If the swarm missed something that surfaces post-merge, add it to `gotcha-agent.md` so the next cycle catches it.

**Periodic validation:** The KB can go stale. Run a validation pass occasionally -- an agent reads each SME file, checks whether the findings still apply against current code (grep for the functions/patterns named, check if issues are closed, verify the code paths still exist), and either confirms, updates, or marks entries superseded. Stale findings waste reviewer attention and erode trust in the KB. A good trigger is after a significant refactor, a batch of issue closures, or if it's been more than a few weeks since the last check.

The KB grows with every review. Each swarm starts smarter than the last. See `docs/sme/README.md` for capture rules and PR comment format.
