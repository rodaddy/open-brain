# Canon storage model — how canon lives in the database

**Status: reference, describing RUNNING behavior verified 2026-08-03 against
the dogfood service.** Written because answering "how is Skippy's canon
separated from Rico's" took three code reads; it should take one `aqmd`.

## Canon is an event-sourced ledger, not a table of rules

There is no `ob_canon` table. Every canon rule is a **row in
`ob_session_events`** carrying lifecycle metadata:

- `metadata.memory_lifecycle_action` — `promote` | `relegate` | `discard`
- `metadata.candidate_type` — `user_preference` (profile_guidance section) or
  `process_rule` (process_guidance section)
- `metadata.candidate_scope` — the **scope key**, e.g.
  `process.rico_comment_review_is_blocking`. The key is the rule's identity.

The **standing set is computed at read time**
(`server/tools/context-pack-guidance.ts:166-200`): pull every
promote/relegate/discard for the namespace, keep the newest `promote` per
scope key, drop any key later relegated or discarded. Retiring a rule is an
operator-authored **relegate event on the key** — never a DELETE; the ledger
keeps the history.

## The separation is one predicate deep

Events hang on lanes, and **`ob_session_lanes.namespace` is the isolation
boundary**. The pack read joins event → lane and binds
`WHERE l.namespace = $1` with the **auth-resolved** namespace
(`context-pack-guidance.ts:162-181`). Rico's canon is the fold of lifecycle
events on `rico` lanes; Skippy's is the fold on `skippy` lanes. Same tables,
one column apart.

Namespace comes from the consumer token: `AUTH_TOKEN_USER_<NAME>` →
clientId `<name>` (`server/config.ts:200-207`, value format `role:token`).
Proven live 2026-08-03: the same SessionStart probe under two tokens returned
`namespace=rico` (10 profile / 22 process rules) and `namespace=skippy`
(0 / 0 — his ledger was empty).

**Canon guidance reads consult ONLY the token's own namespace.** There is no
`shared-kb` merge anywhere in the pack path (verified by reading every
`context-pack-*.ts` consumer). `shared-kb` is a namespace for shared knowledge
tools (`docs/decisions/shared-kb-canonical-namespace.md`), but SessionStart
canon never reads it.

## The three scope axes (all exist; none is canon-specific)

| Axis | Mechanism | Where |
|---|---|---|
| User/agent | token → namespace on every lane and read | `server/config.ts:200-207`, lane join above |
| Session | lanes keyed by `platform` / `server_id` / `channel_id` / `session_key`; events carry `lane_id` | `session_start` / `session_context`, startup LANE RESUME (#519) |
| Folder/repo | `repo_facts` bound exactly to the repo slug derived from cwd; no fallback, key omitted when underivable | #517, #526, `agent-context-pack-repo-facts.ts` |

## Multi-agent canon: "different but mostly the same"

The database does **not** relate two agents' copies of the same rule. The
shared identity is the **scope key convention plus the declared pack file** —
canon-as-code:

- **Shared subset** (e.g. the process rules that apply to every agent): the
  same scope keys and text are promoted into EACH namespace — one ledger entry
  per agent. What keeps N copies honest is `openbrain-canon-reconcile`
  (`python/openbrain/src/openbrain/apps/canon/`, dry-run by default): diff one
  declared pack file against one namespace's live fold; non-zero exit on
  drift; `--apply` promotes the delta. A shared-rule edit means one reconcile
  run per agent namespace.
- **Per-agent subset**: keys that exist only in that agent's namespace — its
  own `profile_guidance` (who its operator is, how it works) and any
  agent-specific process rules. Separate pack file per agent.

Practical shape per agent: one shared process pack + one per-agent profile
pack + optional per-agent process deltas.

**Not built (design question, file when the fleet grows):** a shared-canon
merge — the guidance read consulting `shared-kb` (or a designated shared
namespace) after the own-namespace read, so N agents share one copy of the
common rulebook instead of N reconciled copies. At 2 agents the reconcile loop
is fine; at 10 it is the argument for the merge.

## See also

- `_plans/canon-always-known.md` — the canon model ruling (canon auto-loads,
  episodic is explicit; 2026-08-03 amendment: repo-scoped lane resume
  auto-loads)
- `docs/code-brain-design.md` — authority tiers (canon > decided > observed)
- `docs/decisions/shared-kb-canonical-namespace.md` — the shared namespace
- `server/tools/context-pack-guidance.ts` — the read path this documents
