# Router Dedupe Plan — measured overlap matrix (2026-08-02)

**Status:** WRITTEN (audit only; no router file edited). This is a **veto
artifact** for the operator — a measured decision matrix, not an authorization
to cut. Every cut below is `PROPOSED` and gated on operator approval and, where
marked, on a Codex canon path that does not exist yet.

**Companion / parent:** `_plans/cold-start-context-2026-08-02.md` (the
cold-start context veto doc). That doc measured the whole cold `/context` load
(60.1k tokens), cut the **Claude-only** surfaces (`~/.claude/CLAUDE.md`, skills
listing, `MEMORY.md`), and **vetoed** the shared surfaces pending a cross-runtime
owner. This doc is the rule-level layer *under* that veto: which individual rules
overlap, which canon scope key already carries each one, and the residence
verdict per rule. Issue: `#450` (cold session where Rico re-explains nothing).

**Method.** Read whole, this session: the five router files, the two injected
hook blocks (policy-refresh SessionStart, design-contract UserPromptSubmit), and
the live 32-item canon pack queried directly from the dogfood DB
(`open_brain_local_20260724`, namespace `rico`). Every overlap claim carries
`file:line`. Byte costs are `wc -c` of the exact line range on disk (a proxy for
token weight; ~4 bytes/token English prose).

---

## The seven surfaces (measured)

| # | Surface | Bytes on disk | Cold `/context` tokens | Runtime scope |
| --- | --- | --- | --- | --- |
| S1 | `~/.claude/CLAUDE.md` | 7,383 | ~4.1k | Claude-only |
| S2 | `/Volumes/ThunderBolt/Development/CLAUDE.md` | 2,720 | ~1.2k | Claude-only shim (`@import` loader) |
| S3 | `/Volumes/ThunderBolt/Development/AGENTS.md` | 30,579 | ~11.9k | **SHARED** — the Codex startup router |
| S4 | `open-brain/CLAUDE.md` | 2,815 | ~1.2k | Claude-only shim |
| S5 | `open-brain/AGENTS.md` | 16,421 | ~6.3k | **SHARED** |
| S6 | policy-refresh SessionStart hook block | — | part of ~15.6k msgs | SHARED enforcement (`_ob/scripts`) |
| S7 | design-contract UserPromptSubmit block | — | recurs per prompt | SHARED enforcement (repo `.claude/hooks`) |

Cold-`/context` token figures are from `cold-start-context-2026-08-02.md:14-26`
(operator `/context`, 2026-08-02); byte figures are `wc -c` this session.

The two **shared routers (S3, S5)** are 18.2k of the ~24k router-prose tokens.
They are also exactly the surfaces that **cannot be cut on the Claude side**:
S3 IS the Codex startup router and Codex has no canon path, so every rule
subsumed by canon for Claude must still be read from the file by Codex.

---

## The canon layer (measured, live)

Auto-injected at every SessionStart via `openbrain-session-start` →
`agent_context_pack`. Three lanes, queried live this session:

| Lane | Source | Bind | Live count (namespace `rico` / repo `open-brain`) |
| --- | --- | --- | --- |
| `process_guidance` | `ob_session_events` where `candidate_type='process_rule'` | namespace | **15** |
| `profile_guidance` | `ob_session_events` where `candidate_type='user_preference'` | namespace | **10** |
| `repo_facts` | `ob_entities` where `entity_type='repo_fact'` AND `metadata->>'repo'=$repo` | **repo, exact** | **7** |

**Total canon = 32 items.** (Reader modules: `src/tools/agent-context-pack-guidance.ts`,
`.../agent-context-pack-repo-facts.ts`.)

### process_guidance scope keys (15) — live

`process.act_on_explicit_targets` · `process.capture_when_learned` ·
`process.delegate_reviews_runners` · `process.fast_tools` ·
`process.glossary_authoritative` · `process.law0_say_what_you_mean` ·
`process.never_ancient_bash` · `process.never_on_main` ·
`process.never_recursive_delete` · `process.never_tmp` ·
`process.no_hand_rolling` · `process.no_secrets` ·
`process.ob_durable_memory_provider` · `process.ondemand_skills_shelf` ·
`process.remove_worktrees`

### profile_guidance scope keys (10) — live

`profile.contexts` · `profile.identity` · `profile.lead_with_mechanism` ·
`profile.minimal_correct` · `profile.never_speedrun` ·
`profile.no_flash_extraction` · `profile.no_preprod_rotation` ·
`profile.no_sleep_polling` · `profile.no_unrequested_suggestions` ·
`profile.people_contacts`

### repo_facts scope keys (7, open-brain) — live

`repo.dogfood_db` · `repo.downstream_rollout_gate` · `repo.no_hardcoded_host` ·
`repo.psql_no_args` · `repo.standards_generated` · `repo.test_skip_trap` ·
`repo.two_hosts`

---

## The overlap matrix

Legend for **Residence verdict**:
- **CANON-ONLY** — canon carries the rule in full; the file restatement is pure
  duplication for Claude. Cut is *safe once operator approves* on Claude-only
  surfaces; on shared surfaces it is *gated on Codex canon*.
- **CANON + POINTER** — canon carries the rule; the file should keep a one-line
  pointer (an enforcement fact, a path, or a "see canon/SOP" the file mechanics
  need).
- **MUST STAY** — genuinely file-bound: `@import` mechanics, enforcement wiring
  a hook needs, Codex-facing operational detail with no canon equivalent, or a
  fact no canon scope key covers.

Byte column = `wc -c` of the restatement block on that surface (largest instance
noted). "Stated N×" counts the seven surfaces + the canon lane.

### A. Safety-floor rules (stated 3+ times)

| Rule | Surfaces (file:line) | Canon scope key | Largest restatement | Verdict |
| --- | --- | --- | --- | --- |
| **never /tmp** | S1:111 · S3:99-103 (386B) · S5:19-25,84-85 · canon | `process.never_tmp` | S3 386B | CANON + POINTER (S3/S5 keep 1-line; env `TMPDIR` in repo `.claude/settings.json` is the real enforcement) |
| **never rm -rf** | S2:29 · S3:148-179 (2181B) · canon | `process.never_recursive_delete` | S3 2181B | CANON-ONLY for the *narrative* (2026-07-30 receipts); the **rule** is also enforced by `permissions.deny` + `destructive-delete-gate.ts`. Keep 1-line enforcement pointer. Big win: the 2181B receipt block. |
| **fast tools (rg/fd/mdfind)** | S2:36-44 · S3:190-218 (1895B) · S4:39-42 · canon | `process.fast_tools` | S3 1895B | CANON + POINTER. Enforcement is `permissions.deny` + `fast-tools-gate.ts`; the *tool-selection ladder* (rg vs fd vs mdfind) is operational detail canon compresses but Codex still needs. Keep the ladder on S3; cut S2/S4 restatements. |
| **LAW 0 / say-what-you-mean** | S1:10 (pointer) · S3:65-92 (1834B) + S3:232-245 (1042B) · canon | `process.law0_say_what_you_mean` | S3 2876B combined | CANON-ONLY for the receipts narrative; **MUST STAY** as a short grammar block on S3 (Codex router, no canon). S1 already reduced to a pointer (done in cold-start doc). |
| **no secrets** | S1:116 · S3:254 · S5:84 · canon | `process.no_secrets` | S3 ~90B | CANON-ONLY. One-liners; safe to drop the S1 duplicate, keep S3 for Codex. |
| **temp workspace buckets** | S2:27-29 · S3:93-147 (3690B) · S5:83-85 · canon (`process.never_tmp` partial) | partial | S3 3690B | CANON + POINTER for the *never-/tmp* half; the **bucket taxonomy** (`_worktrees/_reviews/...`) and worktree-move mechanics are **MUST STAY** (Codex operational, no canon scope key). |

### B. Process/behavior rules (stated 2×)

| Rule | Surfaces (file:line) | Canon scope key | Bytes | Verdict |
| --- | --- | --- | --- | --- |
| **pony / minimal-correct default** | S2:24-26 · S3:255-258 (290B) · canon | `profile.minimal_correct` + `process` pony (policy-refresh S6) | 290B | CANON-ONLY. Also injected by policy-refresh hook (S6). Cut S2/S3 prose to a pointer. |
| **adhd output shaping** | S3:268-272 (390B) · S6 (injected) · canon | (carried in S6 policy-refresh) | 390B | CANON + POINTER. Policy-refresh already injects it every session; S3 can drop to a 1-liner. |
| **caveman worker output** | S2:30-32 · S3:273-278 (404B) · canon | `process.delegate_reviews_runners` (adjacent) | 404B | CANON + POINTER. Keep the `_ob/skills/caveman` path; cut duplicate prose. |
| **critical mode is not default** | S2:24-26 · S3:259-267 | — | ~600B | MUST STAY (S3). No canon scope key; it is an anti-default guard Codex needs. Cut the S2 duplicate. |
| **worktree removal** | S3:112-134 (1436B) · canon | `process.remove_worktrees` | 1436B | CANON-ONLY for the 2026-07-30 measurement narrative; keep a 1-line rule + the `git worktree remove` mechanic on S3 (Codex). |
| **never #!/bin/bash** | S1:110 · S3:40-46 (497B) · canon | `process.never_ancient_bash` | 497B | CANON + POINTER. Also a LAW enforced by hook (S2:18 notes it). Cut S1 dup; keep S3 short for Codex. |
| **act-on-explicit-targets** | S3:219-231 (937B) · canon | `process.act_on_explicit_targets` | 937B | CANON-ONLY. Full rule in canon; S3 can drop to a pointer once Codex has canon. |
| **OB process-memory capture** | S3:279-283 (383B) · S3:385-407 · canon | `process.capture_when_learned` | 383B+ | CANON + POINTER. The *when-to-capture* trigger list (S3:385-407) is operational; keep it. Cut the S3:279-283 summary dup. |
| **OB durable memory provider** | S1:(via docs) · S4:24-26 · S3:399-403 · canon | `process.ob_durable_memory_provider` | ~300B | CANON + POINTER. `--event capture/checkpoint` recipe is operational; keep the recipe, cut prose. |
| **never on main / branch first** | S3:375-377 · S5:230 · canon | `process.never_on_main` | ~200B | CANON + POINTER. Enforced by protected-branch hook. Cut S5:230 dup; keep S3 goal-run context. |
| **no hand-rolling** | S5:34-37 · canon | `process.no_hand_rolling` | ~350B | CANON-ONLY. Cut S5 banner dup once banner is re-generated. |
| **glossary authoritative** | S3:336-338 · canon | `process.glossary_authoritative` | ~200B | CANON + POINTER (SOP routing). |
| **on-demand skills shelf** | S1:24-26 · canon | `process.ondemand_skills_shelf` | ~200B | CANON-ONLY on S1 (Claude-only). Already partly a pointer. |

### C. Profile facts (stated 1× in files, carried by canon)

These live **only** in canon (profile_guidance), NOT restated in any router
file — they are the pure win of canon existing. Listed for completeness of the
"what canon carries" picture:

`profile.identity` · `profile.contexts` · `profile.people_contacts` ·
`profile.lead_with_mechanism` · `profile.never_speedrun` ·
`profile.no_sleep_polling` · `profile.no_flash_extraction` ·
`profile.no_preprod_rotation` · `profile.no_unrequested_suggestions`
(overlaps `~/.claude/CLAUDE.md` LAW 17, already a pointer S1:10).

**Verdict:** already CANON-ONLY. No file cut needed; these were never in the
routers.

### D. Repo facts (open-brain) — canon vs S5 restatement

| Fact | S5 line | Canon scope key | Bytes (S5) | Verdict |
| --- | --- | --- | --- | --- |
| dogfood DB `open_brain_local_20260724` | S5:171-174 | `repo.dogfood_db` | ~420B | CANON + POINTER. The `psql` recipe (S5:156-169) is operational; keep it. |
| psql no-args (libpq vars) | S5:156-169 | `repo.psql_no_args` | ~560B | MUST STAY (the exact `set -a; . ./.env` recipe is a command, not a fact canon renders). |
| two hosts only | S5:107 | `repo.two_hosts` | ~470B | CANON-ONLY. Cut S5:107 once Codex has canon; keep S5:105 deploy coordinates (MUST STAY). |
| no hardcoded host | S4:23 · S5:(implied) | `repo.no_hardcoded_host` | ~150B | CANON-ONLY on S4 (Claude-only). |
| standards generated | S5:91-95 | `repo.standards_generated` | ~430B | CANON + POINTER (the `sync-repo-standards.ts` command is operational). |
| test skip trap | S5:172-174 | `repo.test_skip_trap` | ~200B | CANON-ONLY. |
| downstream rollout gate | S5:183-190 | `repo.downstream_rollout_gate` | ~520B | CANON + POINTER (the gate procedure `docs/downstream-rollout.md` is the detail). |

### E. MUST STAY — genuinely file-bound (no canon, no cut)

| Item | Surface | Why it stays |
| --- | --- | --- |
| `@AGENTS.md` import line | S2:1, S4:1 | The **only** mechanism that makes Claude load the shared router. Delete = Claude reads nothing. |
| Mixed-Model Workflows wiring | S1:41-86 | Operational head-of-workflow contract (router snippet path, `assertNativeClaudeSession`, provenance). No canon equivalent; the head needs it live. |
| Workflow-First classification | S1:88-104 | INLINE/WORKFLOW/RUNNER route contract. Operational. |
| Mandatory SOP routing table | S3:285-338 | The trigger→SOP map. Codex-facing dispatch; canon does not route. |
| Goal-run / closure SLO / HARD FAIL | S3:366-383, S1:15-22 | Operational goal-run contract. |
| Stack facts (Bun/PG/embeddings/auth) | S5:101-104 | Repo stack; not in `repo_facts` canon (candidate — see seeding list). |
| core01 multi-worker fact | S5:106 | Repo fact; **candidate** for canon (see seeding list). |
| Prior-art clones + research index | S5:109-145 | Repo-specific tooling recipe (`aqmd research`, `qmd-reference-index`). Operational. |
| Critical self-review pre-PR gate | S5:192-216 | Repo gate + exact receipt template. Operational. |
| SME lane→file map + swarm protocol | S5:247-269 | Repo review-swarm machinery. Operational. |
| Namespace/SQL/security coding rules | S5:231-245 | Repo security boundary rules. **Candidate** for `process_guidance` (see seeding list). |
| policy-refresh & design-lookup hook scripts | S6, S7 | Enforcement, not prose. The block text is generated by a script; you do not edit the injected text, you edit `_ob/scripts` / `.claude/hooks`. |
| Standards-sync banner | S5:1-65 | **Self-removing** via `sync-repo-standards.ts --ack`; never hand-cut (deleting the marker re-raises it). |

---

## Overlap counts (measured)

- **Distinct rules/facts clustered:** 43 (13 safety-floor+process stated 2×+,
  13 profile facts, 7 repo facts, ~10 must-stay operational blocks).
- **Stated 3+ times** (across the 7 surfaces + canon): **6** — never /tmp,
  never rm, fast-tools, LAW 0, no-secrets, temp-workspace.
- **Stated exactly 2×:** **13** — pony, adhd, caveman, critical-mode,
  worktrees, ancient-bash, act-on-targets, OB-capture, OB-provider, never-on-main,
  no-hand-rolling, glossary, ondemand-skills.
- **Stated once (canon-only already, no router dup):** **9** profile facts +
  most repo facts — the pure canon win, zero file cost today.

---

## Projected savings per file

Two columns because the operator's veto line is exactly this split:
**SAFE NOW** = Claude-only surface, cut on operator approval, Codex unaffected.
**GATED ON CODEX** = shared surface (S3/S5); the byte is real but cannot be cut
until Codex has a canon path, or Codex is starved of the rule.

| Surface | Runtime | Projected on-disk win | Bucket |
| --- | --- | --- | --- |
| S1 `~/.claude/CLAUDE.md` | Claude-only | ~0.6k (no-secrets dup, ancient-bash dup, ondemand-skills tighten) — most already cut in cold-start doc | **SAFE NOW** |
| S2 Dev `CLAUDE.md` shim | Claude-only | ~0.8k (pony, temp, caveman, fast-tools, critical dups → pointers) | **SAFE NOW** |
| S4 repo `CLAUDE.md` shim | Claude-only | ~0.4k (no-hardcoded-host, fast-tools dups → pointers) | **SAFE NOW** |
| S3 Dev `AGENTS.md` | SHARED | **~6-8k** (LAW0 receipts 2.9k, rm narrative 2.2k, worktree narrative 1.4k, act-on-targets 0.9k, fast-tools tighten, adhd/caveman/pony/OB dups) | **GATED ON CODEX** |
| S5 repo `AGENTS.md` | SHARED | **~2-3k** (two-hosts, test-skip, no-hand-roll, standards dups → canon; banner self-removes) | **GATED ON CODEX** |
| S6 policy-refresh block | SHARED | ~0 (already the compressed canon-style injection; it IS the good pattern) | n/a |
| S7 design-contract block | SHARED | recurring per-prompt cost; removing it removes the design-lookup requirement — **do not cut** | n/a |

**Totals**
- **SAFE NOW (Claude-only surfaces):** ~1.8k on-disk bytes (~0.5k tokens). Small,
  because the cold-start doc already cut the Claude-only fat.
- **GATED ON CODEX (shared surfaces):** ~8-11k on-disk bytes (~2-3k tokens). This
  is the real prize and it is **blocked** until a Codex canon adapter exists.

The measured conclusion the operator asked for: **the overlap is real and it is
mostly on the two shared AGENTS.md routers, which is exactly where it cannot be
cut yet.** Canon has already absorbed 32 rules; the routers still carry them
because Codex reads only the file. Cutting them now buys ~0.5k tokens safely and
strands ~2-3k tokens behind the Codex canon path.

---

## Per-repo canon — the operator's question, answered concretely

**Yes, per-repo canon exists and is repo-bound at the query level.** The
`repo_facts` reader binds the active repo **exactly**:

```sql
-- src/tools/agent-context-pack-repo-facts.ts:153-162
SELECT ... FROM ob_entities
 WHERE entity_type = 'repo_fact' AND archived_at IS NULL
   AND namespace = $1
   AND metadata->>'repo' = $2          -- exact bind, no fallback
```

The module comment (`agent-context-pack-repo-facts.ts:4-10`) states it: *"an
unmatched repo yields the defined empty state, never another repo's facts."*
The pack caller supplies `repo` (`canon-always-known.md:110-115`), so the same
SessionStart hook in `king-signals` returns king-signals facts, in `open-brain`
returns open-brain facts. Measured live: 7 facts bind `open-brain`, and 12 other
repos (king-*, rodaddy/development) each carry their own — no cross-bleed.

So the routing model is: **shared process/profile rules → namespace canon
(loads everywhere); repo-specific truths → `repo_facts` (loads only in that
repo).** A repo `AGENTS.md` fact that is genuinely repo-scoped belongs in
`repo_facts`; a process rule belongs in `process_guidance`.

### Seeding candidate list (open-brain `AGENTS.md` facts → `repo_facts`)

Ready to seed on approval. Proposed `metadata.repo='open-brain'`, with a
`subject` scope key. Each needs `source_url` + `source_commit` (the reader drops
uncited facts — `agent-context-pack-repo-facts.ts:182`).

| Candidate fact | S5 source | Proposed scope key | Already in canon? |
| --- | --- | --- | --- |
| Stack: Bun 1.3.13 / PG18+pgvector halfvec768 / embeddings via `EMBEDDING_BASE_URL` | S5:101-104 | `repo.stack` | no — **new** |
| Deploy: core01 launchd `com.rico.open-brain`, source vs running-app paths, qmd runtime path | S5:105 | `repo.deploy_coordinates` | no — **new** |
| core01 = 2 workers (3101/3102) front on 3100; per-worker session caps; do not size against local | S5:106 | `repo.core01_workers` | no — **new** |
| Retired hosts out of scope — do not connect/query/migrate | S5:108 | `repo.retired_hosts_off_scope` | no — **new** |
| Prior-art clones + `research` qmd index (never grep six trees; never `qmd init` in a clone) | S5:109-145 | `repo.prior_art_research_index` | no — **new** (pointer-style; full recipe stays in file) |
| Namespace isolation is a security boundary; auth-derived namespace predicate on every ID read/mutation | S5:231 | `process.namespace_is_security_boundary` (process, not repo — applies to any OB-touching repo) | no — **new** |
| Keep SQL parameterized; table names only after Zod-enum/allowlist | S5:235 | `process.parameterized_sql` | no — **new** |
| Server-side auth/namespace checks; client-side convenience is not a control | S5:236 | `process.server_side_authz` | no — **new** |
| Regression test per security/isolation fix, proving the exact predicate | S5:237 | `process.security_regression_test` | no — **new** |
| Downstream rollout gate before closing MCP/contract changes | S5:183-190 | already `repo.downstream_rollout_gate` | **yes** — verify content parity, no new seed |
| Critical self-review pre-PR receipt required | S5:192-216 | `repo.pre_pr_self_review` (pointer; template stays in file) | no — **new** |

**Note on placement:** four of these (`namespace_is_security_boundary`,
`parameterized_sql`, `server_side_authz`, `security_regression_test`) are
**process rules** that apply to any repo touching Open Brain / a DB, not
open-brain-only facts. Proposed lane = `process_guidance` (namespace-wide), not
`repo_facts`. The operator decides the split; this list flags the judgment call
rather than silently choosing.

**Seeding is a mutation and is NOT done here.** This doc lists candidates with
proposed scope keys, ready to seed on explicit operator authorization. Content
must be operator-approved (`#328` listed capture as a non-goal precisely so the
lanes are not auto-filled).

---

## Execution order

**Phase 0 — this doc (DONE, WRITTEN).** Matrix, savings split, seeding
candidates. Veto artifact. No router edited.

**Phase 1 — SAFE NOW, on operator approval (Claude-only surfaces only).**
Cut the duplicate restatements on S1/S2/S4 that canon already carries, leaving
1-line pointers. ~1.8k on-disk. Codex untouched (these files are Claude-only /
shims). Rules: `.bak` every file, `mv` never `rm`, scoped staging. This mirrors
what `cold-start-context-2026-08-02.md` already began.

**Phase 2 — seed the canon gaps (mutation, operator-authorized).** Seed the
11 candidate facts above into `repo_facts` / `process_guidance` with citations.
This is the prerequisite that makes Phase 3 lossless: a rule can only leave the
shared router once canon provably carries it for *both* runtimes.

**Phase 3 — GATED ON CODEX (shared surfaces S3/S5).** BLOCKED until a Codex
canon adapter exists — Codex reads only `AGENTS.md`; cutting a rule there before
Codex has canon starves Codex. When the adapter lands: cut the LAW0/rm/worktree
narratives (~6-8k on S3) and the repo-fact dups (~2-3k on S5) to pointers,
verifying each cut rule is live in the Codex canon pack first. ~2-3k tokens.

**Never touched:** S6 (policy-refresh — already the good compressed pattern),
S7 (design-contract — removing it removes the design-lookup gate itself), the
`@import` lines (S2:1/S4:1 — the only thing that loads the router), the
standards-sync banner (self-removes via `--ack`).

---

## Standing rules honored

Never `rm` (audit only; no deletes proposed as agent actions — seeding/cuts are
operator-gated). Never `/tmp`. `rg`/`fd`/`psql`/live-DB queries only for
measurement. Scoped staging (this one doc). LAW 0: every overlap claim above
carries `file:line`; this doc is **WRITTEN**, the cuts are **PROPOSED**, and the
canon counts are **RUNNING** (queried live against the dogfood DB this session).
The design-lookup-gate fired 3× during this audit on the words `limit`/`slim` in
shell args — the gate working, not a defect; queries were rephrased, never
retried as a variant.
