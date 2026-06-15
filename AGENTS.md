# Open Brain

MCP server providing a unified semantic brain over PostgreSQL + pgvector. TypeScript (Bun), with a Python client package at `python/openbrain-memory/`.


> Repo LAWs and workflow expectations are documented here for Codex and exposed to Claude through the `CLAUDE.md -> AGENTS.md` symlink.


## Stack

- **Runtime:** Bun 1.3.13
- **Database:** PostgreSQL 17 + pgvector (halfvec 768)
- **Embeddings:** Any OpenAI-compatible endpoint via `EMBEDDING_BASE_URL` (prod: local MLX server on 127.0.0.1:8791, `embeddinggemma-300m-8bit`); LiteLLM as optional fallback/extraction
- **Auth:** Per-consumer Bearer tokens (admin, agent, discord, n8n, readonly)
- **Deploy:** Mac Mini via launchd `com.rico.open-brain` (10.71.1.21:3100). LXC 208 decommissioned 2026-06-11; its Postgres (10.71.20.49) retained as a pre-cutover snapshot.

## Commands

```bash
bun install --frozen-lockfile   # install deps
bunx tsc --noEmit               # typecheck
bun run migrate                 # run migrations
bun test                        # run tests
```

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
- Do not hard-code `collab` as the only promotion target. Promotion and scan flows must accept and test `target_namespace` where relevant.
- Keep SQL parameterized. Table names may be interpolated only after Zod enum validation or another explicit allowlist.
- Put auth, namespace, and permission checks on the server side. Client-side convenience checks are not security controls.
- For every security/isolation bug fix, add a regression test that fails on the old behavior and proves the exact predicate, header binding, or call shape.
- Preserve DreamEngine dry-run behavior by default. No archive, promote, demote, or tier mutation should run from dream planning unless the caller explicitly opts into a mutating wrapper.
- Python client behavior must be covered by fake transport tests for headers, session lifecycle, error redaction, and wrapper call shapes. Live canaries stay env-gated.
- Python package source must pass `uv run mypy src/openbrain_memory` and `uv run ruff check src tests` with zero errors, matching the quality bar used by `/Volumes/ThunderBolt/Development/king-capital/king-signals`.
- Keep fixes scoped to the issue. Avoid broad refactors unless they are required to close the bug safely.
- When a review or post-merge issue exposes a missed pattern, update `docs/sme/` so the next swarm checks for it.

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
