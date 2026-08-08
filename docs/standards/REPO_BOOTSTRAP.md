# Repo Bootstrap SOP

Canonical checklist for creating a new repo in the Development ecosystem.
Follow it in order; every step is required unless Rico explicitly waives it.
Written 2026-07-09 after pages-platform was bootstrapped ad-hoc (board filed on
the wrong control plane, no board map — the exact failures this SOP prevents).

## 1. Before creating anything

- Confirm the GO: repo creation is outward-facing shared state. Name, owner
  (rodaddy vs King-Capital), and visibility are Rico's decisions — ask if not
  already given.
- Match visibility to the repo family (check a sibling: `gh repo view <sibling>
  --json visibility`).
- Check `glossary/repos.md` for naming/namespace fit; add the new repo to it.

## 2. Create + clone

- `gh repo create <owner>/<name> --private|--public -d "<one-line purpose>"`
- Clone to the canonical local home: `/path/to/open-brain/Development/<name>`
  (never under another repo, never in temp).
- Create the matching temp area `{temp_workspace}/<name>/` with `_archive/`.

## 3. Bootstrap contents (initial commit to main is the ONLY direct-main commit)

- `README.md` — what it is, architecture/decisions summary, pointer to the plan
  (plan HTML lives on `/mnt/collab/sites/<name>/plans/`, per planf3 — not in
  the repo).
- `AGENTS.md` — the CANONICAL session contract for all agents: plan pointer,
  ratified decisions (so they don't get re-litigated), branch discipline
  (never work in main), board pointer, review tier, temp workspace path.
  `CLAUDE.md` is a thin Claude shim using Claude Code's import syntax —
  `@AGENTS.md` on its own line pulls the canonical contract into context
  every session — plus a Claude-Specific Deltas section. Never byte-copies,
  never symlinks; hooks/CI verify the shim contains the `@AGENTS.md` import.
  Standard shim:

  ```markdown
  # <repo> — Claude Shim

  @AGENTS.md

  AGENTS.md above is the canonical session contract; if this file and
  AGENTS.md disagree, AGENTS.md wins unless a rule here is stricter.

  ## Claude-Specific Deltas
  - (Claude-only notes; shared policy goes in AGENTS.md)
  ```
- `.gitignore` — deps/build, `.env*`, keys, logs, OS noise.
- `.github/workflows/` CI skeleton — per the CI security baseline in
  `CODING_STANDARDS.md`: explicit least-privilege `permissions:`, third-party
  actions pinned by commit SHA, no event-expression interpolation in `run:`.
- Enforcement rails from day one, matched to the repo's DECLARED stack —
  tracked `_githooks/` + `scripts/install-hooks.sh` (`core.hooksPath` —
  visible name, never `.githooks/`: no hidden folders rule); pre-push and CI
  command-identical, stack-gated steps for the other stacks stay dormant.
  Do NOT add tooling config for a stack the repo doesn't use (no speculative
  `pyproject.toml` in a TS repo): the stack's config lands in the same PR as
  its first file. Python rails when Python lands: ruff format + ruff check
  incl. pydocstyle `D` rules google convention (module D100, package
  `__init__.py` D104, class/function D101-D103 are gate failures), mypy
  strict, Python ≥3.13 — full baseline in `CODING_STANDARDS.md`.
- No hidden (dot-prefixed) folders for project content anywhere in the repo —
  only git/GitHub-mandated dot-paths (`.git/`, `.github/`, `.gitignore`).
- `specs/<plan-name>.verify.sh` checker skeleton if the repo is plan-driven —
  every gate SKIP-with-reason until its implementing PR replaces it.
- `docs/decisions.md` — the ratified decision log.
- **In-repo standards + temp workspace — run the two scripts, do not hand-roll:**

  ```bash
  bun _ob/scripts/sync-repo-standards.ts <repo>   # writes repo _DOCS/STANDARDS-*.md
  bun _ob/scripts/init-temp-workspace.ts <repo>   # creates the _* temp buckets
  ```

  The first writes only the bundles matching the repo's DECLARED stack (same
  no-speculative-config rule as the rails above) and reports remaining gaps
  without fixing them. The second is also invoked by the first, so running the
  sync alone is enough; it is listed separately because an existing repo may
  need only the buckets. Both are idempotent — re-run them any time, and
  whenever Rico says *"make sure this repo is up to standards"*. Details:
  `CODING_STANDARDS.md` (`## In-Repo Standards`).
- After the bootstrap commit: all further work is branch → PR → `Closes #N`.

## 4. Board (BEFORE filing any issues) — see BOARD_FIELDS.md

- Create the **repo-owned** project: `gh project create --owner <owner>
  --title "<name>"`. Never use a global/cross-repo board as the default
  control plane for repo-scoped work.
- Add the convention fields (Review Gate, Validation, plus program-specific
  fields) and link: `gh project link <num> --owner <owner> --repo <owner>/<name>`.
- Record the board map in BOTH places: `docs/board-map.md` in the repo AND a
  section appended to `_DOCS/BOARD_FIELDS.md` (URL, number, ownership, fields
  and values, automation owner, required transitions).

## 5. Issues

- Epic first, then small independently trackable issues. Group related issues
  into coherent PRs according to `_DOCS/GIT_STANDARDS.md`; issue boundaries do
  not require matching branch or PR boundaries.
- Every issue added to the repo board at creation
  (`gh project item-add <num> --owner <owner> --url <issue-url>`).
- Sub-issues reference the epic (`Part of #N`); PRs carry `Closes #N`.
- If the repo supersedes prior issues elsewhere, close them with pointer
  comments in the same pass.

## 6. Cross-cutting registrations

- Plan HTML + amendments updated (repo created, issues filed, forward refs).
- Update `glossary/repos.md` and any router/docs that enumerate repos.
- qmd source index: give the repo its own project-local index so an agent
  standing in it can answer questions about its own code instead of asking.
  An unindexed repo is invisible to the fast lookup path, so sessions re-derive
  from raw files — or worse, ask the user how their own software works.

  ```bash
  cd /path/to/repo
  bun /path/to/open-brain/Development/_ob/bin/qmd-backfill
  ```

  The backfill is resumable and skips any repo that already has `.qmd/`, so
  running it after adding a repo indexes only the new one. It writes the
  allowlist config, indexes, embeds, and adds `.qmd/` to `.gitignore`.

  **Do not use `qmd collection add`.** That registers into the shared global
  index (2.2 GB, every repo), which is the thing project-local indexes replace:
  a query from inside the repo then competes with every other repo's code.

  The index must be scoped by an ALLOWLIST, not a mask plus exclusions — see
  `_DOCS/STANDARDS-repo-search.md`. A broad mask indexes build output, virtual
  envs, and vendored trees, which is how one repo reached 121,415 files.

  Registration alone is not enough — an index that is never refreshed decays
  into a snapshot of the day it was created. `qmd update` from inside the repo
  is sub-second; run it when the tree has moved.
- Infra wiring (DNS, Caddy, runners, LXC) belongs in `rtech-infra` as declared
  config — never hand-wired (rico-rojas.com was erased because it never was
  declared).
- Session memory/OB checkpoint: record the program, board number, and the
  "which session owns the build" decision.

## 7. Verify before reporting done

- CI green on the bootstrap commit.
- Board: correct project, issue count matches, no strays on other boards.
- Thin Claude shim contract:
  `test -f CLAUDE.md && test ! -L CLAUDE.md && test "$(grep -Fxc '@AGENTS.md' CLAUDE.md)" -eq 1 && grep -Fxq '## Claude-Specific Deltas' CLAUDE.md && ! cmp -s CLAUDE.md AGENTS.md`.
  This fails for a missing, empty, symlinked, or byte-copied shim while
  requiring exactly one standalone `@AGENTS.md` import plus the standalone
  deltas heading documented above.
- Checker syntax: `bash -n specs/*.verify.sh`.
