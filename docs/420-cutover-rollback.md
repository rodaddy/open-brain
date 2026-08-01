# #420 settings.json cutover — verify & rollback

PROV-11 cut `~/.claude/settings.json` over from the hash-pinned TypeScript
adapter (`adapters/versions/sha256-.../ob-memory-provider/claude-hook.ts`) to the
Python `openbrain` console-script hooks installed with `uv tool`. This document
is the operator's runbook for verifying the new path is active, verifying it is
absent, and restoring the previous settings in one command.

`~/.claude/settings.json` is OUTSIDE this repo, so it is not versioned here. The
backup taken before the cutover, the installed console scripts, and the env
wrapper are all outside the repo too. What lives in the repo: this doc, the
`openbrain-session-start` console-script declaration
(`python/openbrain/pyproject.toml`), and the surviving TS the settings now point
at (`_ob/scripts/...`, a separate repo).

## What the cutover changed (per hook event)

| Event | Before (hash-pinned) | After |
|-------|----------------------|-------|
| `Stop` | `bun --env-file=… sha256-…/claude-hook.ts` | `sh …/openbrain-hook-env openbrain-capture-stop` |
| `SubagentStop` | (not wired) | `sh …/openbrain-hook-env openbrain-capture-subagent-stop` |
| `SessionEnd` | `bun … claude-hook.ts` | `sh …/openbrain-hook-env openbrain-session-end` |
| `PostCompact` | `bun … claude-hook.ts` | `sh …/openbrain-hook-env openbrain-post-compact` |
| `SessionStart` | `bun … claude-hook.ts` | `sh …/openbrain-hook-env openbrain-session-start` |
| `UserPromptSubmit` / `PreCompact` | `bun … claude-hook.ts` (no-op) | removed |
| `context-budget-gate.ts` (7 events) | `sha256-…/context-budget-gate.ts` | `/Volumes/ThunderBolt/Development/_ob/scripts/context-budget-gate.ts` |
| `guard.ts` (PreToolUse Bash) | `sha256-…/ob-memory-provider/guard.ts` | `/Volumes/ThunderBolt/Development/_ob/scripts/ob-memory-provider/guard.ts` |

The `_ob/scripts/...` copies are the surviving source-of-truth the sha256 store
was built from; they are not part of the retirement.

### Install mechanism

The provider is installed as a `uv tool` from `python/openbrain/`:

```
uv tool install --force /Volumes/ThunderBolt/Development/open-brain/python/openbrain
```

This links five console scripts into `~/.local/bin/` (on the settings `PATH`):
`openbrain-capture-stop`, `openbrain-capture-subagent-stop`,
`openbrain-session-end`, `openbrain-post-compact`, `openbrain-session-start`.
No `sha256-` path is involved; a `uv tool install --upgrade` re-bakes the same
stable names.

### Env delivery

The Python config REJECTS any `OPENBRAIN_*` variable it does not declare
(`config.unknown_prefixed_variables`), and the hooks swallow that rejection —
so sourcing the whole `claudex-observation.env` (which carries
`OPENBRAIN_OBSERVATION_*`, `OPENBRAIN_ALLOW_INSECURE_HTTP`, `OPENBRAIN_NAMESPACE`)
would silently zero every capture. The wrapper
`~/.local/share/openbrain-memory/env/openbrain-hook-env` sources that file and
passes the child ONLY the two accepted variables (`OPENBRAIN_BASE_URL`,
`OPENBRAIN_TOKEN`) via `env -i`. The token stays in the env file; it is never
written into `settings.json`.

## Verify the NEW path is ACTIVE

```
rg -c 'openbrain-capture-stop' ~/.claude/settings.json     # expect >= 1
rg -c 'sha256-'                ~/.claude/settings.json      # expect 0
rg -c 'claude-hook.ts'         ~/.claude/settings.json      # expect 0
command -v openbrain-capture-stop                           # expect /Users/rico/.local/bin/openbrain-capture-stop
```

Live row proof (dogfood DB; run from the repo so `psql` reads `.env`):

```
set -a; . ./.env; set +a
# Stop capture lands a row keyed by the harness session_id in session_ref:
psql -c "select id, created_at, left(content,60) from ob_raw_turns where session_ref='<session-id>' order by created_at;"
```

## Verify the new path is ABSENT (rolled back)

```
rg -c 'openbrain-capture-stop' ~/.claude/settings.json     # expect 0
rg -c 'sha256-'                ~/.claude/settings.json      # expect >= 1 (store paths restored)
```

## Restore — the ONE command

```
cp ~/.claude/settings.json.bak-420-cutover-20260801 ~/.claude/settings.json
```

That single copy re-points every hook back at the sha256 store. The store,
wheelhouse, data-dir `.venv`, and private uv-cache are retired LAST and only
after the new path is row-proven, so rollback stays a pure settings-file swap
and never needs the store rebuilt. If the store has since been archived and a
deeper rollback is needed, also `uv tool uninstall openbrain` and restore the
archived store from `~/.local/share/openbrain-memory/_archive/`.
