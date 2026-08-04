# Fleet rollout — Open Brain 0.9.x to the CC boxes and other agents

> **STATE: PROPOSED.** Nothing in this document has been executed. No box was
> contacted, no infrastructure mutated, no tag pushed. Every command below is
> **WRITTEN** — composed by reading source and config this session — and awaits
> operator go/no-go. The inventory and the "mechanism that exists" claims are
> **RUNNING-** or **WRITTEN-**verified this session and are cited by `file:line`.
>
> Date: 2026-08-02. Target revision: `origin/main` @ `b9a5483`.
> This is a decision artifact. It is deliberately not merged.

---

## TL;DR — what this actually is

Rolling Open Brain 0.9.x to the fleet is **not** one rollout. It is a
**server-side repoint** plus **three independent client families**, each with its
own switch, its own install artifact, and its own failure mode:

| Consumer family | Where | Switch mechanism | Status |
|---|---|---|---|
| **A. Claude / Claudex** | Rico's Mac (`10.71.1.20`) | env file `claudex-observation.env` | **EXISTS, RUNNING** |
| **B. Hermes agents** | bilby `10.71.1.71`, agent profiles | plugin config `base_url` + `transport` | **EXISTS**, different switch |
| **C. Codex / operator** | anywhere with `mcp2cli` | mcp2cli daemon service definition | **EXISTS** |
| **D. cc-\* boxes** | 4 LXCs, `10.71.20.120-123` | *nothing installed* | **TO BUILD** |

The single most consequential finding: **the cc-\* boxes have no Open Brain
client of any kind today, and the documented install command is an absolute
macOS repo path.** That one line (`docs/420-cutover-rollback.md:37`) is the whole
gap between "vetted locally" and "on the fleet". Everything else is already
built.

The second finding: **there is no `v0.9.0` tag.** `0.9.0` exists only in four
manifests (PR #497). The deploy gate keys on a pushed `v*` tag, so the server
side has a real, unbuilt step in front of it.

---

## 0. Inventory — what is actually out there (RUNNING, read-only this session)

### The cc-\* boxes

Read from `/Volumes/collab/hostmap.json` with `jq`, read-only. No box contacted.

| Name | CT | Node | IP | Status | Mounts |
|---|---|---|---|---|---|
| `cc-king` | 320 | proxmox02 | `10.71.20.120` | running | `/mnt/collab`, `/mnt/dev-index`, `/mnt/builds`, `/mnt/logs` |
| `cc-kevin` | 321 | proxmox04 | `10.71.20.121` | running | same four |
| `cc-geetesh` | 322 | proxmox04 | `10.71.20.122` | running | same four |
| `cc-lisa` | 323 | proxmox04 | `10.71.20.123` | running | same four |

All four already mount `/mnt/collab` (`mp0`), which is the same shared volume the
Mac sees as `/Volumes/collab` — that matters because it is a candidate delivery
channel for the client artifacts, and because
`/Volumes/ThunderBolt/Development/_DOCS/INFRASTRUCTURE_SOP.md:122-128` states
collab access is solved through the `collab` group and LXC idmap, not by
loosening permissions.

All four run `postgresql@18-main` and `nats-server` locally. **Neither is Open
Brain.** They are unrelated services on the same boxes; nothing in the hostmap
entry lists an Open Brain process or port `3100`.

**UNVERIFIED / must be checked on the box before Step 5:** whether `uv` is
installed, which Python is present, whether `~/.local/bin` is on the agent's
`PATH`, and whether an agent harness with a hook chain even runs there. The
hostmap carries service and port facts, not toolchain facts. This is a read-only
`pct exec` / `ssh` check and is the first action of Step 5, not an assumption.

### Other agents

- Hermes agent profiles under `/Volumes/collab/agent-backups/agents/`: `bilby`,
  `nagatha`, `skippy` (plus `common`). Each has `config.yaml` / `agent.yaml`.
- The Hermes Open Brain plugin is present at
  `/Volumes/collab/agent-backups/rtech-hermes/plugins/memory/openbrain/`.

### The brain that is running right now

`launchctl list` → `com.rico.open-brain-local-clone`, pid 85347.
`curl -sS -m 8 http://127.0.0.1:3100/health` → **HTTP 200**:

```json
{"status":"healthy","database":{"connected":true,"total":2,"idle":2,"waiting":0},
 "embedding":{"configured":true,"connected":true},
 "nats":{"requested_transport":"http","availability":"not_runtime_available","fallback_http":true}}
```

This is the **local dogfood brain** on the Mac, serving
`open_brain_local_20260724`. It is the real brain for this machine while in dev
mode (`CLAUDE.md`, Claude-Specific Deltas).

**It is already LAN-reachable.** `/Volumes/ThunderBolt/open-brain-local/local-clone.env:3`
sets `OPEN_BRAIN_BIND_HOST=0.0.0.0`, and `src/index.ts:351-355` honors
`localClone.bindHost` when local-clone mode is enabled. So a cc-\* box can reach
`http://10.71.1.20:3100` today **without one line of new server code**. Whether
it *should* is a Rico decision — see §6.

---

## 1. What a CLIENT box needs — the exact artifacts

Four artifacts. Three exist and are proven on the Mac; the delivery path to a
Linux box is the gap.

### 1.1 The console scripts (`uv tool`) — EXISTS on Mac, DELIVERY TO-BUILD

`docs/420-cutover-rollback.md:34-44` is the authority:

```bash
uv tool install --force /Volumes/ThunderBolt/Development/open-brain/python/openbrain
```

This links stable-named console scripts into `~/.local/bin/`. Verified present
on the Mac this session:

```
openbrain-capture-stop            openbrain-post-compact
openbrain-capture-subagent-stop   openbrain-session-start
openbrain-session-end             openbrain-session-start-remaining
openbrain-bulk-ingest             openbrain-memory
```

Declared at `python/openbrain/pyproject.toml:65-77` (`[project.scripts]`), and
`test_console_scripts.py` parses that table and imports every `module:attr`, so
a dead shim fails pytest rather than shipping green (`pyproject.toml:59-61`).

> **TO-BUILD — the delivery gap.** That install path is an absolute path into
> Rico's Mac checkout. A cc-\* box has no such path. `python/openbrain/dist/`
> does not exist (checked), and there is no published index:
> `python/openbrain-memory/pyproject.toml:14-19` records that `fleet-nats` is
> **not** on PyPI and lives in a private monorepo. `docs/README.md:264` shows
> `uv pip install openbrain-memory==<version>`, which implies an index that this
> plan cannot confirm exists.
>
> **Three candidate delivery mechanisms, none yet chosen (Rico decision, §6):**
> 1. `uv tool install` from a git ref — `uv tool install --force
>    "git+ssh://git@github.com/rodaddy/open-brain@v0.9.0#subdirectory=python/openbrain"`.
>    Needs deploy-key/SSH access from each cc-\* box to the private repo.
>    **UNVERIFIED** that such access exists.
> 2. Built wheels staged on `/mnt/collab` — `uv build` on the Mac, drop the
>    wheels in a versioned collab directory, `uv tool install` from the local
>    path. Uses a mount all four boxes already have. No new credentials. This is
>    the lowest-friction candidate, but it makes collab a distribution channel,
>    which is a policy question.
> 3. A private package index. Most correct long-term, most infrastructure.

### 1.2 The env file — EXISTS, and it already contains the switch

`~/.local/share/openbrain-memory/env/claudex-observation.env`, mode `0600`.
Confirmed keys (values never read):

```
OPENBRAIN_BASE_URL=http://10.71.1.20:3100      # line 7  — LIVE: local Mac brain
# OPENBRAIN_BASE_URL=http://10.71.1.21:3100    # line 9  — COMMENTED: core01
OPENBRAIN_TOKEN=<redacted>
OPENBRAIN_NAMESPACE=<redacted>
OPENBRAIN_OBSERVATION_* (5 vars)
OPENBRAIN_ALLOW_INSECURE_HTTP=<redacted>
```

**The swap-back toggle is a two-line comment flip that already exists in the
file.** This is the mechanism `rodaddy/development` PR #74 (MERGED
2026-08-02T20:14:25Z) hardened: `_ob/scripts/ob-memory-provider.ts`
`childEnvironment` now resolves in exactly one order —

1. process env / `childEnv` (an explicit export always wins),
2. the shared env file,
3. still missing → `MissingRuntimeEnvError`.

**No fallback endpoint remains in the source** (not core01, not loopback). The
file is parsed as `KEY=VALUE`, never shell-sourced, so a hostile line can only
become an inert string. On a missing variable it writes to stderr naming the
**variable and the file, never the value**.

That last property is what makes this safe to roll to more boxes: a
misconfigured client fails **loudly and locally** instead of silently writing to
the wrong brain. Before #74, a session with no `OPENBRAIN_*` silently hydrated
from core01 — two sessions chased a phantom core01 outage over exactly that.

`OPENBRAIN_ALLOW_INSECURE_HTTP` is present because the local/LAN endpoint is
plain `http`, and as of #525 it is a **declared** setting on both
`CaptureSettings` and `CanonSettings` that the wrapper passes through — see §1.3.
Before that fix it was declared nowhere and stripped by the wrapper, which is why
a LAN box could not reach the brain at all: the client refuses non-loopback plain
`http` without the flag, and exporting the flag made the strict config reject the
whole environment. A LAN box now needs this variable set; on `127.0.0.1` it is
inert (loopback http is auto-permitted).

**UNVERIFIED for cc-\* boxes:** whether cross-box plain-HTTP bearer tokens over
the LAN are acceptable to Rico, or whether the boxes must go through
`https://open-brain.rodaddy.live`. §6. The declared opt-in makes plain-HTTP LAN
possible; it does not decide that it is the chosen posture for those boxes.

### 1.3 The hook-env wrapper — EXISTS, and it is not optional

`~/.local/share/openbrain-memory/env/openbrain-hook-env` (mode `0755`, 1973
bytes). Its tail:

```sh
ENV_FILE=".../claudex-observation.env"
set -a; . "$ENV_FILE"; set +a
exec env -i \
  PATH="$PATH" HOME="$HOME" \
  OPENBRAIN_BASE_URL="${OPENBRAIN_BASE_URL:-}" \
  OPENBRAIN_TOKEN="${OPENBRAIN_TOKEN:-}" \
  OPENBRAIN_OBSERVATION_*="..." \
  OPENBRAIN_ALLOW_INSECURE_HTTP="${OPENBRAIN_ALLOW_INSECURE_HTTP:-}" \
  "$@"
```

**Why it must be copied and not skipped** (`docs/420-cutover-rollback.md`):
the Python config **rejects** any `OPENBRAIN_*` variable it does not declare
(`config.unknown_prefixed_variables`), *and the hooks swallow that rejection*.
So sourcing the whole env file into a hook would **silently zero every
capture** — a green-looking box writing nothing. The wrapper's `env -i` passes
exactly the accepted variables and nothing else.

**The pass-through list grows only AFTER the installed package declares the
field** — declare in `openbrain.config`, `uv tool install --reinstall`, verify
the installed interpreter accepts it, then edit the wrapper. Getting that order
backwards is itself the silent-zero-capture failure. `OPENBRAIN_OBSERVATION_*`
(#523) and `OPENBRAIN_ALLOW_INSECURE_HTTP` (#525) were both added this way.

**A LAN box needs `OPENBRAIN_ALLOW_INSECURE_HTTP` in its env file** (the Air,
`10.71.1.26`, pointing at `http://10.71.1.20:3100`). Without it the client
refuses the non-loopback plain-`http` base URL and canon *and* capture decline
silently — the #525 symptom. This is the family-A delta a LAN box has that the
dev Mac does not, because loopback needs no flag.

This is the single highest-risk thing to get wrong on a new box, because the
failure is silent. The Step-5 gate below is written specifically to catch it by
**row proof**, not by exit code.

> **TO-BUILD:** the wrapper hardcodes `ENV_FILE` as an absolute macOS path
> (`/Users/rico/...`). A Linux box needs a path-parameterized copy. Trivial, but
> it is an edit, so it is a delta, not a copy.

### 1.4 The harness hook wiring — EXISTS on Mac, UNVERIFIED on cc-\*

`~/.claude/settings.json` carries six entries pointing at the wrapper —
lines 258 (`PostCompact`), 356 (`SessionEnd`), 368 (`SubagentStop`), 404 and 409
(`SessionStart`, two independent emissions), 439 (`Stop`). Shape:

```
sh /Users/rico/.local/share/openbrain-memory/env/openbrain-hook-env openbrain-capture-stop
```

Issue #420 (PROV-11 cutover) is **CLOSED**, so this is the landed design, not a
proposal. `settings.json` is outside this repo and is therefore not versioned
here (`docs/420-cutover-rollback.md:9-14`).

**UNVERIFIED:** whether the cc-\* boxes run a Claude Code harness with a
`settings.json` hook chain at all. If they run a different agent runtime, family
**D** collapses into family **B** or **C** and the artifact list changes
completely. **This is the first question Step 5 must answer, and it can
invalidate §1 for those boxes.**

---

## 2. The SERVER side — core01 swap-back day

### 2.1 What "swap back" means

Today the Mac's clients point at the **local** brain (`10.71.1.20:3100`). Swap-back
= those clients point at **core01** (`10.71.1.21:3100`, or
`https://open-brain.rodaddy.live`), and core01 runs 0.9.x.

Three independent moves. They are separable and should not be done in one shot:

**(a) Get 0.9.x onto core01.** Per `docs/local-release-deploy-sop.md:10-18`,
merging to `main` is **not** a deploy signal. Production deploy is allowed only
from:
- a manual CI `workflow_dispatch` on `main` with `deploy_core01=true`, from the
  **current** `origin/main` tip; or
- a pushed `v*` tag whose commit is **reachable from `origin/main`**.

Enforced provider-neutrally by `scripts/deploy-ref-gate.ts`. The deploy job waits
on `check`, `db-integration`, and `python-package`, then runs
`scripts/core01-deploy-local.sh` on the `[self-hosted, macOS, core01]` runner
(`docs/downstream-rollout.md:36-47`).

> **TO-BUILD: there is no `v0.9.0` tag.** `git tag -l 'v*'` returns
> `v0.1.0-rc.2`, `v0.1.0-rc.3`, `v0.1.0-rc.4`, `v1.0.0`, `v9.9.9`. `0.9.0` exists
> only in four manifests via PR #497. **This lane is explicitly forbidden from
> creating tags**, so tagging is an operator action.
>
> **Flag — two stray tags.** `v1.0.0` and `v9.9.9` exist and are referenced by no
> doc, script, or workflow found in this repo. Both match the `v*` deploy
> trigger. If either is reachable from `origin/main`, it is a live deploy trigger
> nobody documented. **Rico should check and, if they are test residue, delete
> them before any real tag is pushed.** Deleting a tag is an operator action; this
> plan does not do it.

**(b) Repoint the Mac's clients.** Flip lines 7 and 9 of
`claudex-observation.env`. One comment swap. Reversible in seconds.

**(c) Decide what happens to the local dev brain.** See §2.3 — this is the part
with no existing mechanism and no existing decision.

### 2.2 Ordering (a) against (b)

**Do (a) fully, verify it, and only then do (b).** If (b) runs first, every
Claude session on the Mac writes into a core01 that is still on an older
revision, and the writes land in a brain whose contract may not match the client.
The `X-OB-Contract` header is logged as a mismatch warning but **does not reject
the request** (`docs/memory-contract.md:322-324`) — so this failure is silent at
the wire and only shows up as bad data later. Order matters for a real reason.

### 2.3 What happens to the local dev brain — UNDECIDED

The local brain holds real dogfood data: `ob_raw_turns` was **41,427 rows** as of
2026-08-01 (`_plans/local-clone-deploy-runbook-2026-08-01.md:82`) and has grown
since. Four dispositions, none chosen:

1. **Leave it running, unused.** Zero risk, keeps a warm rollback target. Costs a
   port and a launchd job. Risk: it silently diverges, and a stale local brain
   that still answers is exactly the "retired host that still answers" hazard
   `AGENTS.md` warns about.
2. **Leave it running as the write target, core01 as read-only mirror.** Needs a
   sync mechanism that **does not exist**.
3. **Stop it, keep the DB.** Clean. Rollback means restarting the service.
4. **Migrate the dogfood data into core01, then stop it.** Highest value, and
   the only option with **no mechanism today**. There is no export/import path
   for `ob_raw_turns` + `ob_session_events` between two Open Brain instances that
   this plan could find. That is a whole work item, not a rollout step.

**Rico decision. §6.** The plan explicitly does not assume (3).

### 2.4 Server-side rollback

Already built and documented — nothing to design:

- `scripts/core01-deploy-local.sh` keeps the prior runtime at
  `/Volumes/ThunderBolt/open-brain/app.previous`. On post-deploy health failure
  it **restores the prior runtime automatically**, restarts launchd, and re-runs
  the health loop (`docs/local-release-deploy-sop.md:276-290`).
- If rollback health also fails: treat core01 as degraded and **stop issue
  closure** until manually recovered. That is the SOP's language, not this plan's.
- Client-side rollback is the comment flip in §2.1(b).

---

## 3. The ORDER, with gates and rollback per step

Each step has an **exit criterion** that must be met before the next begins. A
failed gate stops the rollout at that step; it does not proceed with a caveat.

### Step 1 — Local vetting exit criteria (GATE 1)

Per `docs/local-release-deploy-sop.md:73-148`, run from a clean release-candidate
worktree under `/Volumes/ThunderBolt/_tmp/open-brain/`, **never** from a dirty
development checkout (`:22-25`), and against an **isolated** test DB — never the
dogfood `open_brain_local_20260724`.

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
cd python/openbrain-memory && uv run mypy src/openbrain_memory && uv run ruff check src tests && uv run pytest -q && uv build
```

> **Trap, from `AGENTS.md`:** `bun test` Postgres tests **skip silently** without
> `OPENBRAIN_TEST_DATABASE_URL`. A green run may have tested nothing. The gate is
> not "bun test passed" — it is "bun test passed **with that variable set**", and
> the evidence must show it.

Plus the local runtime smoke on the non-production port `13100`
(`:100-148`): `/health` returns `status: healthy`,
`embedding.configured: true`, `embedding.connected: true`, then a REST
write/read round trip.

**Exit criteria:**
- [ ] All four suites green, with `OPENBRAIN_TEST_DATABASE_URL` demonstrably set.
- [ ] Runtime smoke on `13100` passes all three health assertions.
- [ ] Downstream-rollout classification written down (`docs/downstream-rollout.md:8-22`).
- [ ] The four client artifacts in §1 are proven **row-level** on the Mac — a
      capture lands a row in `ob_raw_turns` keyed by `session_ref`
      (`docs/420-cutover-rollback.md:67-73`). Receipts are not proof; the row is.
- [ ] The two stray tags (`v1.0.0`, `v9.9.9`) are triaged by Rico.

**Rollback:** none needed — nothing outside the Mac has changed.

### Step 2 — core01 (GATE 2)

Operator pushes the version tag, or runs the manual dispatch. **This lane does
not tag.** Then, per `docs/local-release-deploy-sop.md:200-214`:

```bash
curl -fsS http://127.0.0.1:3100/health      # front
curl -fsS http://127.0.0.1:3101/health      # worker-1
curl -fsS http://127.0.0.1:3102/health      # worker-2
curl -fsS https://open-brain.rodaddy.live/health
```

All four are **operator-run on core01**. This plan's author is forbidden from
contacting `10.71.1.21`.

> **core01 is not shaped like local.** `10.71.1.21:3100` is a front over
> `open-brain-worker-1` (3101) and `open-brain-worker-2` (3102) — the `workers`
> array in `/health` that the single-process local service does not emit
> (`AGENTS.md`, Stack). Session caps are **per worker**. Do not size anything
> against local and assume it transfers.

**Exit criteria:**
- [ ] Deploy workflow green (`check`, `db-integration`, `python-package`, deploy).
- [ ] All four health endpoints answer healthy.
- [ ] A real hosted MCP call for **each changed tool**, with the returned
      `contract_version` and `schema_hash` recorded. Workflow success is
      **necessary but not sufficient** (`docs/downstream-rollout.md:48-50`) — the
      deploy script's own test is `search-all.test.ts`, which is regression
      coverage, **not** a live changed-tool smoke.
- [ ] `get_contract` returns `contract_version` and a `schema_hash` matching the
      deployed revision. Note `min_client_versions["openbrain-memory"]` stays
      `0.1.15` and the range is `>=0.1.15 <1.0.0` (`src/contract.ts:567-573`), so
      **0.9.0 clients satisfy it and no floor change is required.**

**Rollback:** automatic runtime restore from `app.previous` on health failure
(§2.4). Client rollback is the §2.1(b) comment flip.

### Step 3 — rtech-mcps → mcp2cli → Hermes (GATE 3)

This is `docs/downstream-rollout.md:52-147` steps 3-6 **unchanged**. This plan
adds no delta and restates none of it; the SOP wins. The only thing worth
carrying forward is the trap the SOP already documents:

> `mcp2cli cache warm open-brain --force` is **broken** for a daemon-routed
> service — the daemon is asked to discover through itself and it deadlocks
> (`rodaddy/mcp2cli#60`). **Do not make it a rollout requirement**
> (`docs/downstream-rollout.md:60-64`). The supported workaround is
> `mcp2cli credentials reload` or a daemon restart, coordinated because it
> interrupts pooled connections (`:94-101`).

**Exit criteria:** exactly the SOP's, per applicable step, each either completed
with evidence or explicitly marked not applicable with a reason
(`docs/downstream-rollout.md:149-159`).

**Rollback:** per-consumer. mcp2cli reverts by restoring the prior service
definition; Hermes reverts by `git`-reverting the `rtech-hermes` change and
re-running `scripts/update.sh` from `10.71.1.71` (`:126-138`). **Not** from
TN01/`10.71.1.11` — the SOP says so explicitly (`:127`).

### Step 4 — ONE cc-\* box, the canary (GATE 4)

**`cc-lisa` (`10.71.20.123`, CT 323, proxmox04)** is the proposed canary: it is
the last of the four and, on the hostmap evidence, the least-loaded service list.
**Rico may prefer a different box — §6.**

Step 4 begins with the **read-only discovery** that §1 flagged as unverified:

```bash
# READ-ONLY. Answers the question that decides whether §1 even applies.
command -v uv; command -v python3; python3 -V
echo "$PATH"; ls -d ~/.local/bin 2>/dev/null
ls -d ~/.claude 2>/dev/null            # is there a Claude harness here at all?
mount | rg collab                       # is /mnt/collab actually mounted
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://10.71.1.20:3100/health   # LAN reachability
```

> If `~/.claude` is absent, **stop and re-plan**: this box is not consumer family
> D and §1's artifact list does not apply to it.

Then, in order: install the console scripts by the §1.1 mechanism Rico chose →
place the env file at `0600` with a **per-box token** (§4) → place the
path-adjusted wrapper → wire the harness hooks → **restart the agent runtime**
(hook definitions are read at session start).

**Exit criteria:**
- [ ] `command -v openbrain-capture-stop` resolves.
- [ ] Env file is mode `0600`, owned by the agent user.
- [ ] `openbrain-hook-env` runs a script and exits 0.
- [ ] **The silent-failure check.** A real session start + capture on the box
      produces a **row** in `ob_raw_turns` with that box's `session_ref`,
      confirmed by `psql` against the brain. **A receipt or a zero exit code is
      NOT acceptable evidence here** — §1.3 is precisely the failure that exits 0
      and writes nothing.
- [ ] The row's namespace is the per-box namespace, not `rico`'s (§4).
- [ ] Deliberate negative test: temporarily unset `OPENBRAIN_BASE_URL` and
      confirm the stderr line names the **variable and file, not the value**
      (PR #74 behavior). This proves the fail-loud property on *this* box rather
      than assuming it ported.

**Rollback:** remove the hook entries from the box's harness config (keep a
timestamped backup first, per `docs/420-cutover-rollback.md:82-86`), and
`uv tool uninstall openbrain`. The box returns to having no Open Brain client —
its prior state. Nothing on the server needs undoing; a per-box token is simply
revoked (§4).

### Step 5 — the remaining three cc-\* boxes (GATE 5)

Only after the canary has been **stable for an operator-chosen soak period**
(§6 — this plan does not pick a duration).

`cc-king`, `cc-kevin`, `cc-geetesh`, one at a time, same steps, same gates. Not
in parallel: four boxes failing the §1.3 silent-capture failure simultaneously is
four times the diagnosis for zero time saved.

**Exit criteria:** Step 4's per-box, for each box.
**Rollback:** per-box and independent — that is the point of doing them serially.

### Step 6 — other agents (GATE 6)

Hermes agents (`bilby`, `nagatha`, `skippy`) are **family B**, not family D. Their
switch is `plugins/memory/openbrain/support.py:530-535`:

```python
transport: str = "mcp2cli"
base_url: str = "https://open-brain.rodaddy.live"
```

overridable by `OPENBRAIN_TRANSPORT` / `OPENBRAIN_BASE_URL` /
`OPENBRAIN_MCP2CLI_BIN` / `OPENBRAIN_MCP2CLI_NO_DAEMON` (`support.py:127-132`),
or per-agent in `agent-backups/agents/<name>/config.yaml`.

Note their default is **already core01 over HTTPS**. So for Hermes, "swap-back
day" is a **no-op** — they never pointed at the local Mac brain. Their real gate
is Step 3's rtech-hermes merge plus the live canaries at
`docs/downstream-rollout.md:140-147`: agent venv imports the updated runtime,
`openbrain` loads through the memory registry, a representative read/write
succeeds, a **fresh session is started** (plugin/tool schemas are snapshotted at
session start), and **no `openbrain_spool.jsonl` failures remain**.

**Rollback:** revert the `rtech-hermes` change, re-run `scripts/update.sh` from
`10.71.1.71`, restart the agent session.

---

## 4. Tokens and namespaces per consumer

**The mechanism exists and needs no new server code.** `src/auth.ts:41-64`:

```
AUTH_TOKEN_USER_<NAME>=<role>:<token>
```

The env key becomes the `clientId`, lowercased with `_` → `-`
(`src/auth.ts:59-62`). The role must be one of the six in `src/auth.ts:6-13`
(`admin`, `agent`, `discord`, `ob-admin`, `promoter`, `readonly`); an invalid
role is **skipped with a warning**, not an error (`:50-56`) — so a typo yields a
token that simply does not work, with the reason only in the server log.

Six role-wide tokens also exist (`src/auth.ts:15-22`), but **those are the wrong
tool here**: a shared role token gives every box the same `clientId`, which
destroys per-box attribution and makes revocation all-or-nothing.

**Proposed provisioning (PROPOSED — Rico approves the roles):**

| Consumer | Env key | Role | Why |
|---|---|---|---|
| `cc-king` | `AUTH_TOKEN_USER_CC_KING` | `agent` | writes its own sessions |
| `cc-kevin` | `AUTH_TOKEN_USER_CC_KEVIN` | `agent` | " |
| `cc-geetesh` | `AUTH_TOKEN_USER_CC_GEETESH` | `agent` | " |
| `cc-lisa` | `AUTH_TOKEN_USER_CC_LISA` | `agent` | " |

Yielding `clientId`s `cc-king`, `cc-kevin`, `cc-geetesh`, `cc-lisa`.

**Why one token per box and not one shared fleet token:** revocation granularity.
A compromised box is revoked by deleting one line from the server env and
restarting; a shared token means re-provisioning all four. Attribution follows
for free.

### The namespace constraint that shapes this

`src/auth.ts:112-124`: the `X-Namespace` delegation header is honored **only for
`admin` and `ob-admin`**. `promoter` is *explicitly* excluded, with the reason in
a source comment (`:113-115`): it is a service identity writing under its own
authority, not a proxy delegating arbitrary client namespaces. An `agent`-role
token presenting `X-Namespace` gets **403**.

**Consequence for this rollout:** an `agent`-role cc-\* box **cannot choose its
namespace at the wire.** Its namespace is whatever the server resolves for that
identity. So "each box writes to its own namespace" is **not** achievable by
handing the box a header — it must be a server-side property of the identity.

**This plan does not know how per-`clientId` namespace resolution is configured**,
and that is an honest gap, not a detail. It is §6's first open question. Do not
provision cc-\* tokens until it is answered, or all four boxes may write into one
undifferentiated namespace.

Token generation and storage: Vaultwarden, per Development policy. **No token
value appears in this plan, in any PR, or in any log.** `src/auth.ts:69-80`
compares with `timingSafeEqual` and burns constant time on a length mismatch, so
tokens should be generated at full length rather than trimmed.

---

## 5. Mechanism inventory — exists vs. to-build

**EXISTS (cited, verified this session):**

| Mechanism | Evidence |
|---|---|
| Client env-file routing, no hardcoded host | `rodaddy/development` PR #74, MERGED 2026-08-02T20:14:25Z |
| Fail-loud on missing env, value never logged | same PR; stderr names variable + file only |
| Console-script install via `uv tool` | `docs/420-cutover-rollback.md:34-44` |
| Entry points gated by a real test | `python/openbrain/pyproject.toml:59-77` |
| `env -i` wrapper preventing silent capture-zeroing | `docs/420-cutover-rollback.md:46-56` |
| Harness hook wiring (6 events) | `~/.claude/settings.json:258,356,368,404,409,439`; issue #420 CLOSED |
| Per-consumer bearer tokens | `src/auth.ts:41-64` |
| Namespace delegation restricted to admin/ob-admin | `src/auth.ts:112-124` |
| Deploy ref gate (tag or current-tip dispatch) | `docs/local-release-deploy-sop.md:10-18`; `scripts/deploy-ref-gate.ts` |
| Automatic core01 runtime rollback | `docs/local-release-deploy-sop.md:276-290` |
| Client-side rollback = one `cp` | `docs/420-cutover-rollback.md:82-86` |
| LAN-reachable local brain | `local-clone.env:3`; `src/index.ts:351-355` |
| Downstream order for mcps/mcp2cli/Hermes | `docs/downstream-rollout.md:24-147` |
| Hermes client switch | `plugins/memory/openbrain/support.py:127-132,530-535` |
| 0.9.0 within the compatible client range | `src/contract.ts:567-573` |

**TO-BUILD / UNVERIFIED:**

| Gap | State | Blocks |
|---|---|---|
| Linux delivery of the console scripts | **TO-BUILD** — 3 candidates, none chosen | Step 4 |
| Path-parameterized `openbrain-hook-env` | **TO-BUILD** — trivial edit, still a delta | Step 4 |
| `v0.9.0` tag | **TO-BUILD** — operator action, this lane must not tag | Step 2 |
| Stray `v1.0.0` / `v9.9.9` tags | **UNVERIFIED** — undocumented, match the deploy trigger | Step 2 |
| `uv`/Python/PATH present on cc-\* | **UNVERIFIED** — hostmap has no toolchain facts | Step 4 |
| Whether cc-\* run a Claude harness at all | **UNVERIFIED** — can invalidate §1 for those boxes | Step 4 |
| Per-`clientId` namespace resolution | **UNVERIFIED** — `agent` role cannot self-select | Step 4 (§4) |
| Plain-HTTP LAN bearer tokens acceptable? | **UNDECIDED** | Step 4 |
| Local dogfood brain disposition | **UNDECIDED** — option 4 has no mechanism | Step 2 |
| Dogfood → core01 data migration | **DOES NOT EXIST** — separate work item | out of scope |
| Canary soak duration | **UNDECIDED** | Step 5 |

---

## 6. What is NOT decided and needs Rico

Plainly, in the order they block work:

1. **How does a namespace get attached to a per-box `agent` token?** An
   `agent`-role identity cannot present `X-Namespace` (403, `src/auth.ts:116-119`).
   If there is no server-side per-`clientId` namespace mapping, all four boxes
   write into one namespace. **Blocks token provisioning entirely.**
2. **How do the console scripts reach a Linux box?** git+ssh install, wheels
   staged on `/mnt/collab`, or a private index (§1.1). Collab is the
   lowest-friction and needs no new credentials, but it makes a shared volume a
   distribution channel. **Blocks Step 4.**
3. **Do the cc-\* boxes even run a Claude Code harness?** If not, they are not
   consumer family D and §1's artifact list is the wrong list for them.
   **Determines whether Step 4 exists in this shape at all.**
4. **Plain HTTP over the LAN, or HTTPS through Caddy?** Local is
   `http://10.71.1.20:3100`; Hermes already defaults to
   `https://open-brain.rodaddy.live`. Bearer tokens over plain LAN HTTP is a
   posture call, not an engineering one.
5. **What happens to the local dogfood brain on swap-back day?** Four options in
   §2.3. Option 4 (migrate the data) has **no mechanism** and would be its own
   work item. **Nothing should be stopped before this is answered** — the DB holds
   real, growing dogfood data.
6. **Which box is the canary, and how long is the soak?** This plan proposes
   `cc-lisa` and declines to invent a duration.
7. **What are `v1.0.0` and `v9.9.9`?** Undocumented, and both match the `v*`
   deploy trigger. If they are test residue they should go before a real tag is
   pushed. Tag deletion is an operator action.
8. **Do the cc-\* boxes point at core01 or at the Mac?** If the Mac, the fleet
   depends on Rico's laptop being up, and a sleeping Mac becomes a fleet-wide
   memory outage. If core01, Step 4 must wait for Step 2. **This plan assumes
   core01 and orders the steps accordingly, but the assumption is Rico's to
   confirm.**
9. **Is a shared fleet token ever acceptable?** §4 argues no, on revocation
   granularity. Recorded as a recommendation, not a decision.

---

## 7. Explicit non-goals

- Not a deploy runbook for core01 — that is `docs/local-release-deploy-sop.md`.
- Not a restatement of downstream steps 3-6 — that is
  `docs/downstream-rollout.md`, and it wins on any disagreement.
- Not a dogfood-data migration design (§6.5).
- Not a NATS worker rollout — see `docs/core01-nats-worker-runbook.md`; local
  currently reports `nats.availability: not_runtime_available` with
  `fallback_http: true`.
- Not a Forgejo cutover — prepared in source, explicitly deferred
  (`docs/local-release-deploy-sop.md:228-274`).

## Provenance

Every "exists" claim above was read from source, config, or the hostmap during
this session and carries a `file:line`. The local `/health` result and the
`launchctl` entry are **RUNNING**-verified on this Mac only. **No contact was
made with `10.71.1.21` / core01 or with any cc-\* box.** The cc-\* inventory is a
read-only `jq` query against `/Volumes/collab/hostmap.json`. Every command
written for a box or for core01 is **WRITTEN**, never executed.
