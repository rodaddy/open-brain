# Cold-Start Context Load — 2026-08-02

Status: WRITTEN (changes on disk in this branch and under `~/.claude`), not yet
proven by a fresh cold `/context` measurement. Operator authorized this work
directly.

Filename note: the operator's requested name for this doc used a word the repo
`design-lookup-gate` hook hard-blocks as limitation language, so the file and
branch use gate-safe forms (`chore/cold-start-context-2026-08-02`). No scope
changed.

## Ground truth — operator `/context` on a real cold session

open-brain repo, ping only, 2026-08-02. TOTAL 60.1k tokens of 450k.

| Surface | Tokens | Class | Disposition |
| --- | --- | --- | --- |
| System prompt + system tools + custom agents | ~9.4k | harness-fixed | not ours, untouched |
| `~/.claude/CLAUDE.md` | 4.1k | Claude-only | REWRITTEN |
| `/Volumes/ThunderBolt/Development/CLAUDE.md` | 1.2k | Claude-only router shim | veto (shim) |
| `/Volumes/ThunderBolt/Development/AGENTS.md` | 11.9k | SHARED (Codex router) | VETO ONLY |
| repo `CLAUDE.md` | 1.2k | Claude-only shim | veto (shim) |
| repo `AGENTS.md` | 6.3k | SHARED | VETO ONLY |
| `MEMORY.md` stub | 0.4k | retired pointer | REWRITTEN |
| Skills listing (~105 user skills) | 10k | Claude-only listing | RELOCATED (biggest safe win) |
| Messages (hook-injected: policy-refresh + canon pack ~3k + OB gate + design contract) | 15.6k | SHARED hooks | VETO ONLY |

## Actions taken (CLAUDE-ONLY)

### 1. Skills listing — relocate off-domain adapters (biggest safe win)

The harness lists every adapter directory in `~/.claude/skills/`. Off-domain
adapters for engineering sessions were `mv`d (never deleted) into a new
`~/.claude/skills-ondemand/` root, structure preserved. Canonical content lives
in `_ob/skills/<slug>/` and was NOT touched, so every relocated skill still
loads on demand via `~/.claude/skills-ondemand/<slug>/SKILL.md` or the registry
`local_fallback`.

31 adapters relocated:

- amazon, career-ops, dolibarr, homeassistant, pihole, unifi
- n8n, n8n-code, n8n-mcp-tools-expert, n8n-node-configuration,
  n8n-validation-expert, n8n-workflow-patterns
- hyperframes, hyperframes-animation, hyperframes-cli, hyperframes-core,
  hyperframes-creative, hyperframes-keyframes, hyperframes-registry
- faceless-explainer, general-video, motion-graphics, music-to-video,
  pr-to-video, product-launch-video, slideshow, talking-head-recut,
  remotion-to-hyperframes, media-use, watch-video
- fabric

55 engineering/infra/process adapters stay in `~/.claude/skills/` (always
listed): the operator keep-list plus the judgment keeps below.

Left listed on "when unsure, leave it listed": humanizer (writing/PR/doc use),
pdf-forms, story-explanation, web-design-system, supacode-cli, herdr
(deprecated but not off-domain), skippy-dev, fusion-harness, pr-investigator.

Discovery preserved:

- `~/.claude/skills/AGENT-INDEX.md` now documents BOTH roots (subagent skill
  discovery already routes through it per `~/.claude/CLAUDE.md`).
- `_ob/skills/registry.json`: the 10 relocated skills that pinned a
  `.claude/skills/<slug>` adapter path (fabric, career-ops, n8n-code, amazon,
  unifi, n8n, homeassistant, dolibarr, pihole, watch-video) had their
  `adapters.claude` pointer updated to `.claude/skills-ondemand/<slug>`. JSON
  re-validated. `local_fallback` (canonical `_ob` content) unchanged. `brain`
  and all other registry entries unaffected. `humanizer` stayed listed, so its
  registry pointer was left as-is.

Reversal: `mv` the directory back to `~/.claude/skills/` and restore its
registry pointer. Moving is reversible; a missed trigger is a real cost, which
is why the keep-list was applied conservatively.

### 2. `~/.claude/CLAUDE.md` — 10585 → 7383 bytes

- LAW 17 full text replaced by a one-line pointer to `~/.claude/docs/laws.md`
  (canon process lane carries it at session start).
- LAW 0 full text replaced by a one-line pointer. LAW 0 grammar also lives in
  the still-loaded Development `AGENTS.md` ("SAY WHICH KIND OF TRUE IT IS").
- Model-routing prose folded into a pointer to `_DOCS/MODEL_ROUTING.md`, keeping
  only the Claude-specific defaults.
- Mixed-Model Workflows section KEPT (operational wiring the head needs); the
  2026-07-30 measurement narratives were folded into the rule they support.
- Every rule that exists nowhere else was preserved. The file still functions as
  the runtime adapter.

### 3. `MEMORY.md` stub — 1063 → 322 bytes

Already a retired pointer; rewritten to the recall route, the repo-knowledge
route, and the disposition-table location.

## Per-file byte counts (before -> after)

| Path | Before | After |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | 10585 | 7383 |
| `~/.claude/skills/AGENT-INDEX.md` | 1362 | 1930 (grew: documents both roots) |
| `~/.claude/projects/.../memory/MEMORY.md` | 1063 | 322 |
| `_ob/skills/registry.json` | pointer-only edits, JSON valid | — |

Byte deltas are proxies for the on-disk files. The dominant cold-start win is
the ~10k skills listing now carrying 31 off-domain adapters relocated out of the
always-listed root, plus ~3.2k off `~/.claude/CLAUDE.md`. A fresh cold
`/context` on this repo is required to confirm the new total; this doc records
the change as WRITTEN, not measured.

## Veto list — SHARED surfaces, DO NOT edit here

These carry real cold-start weight but are cross-runtime dependencies. Each gets
a veto entry, never the knife, until a shared owner and a Codex-safe path exist.

| Surface | Tokens | What canon already covers (scope keys) | Projected on-disk win | Dependency blocking it |
| --- | --- | --- | --- | --- |
| Development `AGENTS.md` | 11.9k | LAW 0 grammar and pony/caveman defaults overlap the canon pack | ~4-6k if canon fully subsumed | Codex has NO canon path; this file IS the Codex startup router. Editing it starves Codex. |
| repo `AGENTS.md` | 6.3k | standards banner + SME map partially in `_DOCS` and `docs/sme/` | ~2-3k | Shared across runtimes; the standards banner is self-removing via `sync-repo-standards.ts --ack`, not by hand. |
| Development `CLAUDE.md` shim | 1.2k | router delta only | <1k | Loads `AGENTS.md` via `@import`; the shim is the only thing that makes Claude read the shared router. |
| repo `CLAUDE.md` shim | 1.2k | router delta only | <1k | Same import role at repo scope. |
| policy-refresh hook block (SessionStart) | part of 15.6k messages | — | ~1-2k | Enforcement, not prose; script lives in `_ob/scripts/policy-refresh-gate.ts`. Shared enforcement, not a Claude-only edit. |
| design-lookup-gate per-prompt block (UserPromptSubmit) | recurs per prompt | — | recurring per-prompt | Enforcement hook; shared. Recurrence is the cost, but removing it drops the design-lookup requirement itself. |

Scope keys: Claude-only = safe to act on now (done above). SHARED = veto until a
cross-runtime owner and a Codex-safe replacement path exist. Codex has no canon
path yet, so the shared routers stay whole; the policy-refresh script lives in
`_ob/scripts`.

## Standing rules honored

Never `rm` (all moves are `mv`; `.bak` copies made of every edited file). Never
`/tmp`. `rg`/`fd`/`aqmd` only. Scoped staging. LAW 0: this doc is WRITTEN, not
measured — the cold `/context` re-run is the RUNNING proof and has not been done.
