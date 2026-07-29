# Open Brain — Claude Router

READ `AGENTS.md` FIRST (this repo, alongside this file). It is the shared agent
router and the single source of truth for this repo: stack, hosts, commands,
coding standards, the downstream rollout gate, the pre-PR self-review gate,
review swarms, and the SME knowledge base. Do not duplicate its rules here; if
this file and `AGENTS.md` ever disagree, `AGENTS.md` wins unless a rule here is
stricter.

Development-wide policy lives in `/Volumes/ThunderBolt/Development/AGENTS.md`
and `/Volumes/ThunderBolt/Development/CLAUDE.md`. Repo-local files override
those when stricter or more specific.

## Claude-Specific Deltas

- **Open Brain is Claude's durable memory here, and this repo IS Open Brain.**
  The local dogfood service is the real one for this machine while in dev mode;
  `mcp2cli`/core01 is not. Endpoint and token come from
  `$OPENBRAIN_BASE_URL` / `$OPENBRAIN_TOKEN`
  (`~/.local/share/openbrain-memory/env/claudex-observation.env`). Never
  hardcode a host — not `10.71.1.21`, not `127.0.0.1`.
- **The retired operator CLI bridge is hook-blocked for Claude.** Durable writes
  use the direct `openbrain-memory` provider commands advertised in the
  SessionStart context. Those recipes remain valid for Codex and operators.
- **Canon vs episodic.** Canon (who Rico is, the rules, this repo's facts) is
  meant to load automatically; lane/session history is explicit-on-request
  because auto-loading it contaminates unrelated work. The model and its
  measured gaps: `_ob/skills/brain/workflows/canon.md` and
  `_plans/canon-always-known.md`.
- **Resume before archaeology.** On continuing work, run
  `_ob/skills/brain/scripts/resume.py` before grep, `aqmd`, or reading source.
  Skipping it cost a full session on 2026-07-29.
- **Repo-local hooks are enforcement, not advice.** `.claude/hooks/` gates
  mutations behind a subject-relevant design lookup, blocks tree-search as a
  first move, and refuses writes to the shared `/Volumes/collab` volume. A
  denial means adjust, not retry with a different spelling.
- **Search this repo before asking.** `aqmd search "<word>"` (~0.1s) then
  `aqmd "<question>"`. `grep`/`find` are denied; use `rg`, `fd`, `mdfind`.
  Development-wide `_DOCS`/`_ob` are not yet in any index (#440), so procedures
  living there are currently unreachable by search.
- **Skills are thin adapters.** Canonical content lives in
  `_ob/skills/<slug>/`; `~/.claude/skills/<slug>/` may only carry trigger text,
  paths, OB ref status, and a runtime caveat (≤2400 bytes). Editing an adapter
  instead of the canonical is a fork — see
  `_ob/skills/skill-maintainer/workflows/update.md`.
- **Model routing** follows `_DOCS/MODEL_ROUTING.md`: the head is Claude Opus 5
  at high effort; workers run as Workflow `agent()` nodes.
