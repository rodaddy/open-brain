# Client install runbook — putting the Open Brain direct stack on a new box

**Status: WRITTEN, and the bundle mechanism has been RUN once** (2026-08-04, the
first bundle staged at `/Volumes/ThunderBolt/open-brain-local/air-bundle/`). The
client-side half — a full `setup-client.sh` run on the Air — is **not yet
proven**; see [Proof ladder](#proof-ladder) for what "done" actually requires.

This is the procedure for installing the Open Brain **direct** client stack on a
machine that is not the Mini. It exists because this has been re-derived from
scratch more than once, each time from the same handful of files, and each time
the same four things went wrong.

---

## 1. What actually has to land — four artifacts

An Open Brain client is not one package. It is four things, and **three of the
four are outside any git repo**, which is precisely why this keeps getting
rebuilt from memory.

| # | Artifact | Where it lives on the client | Versioned in the repo? |
|---|---|---|---|
| 1 | Three wheels: `openbrain`, `openbrain-memory`, `openbrain-provider` | `uv` tool environments, console scripts in `~/.local/bin/` | source is, built wheels are not |
| 2 | The env file `claudex-observation.env` | `~/.local/share/openbrain-memory/env/` | **no** — it holds a live token |
| 3 | The wrapper `openbrain-hook-env` | `~/.local/share/openbrain-memory/env/` | **no** |
| 4 | Hook wiring in `~/.claude/settings.json` | the harness settings file | **no** |

`docs/420-cutover-rollback.md` says this plainly for artifact 4: `settings.json`
is outside this repo, so it is not versioned here. The same is true of 2 and 3.
The bundle in this runbook is the mechanism that carries the unversioned three
without hand-copying.

### Why three packages and not one

The hook commands in `settings.json` are spread across all three:

- `openbrain` — `openbrain-session-start`, `openbrain-session-start-remaining`,
  `openbrain-capture-stop`, `openbrain-capture-subagent-stop`,
  `openbrain-session-end`, `openbrain-post-compact`
- `openbrain-provider` — `openbrain-policy-refresh-gate`,
  `openbrain-context-budget-gate`, `ob-guard`
- `openbrain-memory` — `openbrain-memory` (recall, and the durable-write path)

Install two of three and the harness looks fine while a whole class of hook
quietly fails to exec.

---

## 2. Distribution — the wheels come FROM THE MINI

**Clients cannot install from GitHub.** The repo is private, the client boxes
have no deploy key, and there is no published index — `python/openbrain-memory`
records that its `fleet-nats` dependency is not on PyPI and lives in a private
monorepo. `_plans/fleet-rollout-0.9.md` §1.1 lists three candidate delivery
mechanisms and names staged wheels as the lowest-friction one. This runbook is
that option, chosen and built.

The Mini already uses a local wheelhouse convention for its own installs —
`OPENBRAIN_MEMORY_FIND_LINKS`, defaulting to
`~/.local/share/openbrain-memory/wheels`
(`_ob/scripts/ob-memory-provider/package-runtime.ts`). The client side reuses
that idea rather than inventing a second one: `setup-client.sh` passes
`--find-links` at the bundle's own `wheels/` directory. Same shape, resolved
from a local directory, never from an index.

### Build the bundle (on the Mini)

```bash
cd /Volumes/ThunderBolt/Development/open-brain
scripts/client-bundle.sh
```

It stages into a fresh timestamped directory under
`/Volumes/ThunderBolt/open-brain-local/air-bundle/` and flips a `current`
symlink at it.

**The bundle home is deliberate.** It is a sibling of the running `app/` on the
ThunderBolt volume — a durable location an operator can find without knowing
anything about this session. It is **not** in the temp workspace, because temp
has no persistence guarantee and nobody should be picking artifacts out of a
worktree. It is **not** in the repo, because artifact 2 contains a live bearer
token.

**Nothing is ever deleted.** Each run stages fresh and flips the symlink; stale
bundles stay on disk until an operator removes them by hand. A superseded bundle
costs disk. A wrong recursive delete costs the volume.

### Install it (on the client)

Copy the bundle across — `scp`, a mounted share, a USB stick, whatever the box
can do — then:

```bash
./setup-client.sh
```

Then **restart the agent harness**, because `SessionStart` hooks are read at
session start.

---

## 3. The two URL flavors

`OPENBRAIN_BASE_URL` in the env file is the single switch that says which brain a
client talks to. There are two legitimate spellings and they have different
requirements.

| URL | Opt-in needed | Notes |
|---|---|---|
| `https://ob.rodaddy.live` | **none** | **Preferred.** TLS, so the client's transport check passes with no extra variable. |
| `http://10.71.1.20:3100` | `OPENBRAIN_ALLOW_INSECURE_HTTP=1` | LAN plain-http. Requires the opt-in declared by #525 / PR #544. |

`openbrain_memory.client._validate_base_url` permits plain `http` only for
loopback. A LAN address over plain `http` is refused outright unless the client
was built with `allow_insecure_http=True`, which is what
`OPENBRAIN_ALLOW_INSECURE_HTTP` now sets (PR #544 declared it on
`CaptureSettings` and `CanonSettings` and flowed it to all five client
construction sites).

Prefer the `https://` flavor. It needs no opt-in, it does not put a bearer token
on the wire in plain text, and it removes an entire category of "why is this box
silent" from the install.

**The URL is a BARE `scheme://host:port` with no path.** Not `/mcp`, not `/api`,
no trailing path segment of any kind. See the gotchas.

**Loopback is for the Mini only.** `127.0.0.1` in the env file means "the brain
on this machine". On a client that is wrong and will fail, and on the Mini it is
correct and needs no opt-in. The bundle copies the Mini's env file verbatim, so
**editing `OPENBRAIN_BASE_URL` on the client is a required step** when the
staged value is loopback.

---

## 4. The MATCHED-PAIR rule — the one that fails silently

**The wrapper and the installed package must move together, package first.**

The mechanism, in three facts that compound:

1. The Python config (`config.unknown_prefixed_variables`) **rejects** any
   `OPENBRAIN_*` environment variable that matches no declared setting.
2. The hook entrypoints **swallow every exception** — that is the fail-open
   observer contract.
3. Therefore a rejected environment is a **clean exit 0 with zero capture and
   zero injection**. Receipts, no rows. The box looks perfectly healthy.

So if the wrapper passes a variable the installed package does not declare,
**every hook on that box silently stops working**. Not some. Every one, because
the rejection is of the whole environment, not of the one variable.

This has now happened three times with three different variables —
`OPENBRAIN_OBSERVATION_*`, `OPENBRAIN_SPOOL_PATH`, and
`OPENBRAIN_ALLOW_INSECURE_HTTP` — which is why the rationale lives in the
wrapper's own header comment and in `docs/CONFIG_REFERENCE.md` rather than in a
commit message.

**The ordering rule, from PR #544:** install the package that declares the
variable, *then* edit the wrapper to pass it. PR #544 verified this empirically
in exactly that order — the old install raised `UnknownEnvironmentVariableError`
with the variable present; the reinstalled package accepted it and resolved
`allow_insecure_http=True`. Reversed, the box goes dark between the two steps.

`setup-client.sh` installs wheels before placing the wrapper for this reason.

### The empty-string gotcha, on top of it

The wrapper's `env -i VAR="${VAR:-}"` pass-through style **cannot express
"absent"** — an unset variable arrives in the child as an **empty string**.

For a string field that is harmless. For `allow_insecure_http`, a bool, it is
not: pydantic rejected `""` with `Input should be a valid boolean`, both
`load_capture_settings` and `load_canon_settings` raised, the entrypoints
swallowed it, and every hook on a host that **never opted in** became a silent
zero capture. The #525 defect class, re-armed by the fix for #525.

Two layers now guard it: a validator in `config.py` mapping `""` to the default
`False`, and a conditional in the wrapper that prepends the assignment only when
the value is non-empty. The conditional is what protects an **older** installed
package that predates the validator — which is exactly the situation a client
being upgraded is in.

**Rule for anyone adding a pass-through:** a non-string variable goes in the
conditional block, never in the `env -i` list.

---

## 5. Proof ladder

An install is not done because the commands exist and the script exited 0. It is
done when each rung holds, in order. Each one can pass while the next fails, so
stopping early is how a green-looking dead box happens.

| # | Rung | How | What a failure means |
|---|---|---|---|
| 0 | **The env file was edited** | `OPENBRAIN_BASE_URL` is the Mini's LAN address, and `OPENBRAIN_NAMESPACE` is present | The bundle ships the build machine's env verbatim, so an unedited `OPENBRAIN_BASE_URL` is loopback and points the client at itself. A missing `OPENBRAIN_NAMESPACE` fails later as a message about a *request key*, which points at the JSON instead of at this file. `setup-client.sh` now refuses on both. |
| 1 | **Health** | `curl -sS $OPENBRAIN_BASE_URL/health` → `200` | Service down, wrong URL, or the plain-http opt-in is missing. |
| 2 | **Recall is `direct`** | source the env file, then pipe one JSON object (below) to `openbrain-memory` → `"status": "direct"` | Anything other than `direct` means the direct stack is not the lane answering — suspect a stale MCP registration. |
| 3 | **CANON PACK, non-zero counts** | Start a **fresh** session; the `SessionStart` emissions carry section counts | Counts of zero, or no pack at all, is the matched-pair failure. The hooks ran and swallowed a rejection. |
| 4 | **The turn is visible in Langfuse** | Find the session's turn in the Langfuse observation sink | The capture spine reached the brain but the observation lane did not. |

Rung 2 in full. **The CLI takes one bounded JSON object on stdin** — with
`operation` inside it — and it takes no argv flags at all; an argv invocation
returns `arguments are not supported` without ever reaching the brain. The
namespace comes from `OPENBRAIN_NAMESPACE` in the environment, which is why the
env file is sourced first and why it is not a key in the JSON:

```sh
set -a; . ~/.local/share/openbrain-memory/env/claudex-observation.env; set +a
printf '%s' '{"operation":"recall","query":"client install proof","scope":{"agent":"setup-client","platform":"claude-code","server_id":"client-install","channel_id":"client-install","session_key":"client-install-proof"}}' \
  | openbrain-memory
```

All five scope fields are required. They are reported together in one receipt,
so a scope that is missing several does not cost one attempt per field.

Rung 3 is the one that catches the silent failure, because rungs 1 and 2 both
pass on a box whose hooks are dead — they exercise the client library directly
and never go through the hook entrypoints' exception swallowing.

**Agent-side note:** the terminal `OB ✓ gate passed` receipt is a
`systemMessage` for the operator's eyes and never appears in an agent's own
context. An agent proving its own hydration reads the CANON PACK section counts,
not that line.

---

## 6. Diagnosing a client that came up silent

In order, because each check makes the next one meaningful:

1. **Are `OPENBRAIN_BASE_URL` and `OPENBRAIN_TOKEN` both present?** A present
   URL with a missing token produces the *same* message as an unreachable host.
   Two sessions once diagnosed a missing token as a core01 outage. Name the
   variable in your report, never the value.
2. **Does the wrapper's `ENV_FILE` path exist on this box?** It is an absolute
   path baked in at build time. `setup-client.sh` rewrites it, but a hand-copied
   wrapper will still point at the build machine's `$HOME`.
3. **Is the wrapper executable?** A copy that lost its mode bit makes every hook
   a no-op.
4. **Does the installed package declare every variable the wrapper passes?**
   This is the matched pair. Run one entrypoint by hand and read the error
   instead of trusting exit 0.
5. **Is there a stale MCP registration?** `claude mcp list`. A URL ending `/mcp`
   in any error is the retired lane.
6. **Only then** probe host availability. A healthy `/health` next to a failing
   gate is positive evidence that the problem is credentials or environment, not
   the network.

---

## 7. Related documents

- `docs/420-cutover-rollback.md` — the settings.json cutover, the wrapper's
  design, and the rollback procedure.
- `docs/CONFIG_REFERENCE.md` — every `OPENBRAIN_*` variable and which section
  declares it.
- `docs/GOTCHAS.md` — the four client-install traps, stated as failures.
- `_plans/fleet-rollout-0.9.md` §1 — the artifact inventory and the delivery
  options this runbook chose from.
