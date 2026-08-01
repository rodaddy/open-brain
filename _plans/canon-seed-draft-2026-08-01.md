# Canon seed set — candidate draft for #444

**Status:** PROPOSED draft for #444 veto — nothing here is seeded.

This is a concrete artifact for the operator to cut and veto, **not a decision**.
#444 is HITL grilling ("Rico decides; do not answer this one alone"). This is the
prototype he reacts to: strike rows, reword rules, reassign lanes, split or merge
entries. Nothing here has been promoted; the three lanes still measure `items=0`.

## How to read this

Every candidate carries four fields:

- **scope key** — the `candidate_scope.key` from #445's mechanism. Required on
  every promotable row or it can never be retired (a newer `relegate`/`discard` on
  the same key is the only retirement path; without the key the row cannot be
  proven current). Keys are proposed, not final.
- **rule** — ≤3 sentences. The **short absolute** only. Where detail lives in an
  indexed doc, the rule is a *pointer* ("X is forbidden; full procedure at Y"),
  not the procedure itself. If a candidate is really a procedure, it appears here
  as its 3-line pointer form.
- **source** — where the rule is cited from, so a reviewer can check it against
  live authority.
- **lane** — `user_preference` (→ `profile_guidance`), `process_rule` (→
  `process_guidance`), or `repo_fact` (→ `repo_facts`, `open-brain`-bound).

**Inclusion test, applied ruthlessly** (from `_plans/canon-always-known.md`):
*would an agent that does not know this do the wrong thing confidently?* If a rule
only matters once you are already deep in a task, it belongs in the index, not
canon. Canon is front-of-mind and small. Pointer rules beat full procedures.

**Two-level rule:** canon carries the SHORT ABSOLUTE; the index serves the detail.
Nothing below should be a 40-line procedure. If it reads like one, it was cut to
its pointer.

**Not included by design:** secrets/tokens/credential values; any host beyond the
sanctioned two (this dev machine, core01); anything that contradicts current
`AGENTS.md`. Rows I am genuinely unsure belong in canon are marked
**UNCERTAIN — operator call**.

Lane counts: profile_guidance **8** · process_guidance **13** · repo_facts[open-brain] **7**.

---

## profile_guidance — who Rico is, how he works (lane: `user_preference`)

### 1. Rico profile
- **scope key:** `profile.identity`
- **rule:** Rico is the architect-level creator/maintainer of PAI and Open Brain;
  builds MCP servers, infra tooling, Proxmox clusters, and AI pipelines.
  Knowledge management is a core priority. Prefers brevity, no filler, no
  hand-holding; frame suggestions as trade-offs, not tutorials.
- **source:** migrated event "Rico profile (user)" (OB, 2026-08-01);
  `user_rico_profile.md`.
- **lane:** user_preference

### 2. Never speedrun — discussion is the default
- **scope key:** `profile.never_speedrun`
- **rule:** Discussion, explanation, and ideas are the DEFAULT mode. Editing,
  committing, pushing, and opening PRs each require explicit, unambiguous
  authorization for THAT specific action, every time — authorization never
  generalizes across actions and silence mid-turn is not consent. Hedged phrasing
  (possibly, maybe, we could, thoughts?) means DISCUSS, not GO.
- **source:** migrated event "NEVER speedrun" (OB, 2026-08-01);
  `feedback_never_speedrun.md`.
- **lane:** user_preference

### 3. No unrequested suggestions
- **scope key:** `profile.no_unrequested_suggestions`
- **rule:** Do the task asked and stop. Unprompted ideas are almost always wrong
  against what the repo already designed; state the work and its result, do not
  offer follow-on work.
- **source:** `feedback_no_unrequested_suggestions.md`; reinforced by LAW 17
  (`~/.claude/docs/laws.md`).
- **lane:** user_preference

### 4. Lead with the mechanism, not the tool name
- **scope key:** `profile.lead_with_mechanism`
- **rule:** When Rico names a tool he likes, treat it as a description of the
  PROPERTIES he wants, not a request to clone that tool. Put the enforcement
  mechanism and the root need FIRST; do not build comparison tables scored on
  axes where every candidate fails identically.
- **source:** migrated event "lead with mechanism" (OB, 2026-08-01);
  `feedback_lead_with_mechanism.md`.
- **lane:** user_preference

### 5. No over-engineering; tight tests
- **scope key:** `profile.minimal_correct`
- **rule:** Prefer the smallest design that satisfies the stated requirement (one
  hash over a tree walk, one fixture over five near-duplicates). Tests must be
  correct but TIGHT — cover the contract and the failure modes that matter, no
  redundant permutations, no testing implementation internals.
- **source:** migrated event "do not over-engineer" (OB, 2026-08-01);
  Development `AGENTS.md` (Ponytail/minimal-correct default).
- **lane:** user_preference

### 6. Delegate the wait — never sleep-poll in the head
- **scope key:** `profile.no_sleep_polling`
- **rule:** Never run `sleep N; check` loops in the head session to wait on a long
  operation; delegate the whole wait to a Workflow `agent()` node that reports on
  completion. A single ping is acceptable only for genuinely external services.
  The head is a controller and must stay available.
- **source:** migrated event "no sleep polling" (OB, 2026-08-01);
  `feedback_no_sleep_polling.md`.
- **lane:** user_preference
- **note:** UNCERTAIN — operator call. This is arguably process_guidance (a
  workflow rule), not a profile fact. Included under profile because it is stored
  as a Rico operating preference; reassign if the lane feels wrong.

### 7. No flash/haiku for extraction
- **scope key:** `profile.no_flash_extraction`
- **rule:** Never use flash/haiku-tier models for LLM extraction, summarization,
  or metadata tasks — Sonnet minimum, Opus when quality matters. Flash produced
  identical outputs across different inputs; Sonnet fixed it immediately.
- **source:** migrated event "no flash model" (OB, 2026-08-01);
  `feedback_no_flash_model.md`.
- **lane:** user_preference
- **note:** UNCERTAIN — operator call. Passes the inclusion test (an agent that
  doesn't know this wires flash into an EXTRACTION_MODEL confidently), but it is
  narrow. Keep if extraction pipelines are common; cut to the index if rare.

### 8. No pre-prod key rotation ceremony
- **scope key:** `profile.no_preprod_rotation`
- **rule:** Pre-prod / LAN-local (10.71.x) credentials get no rotation ceremony
  until systems reach prod. Do not flag transcript exposure of LAN-local tokens as
  action items or propose rotation as part of LAN rollouts. The
  no-secrets-in-logs/git floor still stands, and anything internet- or
  client-facing gets full hygiene.
- **source:** migrated event "no pre-prod key rotation" (OB, 2026-08-01);
  `feedback_no_preprod_key_rotation.md`.
- **lane:** user_preference

---

## process_guidance — the rules any agent doing work needs (lane: `process_rule`)

### 9. LAW 0 — say which kind of true it is
- **scope key:** `process.law0_say_what_you_mean`
- **rule:** Every claim is RUNNING (checked live this session), MERGED (in main,
  unproven), WRITTEN (on disk), or PROPOSED (someone said it) — and a claim
  inherits the weakest state in its chain. Never say done/complete/fixed/working/
  deployed for anything below RUNNING; say "written, not deployed" / "merged,
  unverified" / "proposed". Do not certify your own work; a subagent's confident
  output is PROPOSED until verified. Full text: `~/.claude/docs/laws.md` LAW 0.
- **source:** `~/.claude/docs/laws.md` LAW 0; Development `AGENTS.md`
  ("SAY WHICH KIND OF TRUE IT IS").
- **lane:** process_rule

### 10. Never work on main
- **scope key:** `process.never_on_main`
- **rule:** All development on feature/wip branches; never commit, stage, or push
  on a protected branch (main, master, develop, production, staging, release/*).
  Reading and status on main are fine; editing is not — branch first. Enforced by
  `_ob/scripts/policy-refresh-gate.ts` (LAW 8).
- **source:** `~/.claude/docs/laws.md` LAW 8; Development `AGENTS.md`
  (Goal-Run Execution Rule).
- **lane:** process_rule

### 11. Never `/tmp`, `$TMPDIR`, or `mktemp -d`
- **scope key:** `process.never_tmp`
- **rule:** `/tmp`, `$TMPDIR`, and `mktemp -d` are sandbox-local — a runner, a
  Codex sandbox, and the host each see a different one, so anything written there
  is invisible to everyone else and vanishes silently. Use
  `{temp_workspace}/open-brain/_scratch/`. Treat a `/tmp` path in a command you
  are about to run as a bug, like `rm -rf`.
- **source:** Development `AGENTS.md` (core rules); open-brain `AGENTS.md`
  standards banner; laws.md enforcement note.
- **lane:** process_rule

### 12. Never a recursive or forced delete — the agent's cleanup verb is `mv`
- **scope key:** `process.never_recursive_delete`
- **rule:** An agent never runs a recursive or forced delete anywhere, for any
  reason (`rm -rf`, `rm -r`, `rm -f`, `find -delete`, `shred`, `sudo rm`). Archive
  agent-owned temp under the matching `_archive/`; for user-owned data propose
  `mv <path> ~/.Trash/`. Print the command and STOP — Rico decides. Enforced at
  the tool layer in `.claude/settings.json`.
- **source:** Development `AGENTS.md` ("AN AGENT NEVER RUNS A RECURSIVE OR FORCED
  DELETE"); `.claude/settings.json` deny + `destructive-delete-gate.ts`.
- **lane:** process_rule

### 13. Use the fast tools — `grep`/`find` are denied
- **scope key:** `process.fast_tools`
- **rule:** `grep`, `egrep`, `fgrep`, and `find` are denied at the tool layer;
  reach for `rg` (content in-repo), `fd` (file by name in-repo), `mdfind` (file
  anywhere on disk), `aqmd`/`qmd` (semantic). A denial is the rule working — read
  the replacement out of the refusal and use it; do not retry a variant.
- **source:** Development `AGENTS.md` ("USE THE FAST TOOLS"); open-brain
  `.claude/settings.json` deny + `fast-tools-gate.ts`.
- **lane:** process_rule

### 14. Never ancient bash
- **scope key:** `process.never_ancient_bash`
- **rule:** Never `#!/bin/bash` — macOS system bash is v3.2 (2007). Use
  `#!/usr/bin/env bash` (or `zsh`/`sh`). Do not use `/bin/bash` or bare `bash` on
  macOS; name the interpreter path you mean.
- **source:** `~/.claude/docs/laws.md` LAW 7; Development `AGENTS.md` (the
  `/bin/bash` / `/bin/zsh` / system-python rule).
- **lane:** process_rule

### 15. Act on explicit targets
- **scope key:** `process.act_on_explicit_targets`
- **rule:** When the user gives an exact target and an action (an IP, hostname,
  container id, file path), do it immediately with that value — zero lookups, zero
  pre-verify searches. Full HOSTMAP lookup is reserved for vague/by-name targets
  only. Recovery (look up + retry) happens only on failure.
- **source:** Development `AGENTS.md` ("ACT ON EXPLICIT TARGETS");
  act-on-explicit-targets feedback memory.
- **lane:** process_rule

### 16. No secrets in git, logs, reports, PRs, or issues
- **scope key:** `process.no_secrets`
- **rule:** Never commit or print API keys, tokens, passwords, SSH keys, or
  credential values — not in git, logs, fixtures, reports, PRs, issues, or
  screenshots. Use `.env` (gitignored) and the vaultwarden secrets tool for shared
  credentials. Enforced by ggshield pre-commit/pre-push (LAW 11).
- **source:** `~/.claude/docs/laws.md` LAW 11; Development `AGENTS.md`.
- **lane:** process_rule

### 17. Finished with a worktree? Remove it
- **scope key:** `process.remove_worktrees`
- **rule:** A worktree is scaffolding for one piece of work; once the branch is
  merged or the info gathered, run `git worktree remove <path>` in the same
  session that created it (and `git worktree prune`). This is the one cleanup an
  agent completes itself — it is a git operation, not an `rm`. Copy anything worth
  keeping to a durable path first.
- **source:** Development `AGENTS.md` ("FINISHED WITH A WORKTREE? REMOVE IT").
- **lane:** process_rule

### 18. Delegate reviews and runner lifecycles to a Workflow node
- **scope key:** `process.delegate_reviews_runners`
- **rule:** Reviews, runner-box lifecycles, and PR verification belong in a
  delegated Workflow `agent()` node, not the head. Both runner lanes have mounts
  but the path differs: local runners see `/Volumes`, Proxmox LXC runners see
  `/mnt`. A `CONNECTION_ERROR` on `runner_needed` often means the op still
  completed — confirm with `runner_list` before retrying.
- **source:** migrated event "reviews/runner-box lifecycles belong in a delegated
  node" (OB, 2026-08-01); `feedback_delegate_runner_lifecycle.md`.
- **lane:** process_rule

### 19. OB is Claude's durable memory — direct provider only, never mcp2cli
- **scope key:** `process.ob_durable_memory_provider`
- **rule:** Durable memory writes use the direct `openbrain-memory` provider
  commands advertised in the SessionStart context (`--event capture` /
  `--event checkpoint`). The retired mcp2cli/operator bridge is hook-blocked for
  Claude — never substitute it or `MEMORY.md`. If the direct provider fails,
  report the failure; do not fall back.
- **source:** Development `AGENTS.md` (Open Brain Process Memory); open-brain
  `CLAUDE.md` (retired operator CLI bridge).
- **lane:** process_rule

### 20. Capture process memory when learned
- **scope key:** `process.capture_when_learned`
- **rule:** Capture reusable process memory in Open Brain when it is learned, not
  only at session wrap — corrections, missed-review patterns, workflow drift,
  CI/debugging lessons, security gotchas, operating preferences. Concise and
  actionable: what changed, where it applies, why it matters, what to do
  differently. Skip if already captured in an SOP, skill, repo doc, or recent
  event.
- **source:** Development `AGENTS.md` (Open Brain Process Memory / repo-local
  capture rule).
- **lane:** process_rule
- **note:** UNCERTAIN — operator call. Behavior rule about OB itself; keep if the
  loader should nudge capture, cut if that is loader-driven rather than canon.

### 21. Do not hand-roll solved problems
- **scope key:** `process.no_hand_rolling`
- **rule:** Prefer an existing repo helper → a maintained library → the standard
  library → custom code. An empty dependency list on a new repo is not a reason to
  write your own logger, HTTP client, retry, config loader, or validator.
- **source:** open-brain `AGENTS.md` standards banner; `_DOCS/STANDARDS-core.md`.
- **lane:** process_rule

---

## repo_facts[open-brain] — this repo's own truths (lane: `repo_fact`, `open-brain`-bound)

### 22. There are exactly two hosts
- **scope key:** `repo.two_hosts`
- **rule:** This project has exactly two hosts: this machine while developing, and
  core01 (10.71.1.21:3100) when dev work is done. No other database or service
  host belongs to it. Retired LXC hosts may still answer on the network and hold
  old Open Brain data — that does not make them in scope; do not connect, query,
  or point config at them.
- **source:** open-brain `AGENTS.md` (Stack — "Hosts — there are exactly two",
  "Retired hosts are out of scope").
- **lane:** repo_fact

### 23. Never hardcode a host — the env is the only source
- **scope key:** `repo.no_hardcoded_host`
- **rule:** Endpoint and token come from `$OPENBRAIN_BASE_URL` /
  `$OPENBRAIN_TOKEN`. Never hardcode a host — not `10.71.1.21`, not `127.0.0.1`,
  not `10.71.1.21:3100`. A hardcoded host is wrong on both machines and goes stale
  the moment a port moves.
- **source:** open-brain `CLAUDE.md` (Claude deltas); `_plans/canon-always-known.md`
  (Rejected — hardcoding any endpoint).
- **lane:** repo_fact

### 24. The dogfood database
- **scope key:** `repo.dogfood_db`
- **rule:** The dogfood database is `open_brain_local_20260724` on `127.0.0.1` —
  the real durable memory for this machine while in dev/dogfood mode, not
  mcp2cli/core01.
- **source:** open-brain `AGENTS.md` (Querying the dogfood database);
  `reference_openbrain_test_db.md`.
- **lane:** repo_fact

### 25. `psql` needs no connection arguments
- **scope key:** `repo.psql_no_args`
- **rule:** `.env` carries the standard libpq vars alongside the app's `DB_*`, so
  `set -a; . ./.env; set +a` then bare `psql` connects. Do not hand-build a
  connection: there is no `DATABASE_URL`, the app reads `DB_*` (psql does not), and
  bare `psql` otherwise defaults to a `rico` database that does not exist.
- **source:** open-brain `AGENTS.md` (Querying the dogfood database).
- **lane:** repo_fact

### 26. Postgres tests skip silently without the test DB URL
- **scope key:** `repo.test_skip_trap`
- **rule:** `bun test` Postgres tests SKIP SILENTLY without
  `OPENBRAIN_TEST_DATABASE_URL` — a green run may have tested nothing. Set it (the
  dogfood clone) before trusting a passing test run.
- **source:** open-brain `AGENTS.md` (Stack / dogfood); `reference_openbrain_test_db.md`.
- **lane:** repo_fact

### 27. Downstream rollout gate
- **scope key:** `repo.downstream_rollout_gate`
- **rule:** Open Brain is a live dependency of mcp2cli, generated agent skills,
  and Hermes agents. For MCP tool/schema/protocol/client-facing changes,
  "verified" means the applicable rtech-mcps, mcp2cli, rtech-hermes runtime, and
  live Hermes canary steps are complete or explicitly N/A. Full procedure:
  `docs/downstream-rollout.md`.
- **source:** open-brain `AGENTS.md` (Downstream Rollout Gate).
- **lane:** repo_fact
- **note:** pointer rule — the short absolute is "contract-changing changes are not
  done at local-test green"; the full classification lives in `docs/downstream-rollout.md`.

### 28. Standards are generated — never hand-edit `_DOCS/STANDARDS-*`
- **scope key:** `repo.standards_generated`
- **rule:** `_DOCS/STANDARDS-*` are generated from Development `_DOCS/` and carry a
  `source-hash`. Never hand-edit them — a rule change goes in the source document,
  then `bun _ob/scripts/sync-repo-standards.ts open-brain` refreshes the copies.
- **source:** open-brain `AGENTS.md` (Standards in this repo).
- **lane:** repo_fact
- **note:** UNCERTAIN — operator call. This is a repo mechanic; keep in canon if
  agents edit standards by reflex, cut to the index if the generated banner in the
  files themselves is enough.

---

## Cut from canon on the inclusion test (recorded so the operator can pull them back)

These were considered and left OUT — they are index-tier detail, or duplicate a
row above, or only matter mid-task. Listed so the veto pass sees the boundary.

- **OB visible ritual** (`feedback_ob_visible_ritual.md`) — narrate OB gate/capture
  as two-line action/result blocks. A presentation convention, not a "do the wrong
  thing confidently" rule. Index/skill-tier.
- **Investigate session wipes, don't dismiss as compaction**
  (`feedback_terminal_wipe.md`) — matters when a wipe happens, not front-of-mind
  every session. Index-tier; belongs in session-lifecycle docs.
- **Git archaeology before defending inherited design** (migrated event) — a good
  habit but activates only when questioning a specific design; not always-known.
- **SAS terminology / pai repo naming** (`project_sas_terminology.md`,
  `feedback_pai_repo_naming.md`) — glossary facts. Real, but they belong in a
  glossary index served on demand, not in every session's canon. **UNCERTAIN —
  operator call:** pai repo naming caused wrong-repo errors, so there is a case
  for canon; left out to keep the profile lane tight.
- **Full LAW list (1–17)** — only LAW 0, 4 (implicit in critical-thinking), 7, 8,
  11 rose to canon here. The rest (checkbox questions, pro/con, interview-first,
  file-size, network-share, no-LiteLLM-surgery, sibling-worktrees) are
  situational and index-served; pull any into canon by operator call.
- **Persona always-keep line** (`_ob/skills/personas/SKILL.md`) — "always keep:
  technical accuracy, critical thinking (LAW4), no time estimates, working code
  over pseudocode; Skippy default." **UNCERTAIN — operator call:** this is
  canon-shaped and the plan calls persona a canon layer, but it is loaded by the
  persona/loader path (#446), not the three guidance lanes. Recorded here so the
  operator decides whether it seeds as a `process_rule` or stays loader-owned.
